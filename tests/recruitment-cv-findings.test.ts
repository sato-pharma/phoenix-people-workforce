import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ROW_FINDING_KEYS, countRowFindings, rowFindingSchema } from "../src/lib/recruitment/cv-findings.ts";
import {
  emptyWorkQueueCounts,
  screeningWorkQueueDescriptions,
  screeningWorkQueueEmptyLabels,
  screeningWorkQueueLabels,
  screeningWorkQueues,
  workQueuesFor,
} from "../src/lib/recruitment/screening-queues.ts";
import type { WorkQueueInput } from "../src/lib/recruitment/screening-queues.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";

/**
 * "The CV reader found this and nobody wrote it down" — made visible, and given an address.
 *
 * ── THE GAP, MEASURED ───────────────────────────────────────────────────────────────────────────
 *
 * Production 2026-09-05: 581 of 582 live candidates have a parsed CV, and yet 204 carry no
 * `yearsExperience` while the extraction holds a good number, 109 the same for `nationalId`, 90 for
 * `currentJobTitle` — 271 candidates, 47% of the pool, with at least one.
 *
 * This is NOT an extraction failure and the fix is NOT to widen the gate. `cv-auto-apply.ts` writes
 * unattended only at `confidence: "high"`; `low` waits for a human, and that rule is correct — a
 * low-confidence guess overwriting a real answer is exactly what it exists to prevent. The gap is
 * that for a candidate created by automatic intake, no human ever SAW the proposal.
 *
 * ── WHAT THIS FILE HOLDS ────────────────────────────────────────────────────────────────────────
 *
 *   1. THE BADGE AND THE TAB CANNOT DISAGREE. Both count through `listUnappliedCvFields`; the badge
 *      merely passes a narrowed schema. Re-implementing "is this a real finding" for the row would
 *      reopen the split that function was written to close.
 *   2. THE PROJECTION AND THE KEY LIST CANNOT DRIFT. The select is BUILT from `ROW_FINDING_KEYS`. A
 *      key added to the list and forgotten in the select would be silently unread, and the badge
 *      would quietly stop counting it with nothing on screen to say so.
 *   3. A NEW QUEUE MUST BE COMPLETE. An exhaustive `Record` does not gate the build here —
 *      `ignoreBuildErrors` lets a missing key compile, build and deploy — so the maps are checked
 *      at runtime instead.
 */
