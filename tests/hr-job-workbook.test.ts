import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { hrNavigationSections } from "../src/config/system-navigation.ts";
import {
  displayTitleForRole,
  HR_ROLE_BUNDLES,
  HR_SEAT_JOB_TITLES,
  type HrBundleName,
} from "../src/lib/auth/hr-functions.ts";
import {
  permissionActions,
  permissionMatrix,
  permissionResources,
  phoenixCompanyJobTitles,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";
import { isHrNamespacePath, HR_NAMESPACE_PREFIX } from "../src/lib/navigation/shell-headers.ts";
import {
  allWorkbookLines,
  COMPANY_ROLE_WORKBOOKS,
  HR_SEAT_WORKBOOKS,
  seatHoldsFunction,
  WORKBOOK_MODE_LABELS,
  workbookForSeat,
  workbookLineCounts,
} from "../src/lib/hr/job-workbook.ts";

/**
 * THE JOB WORKBOOK — "all 66 lines mapped to a real screen, none left blank".
 *
 * That sentence is the owner's own completion test for this phase, and this file is what makes it
 * a fact rather than a claim. A workbook is only worth writing if it stays true, and there are
 * three separate ways it can quietly stop being true:
 *
 *   1. A LINE GOES MISSING. The two job descriptions have 29 and 37 responsibility lines. Nothing
 *      about a TypeScript array notices when one is dropped during an edit, so the counts are
 *      pinned per section, not merely in total — a line moved from section 3 to section 4 keeps
 *      the total at 37 and is exactly the kind of drift a total cannot see.
 *   2. A SCREEN STOPS EXISTING, or stops being reachable by the seat whose line names it. A
 *      workbook that sends the new HR Generalist to a page that 404s, or to one her
 *      own sidebar never offers her, is worse than no workbook: it teaches the wrong thing with
 *      authority. So every href is checked twice — the page file is on disk, AND the row is in
 *      that seat's real rendered sidebar.
 *   3. THE OWNER'S WORDS GET EDITED. Every `responsibility` string is verbatim from the .docx he
 *      supplied. The screens, steps and evidence are ours to write; his sentences are not. Four
 *      of them are pinned here character for character as a tripwire on the rest.
 *
 * The count assertions are also the reason this file can be trusted at all. A test that only
 * checked "no field is empty" would pass on a workbook containing one line.
 */

/**
 * The line count of each numbered section, straight off the two job descriptions. Partial because
 * a seat with no written job description (HR Resourcing, 2026-10-08) has no book to count.
 */
// The HR Business Partner's book (29 lines, six sections) left with her seat: the owner retired the HR Business Partner seat on 2026-10-08.
const SECTION_LINE_COUNTS: Partial<Record<HrBundleName, readonly number[]>> = {
  "HR Operations": [4, 4, 4, 4, 4, 4, 4, 5, 4],
};

const EXPECTED_TOTALS: Partial<Record<HrBundleName, number>> = {
  "HR Operations": 37,
};

/**
 * The seats opened WITHOUT a written job description, so they hold no per-line book. Named, not
 * derived from HR_SEAT_WORKBOOKS, so a seat cannot lose its book and pass by being treated as one
 * that never had one.
 */
const SEATS_WITHOUT_A_WRITTEN_JD: readonly HrBundleName[] = ["HR Resourcing", "HR Administration"];

/**
 * Four of the owner's own sentences, character for character. Not a byte window into the file (a
 * shifting-offset slice false-fails the moment anything above it moves) — these are field VALUES,
 * so they stay true wherever the line ends up in the array.
 */
const VERBATIM_PINS: { id: string; responsibility: string }[] = [
  {
    id: "ops-1-1",
    responsibility:
      "Maintain complete and accurate personnel files for active employees and ensure required hiring documents are collected and archived.",
  },
  {
    id: "ops-9-4",
    responsibility:
      "Escalate legal, disciplinary or policy-sensitive cases rather than making an independent judgment outside delegated authority.",
  },
];

function lookupFor(role: PhoenixRole): PermissionLookup {
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = permissionMatrix[role]?.[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

/** The `/hr` sidebar a seat actually gets, as a flat href list — the same call the shell makes. */
function hrSidebarHrefs(role: PhoenixRole): string[] {
  return getSections(hrNavigationSections as never, "hr", lookupFor(role), role).flatMap((section) =>
    section.items.map((item) => item.href),
  );
}

/** `/hr/attendance/exceptions` -> `/attendance/exceptions`. The address the App Router renders. */
function underlyingPath(href: string): string {
  return href === HR_NAMESPACE_PREFIX ? "/" : href.slice(HR_NAMESPACE_PREFIX.length);
}

function pageExists(href: string): boolean {
  const rel = underlyingPath(href).replace(/^\//, "");
  return (
    existsSync(new URL(`../app/(admin)/${rel}/page.tsx`, import.meta.url)) ||
    existsSync(new URL(`../app/${rel}/page.tsx`, import.meta.url))
  );
}

export function runHrJobWorkbookTests() {
  // 1 ── THE HEADLINE COUNT. 37, and each section holds exactly what the JD says. It was 29 + 37 = 66
  // until the owner retired the HR Business Partner seat on 2026-10-08 and its 29 lines left with it.
  const counts = workbookLineCounts();
  assert.equal(counts.total, 37, `the workbook must hold all 37 responsibility lines, found ${counts.total}`);
  assert.equal(HR_SEAT_WORKBOOKS.length, 1, "one workbook: HR Operations' — the only seat with a written job description");

  for (const book of HR_SEAT_WORKBOOKS) {
    const expected = SECTION_LINE_COUNTS[book.seat];
    assert.ok(expected, `no expected section counts recorded for ${book.seat}`);
    assert.equal(
      counts.bySeat[book.seat],
      EXPECTED_TOTALS[book.seat],
      `${book.seat}: expected ${EXPECTED_TOTALS[book.seat]} responsibility lines, found ${counts.bySeat[book.seat]}`,
    );
    assert.deepEqual(
      book.sections.map((section) => section.lines.length),
      [...expected],
      `${book.seat}: the per-section line counts no longer match the job description. A total that ` +
        "still adds to the right number can hide a line moved between sections — that is why this " +
        "is checked section by section",
    );
    // Sections numbered 1..N in order, as the job description numbers them.
    assert.deepEqual(
      book.sections.map((section) => section.number),
      expected.map((_, index) => index + 1),
      `${book.seat}: sections must be numbered 1..${expected.length} in order`,
    );
    // Every section must declare whether its work is done on a screen or by a person. The Role Map
    // page prints this, so an untagged section would render a blank cell in the reader's own map —
    // and a runtime check is the only thing that catches it: an unlisted union member would satisfy
    // the type and next.config's ignoreBuildErrors means a bad one would still build and deploy.
    for (const section of book.sections) {
      assert.ok(
        section.mode in WORKBOOK_MODE_LABELS,
        `${book.seat} § ${section.number} "${section.title}": mode is missing or is not one of ` +
          `${Object.keys(WORKBOOK_MODE_LABELS).join(", ")} (found ${JSON.stringify(section.mode)})`,
      );
      assert.ok(
        WORKBOOK_MODE_LABELS[section.mode]?.trim().length > 0,
        `${book.seat} § ${section.number}: mode "${section.mode}" has no printable label`,
      );
    }
    assert.ok(book.mission.trim().length > 100, `${book.seat}: the role mission is missing or truncated`);
    assert.equal(book.boundaries.length, 5, `${book.seat}: the JD lists five boundary lines`);
    for (const boundary of book.boundaries) {
      assert.ok(boundary.trim().length > 0, `${book.seat}: an empty boundary line`);
    }
  }

  // 2 ── NOTHING LEFT BLANK. The owner's completion test, literally.
  const lines = allWorkbookLines();
  assert.equal(lines.length, 37, `allWorkbookLines() must return all 37, returned ${lines.length}`);

  const ids = new Set<string>();
  for (const line of lines) {
    const where = `${line.seat} ${line.id}`;
    assert.ok(!ids.has(line.id), `duplicate workbook line id: ${line.id}`);
    ids.add(line.id);
    assert.ok(line.responsibility.trim().length > 0, `${where}: empty responsibility`);
    assert.ok(line.screens.length > 0, `${where}: no screen — this is the one thing the workbook exists to supply`);
    assert.ok(line.steps.length > 0, `${where}: no steps`);
    assert.ok(line.evidence.trim().length > 0, `${where}: no evidence`);
    for (const step of line.steps) {
      assert.ok(step.trim().length > 0, `${where}: an empty step`);
    }
    for (const screen of line.screens) {
      assert.ok(screen.label.trim().length > 0, `${where}: a screen with no label`);
    }
    // The id encodes the seat and the section it sits in, so a line copied between sections during
    // an edit shows up here rather than silently reading under the wrong heading.
    const prefix = "ops";
    assert.ok(
      line.id.startsWith(`${prefix}-${line.section.number}-`),
      `${where}: id does not match its seat and section (expected ${prefix}-${line.section.number}-…)`,
    );
  }

  // 3 ── EVERY LINE'S FUNCTION IS ONE THE SEAT ACTUALLY HOLDS. The workbook is the human-readable
  // face of the function catalogue; if it claims a line is done under a function the seat's bundle
  // does not contain, then either the bundle is wrong or the mapping is — and both are worth
  // stopping for.
  for (const line of lines) {
    assert.ok(
      seatHoldsFunction(line.seat, line.fn),
      `${line.seat} ${line.id}: mapped to function "${line.fn}", which is not in that seat's bundle ` +
        `(${HR_ROLE_BUNDLES[line.seat].join(", ")})`,
    );
  }

  // 4 ── EVERY SCREEN IS REAL AND REACHABLE BY THE SEAT WHOSE LINE NAMES IT.
  // Two separate failures, reported separately, because they have different fixes: a page that does
  // not exist is a typo, and a page the seat is never offered is a permission or navigation gap.
  const missingPage: string[] = [];
  const notOffered: string[] = [];
  const notPrefixed: string[] = [];
  const sidebarBySeat = new Map<HrBundleName, string[]>(
    HR_SEAT_WORKBOOKS.map((book) => [book.seat, hrSidebarHrefs(book.seat)] as const),
  );

  for (const line of lines) {
    const sidebar = sidebarBySeat.get(line.seat) ?? [];
    for (const screen of line.screens) {
      if (!isHrNamespacePath(screen.href)) {
        notPrefixed.push(`${line.seat} ${line.id} -> ${screen.href}`);
        continue;
      }
      if (!pageExists(screen.href)) {
        missingPage.push(`${line.seat} ${line.id} -> ${screen.href}`);
      }
      // Either the row itself, or a page underneath a row that is offered (e.g.
      // /hr/attendance/exceptions under /hr/attendance). A sub-path counts because the seat gets
      // there from a screen she is offered, which is the thing being asserted.
      const reachable = sidebar.some(
        (href) => href === screen.href || screen.href.startsWith(`${href}/`),
      );
      if (!reachable) {
        notOffered.push(`${line.seat} ${line.id} -> ${screen.href} (${screen.label})`);
      }
    }
  }

  assert.deepEqual(notPrefixed, [], "every workbook screen must be an /hr address — that is the seats' namespace");
  assert.deepEqual(
    missingPage,
    [],
    "a workbook line points at a page that does not exist on disk — the workbook would teach a 404",
  );
  assert.deepEqual(
    notOffered,
    [],
    "a workbook line points at a screen the seat's own sidebar never offers her. Either the row is " +
      "missing from hrNavigationSectionSeeds, or the seat lacks the grant — do not 'fix' this by " +
      "pointing the line at a different screen unless that screen is really where the work is done",
  );

  // A floor on the check itself: if `hrSidebarHrefs` ever returns nothing (a lookup shape change,
  // a renamed export), every `startsWith` above would fail loudly — but a change that made it
  // return EVERYTHING would make section 4 pass by doing nothing. Assert the shape is plausible.
  for (const [seat, hrefs] of sidebarBySeat) {
    assert.ok(hrefs.length >= 15, `${seat}: only ${hrefs.length} sidebar rows — the reachability check is not doing its job`);
    assert.ok(
      hrefs.every((href) => isHrNamespacePath(href)),
      `${seat}: a sidebar href outside the /hr namespace`,
    );
  }

  // 5 ── THE OWNER'S SENTENCES, VERBATIM.
  for (const pin of VERBATIM_PINS) {
    const line = lines.find((entry) => entry.id === pin.id);
    assert.ok(line, `workbook line ${pin.id} no longer exists`);
    assert.equal(
      line.responsibility,
      pin.responsibility,
      `${pin.id}: the responsibility text has been edited. These sentences are the owner's, taken ` +
        "verbatim from the job description he supplied — the screen, steps and evidence beside them " +
        "are ours to improve, the sentence itself is not",
    );
  }

  // 6 ── PART TWO: every job title in the company has an entry, and none is invented.
  const titles = new Set<string>(phoenixCompanyJobTitles as readonly string[]);
  const covered = COMPANY_ROLE_WORKBOOKS.map((entry) => entry.jobTitle);
  assert.equal(
    new Set(covered).size,
    covered.length,
    "a job title appears twice in COMPANY_ROLE_WORKBOOKS",
  );
  assert.deepEqual(
    [...titles].filter((title) => !covered.includes(title as never)),
    [],
    "a job title exists in the company with no workbook entry — the owner asked for every role to " +
      "have one, so a new title cannot arrive silently",
  );
  assert.deepEqual(
    covered.filter((title) => !titles.has(title)),
    [],
    "COMPANY_ROLE_WORKBOOKS names a job title the company does not have",
  );
  for (const entry of COMPANY_ROLE_WORKBOOKS) {
    assert.ok(entry.purpose.trim().length > 0, `${entry.jobTitle}: no purpose recorded`);
  }

  // The anti-fabrication pin. Only two written job descriptions have ever been supplied, and the
  // other twenty entries deliberately record access and purpose rather than invented
  // responsibility lines. If a future session "completes" the workbook by writing responsibilities
  // nobody asked for, this is what catches it.
  assert.deepEqual(
    COMPANY_ROLE_WORKBOOKS.filter((entry) => entry.hasWrittenJd).map((entry) => entry.jobTitle),
    // "HR Generalist" since 2026-10-20: the owner renamed the HR Operations seat's title from HR
    // Operations Coordinator, and the job description he supplied moved with it unchanged. The HR
    // Operations Specialist seat opened the same day from his answers in chat, with NO written job
    // description, so it must stay false here.
    ["HR Generalist"],
    "hasWrittenJd must be true only for the titles whose job description the owner actually " +
      "supplied (the HR Business Partner's was the other, retired with the seat on 2026-10-08). Do " +
      "not invent responsibility lines for a role nobody has written one for",
  );
  assert.equal(
    COMPANY_ROLE_WORKBOOKS.find((entry) => entry.jobTitle === "HR Operations Specialist")?.role,
    "HR Administration",
    "the HR Operations Specialist title carries the HR Administration seat (owner, 2026-10-20)",
  );

  // 7 ── The seat lookup used by the page, so a viewer's role resolves to their own book.
  assert.equal(workbookForSeat("HR Advisory"), null, "the HR Business Partner's book left with the retired seat");
  assert.equal(workbookForSeat("HR Operations")?.jobTitle, "HR Generalist");
  assert.equal(workbookForSeat("HR Administration"), null, "the HR Operations Specialist has no written job description yet");
  assert.equal(workbookForSeat("Super Admin"), null, "only HR Operations holds a workbook of its own");
  assert.equal(workbookForSeat(null), null);
  assert.equal(workbookForSeat(undefined), null);

  // 8 ── THE DISPLAYED TITLE. `HR_SEAT_JOB_TITLES` is what every screen in an HR seat's account
  // actually shows — the topbar chip, its dropdown, the profile page and the command-centre hero
  // all resolve through it. It lives in hr-functions.ts rather than here because it is read on
  // every authenticated page render and this module is ~1,300 lines of workbook prose, so the two
  // are separate copies of one fact and CAN drift. This is what stops them.
  for (const seat of Object.keys(HR_ROLE_BUNDLES) as HrBundleName[]) {
    // A seat whose job description was never supplied has NO seat workbook (the anti-fabrication pin
    // above) — the Talent Acquisition seat, HR Resourcing, opened 2026-10-08, and the HR Operations
    // Specialist seat, HR Administration, opened 2026-10-20. Each title is still pinned to the
    // company catalogue below; only the per-line book is absent, and that on purpose.
    if (SEATS_WITHOUT_A_WRITTEN_JD.includes(seat)) {
      assert.equal(workbookForSeat(seat), null, "no written job description, so no seat workbook");
    } else {
      assert.equal(
        HR_SEAT_JOB_TITLES[seat],
        workbookForSeat(seat)?.jobTitle,
        `${seat}: the title shown in the account must equal the seat workbook's jobTitle`,
      );
    }
    assert.equal(
      HR_SEAT_JOB_TITLES[seat],
      COMPANY_ROLE_WORKBOOKS.find((entry) => entry.role === seat)?.jobTitle,
      `${seat}: the title shown in the account must equal the company catalogue's jobTitle`,
    );
    // The seat key itself must never leak to a person. This is the regression the owner reported
    // on 2026-08-30: her account said "HR Advisory" everywhere instead of "HR Business Partner".
    assert.notEqual(
      HR_SEAT_JOB_TITLES[seat],
      seat,
      `${seat}: the displayed title must not be the permission key`,
    );
  }

  // And the helper the callers actually use, including the pass-through every other role relies
  // on — this must not become a company-wide relabelling.
  assert.notEqual(displayTitleForRole("HR Advisory"), "HR Business Partner", "the title retired with its seat");
  // Renamed 2026-10-20 (owner: "make the old account HR generalist" — everywhere).
  assert.equal(displayTitleForRole("HR Operations"), "HR Generalist");
  assert.notEqual(displayTitleForRole("HR Operations"), "HR Operations Coordinator", "the old title is gone from the account");
  assert.equal(displayTitleForRole("HR Resourcing"), "Talent Acquisition");
  assert.equal(displayTitleForRole("HR Administration"), "HR Operations Specialist");
  assert.equal(displayTitleForRole("Finance Manager"), "Finance Manager", "a non-HR role is unchanged");
  assert.equal(displayTitleForRole("Super Admin"), "Super Admin", "a non-HR role is unchanged");
  assert.equal(displayTitleForRole(null), "", "a null role must not render the word 'null'");
  assert.equal(displayTitleForRole(undefined), "");
}
