import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  BULK_DECISION_MAX,
  bulkDecidableStatuses,
  bulkDecisionRefusal,
  candidateStatuses,
  isBulkDecidableStatus,
} from "../src/lib/recruitment/candidate-status.ts";

/**
 * Fewer keystrokes per screening decision — the bulk verdict, and the undo behind it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 *
 * Measured in production 2026-09-05: 238 candidates still `new` after fourteen days, 438 never
 * opened by anybody at all, one screener, and roughly 22 CVs arriving a day. Deciding one row at a
 * time is the bottleneck, so a verdict now covers a selection.
 *
 * That is a dangerous thing to add carelessly, and the traps pinned here are the ones that would
 * each be invisible afterwards:
 *
 *   1. WHICH STATUSES MAY BE SET IN BULK. `sent_to_manager` must not be one. Reaching that status
 *      is supposed to notify a manager, stamp the candidate and write an audit row; setting it in
 *      bulk would mark fifty CVs as sent to somebody who was never told, and the queue would then
 *      stop asking about them. A lie that silently REMOVES work is the worst shape available here.
 *      `hired` is excluded because a hire is only real once an offer has been accepted, and `new`
 *      because it is where a candidate starts, not a verdict.
 *
 *   2. THE CAP IS A BLAST RADIUS. 200 is the largest mistake one press may make, and the same
 *      number is enforced in the database function, so a caller that skips the route still hits it.
 *
 *   3. ONE TRANSACTION, NEVER A LOOP. A Supabase request that times out at 15s STILL COMMITS, so a
 *      client-side loop that dies partway leaves some candidates decided, some not, and the screen
 *      reporting a failure — after which the recruiter re-decides rows that already moved.
 *
 *   4. UNDO IS NOT "DECIDE BACK". A revert restores a DIFFERENT status per candidate and must not
 *      be bound by the two verdicts a bulk decision may set: putting somebody back to
 *      `sent_to_manager` tells no lie, because they really were sent. Routing undo through the
 *      decision rule would block the commonest undo of all — back to `new`, the whole backlog case.
 *
 *   5. A DECISION ACTS ON WHAT THE READER CAN SEE. Marks survive a narrowing so widening restores
 *      them, but the verdict is applied to the VISIBLE marked rows. The same rule `selected`
 *      follows, after a decision once landed on a candidate the list was not showing.
 *
 *   6. REJECT IS NOT A KEYSTROKE. It is the one verdict this screen asks a reason for — the button
 *      opens a panel. A single key that skipped the panel would quietly turn every rejection into
 *      an unexplained one.
 */