export function runRecruitmentCvFindingsTests() {
  const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

  const candidate = (over: Partial<Candidate>) => ({ id: "c1", ...over }) as unknown as Candidate;
  const finding = (value: unknown, confidence: "high" | "low" = "low") =>
    ({ confidence, value }) as never;

  // ── 1 · THE NARROWED SCHEMA IS REAL, NOT INVENTED ─────────────────────────────────────────────

  assert.deepEqual(
    [...ROW_FINDING_KEYS],
    ["yearsExperience", "nationalId", "currentJobTitle"],
    "the three that change what the product DOES: queue order and role fit, the locked dedupe key, " +
      "and the field the fit band is read from",
  );
  assert.equal(
    rowFindingSchema.fields.length,
    ROW_FINDING_KEYS.length,
    "every checked key must resolve to a real field definition — a typo here would silently drop a " +
      "field from the badge, because filter() returns fewer rows rather than throwing",
  );
  for (const key of ROW_FINDING_KEYS) {
    assert.ok(
      rowFindingSchema.fields.some((field) => field.key === key),
      `${key} must exist in universalCvFields — the schema is filtered from it, never re-declared`,
    );
  }

  // ── 2 · THE COUNT ITSELF ──────────────────────────────────────────────────────────────────────

  assert.equal(countRowFindings(null, candidate({})), 0, "no extraction is no findings, not a crash");
  assert.equal(countRowFindings({}, candidate({})), 0, "an empty extraction proposes nothing");

  assert.equal(
    countRowFindings(
      { yearsExperience: finding(5.1), nationalId: finding("29001011234567") },
      candidate({ nationalId: null, yearsExperience: null }),
    ),
    2,
    "two findings against two empty columns is two",
  );

  // THE ONE THAT MATTERS MOST: a value already on the record is not owed. Counting it would give
  // every candidate a permanent badge that nothing could ever clear — the exact "nag that can never
  // reach zero" that cv-extraction-fields.ts guards against.
  assert.equal(
    countRowFindings(
      { yearsExperience: finding(5.1), nationalId: finding("29001011234567") },
      candidate({ nationalId: "29001011234567", yearsExperience: 5.1 }),
    ),
    0,
    "a finding the record already holds is not outstanding",
  );
  assert.equal(
    countRowFindings(
      { yearsExperience: finding(5.1), nationalId: finding("29001011234567") },
      candidate({ nationalId: null, yearsExperience: 5.1 }),
    ),
    1,
    "and the two are counted independently",
  );

  // Confidence does NOT decide whether it is outstanding — only whether auto-apply took it. A
  // high-confidence finding that nothing wrote is still owed to the record, and production holds
  // them: a re-extraction can raise confidence without re-running auto-apply.
  assert.equal(
    countRowFindings({ yearsExperience: finding(7, "high") }, candidate({ yearsExperience: null })),
    1,
    "a high-confidence finding nobody saved is still outstanding",
  );

  // A blank proposal is not a finding. Otherwise the badge fires on every candidate whose CV simply
  // did not mention a national ID, which is most of them.
  assert.equal(
    countRowFindings(
      { currentJobTitle: finding("   "), nationalId: finding(null) },
      candidate({ currentJobTitle: null, nationalId: null }),
    ),
    0,
    "an empty or blank proposal is not something a human can act on",
  );

  // A key outside the three is ignored by the row badge — that is the documented undercount, and it
  // is the safe direction: the badge points at a CV worth opening, the tab remains the authority.
  assert.equal(
    countRowFindings({ university: finding("Cairo University") }, candidate({})),
    0,
    "the badge checks only its three keys — the CV Data tab loads the whole extraction",
  );

  // ── 3 · THE PILE ──────────────────────────────────────────────────────────────────────────────

  const base: WorkQueueInput = {
    answeredAt: null,
    band: "other",
    duplicateCount: 1,
    interviewToday: false,
    redFlagged: false,
    sentToManagerAt: null,
    status: "shortlisted",
    unsavedFindings: 0,
  };

  assert.ok(
    !workQueuesFor(base).includes("unsaved_findings"),
    "a candidate with nothing outstanding is not in the pile",
  );
  assert.ok(
    workQueuesFor({ ...base, unsavedFindings: 2 }).includes("unsaved_findings"),
    "a candidate with outstanding findings is",
  );
  // Excluded for the same reason every other pile excludes them: saving a rejected candidate's job
  // title is not work waiting on anybody, and a pile padded with them stops being a work list.
  assert.ok(
    !workQueuesFor({ ...base, redFlagged: true, unsavedFindings: 2 }).includes("unsaved_findings"),
    "a red-flagged candidate is not in the pile even with findings outstanding",
  );

  // ── 4 · THE QUEUE IS COMPLETE, CHECKED AT RUNTIME ─────────────────────────────────────────────
  //
  // An exhaustive Record does NOT gate the build in this repo — `ignoreBuildErrors` lets a missing
  // key compile, build and deploy, and the rail would then render `undefined` as a heading.

  const counts = emptyWorkQueueCounts();
  for (const queue of screeningWorkQueues) {
    assert.equal(typeof screeningWorkQueueLabels[queue], "string", `${queue} needs a rail heading`);
    assert.ok(screeningWorkQueueLabels[queue].length > 0, `${queue}'s heading must not be blank`);
    assert.ok(screeningWorkQueueDescriptions[queue]?.length > 0, `${queue} needs a description`);
    assert.ok(screeningWorkQueueEmptyLabels[queue]?.length > 0, `${queue} needs its own empty sentence`);
    assert.equal(counts[queue], 0, `${queue} must be present in an empty tally, so no rail guards a missing key`);
  }
  assert.ok(
    screeningWorkQueues.includes("unsaved_findings"),
    "the new pile is registered in the queue vocabulary",
  );

  // ── 5 · THE PROJECTION CANNOT DRIFT FROM THE KEY LIST ─────────────────────────────────────────

  const service = read("src/lib/recruitment/candidates.ts");
  assert.match(
    service,
    /\.\.\.ROW_FINDING_KEYS\.map\(\(key\) => `\$\{key\}:extracted_fields->\$\{key\}`\)/,
    "the select must be BUILT from ROW_FINDING_KEYS — a hand-written list would let a key be added " +
      "to the badge and silently never read, and the badge would stop counting it with no symptom",
  );
  // And THIS function must not pull the whole blob: 1,549 kB against 105 kB, on every page load.
  //
  // Scoped to loadRowFindings, not to the file. `loadCvJobTitlesByCandidate` above it reads the
  // whole `extracted_fields` column on purpose and is right to — it is called with only the handful
  // of candidates the free evidence could not answer, which is the very reason a pool-wide read had
  // to be projected instead. A file-wide ban would fail on that correct code; the first draft of
  // this assertion did exactly that.
  const readerAt = service.indexOf("export async function loadRowFindings(");
  assert.ok(readerAt > 0, "loadRowFindings must exist — without it this check reads an empty string");
  // Ends at the first line that closes a top-level block, so the window is this function and
  // not everything after it.
  const readerEnd = service.indexOf(String.fromCharCode(10) + "}", readerAt);
  const readerBody = service.slice(readerAt, readerEnd > readerAt ? readerEnd : undefined);
  assert.ok(readerBody.length > 200, "the window must actually contain the function body");
  assert.doesNotMatch(
    readerBody,
    /extracted_fields"/,
    "the pool-wide read must project jsonb members, never select the whole extraction column",
  );
  // Two plain substrings, not one regex: the sentence is split across concatenated string
  // literals in the source, so a `.*` between them matches nothing and the check would fail on
  // correct code. It did, on the first run.
  assert.ok(
    service.includes("CV finding paging stopped at"),
    "the paged read must refuse a truncation rather than silently returning fewer candidates",
  );
  assert.ok(
    service.includes("would show no badge and"),
    "and must say WHY it refuses — a missing badge reads as 'nothing to do', the one wrong answer",
  );

  // ── 6 · THE SCREEN ────────────────────────────────────────────────────────────────────────────

  const list = read("src/components/recruitment/workstation/workstation-candidate-list.tsx");
  assert.match(list, /row\.unsavedFindings > 0/, "the row shows the badge only when something is owed");
  assert.match(list, /\{row\.unsavedFindings\} to save/, "and says how many");

  // ── 7 · AND STILL NO BULK APPLY ───────────────────────────────────────────────────────────────
  //
  // A "Save all N to the record" button was built for this phase and REMOVED before it shipped.
  //
  // The rule it would have broken is one this module set a phase earlier, with its reasoning
  // written down: these are the readings the extractor itself hedged on — cv-auto-apply declined
  // them precisely because it is not confident — so a control applying several at once is the
  // unattended write the confidence gate exists to prevent, wearing a button. Friction is not the
  // point; a human actually looking at each hedged value is.
  //
  // `nationalId` is what makes it more than a style preference. It feeds the LOCKED identity rule in
  // candidate-matching.ts, and a wrong one can make two different people look like one — the single
  // most expensive mistake available on this screen, and the one a save-all makes easiest to commit
  // without reading.
  //
  // What closes the measured gap is REACH, not speed of acceptance: the badge and the pile make the
  // 271 candidates findable, and each finding is still judged on its own.
  const workstation = read("src/components/recruitment/workstation/screening-workstation.tsx");
  assert.match(
    workstation,
    /const acceptReaderFinding = useCallback/,
    "the shell owns the write, one field at a time",
  );
  assert.match(
    workstation,
    /body: JSON\.stringify\(\{ \[fieldKey\]: value \}\)/,
    "one field per request — a payload of several fields is a bulk apply by another name",
  );
  assert.doesNotMatch(
    workstation,
    /acceptAllReaderFindings|applyAllExtraction|acceptReaderFindings/,
    "there is no bulk apply, under any spelling — the first attempt at this phase passed the older " +
      "check only because it happened to be named differently",
  );
  const intelligence = read("src/components/recruitment/workstation/workstation-intelligence.tsx");
  assert.doesNotMatch(
    intelligence,
    /onAcceptAll|Save all/,
    "and the CV Data tab offers no save-all control",
  );
  assert.match(
    intelligence,
    /Save this to the record/,
    "the per-field control is what remains, and it is the one that keeps a human on each hedged value",
  );
}
