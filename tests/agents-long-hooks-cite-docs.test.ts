// A LONG RULE THAT CARRIES ITS OWN EVIDENCE IS THE GROWTH MECHANISM, NOT THE SYMPTOM.
//
// WHY THIS EXISTS. AGENTS.md opens by stating the split it lives by: "Adding a rule? Put the hook
// here and the account in `docs/` — never the account here." `tests/autoload-footprint-budget.test.ts`
// already gates the TOTAL, which is the cost. Nothing gated the CAUSE, so the total is reached
// again and again by the same route: a new rule is written with its run ids, table names, counts
// and dates inline, because that is the fastest thing to do at the moment it is learned.
//
// WHAT THAT COST, MEASURED. On 2026-09-07 nine §4 rules were found holding evidence that existed
// NOWHERE ELSE in the repository — including `plan_audit_backup_20260905.dm_fabricated_ceo_approve`
// and `.dm_human_ceo_approve`, the two pre-image tables that are the recovery path for 50 deleted
// production rows. Their only record was one line of one auto-loaded file. Relocating them to
// docs/ removed 3,711 bytes from every request and removed no fact from the repo (#3451). The
// trap that makes this dangerous rather than merely untidy: the obvious order — trim first,
// relocate later — DESTROYS the evidence, and reads as a tidy-up while doing it.
//
// WHY A SIZE GATE ALONE CANNOT FIX IT. When the footprint gate goes red the cheapest way to green
// is to delete a hook, which AGENTS.md §2.2 forbids precisely because a session under pressure
// will reach for it. This check fires EARLIER and names a remedy that is always safe: move the
// account out, keep the hook. It can never be satisfied by deleting a rule.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

/** A hook longer than this is carrying an account, not a cue. */
export const LONG_HOOK_BYTES = 1_200;

/** `docs/<something>.md`, in a link or as bare prose — either is a pointer a reader can follow. */
const DOCS_POINTER = /docs\/[A-Za-z0-9._-]+\.md/;

type Hook = { line: number; section: string; bytes: number; text: string };

/** Top-level bullets of §2 and §4 — the two sections that hold hooks and the two that regrow. */
export function hookBullets(agentsText: string): Hook[] {
  const out: Hook[] = [];
  let section = "";
  agentsText.split("\n").forEach((line, i) => {
    const heading = /^##+\s+(\d+(?:\.\d+)?)/.exec(line);
    if (heading) section = heading[1];
    if (!/^- /.test(line)) return;
    if (!/^2(\.|$)/.test(section) && !/^4(\.|$)/.test(section)) return;
    out.push({ line: i + 1, section, bytes: Buffer.byteLength(line, "utf8"), text: line });
  });
  return out;
}

export function runAgentsLongHooksCiteDocsTests() {
  const agents = readFileSync("AGENTS.md", "utf8");
  const hooks = hookBullets(agents);

  // The gate must be measuring something. A parser that silently matches nothing passes forever —
  // the failure mode source-reading tests here keep repeating.
  assert.ok(hooks.length > 100, `expected the §2/§4 hooks to be found; parsed only ${hooks.length}`);
  assert.ok(
    hooks.some((h) => /^2\./.test(h.section)) && hooks.some((h) => /^4/.test(h.section)),
    "both §2 and §4 must be represented, or the parser is reading one section and calling it all of them",
  );

  const offenders = hooks.filter((h) => h.bytes > LONG_HOOK_BYTES && !DOCS_POINTER.test(h.text));
  assert.deepEqual(
    offenders.map((h) => `AGENTS.md:${h.line} (§${h.section}, ${h.bytes} bytes)`),
    [],
    `These hooks are over ${LONG_HOOK_BYTES} bytes and name no docs/ file, so AGENTS.md is the only `
      + "record of whatever evidence they carry — and AGENTS.md is re-sent on EVERY request.\n"
      + "Move the account into the matching docs/ file and leave the cue plus a pointer behind:\n"
      + "  §2.1 -> docs/agents-session-traps.md      §2.3 -> docs/agents-production-hooks.md\n"
      + "  §4   -> docs/agents-owner-rules.md        worktrees -> docs/agents-worktree-and-machine-limits.md\n"
      + "RELOCATE FIRST, TRIM SECOND — the reverse order destroys evidence that exists nowhere else "
      + "(#3451 found nine such rules, two naming production recovery tables).\n"
      + "NEVER delete a hook to make room: AGENTS.md §2.2 forbids it, and this check cannot be "
      + "satisfied that way — a deleted rule is a lost rule, not a shorter one.",
  );

  // The threshold has to leave the legitimately dense rules alone, or it becomes noise that is
  // routinely suppressed. Most hooks must sit comfortably under it.
  const long = hooks.filter((h) => h.bytes > LONG_HOOK_BYTES);
  assert.ok(
    long.length < hooks.length / 10,
    `${long.length} of ${hooks.length} hooks exceed ${LONG_HOOK_BYTES} bytes; the threshold is `
      + "supposed to catch the exception, not the norm",
  );
}
