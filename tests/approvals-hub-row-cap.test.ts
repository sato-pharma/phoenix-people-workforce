import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  APPROVALS_PAGE_SIZE,
  MAX_APPROVALS_HUB_ROWS,
  fetchAllApprovalRows,
} from "../src/lib/approvals-hub/page-rows.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The approvals hub's company-wide feeds each ended in a `.limit()` — 400, 500 or 1000 depending
// on the surface. A capped read is the worst shape of wrong answer: a well-formed list that is
// simply missing rows, with nothing on the page to say so. On an approvals surface that means a
// request that was decided, or is waiting to be decided, silently does not exist for the person
// looking at it.
//
// This was NOT latent. Measured on production 2026-09-23, before the fix:
//   v2_vacation_requests, decided                536 rows against .limit(500)  → 36 dropped
//   the oldest of them decided 2026-06-30
// So Super Admin's company-wide leave decision history was already missing real decisions.
//
// Pinned here: the paging rule itself, driven against a fake client rather than asserted from the
// source — a regex pin would pass the day someone reintroduced a `.limit()` two lines away.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fake PostgREST builder.
 *
 * `serverMaxRows` models a server-side `max-rows` ceiling BELOW our page size — the case that
 * breaks any pager which advances by page size instead of by rows received.
 */
type FakeBuilder = {
  select: () => FakeBuilder;
  eq: () => FakeBuilder;
  neq: () => FakeBuilder;
  not: () => FakeBuilder;
  or: () => FakeBuilder;
  in: () => FakeBuilder;
  from: () => FakeBuilder;
  /** Returns the builder, so a call site can chain `.order(a).order(b)` the way the real one does. */
  order: (column: string) => FakeBuilder;
  range: (from: number, to: number) => Promise<{ data: Array<Record<string, unknown>> | null; error: unknown }>;
};

function fakeClient(options: { rows: Array<Record<string, unknown>>; serverMaxRows?: number; failOnCall?: number }) {
  const state = {
    calls: 0,
    orders: [] as string[],
    ranges: [] as Array<[number, number]>,
  };

  const build = (): FakeBuilder => {
    const orders: string[] = [];
    const chain = () => builder;
    const builder: FakeBuilder = {
      select: chain,
      eq: chain,
      neq: chain,
      not: chain,
      or: chain,
      in: chain,
      from: chain,
      order: (column: string) => {
        orders.push(column);
        return builder;
      },
      range: (from: number, to: number) => {
        state.calls += 1;
        state.orders.push(...orders);
        state.ranges.push([from, to]);
        if (options.failOnCall && state.calls === options.failOnCall) {
          return Promise.resolve({ data: null, error: { message: "boom" } });
        }
        const width = Math.min(to - from + 1, options.serverMaxRows ?? Number.MAX_SAFE_INTEGER);
        return Promise.resolve({ data: options.rows.slice(from, from + width), error: null });
      },
    };
    return builder;
  };

  return { build, state };
}

const row = (n: number) => ({ id: `r${n}`, n });

export async function runApprovalsHubRowCapTests() {
  // ── A feed larger than one page comes back WHOLE ──────────────────────────
  {
    const rows = Array.from({ length: 2_500 }, (_, i) => row(i));
    const { build, state } = fakeClient({ rows });
    const { data, error } = await fetchAllApprovalRows<{ n: number }>(build);
    assert.equal(error, null, "a complete read must not report an error");
    assert.equal(
      data?.length,
      2_500,
      "RED every matching row must come back — a feed that stops at the page size is the whole defect",
    );
    assert.deepEqual(data?.[0], row(0), "the first row must survive paging");
    assert.deepEqual(data?.at(-1), row(2_499), "the last row must survive paging");
    assert.equal(state.calls, 4, "2,500 rows at 1,000 a page is three full pages plus the empty one that ends it");
  }

  // ── 536 against the old .limit(500): the exact production shape ───────────
  {
    const rows = Array.from({ length: 536 }, (_, i) => row(i));
    const { build } = fakeClient({ rows });
    const { data } = await fetchAllApprovalRows<{ n: number }>(build);
    assert.equal(
      data?.length,
      536,
      "RED the 36 decisions production was already dropping must be in the answer",
    );
  }

  // ── The walk advances by rows RECEIVED, never by page size ────────────────
  {
    const rows = Array.from({ length: 900 }, (_, i) => row(i));
    // The server refuses to return more than 300 at a time, though we asked for 1,000.
    const { build, state } = fakeClient({ rows, serverMaxRows: 300 });
    const { data } = await fetchAllApprovalRows<{ n: number }>(build);
    assert.equal(
      data?.length,
      900,
      "RED a server max-rows below the page size must not end the walk early — advance by rows RECEIVED, not by page size",
    );
    assert.deepEqual(
      state.ranges.map(([from]) => from),
      [0, 300, 600, 900],
      "each page must start where the previous one actually ENDED, not a page-size stride later",
    );
  }

  // ── Every page is ordered by a TOTAL sort ─────────────────────────────────
  {
    const rows = Array.from({ length: 10 }, (_, i) => row(i));
    const { build, state } = fakeClient({ rows });
    await fetchAllApprovalRows<{ n: number }>(() => build().order("decided_at").order("id"));
    assert.equal(
      state.orders.at(-1),
      "id",
      "the ordering must end in a unique column — paging a non-total sort both drops and duplicates rows",
    );
  }

  // ── A failure is an error, never a partial list ───────────────────────────
  {
    const rows = Array.from({ length: 2_500 }, (_, i) => row(i));
    const { build } = fakeClient({ rows, failOnCall: 2 });
    const { data, error } = await fetchAllApprovalRows<{ n: number }>(build);
    assert.ok(error, "a failed page must surface as an error");
    assert.equal(
      data,
      null,
      "RED a read that failed half way must return NOTHING — handing back the rows gathered so far is the silent truncation this fix removes, wearing a different hat",
    );
  }

  // ── Past the ceiling it refuses rather than shortens ──────────────────────
  {
    const rows = Array.from({ length: 50 }, (_, i) => row(i));
    const { build } = fakeClient({ rows });
    const { data, error } = await fetchAllApprovalRows<{ n: number }>(build, { maxRows: 10, pageSize: 20 });
    assert.ok(error, "exceeding the ceiling must be an error");
    assert.equal(data, null, "RED past the ceiling it must refuse, never answer with a partial list");
  }

  // ── The constants are sane ────────────────────────────────────────────────
  assert.ok(APPROVALS_PAGE_SIZE >= 1_000, "a page smaller than 1,000 turns every feed into many round trips");
  assert.ok(
    MAX_APPROVALS_HUB_ROWS >= 100_000,
    "the ceiling must sit far above anything these tables hold, so reaching it means a broken filter rather than real growth",
  );

  // ── No capped read may return to the hub ──────────────────────────────────
  // Comment lines are stripped first: the prose in this repo quotes the removed limits, and a
  // naive match would fire on the explanation rather than on a real call.
  const service = readFileSync(new URL("../src/lib/approvals-hub/service.ts", import.meta.url), "utf8");
  const code = service
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
  assert.doesNotMatch(
    code,
    /\.limit\(/,
    "RED a `.limit()` on an approvals feed silently hides requests — page the read instead",
  );
  assert.match(
    code,
    /fetchAllApprovalRows/,
    "the hub's feeds must go through the pager",
  );
}
