import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  cleanPositionText,
  groupCandidatesByPosition,
  hasSentForPosition,
  positionFolderKey,
  positionFolderLabel,
  shouldShowGroupHeadings,
} from "../src/lib/recruitment/position-folder.ts";
import type { PositionFolder } from "../src/lib/recruitment/position-folder.ts";
import type { Candidate, SentForPosition } from "../src/lib/recruitment/types.ts";

/**
 * "Before sending the CV to the manager, I should be able to choose his area and his job title, so
 *  the same title, same area are consolidated ... he goes to a folder called Nasr City Medical
 *  Reps ... automated foldering based on the area, so he can look at the same page when he wants a
 *  certain position."
 *
 * The owner, 2026-08-28. Until then a send recorded who the CV went to and — since the night before
 * — that manager's own seat. Neither answers the question a manager actually asks, because a
 * manager's seat is not the seat he is hiring for and one manager holds several of the second.
 * Measured in production that morning: 35 open vacancies across 34 areas, and Ahmed Mohamed Nagy is
 * the named manager on five of them.
 *
 * Three properties this file holds still.
 *
 * THE LINE IS PART OF A POSITION'S IDENTITY. Nasr City carries TWO open Medical Representative
 * seats — Anti Infective under one manager, Pedia under another. A folder keyed on area and title
 * alone silently merges two vacancies belonging to two different people.
 *
 * A PICKED POSITION AND A TYPED ONE WITH THE SAME WORDS ARE ONE FOLDER. The owner asked for both
 * ways of naming a position. If the key were the vacancy id, the two would sit in folders reading
 * identically, which is exactly the drift the free-typed option was promised not to cause.
 *
 * A SEND WITH NO POSITION IS NEVER HIDDEN. Every send made before this shipped has none, and they
 * are real people a manager was asked to review.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

/** A candidate carrying only what the folding actually reads. */
function sent(id: string, sentAt: string, position: Partial<SentForPosition> | null): Candidate {
  return {
    id,
    fullName: id,
    managerNotified: { areaName: null, hrId: "HR-1", jobTitle: null, name: "A Manager", regionName: null, sentAt },
    sentFor: position
      ? {
          areaName: position.areaName ?? null,
          jobTitle: position.jobTitle ?? null,
          lineName: position.lineName ?? null,
          regionName: position.regionName ?? null,
          vacancyId: position.vacancyId ?? null,
        }
      : null,
  } as unknown as Candidate;
}

