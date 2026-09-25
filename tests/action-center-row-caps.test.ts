import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Action Center's "decisions I made" history read ten tables, and every one of them ended in
// `.limit(200)` or `.limit(100)`. A capped read is the worst shape of wrong answer: a well-formed
// list that is simply missing rows, with nothing on the page saying it was cut.
//
// This was LIVE, and it was the owner's own screen. Measured on production 2026-09-23:
//   outstation_expenses approved_by = B-10   370 rows against .limit(200)   → 170 dropped
//   the dropped ones run 2026-06-07 … 2026-09-07
//
// Worse than short, it was UNSTABLE. 240 of those 370 approvals share ONE `approved_at` instant
// (a bulk approval writes them together), so `order by approved_at desc` with a limit cut straight
// through the middle of a tie — Postgres was free to return a different arbitrary 200 of those 240
// on each load. That is why the `id` tiebreak below is not tidiness: paging is only correct over a
// TOTAL sort, and without one it both drops and duplicates rows across page boundaries.
//
// The paging RULE itself is pinned behaviourally against a fake client in
// `tests/approvals-hub-row-cap.test.ts` — the Action Center calls that same pager rather than
// carrying a second copy. What is pinned HERE is what is specific to this file: that no cap comes
// back, that every feed's ordering stays total, and that each declared row type still matches the
// columns its own `.select()` asks for.
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE_URL = new URL("../src/lib/action-center/service.ts", import.meta.url);

/** The `await Promise.allSettled([ … ])` block inside getMyApprovalHistory. */
function historyQueryBlock(code: string): string {
  const fnAt = code.indexOf("export async function getMyApprovalHistory");
  assert.notEqual(fnAt, -1, "getMyApprovalHistory must still exist — this test is pinned to it");
  const openAt = code.indexOf("await Promise.allSettled([", fnAt);
  assert.notEqual(openAt, -1, "the decided-history feeds must still be read in one Promise.allSettled");
  const closeAt = code.indexOf("]);", openAt);
  assert.notEqual(closeAt, -1, "the Promise.allSettled block must be closed");
  return code.slice(openAt, closeAt);
}

/** Split a PostgREST select list on its TOP-LEVEL commas, so `parent(a,b)` stays one token. */
function selectColumns(select: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of select) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  // `[\s\S]` rather than the `s` (dotAll) flag: this repo targets ES2017, where that flag is a
  // compile error — and an embedded select like `parent(a,b)` can span lines.
  return out.map((token) => token.trim().replace(/\([\s\S]*$/, "").trim()).filter(Boolean);
}

/** The keys of a `type X = { … };` alias declared in the file. */
function typeKeys(code: string, name: string): string[] {
  const at = code.indexOf(`type ${name} = {`);
  assert.notEqual(at, -1, `the row type ${name} must be declared in service.ts`);
  const body = code.slice(at, code.indexOf("};", at));
  return [...body.matchAll(/^\s{2}([a-z_][a-z0-9_]*)\s*:/gim)].map((m) => m[1]);
}

export async function runActionCenterRowCapTests() {
  const raw = readFileSync(SERVICE_URL, "utf8");
  const code = stripComments(raw);
  const block = historyQueryBlock(code);

  // ── No capped read may return to the decided-history feeds ────────────────
  assert.doesNotMatch(
    block,
    /\.limit\(/,
    "RED a `.limit()` on a decided-history feed silently hides a person's own decisions — page the read instead",
  );

  // ── Every feed goes through the shared pager ──────────────────────────────
  const callSites = [...block.matchAll(/fetchAllApprovalRows<([A-Za-z0-9_]+)>\(/g)].map((m) => m[1]);
  assert.equal(
    callSites.length,
    10,
    "RED all ten decided-history feeds must be paged — a feed left out of the pager is a feed still capped",
  );
  assert.equal(
    new Set(callSites).size,
    10,
    "each feed must declare its own row type — two feeds sharing one type means a select list is unchecked",
  );
  assert.match(
    code,
    /import \{ fetchAllApprovalRows \} from "@\/lib\/approvals-hub\/page-rows"/,
    "the pager must be the SHARED one, never a second copy — one paging rule, tested in one place",
  );

  // ── Every feed's ordering is TOTAL ────────────────────────────────────────
  // Split on the call sites so each segment holds exactly one query's chain.
  const segments = block.split(/fetchAllApprovalRows<[A-Za-z0-9_]+>\(/).slice(1);
  assert.equal(segments.length, 10, "every call site must yield a chain to inspect");
  segments.forEach((segment, i) => {
    const orders = [...segment.matchAll(/\.order\(\s*"([a-z_][a-z0-9_]*)"/gi)].map((m) => m[1]);
    assert.ok(orders.length >= 2, `${callSites[i]} must order by more than one column — a single sort key is not total`);
    assert.equal(
      orders.at(-1),
      "id",
      `RED ${callSites[i]} must END its ordering with \`id\` — a non-total sort both drops and duplicates rows across page boundaries, and 240 real rows share one approved_at instant`,
    );
  });

  // ── Each row type still matches the columns its own select asks for ───────
  // This is what would have caught the two step feeds, whose selects had no `id` at all until the
  // ordering needed one.
  segments.forEach((segment, i) => {
    const select = segment.match(/\.select\(\s*"([^"]+)"/);
    assert.ok(select, `${callSites[i]} must still declare an explicit select list`);
    const declared = new Set(typeKeys(code, callSites[i]));
    for (const column of selectColumns(select[1])) {
      assert.ok(
        declared.has(column),
        `RED ${callSites[i]} selects \`${column}\` but does not declare it — the query and the code reading it have drifted apart`,
      );
    }
  });
}
