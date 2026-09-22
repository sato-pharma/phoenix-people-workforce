import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// "Decided for you" tells a manager back from leave what somebody else decided on his behalf.
// Every read in it used to end in a cap: `PER_MODULE_LIMIT = 200` on the four decision feeds and
// `.limit(1000)` on the marketing request lookup.
//
// A short answer is worse on THIS surface than on any other approvals screen, because an empty
// stretch here is not a blank — it is a claim. "Nothing else happened while you were away" is
// exactly what a truncated list looks like, and it is unfalsifiable from the page.
//
// Three things made these caps sharper than they read:
//
//   * they were applied PER 50-ID CHUNK, so the real ceiling moved with team size;
//   * `marketing_requests` was capped with NO time window and NO ordering, and its truncation
//     dropped rows from a DIFFERENT query — a decided step whose request missed the map is
//     discarded by `if (!request) continue`, silently;
//   * nothing ordered by a unique column, so any truncation was non-deterministic. Measured on
//     production 2026-09-23: 116 leave rows share a single `manager_decision_at` value.
//
// HONESTY ABOUT SCALE, so nobody reads this test as proof of a live leak: on production
// 2026-09-23 none of the five caps bound. The largest team is 11 direct reports, the busiest
// manager's 90-day window holds 66 leave rows against a cap of 200, and all 47 marketing requests
// ever raised fit inside the 1000. This pins a latent defect closed and buys determinism.
//
// The paging RULE lives in `tests/approvals-hub-row-cap.test.ts`, driven against a fake client.
// This module calls that same pager rather than carrying a third copy, so what is pinned HERE is
// what is specific to this file: no cap comes back, every chain stays totally sorted, each row
// type matches its own select, and a failed read is raised rather than rendered as a quiet week.
// ─────────────────────────────────────────────────────────────────────────────

const MODULE_URL = new URL("../src/lib/action-center/decided-for-me.ts", import.meta.url);

/** Drop comment lines: the prose above and in the module quotes the removed limits verbatim. */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
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
  // compile error.
  return out.map((token) => token.trim().replace(/\([\s\S]*$/, "").trim()).filter(Boolean);
}

/**
 * The keys of a `type X = { … };` alias.
 *
 * Unlike the Action Center's copy this does not assume one key per line — these aliases pack
 * several onto a line, and a per-line matcher would silently check only the first of each and
 * pass a select list it never looked at.
 */
function typeKeys(code: string, name: string): string[] {
  const at = code.indexOf(`type ${name} = {`);
  assert.notEqual(at, -1, `the row type ${name} must be declared in decided-for-me.ts`);
  const body = code.slice(at + `type ${name} = {`.length, code.indexOf("};", at));
  return [...body.matchAll(/([a-z_][a-z0-9_]*)\s*:/gi)].map((m) => m[1]);
}

export async function runDecidedForMeRowCapTests() {
  const raw = readFileSync(MODULE_URL, "utf8");
  const code = stripComments(raw);

  // ── No capped read may come back ──────────────────────────────────────────
  assert.doesNotMatch(
    code,
    /\.limit\(/,
    "RED a `.limit()` here renders as 'nothing happened while you were away' — page the read instead",
  );
  assert.doesNotMatch(
    code,
    /PER_MODULE_LIMIT/,
    "RED the per-module cap must not return — it was applied per 50-id chunk, so its real ceiling moved with team size",
  );

  // ── Every read goes through the SHARED pager ──────────────────────────────
  const callSites = [...code.matchAll(/fetchAllApprovalRows<([A-Za-z0-9_]+)>\(/g)].map((m) => m[1]);
  assert.equal(
    callSites.length,
    5,
    "RED all five reads must be paged — leave, excuse, plan, the marketing request lookup and its steps",
  );
  assert.equal(
    new Set(callSites).size,
    5,
    "each read must declare its own row type — two reads sharing one type means a select list goes unchecked",
  );
  assert.match(
    code,
    /import \{ fetchAllApprovalRows \} from "@\/lib\/approvals-hub\/page-rows"/,
    "the pager must be the SHARED one (#4273, reused by #4274) — one paging rule, tested in one place",
  );

  // ── Every chain is TOTALLY sorted ─────────────────────────────────────────
  const segments = code.split(/fetchAllApprovalRows<[A-Za-z0-9_]+>\(/).slice(1);
  assert.equal(segments.length, 5, "every call site must yield a chain to inspect");
  segments.forEach((segment, i) => {
    const chain = segment.slice(0, segment.indexOf("));"));
    const orders = [...chain.matchAll(/\.order\(\s*"([a-z_][a-z0-9_]*)"/gi)].map((m) => m[1]);
    assert.ok(
      orders.length >= 1,
      `RED ${callSites[i]} must ORDER — the marketing request lookup had no ordering at all, so its truncation was arbitrary`,
    );
    assert.equal(
      orders.at(-1),
      "id",
      `RED ${callSites[i]} must END its ordering with \`id\` — 116 real leave rows share one manager_decision_at, and a non-total sort both drops and duplicates rows across page boundaries`,
    );
  });

  // ── Each row type matches the columns its own select asks for ─────────────
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

  // ── A failed read is RAISED, never rendered as a quiet week ───────────────
  // The module already argues this for the employee directory ("the worst possible lie for this
  // particular feature"). The same reasoning binds the paged reads: the pager reports a refusal
  // through `error`, and `?? []` would turn that refusal into an empty, confident list.
  assert.match(
    code,
    /if \(read\.error\) throw read\.error;/,
    "RED the three team feeds must raise a failed read — swallowing it shows an empty list as a quiet fortnight",
  );
  assert.match(
    code,
    /if \(requestError\) throw requestError;/,
    "RED a failed marketing request lookup must raise — swallowed, it silently drops every decided step on those lines",
  );
  assert.match(
    code,
    /if \(stepError\) throw stepError;/,
    "RED a failed step read must raise rather than report zero marketing decisions",
  );
}