export async function runCandidatePositionFolderTests() {
  // ── 1 · Cleaning, which is what makes free typing safe ─────────────────────
  assert.equal(cleanPositionText("  Nasr City  "), "Nasr City", "trimmed");
  assert.equal(
    cleanPositionText("Medical  Representative"),
    "Medical Representative",
    "an inner double space must collapse — otherwise it opens a second folder reading like the first",
  );
  assert.equal(cleanPositionText("   "), null, "whitespace only is no answer at all");
  assert.equal(cleanPositionText(null), null, "absent is no answer at all");

  // ── 2 · The label, as a person reads it ────────────────────────────────────
  assert.equal(
    positionFolderLabel({
      areaName: "Nasr City",
      jobTitle: "Medical Representative",
      lineName: "Pedia",
      regionName: "Cairo",
      vacancyId: 12,
    }),
    "Nasr City · Medical Representative · Pedia",
    "AREA FIRST — 34 of the 35 open seats share one job title, so the area is what tells them apart",
  );
  assert.equal(
    positionFolderLabel({
      areaName: "Head office",
      jobTitle: "Regulatory Affairs",
      lineName: "Head Office",
      regionName: null,
      vacancyId: 9,
    }),
    "Head office · Regulatory Affairs",
    "a line repeating the area is dropped — a repeated word in a heading reads as a rendering fault",
  );
  assert.equal(
    positionFolderLabel({ areaName: "Tanta", jobTitle: null, lineName: null, regionName: null, vacancyId: null }),
    "Tanta",
    "a missing part is OMITTED, never filled in — no invented value reaches a screen",
  );
  assert.equal(
    positionFolderLabel({ areaName: null, jobTitle: null, lineName: null, regionName: null, vacancyId: null }),
    "",
    "nothing named is an empty label, and the caller reads that as no position",
  );

  // ── 3 · Identity: what merges, and what must not ───────────────────────────
  const pedia: SentForPosition = {
    areaName: "Nasr City",
    jobTitle: "Medical Representative",
    lineName: "Pedia",
    regionName: "Cairo",
    vacancyId: 12,
  };
  const antiInfective: SentForPosition = { ...pedia, lineName: "Anti Infective", vacancyId: 44 };
  assert.notEqual(
    positionFolderKey(pedia),
    positionFolderKey(antiInfective),
    "Nasr City holds TWO open Medical Rep seats on different lines, under different managers — one folder would merge them",
  );

  const typedTheSame: SentForPosition = {
    areaName: "  nasr city ",
    jobTitle: "medical  representative",
    lineName: "PEDIA",
    regionName: null,
    // Typed, so no vacancy id — and it must land in the SAME folder as the picked one anyway.
    vacancyId: null,
  };
  assert.equal(
    positionFolderKey(typedTheSame),
    positionFolderKey(pedia),
    "keyed on the normalised TEXT, not the vacancy id — a typed position and a picked one that read the same ARE the same folder",
  );

  assert.equal(
    positionFolderKey({ areaName: null, jobTitle: null, lineName: null, regionName: null, vacancyId: 7 }),
    "",
    "a vacancy id with no words is not a position — the id alone cannot label a folder",
  );

  // The joiner must not be forgeable out of ordinary text.
  assert.notEqual(
    positionFolderKey({ areaName: "Cairo", jobTitle: "Medical Rep", lineName: null, regionName: null, vacancyId: null }),
    positionFolderKey({ areaName: "Cairo Medical", jobTitle: "Rep", lineName: null, regionName: null, vacancyId: null }),
    "parts are joined on a control character, so a space inside one part cannot forge another position's key",
  );

  assert.equal(hasSentForPosition(sent("a", "2026-08-28T10:00:00Z", pedia)), true, "a real position");
  assert.equal(hasSentForPosition(sent("b", "2026-08-28T10:00:00Z", null)), false, "no position at all");
  assert.equal(
    hasSentForPosition(sent("c", "2026-08-28T10:00:00Z", { vacancyId: 3 })),
    false,
    "an id with no words still is not a position",
  );

  // ── 4 · The folding itself ─────────────────────────────────────────────────
  const grouped = groupCandidatesByPosition([
    sent("older-pedia", "2026-08-28T08:00:00Z", pedia),
    sent("no-position", "2026-08-28T09:00:00Z", null),
    sent("anti-infective", "2026-08-28T07:00:00Z", antiInfective),
    sent("typed-pedia", "2026-08-28T11:00:00Z", typedTheSame),
    sent("tanta", "2026-08-28T06:00:00Z", { areaName: "Tanta", jobTitle: "Medical Representative" }),
  ]);

  assert.deepEqual(
    grouped.folders.map((folder) => folder.label),
    ["Nasr City · Medical Representative · Anti Infective", "Nasr City · Medical Representative · Pedia", "Tanta · Medical Representative"],
    "one folder per position, ordered by area then title then line — the order the picker offers them in",
  );
  assert.deepEqual(
    grouped.folders.map((folder) => folder.candidates.length),
    [1, 2, 1],
    "the typed Pedia and the picked Pedia are ONE folder of two, not two folders of one",
  );
  assert.deepEqual(
    grouped.folders[1].candidates.map((candidate) => candidate.id),
    ["typed-pedia", "older-pedia"],
    "newest send first inside a folder — the reason to open a pile is almost always what just landed in it",
  );
  assert.equal(
    grouped.folders[1].label,
    "Nasr City · Medical Representative · Pedia",
    "a PICKED vacancy's spelling heads the folder even though the typed send is newer — the organogram's words, not somebody's keyboard at 4am",
  );
  assert.deepEqual(
    grouped.unfiled.map((candidate) => candidate.id),
    ["no-position"],
    "a send with no position comes back SEPARATELY — never dropped, and never given an invented folder",
  );
  assert.equal(
    grouped.folders.some((folder) => folder.candidates.some((candidate) => candidate.id === "no-position")),
    false,
    "and it is not also inside a folder",
  );

  assert.deepEqual(
    groupCandidatesByPosition([]),
    { folders: [], unfiled: [] },
    "an empty inbox folds to nothing rather than throwing",
  );

  // ── 5 · The write path degrades instead of failing ─────────────────────────
  //
  // Code ships on a merge to `main` and is live within minutes; the migration that adds the five
  // sent_for_* columns is a separate, announced step. In the window between them PostgREST answers
  // an update naming an unknown column with PGRST204 / 42703 — and this update is the one that
  // RECORDS the send, so a bare throw there would mean "Send to manager" is simply broken until
  // somebody runs a migration.
  const notify = read("src/lib/recruitment/hiring-manager-notify.ts");
  assert.match(
    notify,
    /const tiers = \[\s*\{ \.\.\.identity, \.\.\.seat, \.\.\.position \},\s*\{ \.\.\.identity, \.\.\.seat \},\s*identity,/,
    "THREE tiers, widest first: the seat columns and the position columns arrive in separate migrations, so a database can have one and not the other",
  );
  assert.match(
    notify,
    /if \(!isMissingSeatColumn\(attempt\.error\)\) break;/,
    "only a MISSING COLUMN narrows the tier — any other write failure must still surface",
  );
  assert.match(
    notify,
    /if \(!written\) throw lastError;/,
    "and when every tier fails the send throws: this is the only place a send is recorded",
  );

  // ── 6 · The id is re-read server-side, never trusted from the body ─────────
  const vacancyOptions = read("src/lib/recruitment/vacancy-options.ts");
  assert.match(
    vacancyOptions,
    /const vacancy = Number\.isFinite\(vacancyId\) \? await findOpenVacancy\(vacancyId\) : null;/,
    "a posted vacancy id is looked up again before anything is stamped",
  );
  assert.match(
    vacancyOptions,
    /areaName: vacancy\.areaName,\s*jobTitle: vacancy\.jobTitle,/,
    "and the stamp comes from the ROW, not from the words in the request body",
  );
  assert.match(
    vacancyOptions,
    /\.eq\("status", "open"\)/,
    "only OPEN seats are offered — a filled or cancelled one would outlive the reason the folder exists",
  );
  assert.doesNotMatch(
    vacancyOptions,
    /regionName: cleanPositionText\(input\.regionName\)/,
    "a TYPED position has no region: it is derived from the organogram, and Beni Suef and Fayoum sit in different regions depending on the line",
  );

  // ── 7 · An absent id must not become vacancy zero ──────────────────────────
  //
  // `Number(null)` is 0, not NaN. A hand-rolled finiteness check on the raw column therefore turns
  // "no vacancy" into a real-looking foreign key pointing at nothing.
  const db = read("src/lib/recruitment/db.ts");
  assert.match(
    db,
    /vacancyId: numberOrNull\(row\.sent_for_vacancy_id\)/,
    "numberOrNull, never a bare Number() — Number(null) is 0",
  );

  // ── 8 · Both send routes carry the position, and the same way ──────────────
  const singleRoute = read("app/api/recruitment/candidates/[id]/notify-manager/route.ts");
  const bulkRoute = read("app/api/recruitment/candidates/notify-manager/route.ts");
  for (const [name, source] of [
    ["single-candidate", singleRoute],
    ["multi-candidate", bulkRoute],
  ] as const) {
    assert.match(
      source,
      /positionInput\(body\)/,
      `the ${name} route passes the position through — the two share a service and must not disagree at the boundary`,
    );
  }

  // ── 9 · The manager's inbox folds, and shows what is unfiled ───────────────
  const portal = read("src/components/employee-portal/recruitment-candidates-portal.tsx");
  assert.match(
    portal,
    /groupCandidatesByPosition\(liveSends\)/,
    "the manager's inbox folds on the SAME function the recruiter's screen and this test use",
  );
  // The argument was `sentToMe` until 2026-08-30, when the manager got his own CV shelf. It must now
  // be the SHELF-FILTERED list, and the order is the whole point: a CV he has kept for later has to
  // leave "Sent to you" entirely. Folding the unfiltered list would put it in a position folder AND
  // in a folder on his shelf — a candidate in two lists is a candidate answered twice.
  // Since 2026-11-10 the list is first narrowed by the page's find tray (`shownSentToMe`, which IS
  // `sentToMe` when nothing is searched); the shelf split still comes before the grouping.
  assert.match(
    portal,
    /partitionManagerCandidates\(shownSentToMe, filings\)/,
    "the shelf split runs BEFORE the position grouping, so a filed CV is in exactly one list",
  );
  assert.match(
    portal,
    /const shownSentToMe = useMemo\(\(\) => \(narrowing \? sentToMe\.filter\(keepSent\) : sentToMe\)/,
    "and the list it splits is the sent list itself whenever nothing is searched",
  );
  assert.match(
    portal,
    /No position given/,
    "and pre-2026-08-28 sends keep their own heading rather than being hidden or invented into a vacancy",
  );

  // ── 9b · Headings count GROUPS, and the unfiled pile is one ────────────────
  //
  // Behaviour, not a grep of a JSX condition: the rule lives in the pure module precisely so it can
  // be asserted as an answer. The third case is the one that shipped wrong — every send predating
  // 2026-08-28 has no position, so the FIRST manager to receive a positioned CV lands exactly there.
  {
    const folder = (key: string): PositionFolder => ({
      candidates: [],
      key,
      label: key,
      lastSentAt: null,
      position: { areaName: key, jobTitle: "Medical Representative", lineName: null, regionName: null, vacancyId: null },
    });
    const someone = [{ id: "x" } as unknown as Candidate];

    assert.equal(
      shouldShowGroupHeadings([folder("Nasr City")], []),
      false,
      "one folder and nothing beside it is just a list — a heading there separates nothing",
    );
    assert.equal(
      shouldShowGroupHeadings([], someone),
      false,
      "and the state before this feature existed — every send unfiled — must keep rendering bare, exactly as it did",
    );
    assert.equal(
      shouldShowGroupHeadings([folder("Nasr City")], someone),
      true,
      "ONE folder beside unfiled sends is TWO groups: heading both, or the only heading on screen sits on the pile with no position",
    );
    assert.equal(
      shouldShowGroupHeadings([folder("Nasr City"), folder("Heliopolis")], []),
      true,
      "two folders are two groups whether or not anything is unfiled",
    );
  }

  // ── 10 · The picker exists on the screening screen, both ways ──────────────
  const session = read("src/components/recruitment/candidate-screening-session.tsx");
  // The two prompts moved into `vacancy-picker.tsx` on 2026-08-31, when the flat `<select>` became a
  // grouped, searchable picker — 35 open seats across 34 areas, with Nasr City's two differing only
  // by a line the label did not carry. The words a recruiter reads are pinned where they now live,
  // and the screen is pinned to still MOUNT the thing that says them: either half alone would go
  // green while the picker had quietly stopped being rendered.
  const sendPanel = read("src/components/recruitment/workstation/workstation-review-header.tsx");
  assert.match(session, /<VacancyPicker/, "the position picker is on the screening screen");
  assert.match(sendPanel, /<VacancyPicker/, "and on the workstation that replaced it as the default screen");
  // The datalist behind the free-typed position, which the rebuild dropped once and this pins back:
  // an open list of what has ALREADY been used, never a closed one — the option exists precisely so
  // a position that is not an open seat yet can be named.
  assert.match(sendPanel, /list="workstation-position-titles"/, "the free-typed job title offers what is already in use");
  assert.match(sendPanel, /list="workstation-position-areas"/, "and so does the free-typed area");
  const picker = read("src/components/recruitment/vacancy-picker.tsx");
  assert.match(picker, /For which position\? \(optional\)/, "the position is chosen BEFORE the send");
  assert.match(picker, /name: "Another position"/, "and a position that is not an open seat yet can still be named");
  assert.match(
    session,
    /const vacancy = openVacancies\.find\(\(option\) => String\(option\.id\) === value\);/,
    "picking a vacancy pre-selects the manager that vacancy reports to — the organogram already knows who owns the seat",
  );

  // Both page twins must load it, or the picker exists for one shell only — and HR Advisory,
  // the role that screens the most CVs, is the shell that would lose it.
  for (const page of [
    "app/(admin)/recruitment/screening/page.tsx",
    "app/employee-portals/recruitment/screening/page.tsx",
  ]) {
    // The prop names moved with the 2026-09-04 workstation rebuild (`queue.` became `workspace.`,
    // `openVacancies` became `vacancies`), and the SCREEN the picker sits on changed with them. The
    // invariant did not: both shells must still hand the screening screen its open seats AND the
    // already-used titles and areas behind the free-typed position, or one shell quietly loses the
    // half that stops a second "Marketing Exec." opening a near-duplicate folder.
    assert.match(read(page), /vacancies=\{workspace\.vacancies\}/, `${page} passes the open vacancies`);
    assert.match(
      read(page),
      /positionSuggestions=\{workspace\.positionSuggestions\}/,
      `${page} passes the free-typed suggestions`,
    );
  }
}