export function runRecruitmentBulkDecisionTests() {
  const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

  // ── 1. THE VOCABULARY ─────────────────────────────────────────────────────────────────────────
  //
  // Real calls, not a source pin: this is a product rule and it can be executed.

  assert.deepEqual(
    [...bulkDecidableStatuses],
    ["shortlisted", "rejected"],
    "only shortlist and reject may be applied to many candidates at once — see the header for what " +
      "each of the other three would break",
  );

  for (const status of bulkDecidableStatuses) {
    assert.ok(
      (candidateStatuses as readonly string[]).includes(status),
      `${status} must be a real candidate status, not a fifth vocabulary of its own`,
    );
    assert.equal(bulkDecisionRefusal(status, 1), null, `${status} is allowed in bulk`);
    assert.ok(isBulkDecidableStatus(status), `${status} must pass its own guard`);
  }

  // The three that are refused, each for its own reason.
  for (const status of ["sent_to_manager", "hired", "new"]) {
    assert.ok(!isBulkDecidableStatus(status), `${status} must not be bulk-decidable`);
    const refusal = bulkDecisionRefusal(status, 5);
    assert.ok(refusal, `${status} must be refused in bulk`);
    // The sentence has to NAME the thing being refused, or a recruiter reads "cannot" with no idea
    // which of the two buttons they pressed.
    assert.match(
      String(refusal),
      /cannot be set for several candidates at once/,
      `the refusal for ${status} must say what it is refusing`,
    );
  }

  // A status that does not exist at all is refused differently — as nonsense, not as policy. The
  // two sentences send a recruiter to completely different places, so they must not collapse.
  const nonsense = bulkDecisionRefusal("banana", 5);
  assert.ok(nonsense, "an unknown status is refused");
  assert.match(
    String(nonsense),
    /is not a candidate status/,
    "an unknown status must be refused as unknown, not as one that merely cannot be bulk-set",
  );

  // But a LEGACY value is not nonsense. 'Candidate Created' was the old database default that every
  // inbound CV carried, and normalizeCandidateStatus still resolves it to `new` — deliberately, so
  // new code keeps working on old rows. It must therefore be refused on POLICY (new is not a
  // verdict), never as an unknown status. This assertion is here because the first draft of this
  // test got it the wrong way round and the run caught it.
  const legacy = bulkDecisionRefusal("Candidate Created", 5);
  assert.ok(legacy, "a legacy value resolving to `new` is still refused in bulk");
  assert.match(
    String(legacy),
    /cannot be set for several candidates at once/,
    "a recognised legacy value must be refused as policy — it IS a status, it is just not a verdict",
  );

  // ── 2. THE CAP, AT ITS BOUNDARY ───────────────────────────────────────────────────────────────

  assert.equal(BULK_DECISION_MAX, 200, "the cap is 200 — and the database function repeats it");
  assert.equal(
    bulkDecisionRefusal("shortlisted", BULK_DECISION_MAX),
    null,
    "exactly the cap is allowed — an off-by-one here silently costs the reader one row every time",
  );
  const overCap = bulkDecisionRefusal("shortlisted", BULK_DECISION_MAX + 1);
  assert.ok(overCap, "one over the cap is refused");
  assert.match(
    String(overCap),
    new RegExp(String(BULK_DECISION_MAX)),
    "the refusal must print the actual limit, so the reader knows how far to trim",
  );
  assert.ok(bulkDecisionRefusal("shortlisted", 0), "an empty selection is refused");

  // ── 3. ONE TRANSACTION, NEVER A LOOP ──────────────────────────────────────────────────────────

  const service = read("src/lib/recruitment/candidates.ts");
  assert.match(
    service,
    /supabase\.rpc\("ats_bulk_set_candidate_status"/,
    "the bulk decision must go through the database function — one transaction, so it cannot " +
      "half-apply",
  );
  // The regression this guards is somebody "simplifying" the RPC away into the obvious loop.
  assert.doesNotMatch(
    service,
    /for \(const id of (unique|ids)\)[\s\S]{0,400}updateCandidateStatus\(/,
    "a bulk decision must NEVER be a loop over updateCandidateStatus — a request that times out at " +
      "15s still commits, so a loop that dies partway leaves the queue half-decided",
  );

  const migration = read("supabase/migrations/20260905070000_bulk_candidate_decision.sql");
  // The history insert has to live inside the SAME statement as the update. Split across two
  // statements it can succeed while the other fails, which is the state nobody can untangle later.
  assert.match(
    migration,
    /insert into public\.ats_candidate_status_events/,
    "the function must write the decision history itself",
  );
  assert.match(
    migration,
    /returns table \(candidate_id uuid, from_status text, to_status text\)/,
    "it must return where each candidate came FROM — that value is gone once the row is overwritten, " +
      "and it is exactly what the undo needs",
  );
  // ASK THE HEADER, NOT THE FILE. `security definer` is a function ATTRIBUTE, so the only place it
  // can take effect is between `create ... function` and the `as $$` that opens the body. Searching
  // the whole file instead fails on a CORRECT migration — this one both explains in prose that it is
  // not a definer AND says so again inside a `comment on function` string literal, which is not a
  // `--` comment and survives any comment-stripping. Two earlier drafts of this assertion went red
  // on exactly that: a pin that pins the anti-pattern.
  const headers = [...migration.matchAll(/create or replace function[\s\S]*?as \$\$/g)].map((m) => m[0]);
  assert.equal(
    headers.length,
    2,
    "both function headers must be found — otherwise the check below is asking its question of " +
      "nothing at all and would pass on a file that IS security definer",
  );
  for (const header of headers) {
    assert.doesNotMatch(
      header,
      /security definer/i,
      "neither function may be SECURITY DEFINER — a definer function runs as the table OWNER, and " +
        "this repository has already been bitten by owner-privileged paths outranking a revoke",
    );
    assert.match(
      header,
      /set search_path = ''/,
      "each function pins an empty search_path and fully qualifies its tables, as the house style does",
    );
  }
  assert.match(
    migration,
    /200/,
    "the cap is repeated in SQL so it still holds for a caller that does not come through the route",
  );

  // ── 4. UNDO IS NOT BOUND BY THE DECISION VOCABULARY ───────────────────────────────────────────

  assert.match(
    service,
    /supabase\.rpc\("ats_revert_candidate_status"/,
    "undo has its own database function, restoring a per-row status",
  );
  const revertRoute = read("app/api/recruitment/candidates/revert-status/route.ts");
  assert.doesNotMatch(
    revertRoute,
    /bulkDecisionRefusal\(/,
    "the undo route must NOT ask the bulk-decision rule — that rule allows only shortlist and " +
      "reject, so asking it here would block restoring anyone to `new`, which is the entire backlog " +
      "case, and to `sent_to_manager`, which tells no lie because they really were sent",
  );
  assert.match(
    migration,
    /unnest\(p_candidate_ids, p_statuses, p_notes\)/,
    "the revert pairs three positional arrays, so each candidate goes back to its OWN status",
  );
  assert.match(
    migration,
    /A revert needs one status and one note per candidate/,
    "a length mismatch must be refused — pairing a candidate with somebody else's status is the one " +
      "failure here that would look completely ordinary afterwards",
  );

  // The bulk route, by contrast, MUST ask it — one sentence for the button, the service and the 400.
  const bulkRoute = read("app/api/recruitment/candidates/bulk-status/route.ts");
  assert.match(
    bulkRoute,
    /bulkDecisionRefusal\(status, ids\.length\)/,
    "the bulk route asks the shared refusal rather than restating the rule in a fourth wording",
  );

  // ── 5. THE VERDICT LANDS ONLY ON ROWS THE READER CAN SEE ──────────────────────────────────────

  const workstation = read("src/components/recruitment/workstation/screening-workstation.tsx");
  assert.match(
    workstation,
    /const markedVisible = useMemo\(\(\) => visible\.filter\(\(row\) => marked\.has\(row\.id\)\), \[marked, visible\]\)/,
    "the acted-on set is derived from the VISIBLE rows, never from every mark ever made",
  );
  assert.match(
    workstation,
    /const rows = markedVisible;/,
    "and the bulk call uses that derived set — a decision must never land on a candidate the list " +
      "in front of the reader is not showing",
  );
  // The count beside the button must come from the same place the action does, or the button lies.
  assert.match(
    workstation,
    /\{markedVisible\.length\} selected/,
    "the printed count is measured from the same set that will be decided",
  );

  // ── 6. REJECT IS NOT A KEYSTROKE ──────────────────────────────────────────────────────────────

  assert.match(
    workstation,
    /if \(key === "s" && canDecide && selected\)/,
    "shortlist is a keystroke — it asks for nothing today, which is what makes that safe",
  );
  assert.doesNotMatch(
    workstation,
    /key === "r"[\s\S]{0,200}decide\("rejected"/,
    "reject must NOT be bound to a bare key: the button opens a panel asking for a reason, and a " +
      "keystroke that skipped it would turn every rejection into an unexplained one",
  );
  // The keyboard must stand down while somebody is typing, or an "s" in the search box decides a CV.
  assert.match(
    workstation,
    /if \(typing \|\| event\.metaKey \|\| event\.ctrlKey \|\| event\.altKey\) return;/,
    "the keyboard is ignored while typing — the same rule the existing F-for-full-width handler uses",
  );

  // ── 7. THE TICK-BOX IS A SIBLING OF THE ROW, NEVER INSIDE IT ──────────────────────────────────
  //
  // A control nested inside another control is invalid HTML and behaves accordingly: the tick would
  // be swallowed by the row's own click and open the CV instead of selecting it.

  const list = read("src/components/recruitment/workstation/workstation-candidate-list.tsx");
  const rowBlock = list.slice(list.indexOf("{visible.map((row, index) =>"));
  const checkboxAt = rowBlock.indexOf('type="checkbox"');
  const blockAt = rowBlock.indexOf("<CandidateBlock");
  assert.ok(checkboxAt > 0 && blockAt > 0, "the list renders both a tick-box and the row");
  assert.ok(
    checkboxAt < blockAt,
    "the tick-box must be rendered BEFORE the row button and outside it — nesting one interactive " +
      "control in another is invalid HTML and the tick gets swallowed by the row's click",
  );
  assert.match(
    list,
    /onToggleMark: \(\(id: string\) => void\) \| null;/,
    "a reader who cannot decide gets no tick-box at all — forty disabled boxes advertising an " +
      "action nobody can take is furniture, not a permission model",
  );
}
