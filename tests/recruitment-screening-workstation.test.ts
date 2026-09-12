import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { buildCandidateTimeline } from "../src/lib/recruitment/candidate-timeline.ts";
import type { CandidateScreeningFacts } from "../src/lib/recruitment/candidate-screening-facts.ts";
import {
  composeRejectionNote,
  isRejectionReason,
  rejectionReasonLabels,
  rejectionReasons,
} from "../src/lib/recruitment/rejection-reasons.ts";
import { CANDIDATE_STATUS_NOTE_MAX_LENGTH } from "../src/lib/recruitment/candidate-status.ts";
import { hiringTargetFamily, readRoleFit, roleFitVerdict } from "../src/lib/recruitment/role-fit.ts";
import {
  emptyWorkQueueCounts,
  isManagerFeedbackOverdue,
  tallyWorkQueues,
  workQueuesFor,
  type WorkQueueInput,
} from "../src/lib/recruitment/screening-queues.ts";
import { STALE_SEND_NUDGE_AFTER_DAYS } from "../src/lib/recruitment/stale-send-thresholds.ts";
import { vacancyPlaceLabel } from "../src/lib/recruitment/vacancy-applicants.ts";

/**
 * The screening REVIEW WORKSTATION — the rebuild of 2026-09-04.
 *
 * Screening was a filter bar over a full-screen one-CV-at-a-time session: you read a CV, you said
 * yes or no, you pressed next. Everything a recruiter actually decides with — which vacancy this is
 * for, what the CV reader extracted and how sure it was, what has already happened to this person,
 * whether a manager was asked and never replied, whether this is the same person twice — lived on
 * other screens, or on no screen at all.
 *
 * This file holds the rules that rebuild cannot lose. Four of them cost something real if they
 * regress, and each is its own section below:
 *
 *   1. The workstation is a CLIENT surface and the workspace loader reaches the service-role
 *      client. One value import across that line is a build failure at best and a service-role key
 *      shaped into a browser bundle at worst.
 *   2. A fit read is taken against the job being HIRED FOR, never against the candidate's own
 *      current title. Reading a district manager's CV as a district manager scores every candidate
 *      against themselves and comes back excellent every time.
 *   3. Rejecting writes a REASON into the existing note and deletes nothing.
 *   4. The timeline and the queues state only what is on the record. No fabricated events, no
 *      invented score, and "we do not know" is an answer that survives to the screen.
 *
 * Plus the owner's own instruction for this rebuild, in his words: "VERY IMPORTANT: NO ROUNDED
 * CORNERS." Section 6.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const WORKSTATION_DIR = "src/components/recruitment/workstation";

/**
 * `--phx-fs-4xs` … `--phx-fs-3xl` from `src/styles/tokens.css`, as numbers.
 *
 * Written out rather than parsed out of the CSS deliberately: a parser that silently matched nothing
 * would turn the check below into a loop over an empty set, which passes and proves nothing.
 */
const PHOENIX_FONT_LADDER = new Set([8, 9, 10, 11, 12, 13, 14, 15, 20, 26, 34]);

function workstationFiles(): string[] {
  return readdirSync(path.join(process.cwd(), WORKSTATION_DIR))
    .filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))
    .sort();
}

/**
 * Source with its comments removed.
 *
 * Sections 5 and 6 forbid two things these files EXPLAIN at length — a named font size and a
 * rounded corner — and a check that fails on the sentence describing the rule is a check somebody
 * deletes. The lesson is already written into this module once: the CV viewer's `transform: scale`
 * pin turned the required `validate` job red on its own head because it matched the paragraph
 * saying why the component does not use it.
 *
 * `//` is only treated as a comment when it does not follow a colon, so a `https://` inside a
 * string keeps the rest of its line.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** The 10 fields of a screening fact read, all absent. Each test sets only what it is about. */
function noFacts(): CandidateScreeningFacts {
  return {
    area: null,
    background: null,
    declaredExperience: null,
    employer: null,
    expectedSalary: null,
    governorate: null,
    pharmaRep: null,
    region: null,
    roleTitle: null,
    years: null,
  };
}

/** A work-queue input with nothing going on. Each test sets only the field it is about. */
function quietCandidate(): WorkQueueInput {
  return {
    answeredAt: null,
    band: "unknown",
    duplicateCount: 1,
    interviewToday: false,
    redFlagged: false,
    // Required on WorkQueueInput on purpose: a construction site that forgot it would put
    // nobody in the "CV data to save" pile, silently. These fixtures are not about that pile.
    unsavedFindings: 0,
    sentToManagerAt: null,
    status: "new",
  };
}

export async function runRecruitmentScreeningWorkstationTests() {
  // ── 1 · The client/server line ─────────────────────────────────────────────
  //
  // `screening-workspace.ts` calls `listCandidates`, which reaches the employee directory, which
  // reaches employee-photo, which ends at `node:crypto`. Every component in the workstation is
  // "use client". So the TYPES the client names live in `screening-workspace-types.ts`, which holds
  // no runtime import at all, and the loader re-exports them for the server pages.
  //
  // This is the same failure the screening PAGE hit in August — a client component importing one
  // pure helper from the loader dragged the whole chain into the browser bundle and webpack refused
  // the build outright. Under a bundler that tree-shakes it away in dev, the same mistake ships.
  const files = workstationFiles();
  assert.ok(files.length >= 8, "the workstation should be several components, not one file");

  for (const name of files) {
    const source = read(`${WORKSTATION_DIR}/${name}`);
    // The closing quote is what separates the LOADER from the pure types module beside it —
    // `screening-workspace-types` contains `screening-workspace` as a prefix.
    assert.doesNotMatch(
      source,
      /from "@\/lib\/recruitment\/screening-workspace"/,
      `${name} must import its types from screening-workspace-types, never from the loader`,
    );
    for (const forbidden of ["candidates", "db", "recruitment-db", "screening-queue", "screening-workspace"]) {
      assert.doesNotMatch(
        source,
        new RegExp(`^import \\{[^}]*\\} from "@/lib/recruitment/${forbidden}"`, "m"),
        `${name} must not take a VALUE import from ${forbidden} — it pulls the service-role client into the bundle`,
      );
    }
    assert.doesNotMatch(
      source,
      /from "@\/lib\/supabase/,
      `${name} must never reach a Supabase client — it renders in a browser`,
    );
  }

  // And the types module must STAY pure, or the split above quietly undoes itself. It may name the
  // option types the loader returns, but only as types.
  const workspaceTypes = read("src/lib/recruitment/screening-workspace-types.ts");
  for (const forbidden of ["candidates", "db", "screening-workspace", "vacancy-options", "hiring-manager-notify"]) {
    assert.doesNotMatch(
      workspaceTypes,
      new RegExp(`^import \\{[^}]*\\} from "@/lib/recruitment/${forbidden}"`, "m"),
      `screening-workspace-types must not take a value import from ${forbidden}`,
    );
  }
  assert.doesNotMatch(
    workspaceTypes,
    /from "@\/lib\/supabase/,
    "screening-workspace-types is imported by client components and must reach no database",
  );
  // The loader still answers for the server side, so the two halves cannot drift into two shapes.
  assert.match(
    read("src/lib/recruitment/screening-workspace.ts"),
    /export type \{[\s\S]*?\} from "@\/lib\/recruitment\/screening-workspace-types"/,
    "the loader must re-export the pure types rather than declaring a second copy of them",
  );

  // ── 2 · A fit read is taken against the JOB, never against the person ──────
  //
  // THE BUG THIS SECTION EXISTS FOR. `candidateScreeningRoleFamily` answers "what kind of person is
  // this" and therefore reads the candidate's own current title FIRST. Reading a fit against that
  // answer measures a district manager as a district manager — always an excellent one — and the
  // number stops meaning anything on exactly the CVs a recruiter most needs it for. So the fit
  // reads `hiringTargetFamily`, whose order is deliberately the opposite.
  const districtManagerFacts: CandidateScreeningFacts = {
    ...noFacts(),
    roleTitle: { confirmed: true, value: "District Sales Manager" },
  };
  assert.equal(
    hiringTargetFamily("Medical Representative", districtManagerFacts),
    "medical_rep",
    "a district manager applying to be a medical rep must be read against MEDICAL REP",
  );
  // The current title is the fallback, used only when nobody ever said what they applied for —
  // reading them against what they already do is the least wrong thing left, and the dimensions on
  // screen name the job they were read against either way.
  assert.equal(
    hiringTargetFamily(null, districtManagerFacts),
    "district_manager",
    "with no applied-for job on file, the current title is the fallback",
  );
  assert.equal(hiringTargetFamily(null, noFacts()), null, "nothing on file reads as no family, never as a guess");

  // The dimensions VARY BY ROLE, which is the other half of the same rule: a fixed set would mark
  // an excellent office coordinator down for never having sold a drug.
  const repFit = readRoleFit(districtManagerFacts, "medical_rep", "Medical Representative");
  const officeFit = readRoleFit(districtManagerFacts, "office_coordinator", "Office Coordinator");
  assert.ok(
    repFit.dimensions.some((dimension) => dimension.key === "pharma"),
    "pharma experience is the first question about a medical rep",
  );
  assert.ok(
    !officeFit.dimensions.some((dimension) => dimension.key === "pharma"),
    "an office coordinator must not be marked against pharma experience they were never asked for",
  );
  assert.equal(repFit.roleLabel, "Medical Representative", "the read must name the job it was taken against");

  // AN UNREADABLE CV SCORES NULL, NOT ZERO. "We know nothing about this person" and "this person is
  // a poor fit" are opposite findings, and one percentage cannot tell them apart. One answered
  // dimension out of five is not a 20%.
  const barelyKnown = readRoleFit({ ...noFacts(), roleTitle: { confirmed: false, value: "Pharmacist" } }, "medical_rep");
  assert.equal(barelyKnown.score, null, "too little on file must read as unread, never as a low score");
  assert.equal(roleFitVerdict(barelyKnown.score), "unread", "and the word beside it must say so");
  assert.ok(barelyKnown.unknownCount > 0, "the unknowns must be counted, so the score is never read as complete");

  // A CV with enough on it scores, and the arithmetic is met-over-ANSWERED — unknowns are excluded
  // from the denominator rather than counted as failures.
  const wellKnownRep = readRoleFit(
    {
      ...noFacts(),
      area: { confirmed: true, value: "Tanta" },
      background: { confirmed: true, value: "Pharmacy" },
      pharmaRep: { confirmed: true, value: true },
      roleTitle: { confirmed: true, value: "Medical Representative" },
      years: { confirmed: false, value: 6 },
    },
    "medical_rep",
  );
  assert.equal(wellKnownRep.score, 100, "five dimensions met out of five answered is 100");
  assert.equal(wellKnownRep.unknownCount, 0, "and nothing was left unread");
  assert.equal(roleFitVerdict(wellKnownRep.score), "strong");
  // The verdict bands, pinned so a threshold cannot drift silently under the word beside the number.
  assert.equal(roleFitVerdict(75), "strong");
  assert.equal(roleFitVerdict(74), "possible");
  assert.equal(roleFitVerdict(45), "possible");
  assert.equal(roleFitVerdict(44), "weak");

  // ── 3 · Rejecting records a REASON and deletes nothing ─────────────────────
  //
  // The reason composes into the note the status route already stores, so this shipped without a
  // migration and every rejection already on file keeps reading exactly as it did.
  assert.equal(rejectionReasons.length, 10, "the ten standard reasons the owner listed");
  for (const reason of rejectionReasons) {
    assert.ok(isRejectionReason(reason));
    assert.ok(rejectionReasonLabels[reason].length > 0, `${reason} must have words a person would say out loud`);
  }
  assert.ok(!isRejectionReason("made_up_reason"), "an unknown reason must not pass the guard");

  assert.equal(composeRejectionNote("experience_mismatch"), "Experience mismatch");
  assert.equal(
    composeRejectionNote("experience_mismatch", "  only 4 months in the field  "),
    "Experience mismatch — only 4 months in the field",
  );
  // "Other" with nothing typed says nothing at all, so it stores nothing rather than the word.
  assert.equal(composeRejectionNote("other"), null, "a bare Other must not write the word Other into the history");
  assert.equal(composeRejectionNote("other", "   "), null, "whitespace is nothing typed");
  assert.equal(composeRejectionNote("other", "asked for double the band"), "asked for double the band");

  // TRUNCATES RATHER THAN REFUSING. The column caps at 300 and the route rejects anything longer, so
  // a recruiter who typed a long explanation would otherwise lose the whole DECISION to a validation
  // error at the moment they pressed the button.
  const long = composeRejectionNote("location_mismatch", "x".repeat(500));
  assert.ok(long !== null);
  assert.equal(long.length, CANDIDATE_STATUS_NOTE_MAX_LENGTH, "a long note is cut to the column, never refused");
  assert.ok(long.startsWith("Location mismatch — "), "and the standard reason survives the cut, because it is the countable half");

  // ── 4 · The work queues, which are counts of a pile and not a partition ────
  //
  // A candidate can be in several at once. A brand-new medical rep CV is genuinely both "nobody has
  // read this" and "worth reading first", and forcing one home per row would make one of those two
  // rails lie about its own size.
  const freshRep: WorkQueueInput = { ...quietCandidate(), band: "field_force" };
  const queues = workQueuesFor(freshRep);
  assert.ok(queues.includes("new") && queues.includes("recommended"), "a new field-force CV is in both piles");
  assert.ok(queues.includes("all"), "everything is in `all`");

  // Red-flagged rows are out of the piles that mean "worth your time". A rejected candidate, or one
  // whose CV states a nationality the company cannot hire, is not first review required — somebody
  // already answered.
  const redFlagged = workQueuesFor({ ...freshRep, redFlagged: true });
  assert.ok(!redFlagged.includes("new") && !redFlagged.includes("recommended"), "a red-flagged CV is in neither pile");

  // Shortlisted stays in `recommended` on purpose: a CV shortlisted but not yet sent is still a
  // recommendation waiting to be acted on, and dropping it the moment somebody agreed with it would
  // empty the pile of exactly the people it exists to surface.
  assert.ok(
    workQueuesFor({ ...freshRep, status: "shortlisted" }).includes("recommended"),
    "shortlisted but not sent is still a live recommendation",
  );

  // Manager feedback is keyed on the SEND and the ANSWER, never on the status: production carries
  // sends whose status was later moved by hand, and a pile that empties because somebody re-labelled
  // a row is a pile that loses the candidate it was tracking.
  const now = new Date("2026-09-04T09:00:00.000Z");
  const sentDaysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const waiting: WorkQueueInput = { ...quietCandidate(), sentToManagerAt: sentDaysAgo(4) };
  assert.ok(workQueuesFor(waiting).includes("manager_feedback"), "sent with no answer is pending feedback");
  assert.ok(
    !workQueuesFor({ ...waiting, answeredAt: sentDaysAgo(1) }).includes("manager_feedback"),
    "once somebody answered, it leaves the pile",
  );

  // Overdue reads the SAME threshold the nightly stale-send check nudges on — imported, never a
  // second copy of the number. The owner set three days himself on 2026-08-28.
  assert.equal(STALE_SEND_NUDGE_AFTER_DAYS, 3, "the threshold the owner set, and the one the nightly check uses");
  assert.ok(isManagerFeedbackOverdue({ ...quietCandidate(), sentToManagerAt: sentDaysAgo(3) }, now), "3 days is overdue");
  assert.ok(
    !isManagerFeedbackOverdue({ ...quietCandidate(), sentToManagerAt: sentDaysAgo(2) }, now),
    "2 days is still in flight, not overdue",
  );
  assert.ok(
    !isManagerFeedbackOverdue({ ...quietCandidate(), answeredAt: sentDaysAgo(1), sentToManagerAt: sentDaysAgo(9) }, now),
    "an answered send is never overdue, however long it took",
  );

  assert.ok(workQueuesFor({ ...quietCandidate(), duplicateCount: 2 }).includes("duplicates"), "two records, one person");
  assert.ok(!workQueuesFor(quietCandidate()).includes("duplicates"), "one record is not a duplicate");
  assert.ok(workQueuesFor({ ...quietCandidate(), interviewToday: true }).includes("interviews"));

  // The tally reports the overdue figure BESIDE the pending count rather than replacing it: "12
  // pending, 4 of them overdue" is two facts a recruiter acts on differently.
  const tally = tallyWorkQueues(
    [freshRep, waiting, { ...quietCandidate(), duplicateCount: 3 }],
    (item) => item,
    now,
  );
  assert.equal(tally.counts.all, 3, "every row is in `all`");
  assert.equal(tally.counts.manager_feedback, 1);
  assert.equal(tally.overdueManagerFeedback, 1, "the 4-day-old send is overdue");
  assert.equal(tally.counts.duplicates, 1);
  // An empty tally still carries every key, so a rail never has to guard a missing one.
  for (const [queue, count] of Object.entries(emptyWorkQueueCounts())) {
    assert.equal(count, 0, `${queue} starts at zero rather than undefined`);
  }

  // ── 5 · Nothing on these screens is fabricated ─────────────────────────────
  //
  // Every timeline line comes from a stored timestamp. A candidate whose record is thin gets a
  // SHORT timeline, not a plausible one.
  assert.deepEqual(buildCandidateTimeline({}), [], "no sources means no events, never a plausible history");

  const timeline = buildCandidateTimeline({
    comments: [
      {
        authorHrId: "a-12",
        authorJobTitle: "Talent Acquisition Specialist",
        authorName: "Rasha",
        body: "Called her, available to start in October.",
        candidateId: "c-1",
        createdAt: "2026-09-02T08:00:00.000Z",
        id: "note-1",
      },
    ],
    createdAt: "2026-08-30T06:00:00.000Z",
    source: "WhatsApp",
  });
  assert.equal(timeline.length, 2, "two stored facts make two lines — no more");
  // NEWEST FIRST: the question this tab is opened with is "where are we now". The arrival five weeks
  // ago is context; yesterday's note is the answer.
  assert.equal(timeline[0]?.kind, "note", "the newest event leads");
  assert.equal(timeline[1]?.kind, "arrival", "and the arrival is last");
  assert.ok(timeline.every((event) => Date.parse(event.at) > 0), "every line carries a real stored instant");

  // A vacancy is named the way a recruiter reads it — the place and the line, never a raw id.
  assert.equal(vacancyPlaceLabel({ areaName: "Tanta", lineName: "CNS", regionName: "Delta (1)" }), "Tanta · CNS");
  assert.equal(
    vacancyPlaceLabel({ areaName: "Tanta", lineName: null, regionName: "Delta (1)" }),
    "Tanta · Delta (1)",
    "with no line on the seat, the region is what places it",
  );
  assert.equal(vacancyPlaceLabel({ areaName: null, lineName: null, regionName: null }), "", "nothing known says nothing");

  // ── 6 · The owner's two house rules for this rebuild ───────────────────────
  //
  // "DO NOT use rounded corners. Phoenix should remain sharp, structured, corporate, and
  // enterprise-grade." His words, twice, specifying this screen. Checked against source with the
  // comments stripped, so the files may keep explaining the rule.
  for (const name of files) {
    const code = withoutComments(read(`${WORKSTATION_DIR}/${name}`));
    assert.doesNotMatch(
      code,
      /\brounded(-[a-z0-9]+)*\b/,
      `${name} must carry no rounded corner — the owner asked for square, twice, in the words of this rebuild`,
    );
    // AND THE FONT-SIZE TRAP. `cn()` runs tailwind-merge, which silently DROPS a custom named font
    // size — `text-phx-xs` compiles away to nothing and the element falls back to the inherited
    // size, visible only through getComputedStyle in a real browser. The literal `text-[12px]` form
    // was always safe; naming the size is what creates the bug.
    assert.doesNotMatch(
      code,
      /text-phx-(4xs|3xs|2xs|xs|sm|md|base|lg|xl|2xl|3xl)\b/,
      `${name} must write font sizes as text-[12px] — tailwind-merge silently drops the named ones`,
    );
    // AND THE OTHER HALF OF THAT RULE, which the check above cannot see: writing a size as a literal
    // is only safe if the literal is a step of the PHOENIX LADDER. `text-[17px]` compiles perfectly
    // and ships a size the product does not have — the exact way a folder built out of bracket sizes
    // drifts off the design system while every check stays green.
    for (const size of code.matchAll(/text-\[(\d+)px\]/g)) {
      assert.ok(
        PHOENIX_FONT_LADDER.has(Number(size[1])),
        `${name} sets ${size[0]}, which is no step of --phx-fs-* in src/styles/tokens.css — the ` +
          `ladder is ${[...PHOENIX_FONT_LADDER].join(", ")}`,
      );
    }
  }

  // Every foldable block keys its memory to the BLOCK, never to a candidate. A key holding an id
  // would make the fold reset on every person — the one behaviour folding exists to avoid — and
  // would leak an unbounded number of entries into the module-level map over a screening session.
  for (const name of files) {
    const code = withoutComments(read(`${WORKSTATION_DIR}/${name}`));
    for (const key of code.matchAll(/storageKey=\{?["`]([^"`]*)/g)) {
      assert.doesNotMatch(
        key[1],
        /\$\{(candidate|selected|row|id)/i,
        `${name} keys a fold to ${key[1]} — a fold keyed to a candidate reopens on every candidate`,
      );
    }
  }

  // ── 7 · Both shells render the workstation, and neither lost its gate ──────
  //
  // The portal twin is not optional: app/(admin)/layout.tsx redirects portal-shell roles out of the
  // whole (admin) group before any page in it renders, so an admin-only rebuild would be dead for
  // Talent Acquisition — the role that screens the most CVs.
  for (const [name, source] of [
    ["admin", read("app/(admin)/recruitment/screening/page.tsx")],
    ["portal", read("app/employee-portals/recruitment/screening/page.tsx")],
  ] as const) {
    assert.match(
      source,
      /import \{ WorkstationPageClient \} from "@\/components\/recruitment\/workstation\/workstation-page-client"/,
      `the ${name} screening route must render the workstation`,
    );
    assert.match(
      source,
      /rows=\{workspace\.rows\}/,
      `the ${name} screening route must hand over the loaded rows`,
    );
    // The vacancy rail and the work queue are the two AREAS the rebuild added. Both are server-fed,
    // and a shell that forgets one renders an empty rail rather than an error.
    for (const prop of ["counts", "vacancies", "vacancyStats", "hiringManagers", "overdueManagerFeedback"]) {
      assert.match(
        source,
        new RegExp(`${prop}=\\{workspace\\.${prop}\\}`),
        `the ${name} screening route must pass ${prop} through, or that rail is dead in this shell`,
      );
    }
  }

  // ── 8 · The CV is not behind a modal, and it is not re-implemented ─────────
  //
  // The point of the rebuild: the document being judged is the largest thing on the screen and is
  // never a click away. And it is rendered by the EXISTING viewer — pdf.js rasterising multi-page
  // PDFs, docx-preview painting real Word layout, photographed CVs as zoomable images, fit-to-width
  // that re-measures on resize. A second copy of that would fork six months of production lessons.
  const cvPane = read(`${WORKSTATION_DIR}/workstation-cv-pane.tsx`);
  assert.match(
    cvPane,
    /import \{ CvDocumentView \} from "@\/components\/recruitment\/cv-preview-modal"/,
    "the CV pane must reuse the existing viewer rather than reimplementing PDF and docx rendering",
  );
  const shell = read(`${WORKSTATION_DIR}/screening-workstation.tsx`);
  assert.match(shell, /WorkstationCvPane/, "the CV pane belongs in the workspace, not in a dialog");
  // The CV reader's verdict is shown as a verdict, never as a reason to hide the document: a scanned
  // certificate and a photographed CV look alike to it, so a person still decides.
  assert.match(cvPane, /notACv && file \?/, "a document judged 'not a CV' is still SHOWN, with the warning above it");

  // ── 9 · Notes are the EXISTING notes ───────────────────────────────────────
  //
  // `ats_candidate_comments` — the same rows a hiring manager writes on their own screen and the
  // same rows the timeline reads. No separate recruiter store, so nothing already written became
  // invisible when this screen replaced the old one.
  const notesRoute = read("app/api/recruitment/candidates/[id]/notes/route.ts");
  assert.match(notesRoute, /addCandidateComment/, "the note box must write through the existing comment store");
  assert.match(
    notesRoute,
    /assertSameOriginMutation/,
    "a note is a mutation and carries the same CSRF guard as every other write in this module",
  );
  assert.match(
    notesRoute,
    /"recruitment", "update"/,
    "writing a note requires the same grant the send route enforces",
  );
  assert.match(
    read("app/api/recruitment/candidates/[id]/timeline/route.ts"),
    /"candidates", "read"/,
    "reading a candidate's history requires the candidate read grant",
  );

  // ── 10 · The two panes never describe two different people ────────────────
  //
  // `selectedId` is REMEMBERED state; it survives a filter that removes the person it names. The
  // middle pane keys off `selected` — the row, looked up in the current result set — so it correctly
  // fell back to "nothing is selected", while the intelligence panel keyed off `selectedId` and kept
  // rendering that candidate's name, role fit and briefing out of the profile cache. Found in the
  // browser: filtering to "only ones I have read" emptied the list and left one man's 100/100 verdict
  // standing beside an empty middle pane, which reads as a judgement on nobody rather than as stale
  // state. Both panes now key off the ROW, so they go blank together.
  const workstationShell = read("src/components/recruitment/workstation/screening-workstation.tsx");
  assert.match(
    workstationShell,
    /const activeId = selected\?\.id \?\? null;/,
    "the panel's candidate must be derived from the live ROW, never from the remembered id",
  );
  assert.doesNotMatch(
    withoutComments(workstationShell),
    /const entry = selectedId \? loaded\[selectedId\]/,
    "keying `entry` off `selectedId` shows a dropped-out candidate's intelligence beside an empty CV pane",
  );
  assert.doesNotMatch(
    withoutComments(workstationShell),
    /loading=\{Boolean\(selectedId\)/,
    "and keying the panel's loading state off `selectedId` spins forever once that row is filtered away",
  );

  // ── 11 · Every bar and every pane folds, and one control folds them all ──────
  //
  // The owner's words, verbatim: "you must guarantee that every every section or every bar is
  // collapsible. Because I need the full screen to see the CV in." There were four bars that could
  // not fold — the page's toolbar, the filter bar, the small-screen pane switcher and the decision
  // bar — and folding the three panes one at a time still cost three presses and left three spines.
  //
  // WHY THIS IS PINNED RATHER THAN LEFT TO THE EYE: a fold is one boolean per bar, so the failure
  // mode is not a broken screen, it is a bar that quietly stops answering the control beside it
  // while everything still renders. Nothing in a typecheck or a lint run can see that.
  const pageClient = read("src/components/recruitment/workstation/workstation-page-client.tsx");
  const reviewHeader = read("src/components/recruitment/workstation/workstation-review-header.tsx");
  const bare = withoutComments(workstationShell);

  // The page owns focus, because the two bars it draws have to fold with the panes below them.
  assert.match(
    withoutComments(pageClient),
    /const \[focus, setFocus\] = useState\(false\)/,
    "the focus flag must live on the page, which is the only common parent of the filter bar and the panes",
  );
  // ── The page opens on the work, not on its own controls ──────────────────────────────────────
  //
  // The owner, 2026-09-12: the page "looks crowded and noisy". Measured on his own window, 276px of
  // this page's own chrome — 30% of a 910px viewport — stood above the first candidate's name, and
  // the largest single piece of it was a filter bar that opened itself on every load. It starts
  // CLOSED now, which is pinned here because the default is one word: a later session reading the
  // old comment would put it back without ever seeing this measurement.
  assert.match(
    withoutComments(pageClient),
    /function filtersClosedOnServer\(\): boolean \{\s+return false;/,
    "the filter bar starts closed — eight dropdowns are not what this page is opened to read",
  );
  // REMEMBERED, or closing it becomes a chore repeated on every load. In the BROWSER and not in the
  // URL: the URL carries WHICH filters are on and is the shareable half, so a pasted screening link
  // must not prise the other screener's bar open.
  assert.match(
    withoutComments(pageClient),
    /useSyncExternalStore\(\s+subscribeFiltersOpen,\s+readRememberedFiltersOpen,\s+filtersClosedOnServer,\s+\)/,
    "a reader who opens the bar finds it open next time",
  );
  assert.match(
    withoutComments(pageClient),
    /rememberFiltersOpen\(!filtersOpen\)/,
    "and the toggle is what records that, rather than an effect that also fires on the first paint",
  );

  // ── A FILTER THAT UNDOES YOUR CHOICE READS AS A BROKEN FILTER ───────────────────────────
  //
  // The owner, 2026-09-12: "the filters are not working" — every symptom, in the seat view and in
  // the pool. Every filter was in fact correct: measured against the live pool the same morning,
  // status=new returned 161 of 607, received=day 9, role=medical_rep 72, and seat 369 narrowed to
  // 10 and then to 9 under status=new. What was broken was the answering.
  //
  // Each `<select>` is controlled by the value the SERVER last sent, and each change is a full
  // round trip taking 5 to 12 seconds. So the dropdown snapped back to its old value the instant it
  // was clicked, the list sat still, and nothing said the page had heard anything. Two pins, because
  // the fix has two halves and either one alone still reads as broken.
  assert.match(
    withoutComments(pageClient),
    /const \[shown, showImmediately\] = useOptimistic\(/,
    "the dropdown must show what was just picked, not what the server last answered",
  );
  assert.match(
    withoutComments(pageClient),
    /startTransition\(\(\) => \{\s+showImmediately\(next\);\s+router\.push\(href\);\s+\}\)/,
    "and inside the same transition as the navigation, or React drops it on the next render",
  );
  assert.match(
    withoutComments(pageClient),
    /pending=\{pending\}/,
    "and the bar has to say the list is on its way — silence for 12 seconds is what a dead control looks like",
  );
  // Read from the optimistic values, or the folded bar's own count lags the click by the same
  // seconds — which is the half of this the reader sees when the bar is shut.
  assert.match(
    withoutComments(pageClient),
    /const activeFilters = \[\s+shown\.area,/,
    "the folded bar counts what was picked, not what has arrived",
  );
  // NOT an effect that seeds state. `useEffect(() => setFiltersOpen(true), [])` reads correctly and
  // costs a whole second render of the screening page to do it; the React compiler lint calls it out
  // by name (set-state-in-effect) and CI went red on exactly this on 2026-09-12. The store version
  // has the same server-safe behaviour without the extra pass, so the effect must not come back.
  assert.doesNotMatch(
    withoutComments(pageClient),
    /setFiltersOpen/,
    "the preference is read from the store, never poured into state by an effect",
  );
  // localStorage THROWS rather than returning null where a browser blocks site data, so every read
  // and every write is wrapped — an unguarded one would white-screen the whole screening page over a
  // view preference.
  assert.match(
    withoutComments(pageClient),
    /window\.localStorage\.getItem\(FILTERS_OPEN_KEY\)/,
    "the preference is read from this browser",
  );
  assert.match(
    withoutComments(pageClient),
    /\{focus \|\| fullBleed \|\| !filtersOpen \? null : \(/,
    "the filter bar must answer its own fold, focus AND full bleed",
  );
  assert.match(
    withoutComments(pageClient),
    /focus=\{focus\}/,
    "and the workstation has to be told, or the panes stay put while the bars above them go",
  );

  // ONE TREE. Full bleed was an early return into a different element tree, so React unmounted the
  // whole workstation on the way in and out: selection back to row one, every loaded profile thrown
  // away, the open CV re-fetched. Focus turns full bleed on, so that reset would have landed on the
  // one press this change exists to make good.
  assert.doesNotMatch(
    withoutComments(pageClient),
    /if \(fullBleed\) \{\s*return \(/,
    "full bleed must be a class on the one container, never a second tree the workstation remounts into",
  );

  // Three panes, three flags, one override — and leaving focus must restore what was open before,
  // which is only true while focus OVERRIDES the flags instead of writing into them.
  for (const flag of ["showRail = railOpen && !focus", "showList = listOpen && !focus", "showPanel = panelOpen && !focus"]) {
    assert.ok(
      bare.includes("const " + flag),
      "focus must override the pane flag rather than write into it: " + flag,
    );
  }
  for (const setter of ["setRailOpen(false)", "setListOpen(false)", "setPanelOpen(false)"]) {
    assert.ok(bare.includes(setter), "every pane needs its own fold control: " + setter);
  }
  assert.match(
    bare,
    /focus \? "hidden" : "flex"/,
    "the small-screen queue/pane-switcher bar is a bar too, and folds with the rest",
  );

  // The decision bar. It used to be the one band on the screen that could not be folded, said so
  // in a comment, and that is exactly what the owner asked to change.
  assert.match(
    withoutComments(reviewHeader),
    /const \[actionsOpen, toggleActions\] = useSectionFold\("review:actions"\)/,
    "the decision bar folds, and remembers the answer down the list like every other section",
  );
  assert.match(
    withoutComments(reviewHeader),
    /\{actionsOpen \? \(\s+<div className="flex flex-wrap items-center gap-1\.5 border-t border-phx-line bg-phx-surface-2/,
    "and the fold has to gate the BAND itself, not merely appear in its own toggle's label",
  );
  assert.doesNotMatch(
    reviewHeader,
    /the decision bar below it never does/,
    "the comment that says it never folds has to go with the behaviour it described",
  );

  // In focus the two bands become ONE line, and the way back out is on it. A focus mode a reader
  // cannot leave from the screen he is looking at is a trap, not a feature.
  assert.match(
    withoutComments(reviewHeader),
    /if \(focus\) \{/,
    "focus collapses the identity and decision bands into a single strip",
  );
  assert.match(
    reviewHeader,
    /aria-label="Leave full-screen reading"/,
    "and that strip carries the way back out",
  );

  // ── 12 · The panel's own summary block is square, like everything around it ───
  //
  // `CandidateFactsSummary` is SHARED with two older screens, so it kept its rounded slate card and
  // drew it inside the workstation's square, bordered section — a rounded rectangle in the middle of
  // a corporate grid, against the owner's standing "no rounded corners" rule. The frame is now a
  // prop: the older screens keep the card, the workstation asks for nothing at all.
  const factsSummary = read("src/components/recruitment/candidate-facts-summary.tsx");
  assert.match(
    withoutComments(factsSummary),
    /frame = "card"/,
    "the default frame must stay the card, so the two screens outside this rebuild do not move",
  );
  assert.match(
    withoutComments(read("src/components/recruitment/workstation/workstation-intelligence.tsx")),
    /frame="flat"/,
    "and the workstation asks for the unframed one",
  );
  assert.doesNotMatch(
    withoutComments(factsSummary),
    /flat \? "[^"]*rounded/,
    "the flat frame must not round anything",
  );

  // ── 13 · The two things that made the list read as noise ────────────
  //
  // The owner, looking at the screen: "It is very noisy … you must apply in it our rules."
  // Two of the things making it noisy were rule breaches rather than taste:
  //
  //   1. `source` was printed straight out of the column — forty rows reading "whatsapp". The
  //      standing rule is human-readable names, never raw codes, and a label for exactly this
  //      value already existed in the CV digest, applied there and nowhere else.
  //   2. The band was printed on EVERY row. The list is ordered BY band, so the same three words
  //      repeat down the whole queue and say nothing — it is only information where it CHANGES.
  //
  // Both are pinned because both are invisible to a typecheck: a raw code and a labelled one are
  // the same string type, and a band on every row renders perfectly.
  const { intakeSourceLabel } = await import("@/lib/recruitment/intake-source");
  assert.equal(intakeSourceLabel("whatsapp"), "WhatsApp", "the channel is written the way a person writes it");
  assert.equal(intakeSourceLabel("email"), "Email", "and so is the other one");
  assert.equal(intakeSourceLabel(null), "", "nothing recorded stays nothing, never the word null");
  assert.equal(
    intakeSourceLabel("careers fair"),
    "careers fair",
    "an unrecognised value is somebody's own word and is kept verbatim, never folded into 'other'",
  );

  const workspaceLoader = read("src/lib/recruitment/screening-workspace.ts");
  assert.match(
    withoutComments(workspaceLoader),
    /source: intakeSourceLabel\(/,
    "the screening row must carry the label, not the stored code",
  );
  assert.doesNotMatch(
    withoutComments(read("src/lib/recruitment/inbound/daily-cv-digest.ts")),
    /const SOURCE_LABELS/,
    "and the digest's private copy of the map has to be gone, or the two drift apart again",
  );

  const listSource = withoutComments(read("src/components/recruitment/workstation/workstation-candidate-list.tsx"));
  assert.match(
    listSource,
    /const showBand = index === 0 \|\| visible\[index - 1\]\.band !== row\.band;/,
    "the band prints on the first row of each group and nowhere else",
  );
  // MOVED OUT OF THE CARD ON 2026-09-12. It was a prop on CandidateBlock and drew at the BOTTOM of
  // the first card in the group, which reads as a caption on that one candidate rather than as the
  // name of the group they open. A group heading is a heading: it is now the list's own element,
  // full width, above the row — which also means it spans the bulk-decision tick-box column instead
  // of starting to the right of it. The regex pins the heading to the list level: a `showBand` prop
  // handed back to the card would not match it.
  assert.match(
    listSource,
    /\{showBand \? \(\s+<span className="block border-b border-phx-line bg-phx-surface-2 px-3 py-1 text-\[10px\]/,
    "and the flag has to gate the band itself, not merely exist",
  );
  assert.doesNotMatch(
    listSource,
    /showBand=\{/,
    "the band is the list's heading, not something the card is told to draw",
  );

  // A folded pane and the spine that brings it back must call the pane the same thing. The list's
  // heading is the QUEUE it is showing, so the control built from it read "Fold the new cvs pane
  // away" while the spine said "Candidates" — one pane, two names, one of them reading like a typo.
  const uiSource = withoutComments(read("src/components/recruitment/workstation/workstation-ui.tsx"));
  assert.match(uiSource, /const foldName = \(foldLabel \?\? title\)\.toLowerCase\(\)/, "the fold control can be given the pane's own name");
  assert.doesNotMatch(uiSource, /Fold the \$\{title\.toLowerCase\(\)\}/, "and must no longer build that name out of the heading");
  assert.match(listSource, /foldLabel="candidates"/, "the list names itself the way its spine does");

  // ── The red-flagged pile, and the two the rail must NOT count ─────────────────────────────────
  //
  // red-flag.ts exists because the owner's complaint was that CVs he cannot hire sit mixed in among
  // the ones he can, and the candidate pool answers it with a two-tab split. The rail never got one:
  // 97 of 597 rows on 2026-09-05 — 96 rejected, 24 stating a nationality we cannot hire — were kept
  // out of New / Recommended / Duplicates and then left unsorted in "Everyone", the one pile a
  // recruiter searches.
  {
    const base: WorkQueueInput = {
      answeredAt: null,
      band: "field_force",
      duplicateCount: 1,
      interviewToday: false,
      redFlagged: false,
      unsavedFindings: 0,
      sentToManagerAt: null,
      status: "new",
    };
    assert.ok(!workQueuesFor(base).includes("red_flagged"), "an ordinary CV is not in the red pile");
    const red = workQueuesFor({ ...base, redFlagged: true });
    assert.ok(red.includes("red_flagged"), "a red-flagged CV has its own pile");
    // Still counted, still reachable — the pool's own words about its red tab.
    assert.ok(red.includes("all"), "and it stays in Everyone, fully visible and fully counted");
    // And still out of the piles that mean work, which is the behaviour that already existed.
    assert.ok(!red.includes("new"), "a CV nobody can hire is not first review required");
    assert.ok(!red.includes("recommended"), "nor recommended");
  }

  const railSource = read("src/components/recruitment/workstation/workstation-queue-panel.tsx");
  // The folded rail reports ONE number, and it must mean "waiting on me". Counting 97 unhireable
  // CVs into it would make the only figure a folded rail shows meaningless.
  assert.match(
    railSource,
    /NOT_WAITING_ON_ANYBODY: readonly ScreeningWorkQueue\[\] = \["red_flagged"\]/,
    "the red pile is not work waiting on the reader, so it is not in the folded total",
  );
  // A PILE THAT CAN NEVER FILL teaches the eye to skip the rail. "Interviews today" has read 0 since
  // it shipped and structurally: one interview row has ever existed in production and none carries a
  // scheduled_at. Hidden while empty rather than deleted, so it returns by itself the day one is
  // booked — the classifier still computes it.
  assert.match(
    railSource,
    /key !== "interviews" \|\| counts\.interviews > 0/,
    "an empty interviews pile is hidden, not deleted",
  );

  // ── Is the backlog growing? The question no number on the page could answer ───────────────────
  const pageSource = read("src/components/recruitment/workstation/workstation-page-client.tsx");
  // Renamed from ThroughputStrip on 2026-09-12: the strip stopped being a strip. It is now three
  // figures sitting inside the page header beside the title, because a full-width band of its own
  // was one of the three stacked bars that pushed the first candidate's name 276px down the page.
  assert.match(pageSource, /function BacklogFigures\(/, "the page must say whether the reader is keeping up");
  // IN AGAINST OUT — the difference is still the answer, but the arithmetic moved out of the
  // component into candidate-throughput.ts on 2026-09-05, when the strip became a four-week trend.
  // It had to move: the counting it used to do was measured wrong in both directions against the
  // real decision history, and a trend built on that draws a confident line out of an artefact.
  const trendSource = read("src/lib/recruitment/candidate-throughput.ts");
  assert.match(
    trendSource,
    /bucket\.arrived - bucket\.decided/,
    "in against out — the difference is the answer",
  );
  assert.match(
    pageSource,
    /throughputDirection\(throughput\)/,
    "and the strip asks for that difference rather than recomputing it beside the module that owns it",
  );
  // THREE FIGURES, NOT SIX, AND NO BAND OF ITS OWN — 2026-09-12. The strip shipped as a bordered
  // band above the toolbar carrying the pool, the unread, two in-against-out spans and a direction,
  // and the spans rendered as "this week 220 in 300 decided -80": a sentence nobody reads at a
  // glance, in a band that pushed the first candidate's name down the page. The question it exists
  // to answer is unchanged; what is gone is the half of it that was never legible.
  assert.doesNotMatch(
    pageSource,
    /function Span\(/,
    "the in-against-out pair is gone — the direction is the readable half and it stayed",
  );

  // ── The candidate card: what a scanning eye needs, and nothing else ───────────────────────────
  //
  // Nine things printed on every one of forty cards. Four went, and none of them are lost: a "New"
  // pill on a queue of new CVs is forty identical pills, and the arrival, the source and (in seat
  // mode) the place all print in the review header the moment the card is opened.
  const cardSource = withoutComments(read("src/components/recruitment/workstation/workstation-candidate-list.tsx"));
  assert.match(
    cardSource,
    /const hasMeta =/,
    "the second line knows whether it has anything to say, so an empty one is never drawn",
  );
  assert.match(
    cardSource,
    /\{decided \|\| status !== "new" \? \(/,
    "a status pill prints only when it is not the default",
  );
  assert.match(
    cardSource,
    /\{row\.locationLabel && !row\.seatReason \? \(/,
    "and the place is not printed twice where the seat reason above already names it",
  );
  assert.doesNotMatch(
    cardSource,
    /\{row\.source \? <span/,
    "the source belongs to the opened card — it is in the review header",
  );
  assert.doesNotMatch(
    cardSource,
    /relativeDays\(row\.createdAt\)/,
    "so does the arrival — the review header prints 'Arrived ...' on the card that opens",
  );
  const headerSource = read("src/components/recruitment/workstation/workstation-review-header.tsx");
  // THE PAIR IS THE POINT: cutting them from the card is only safe while the opened card still says
  // them. If either of these ever goes, the two assertions above are cutting information, not noise.
  assert.match(headerSource, /Arrived \{relativeDays\(row\.createdAt\)\}/, "the opened card says when it arrived");
  assert.match(headerSource, /via \{row\.source\}/, "and where it came from");

  // ── The intelligence panel opens on the decision ──────────────────────────────────────────────
  //
  // Role fit and the recruiter briefing are both READINGS of facts printed above them, so they are
  // the right thing to have to ask for. Both keep a summary on the closed bar — the fit keeps its
  // score and verdict, the briefing its counts — so a folded section still answers "worth my time".
  const intelligenceSource = read("src/components/recruitment/workstation/workstation-intelligence.tsx");
  for (const [key, what] of [
    ["summary:fit", "the fit breakdown"],
    ["summary:briefing", "the recruiter briefing"],
  ] as const) {
    const block = intelligenceSource.slice(
      Math.max(0, intelligenceSource.indexOf(`storageKey="${key}"`) - 900),
      intelligenceSource.indexOf(`storageKey="${key}"`),
    );
    assert.ok(
      block.includes("defaultOpen={false}"),
      what + " starts folded — it is a reading of the facts above it, not new information",
    );
  }

  const loaderSource = read("src/lib/recruitment/screening-workspace.ts");
  // NEVER THE NARROWED VIEW. That is the invariant this has always guarded: a backlog figure that
  // shrank because a URL filter was applied would answer a different question from the one it is
  // labelled with. `rows` is the narrowed list; `allCandidates` and `pool` are not.
  assert.doesNotMatch(
    loaderSource,
    /arrivals: rows\.|firstDecisions: rows\./,
    "the throughput figures must never be computed over the filtered rows",
  );
  // ARRIVALS COME FROM EVERY CANDIDATE, not just the pool — tightened 2026-09-05. A CV filed to a
  // shelf still arrived, so counting only the pool would shrink the "in" side every time somebody
  // tidied up, and the strip would report the backlog improving because work was HIDDEN, not done.
  assert.match(
    loaderSource,
    /arrivals: allCandidates\.map\(\(candidate\) => candidate\.createdAt\)/,
    "arrivals are counted over every candidate that has ever arrived",
  );
  // And decisions come from the recorded history rather than the pool's own status stamps, which
  // hold only the LATEST move and so counted a re-decision as fresh output.
  assert.match(
    loaderSource,
    /firstDecisions: \[\.\.\.decisionHistory\.firstDecisionAt\.values\(\)\]/,
    "decisions come from the decision history, not from the latest status stamp on the row",
  );

  // ── Duplicates: two kinds of evidence, and neither of them proof ──────────────────────────────
  //
  // The pile keyed on the phone alone, so it could not see one person applying twice under one name
  // with two numbers — and 58 of 597 carry no phone at all, so they could never enter it. The pool
  // has always flagged both (findDuplicateFlags). candidate-matching.ts keeps the identity rule
  // LOCKED to national ID then email because phone matching once "merged three different applicants
  // into one record", so the strength is carried to the screen rather than flattened away.
  assert.match(loaderSource, /const nameTwins = new Map<string, Candidate\[\]>\(\)/, "names are indexed too");
  assert.match(loaderSource, /duplicateReason: DuplicateReason \| null/, "and the evidence travels with the pair");
  const workstationSource = read("src/components/recruitment/workstation/screening-workstation.tsx");
  assert.match(workstationSource, /share this phone number/, "the banner names the evidence");
  assert.match(workstationSource, /carry this same name/, "both kinds of it");
  // Archiving is a SHELF, not a delete, and it acts on the record ON SCREEN.
  assert.match(workstationSource, /const archiveDuplicate = useCallback/, "a duplicate can be archived from here");
  assert.match(
    workstationSource,
    /kind: DUPLICATE_FOLDER_KIND/,
    "through the folder route — the row, its files and its history all survive",
  );
  assert.doesNotMatch(workstationSource, /method: "DELETE"/, "nothing on this screen deletes a candidate");

  // --- Accept what the reader found -----------------------------------------------------------
  //
  // The screening workstation already RECEIVED the whole extraction and rendered it field by field;
  // what it could not say was whether a value had ever reached the record, and it offered no way to
  // put it there. 215 candidates carried a good yearsExperience against a null column on
  // 2026-09-05 for exactly that reason.
  const intelligence = read("src/components/recruitment/workstation/workstation-intelligence.tsx");
  assert.match(
    intelligence,
    /listUnappliedCvFields\(extraction\.fields, candidate, schema\)/,
    "the tab must ask the SHARED rule which findings are unsaved, never re-derive it",
  );
  assert.match(intelligence, /Not saved to the record/, "and say so on the row — the tab looks identical otherwise");
  assert.match(intelligence, /Save this to the record/, "with a way to fix it");
  // NULL, not disabled, when the viewer may not write: the button is absent rather than present and
  // answering 403.
  assert.match(
    intelligence,
    /onAcceptField: \(\(fieldKey: string, value: ExtractedCvValue\) => void\) \| null;/,
    "a viewer who cannot write is given no button at all",
  );

  const acceptShell = read("src/components/recruitment/workstation/screening-workstation.tsx");
  assert.match(acceptShell, /const acceptReaderFinding = useCallback/, "the shell owns the write");
  // ONE FIELD PER PRESS. These are the readings the extractor itself hedged on, so a bulk apply
  // would be the unattended write the confidence gate exists to prevent, wearing a button.
  assert.doesNotMatch(acceptShell, /acceptAllReaderFindings|applyAllExtraction/, "there is no bulk apply");
  // The SERVER's copy replaces the cache — a locally patched one leaves the button on screen
  // whenever the server normalises the value differently from the reader's raw proposal.
  assert.match(acceptShell, /profile: \{ \.\.\.entry\.profile, candidate: saved \}/, "the cache takes the server's record");
  assert.match(acceptShell, /canWriteNotes \? \(key, value\)/, "and the write is gated on the update grant");
}
