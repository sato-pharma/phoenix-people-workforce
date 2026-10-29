// Pins the Recruitment workspace's second release (owner, 20 Oct 2026, after looking at the first one
// live): the candidates in "a polished premium table with borders", the opened CV halving the page
// with "the cv 1 page fully appearing with no need to scroll" and "the action buttons" in view, and
// Needs placing filed from HR's own answers — Applying for, then the region, then only that region's
// areas, then that role's WhatsApp questions.
//
// Why each case matters:
//   * `cvFitZoom` is the whole of "page 1 with no scrolling": in "page" mode the tighter of across
//     and down wins. If it ever fits only the width again, an A4 page in a half-page pane is taller
//     than the pane and the reader scrolls to see its foot — the exact complaint.
//   * The table's columns are the owner's six, in his order and his words, and each layout's shares
//     sum to 100 — a short total leaves a column unsized under `table-fixed`, a long one overflows.
//   * The table switches on its OWN width (`@container`), never the window's: beside an opened CV it
//     is half the page on a wide screen. Every container breakpoint in it is the one constant.
//   * The table's head stays pinned while the rows scroll (owner, the same day): every head cell is
//     sticky at `--ws-head-top`, under the workspace's own pinned header, and the frame overrides the
//     shell's `:has(> table)` overflow — left as a scroll box, the frame never scrolls and the head
//     never moves. A row stepped into view stops below the head as well as the header.
//   * The viewer measures the page in its OWN pixels (offsetWidth/offsetHeight), the same pixels it
//     reads the pane in. getBoundingClientRect carries the admin shell's screen zoom (90%), so a page
//     measured that way fitted 1/0.9 too big and page 1's foot sat under the pane.
//   * The pane is a fixed HEIGHT, not a cap: the document needs a definite box to fit page 1 into,
//     and a `max-height` pane scrolls as a whole, taking the action bar out of view with it.
//   * `placingRefusal` is what the placing route refuses before any write — no role, a role off the
//     list, a tab the reader may not file into (the Talent Acquisition seat and the two HR tabs), an
//     area for a role that has none, an area with no region.
//   * `placingQuestionsFor` is what the form asks: the built-ins that role is asked, then that role's
//     active questions, the owner's six first — never a retired question or another role's.
//   * `roleFamilyForTypedRole` reads the form's "Applying for", which saves the role's LABEL; read as
//     anything else, the person would be filed nowhere. Every role the form offers must round-trip.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MIN_ZOOM, cvFitZoom } from "../src/components/recruitment/cv-fit-zoom.ts";
import {
  COMPACT_COLUMNS,
  TABLE_LEAD_KEYS,
  TABLE_LEAD_LABELS,
  TABLE_WIDE_MIN_PX,
  WIDE_COLUMNS,
  columnsFor,
} from "../src/components/recruitment/workspace/candidate-table-columns.ts";
import { candidateBackgroundLabels } from "../src/lib/recruitment/inbound/whatsapp-classify-menus.ts";
import { roleFamilyForTypedRole } from "../src/lib/recruitment/whatsapp-answer-edit.ts";
import {
  MEDICAL_REP_LEAD_KEYS,
  OWNER_ANSWER_LABELS,
  placingQuestionsFor,
  type AnswerChipContext,
  type ChipQuestion,
} from "../src/lib/recruitment/workspace/answer-chips.ts";
import {
  PLACING_MAX_ANSWERS,
  placingRefusal,
  placingRoleFamilies,
  placingRoleLabel,
  type PlacingInput,
} from "../src/lib/recruitment/workspace/placing-rules.ts";
import { HR_ROLE_TABS, workspaceRoleTabs } from "../src/lib/recruitment/workspace/role-tabs.ts";
import { stripComments } from "./support/comment-strip.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function code(relative: string): string {
  return stripComments(readFileSync(path.join(ROOT, relative), "utf8"));
}

/** An A4 page as the viewer paints it at zoom 1 (96 dpi). */
const A4 = { pageHeight: 1123, pageWidth: 794 };

function fitZoomTests(): void {
  const halfPane = { paneHeight: 760, paneWidth: 900 };
  const page = cvFitZoom({ ...A4, ...halfPane, mode: "page" });
  assert.equal(page, 760 / 1123, "a half-page pane: page 1 is fitted DOWN, the tighter way, so its foot is inside the pane");
  assert.ok(page * A4.pageHeight <= halfPane.paneHeight + 0.001, "the fitted page is no taller than the pane");
  assert.equal(cvFitZoom({ ...A4, ...halfPane, mode: "width" }), 1, "fit width never enlarges past the page's true size");

  assert.equal(cvFitZoom({ ...A4, mode: "page", paneHeight: 2000, paneWidth: 400 }), 400 / 794, "a narrow, tall pane fits across");
  assert.equal(
    cvFitZoom({ mode: "page", pageHeight: 794, pageWidth: 1123, paneHeight: 700, paneWidth: 900 }),
    900 / 1123,
    "a landscape page fits whichever way is tighter",
  );
  assert.equal(cvFitZoom({ ...A4, mode: "page", paneHeight: 100, paneWidth: 100 }), MIN_ZOOM, "never below the hand zoom's floor");
  assert.equal(
    cvFitZoom({ mode: "page", pageHeight: null, pageWidth: 794, paneHeight: 760, paneWidth: 600 }),
    600 / 794,
    "a page whose height is not measured (an old Word .doc, one long page) stays at fit width",
  );
  assert.equal(cvFitZoom({ mode: "page", pageHeight: null, pageWidth: null, paneHeight: 760, paneWidth: 600 }), 1, "nothing measured: true size");
}

function columnTests(): void {
  const sum = (columns: readonly { percent: number }[]) => columns.reduce((total, column) => total + column.percent, 0);
  assert.equal(sum(WIDE_COLUMNS), 100, "the ten columns share the width exactly");
  assert.equal(sum(COMPACT_COLUMNS), 100, "the half-page layout shares it exactly");
  for (const columns of [WIDE_COLUMNS, COMPACT_COLUMNS]) {
    const withoutTick = columnsFor(columns, false);
    assert.equal(sum(withoutTick), 100, "a reader who cannot tick rows loses the tick column, and its share goes to the candidate");
    assert.ok(!withoutTick.some((column) => column.key === "tick"));
  }
  assert.ok(COMPACT_COLUMNS.length < WIDE_COLUMNS.length, "the one colgroup declares the wide count; the compact layout fills the first columns");

  assert.deepEqual([...TABLE_LEAD_KEYS], [...MEDICAL_REP_LEAD_KEYS], "the table's six are the owner's six, in his order");
  for (const key of TABLE_LEAD_KEYS) {
    assert.equal(TABLE_LEAD_LABELS[key], OWNER_ANSWER_LABELS[key], `the "${key}" column is headed in his words`);
  }
  const wideKeys = WIDE_COLUMNS.map((column) => column.key);
  assert.deepEqual(wideKeys.slice(2, 8), [...TABLE_LEAD_KEYS], "the six follow the candidate, each in a column of its own");
}

function tableSourceTests(): void {
  const table = code("src/components/recruitment/workspace/candidate-table.tsx");
  assert.match(
    table,
    /<div className="@container !overflow-visible" style=\{\{ "--ws-head-h": `\$\{headHeight\}px` \} as CSSProperties\}>/,
    "the table switches on its own width, in a frame that never scrolls on its own",
  );
  assert.match(table, /const headCell =\s*"sticky top-\[var\(--ws-head-top,0px\)\] z-20 /, "every head cell pins under the workspace's header");
  assert.match(table, /<thead ref=\{headRef\}>/, "the head's height is measured");
  assert.match(table, /scroll-mt-\[calc\(var\(--ws-row-margin,0px\)\+var\(--ws-head-h,0px\)\)\]/, "a row stepped into view stops below the pinned head");
  assert.match(table, /className="hidden w-full table-fixed border-collapse md:table"/, "a fixed table on a desktop");
  assert.match(table, /data-portal-desktop-table/);
  assert.match(table, /<colgroup>/, "a colgroup sizes the columns");
  assert.doesNotMatch(table, /<colgroup className/, "one colgroup, never two switched by hiding one");
  assert.match(table, /<div className="md:hidden" role="list">/, "a phone gets the cards");
  assert.match(table, /<CandidateRow\b/, "the cards are the workspace's own row");
  assert.match(table, /<TableRowDetail\b[^>]*colSpan=\{wideColumns\.length\}/, "the opened row's panel is the joined TableRowDetail, spanning every column");
  assert.match(table, /rowDetailToggleProps\(/, "the opening toggle names the panel it controls");
  assert.doesNotMatch(table, /<td className="p-3" colSpan/, "no hand-written second row under a candidate");
  const breakpoints = [...table.matchAll(/@min-\[(\d+)px\]/g)].map((match) => Number(match[1]));
  assert.ok(breakpoints.length >= 4, `expected the container breakpoints, found ${breakpoints.length}`);
  assert.deepEqual([...new Set(breakpoints)], [TABLE_WIDE_MIN_PX], "every container breakpoint is TABLE_WIDE_MIN_PX");
  assert.doesNotMatch(table, /\b(?:sm|lg|xl|2xl):/, "no cell switches on the window's width; md: is only the phone/table gate");

  const shell = code("src/components/recruitment/workspace/role-workspace.tsx");
  assert.match(shell, /grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)\]/, "an opened CV halves the page");
  assert.match(
    shell,
    /const headTop = `calc\(var\(--ws-chrome, 0px\) \/ var\(--phx-scale-applied, 1\) \+ \$\{pinned \? headerHeight : 0\}px\)`;/,
    "the head pins just under the pinned header",
  );
  assert.match(shell, /"--ws-head-top": headTop/, "and the table is told where");
  assert.match(shell, /style=\{\{ height: cvHeight, top: cvTop \}\}/, "the pane is a fixed HEIGHT, pinned under the app's bar");
  assert.doesNotMatch(shell, /maxHeight/, "never a max-height pane that scrolls as a whole");
  assert.match(shell, /className=\{`sticky min-w-0 self-start overflow-hidden /, "the pane itself never scrolls");
  assert.match(shell, /<OpenedCv\b[\s\S]*?\n\s*fill\n[\s\S]*?\/>/, "the opened CV is the full-height column");
  assert.match(shell, /<CandidateTable\b/, "the list is the bordered table");
  assert.doesNotMatch(shell, /<CandidateRow\b/, "and not the old two-line rows");
  assert.match(shell, /<PlacingForm\b/, "Needs placing carries the placing form under the opened row");
  assert.match(shell, /setWide\(entry\.contentRect\.width >= SPLIT_MIN_WIDTH\)/, "the split reads the page's width");

  const opened = code("src/components/recruitment/workspace/opened-cv.tsx");
  assert.match(opened, /fit="page"/, "the half-page CV fits page 1 whole");
  assert.match(opened, /showCallResult/, "the call result is a drop-down in the action bar");
  assert.match(opened, /panelTarget=\{drawerHost\}/, "an action's panel opens over the document, so the bar never moves");

  const viewer = code("src/components/recruitment/cv-preview-modal.tsx");
  assert.match(viewer, /from "@\/components\/recruitment\/cv-fit-zoom"/, "the viewer uses the pinned arithmetic");
  assert.doesNotMatch(viewer, /function cvFitZoom\b/, "and keeps no copy of its own");
  const measure = viewer.slice(viewer.indexOf("if (!canFit || loading || naturalWidth !== null) return;"), viewer.indexOf("const observer = new ResizeObserver((entries)"));
  assert.ok(measure.length > 200, "the page-measuring effect is where the test expects it");
  assert.match(measure, /measured = Math\.max\(measured, page\.offsetWidth\)/, "the page's width in its own pixels");
  assert.match(measure, /\? first\.offsetHeight : 0/, "page 1's height in its own pixels");
  assert.doesNotMatch(measure, /getBoundingClientRect\(\)\.(?:width|height)/, "never in the screen-zoomed pixels the pane is not read in");

  // A retry after a save that stored the new role and then failed sees "no role change"; if the stale
  // answer-filed tabs were cleared only on a change, the person would stay filed in two tabs.
  const placing = code("src/lib/recruitment/workspace/placing.ts");
  assert.match(placing, /\n {2}await removePlacementsWhere\(\{ candidateId, exceptRoleTab: roleTab, placedBy: ANSWER_PLACEMENT_SOURCES \}\);/, "every save clears the other tabs the answers filed them in");
  assert.doesNotMatch(placing, /if \(roleChanged\) \{\s*await removePlacementsWhere/, "never only when the role changed in this save");

  const route = code("app/api/recruitment/candidates/[id]/answers/route.ts");
  const put = route.slice(route.indexOf("export async function PUT"));
  const order = ["assertSameOriginMutation(request)", 'requireRecruitmentAccess(request, "candidates", "update")', "assertWorkspaceWorker(access)", "isUuid(id)", "assertCandidateVisible(access, id)", "placeWithAnswers("];
  let at = -1;
  for (const step of order) {
    const next = put.indexOf(step);
    assert.ok(next > at, `the placing save checks "${step}" in order, before it writes`);
    at = next;
  }
}

function refusalTests(): void {
  const everyTab = [...workspaceRoleTabs];
  const taSeat = everyTab.filter((tab) => !(HR_ROLE_TABS as readonly string[]).includes(tab));
  const input = (patch: Partial<PlacingInput>): PlacingInput => ({ answers: {}, areaCode: null, regionCode: null, roleFamily: "medical_rep", ...patch });

  assert.equal(placingRefusal(input({ areaCode: "ALX-1", regionCode: "AB" }), everyTab), null, "a Medical Rep with a region and an area is placed");
  assert.equal(placingRefusal(input({ roleFamily: null }), everyTab), "Choose what they are applying for.");
  assert.equal(placingRefusal(input({ roleFamily: "  " }), everyTab), "Choose what they are applying for.");
  assert.equal(placingRefusal(input({ roleFamily: "human_resources" }), everyTab), "Choose one of the roles on the list.", "the retired Human Resources files nowhere");
  assert.equal(placingRefusal(input({ roleFamily: "hr_section_head" }), taSeat), "You cannot file a CV in that tab.", "the Talent Acquisition seat never files into the HR tabs");
  assert.equal(placingRefusal(input({ roleFamily: "talent_acquisition" }), taSeat), "You cannot file a CV in that tab.");
  assert.equal(placingRefusal(input({ roleFamily: "hr_section_head" }), everyTab), null, "the owner may");
  assert.equal(placingRefusal(input({ areaCode: "D1-3", regionCode: "D1", roleFamily: "district_manager" }), everyTab), "Only a Medical Rep is filed under an area.");
  assert.equal(placingRefusal(input({ regionCode: "D1", roleFamily: "district_manager" }), everyTab), null, "a District Manager is filed by region");
  assert.equal(placingRefusal(input({ regionCode: "CA", roleFamily: "product_manager" }), everyTab), "This role is not split by region.");
  assert.equal(placingRefusal(input({ areaCode: "ALX-1" }), everyTab), "Choose the region before the area.");
  const tooMany = Object.fromEntries(Array.from({ length: PLACING_MAX_ANSWERS + 1 }, (_, index) => [`q${index}`, "x"]));
  assert.equal(placingRefusal(input({ answers: tooMany }), everyTab), "That is more answers than this form asks.");
  assert.equal(placingRefusal(input({ answers: { salary: 30000 as unknown as string } }), everyTab), "An answer is text.");
  assert.equal(placingRefusal(input({ answers: { salary: null } }), everyTab), null, "null clears an answer");
}

function questionTests(): void {
  const question = (patch: Partial<ChipQuestion> & { key: string }): ChipQuestion => ({
    appliesToRoleFamilies: null,
    bodyText: `${patch.key}?`,
    isActive: true,
    kind: "free_text",
    options: [],
    showIf: null,
    ...patch,
  });
  const context: AnswerChipContext = {
    builtInAudience: { area: null, background: null, experience: null, job_title: null, region: null, salary: ["medical_rep"] },
    questions: [
      question({ key: "military", bodyText: "Military service status?" }),
      question({ key: "field_age_band", appliesToRoleFamilies: ["medical_rep"], kind: "tappable", options: [{ title: "25 to 30", value: "25_30" }] }),
      question({ key: "oc_start_date", kind: "tappable", options: [{ title: "Immediately", value: "now" }] }),
      question({ key: "retired", isActive: false }),
      question({ key: "dm_only", appliesToRoleFamilies: ["district_manager"] }),
    ],
  };

  const rep = placingQuestionsFor("medical_rep", context);
  assert.deepEqual(
    rep.map((item) => item.key),
    ["background", "experience", "salary", "oc_start_date", "field_age_band", "military"],
    "a Medical Rep: the owner's six first, in his order, then the rest as the admin ordered them — never a retired question or another role's",
  );
  assert.equal(rep[0].label, "Graduated in", "his words");
  assert.deepEqual(
    rep[0].options.map((option) => option.title),
    Object.values(candidateBackgroundLabels),
    "Graduated in offers the bot's own choices",
  );
  assert.ok(rep[0].options.every((option) => option.value === option.title), "a choice is saved as the title the applicant would have tapped");
  assert.deepEqual(rep[2].options, [], "the expected salary is typed");
  assert.equal(rep[5].label, "Military service status?", "an admin question carries the admin's sentence");

  assert.deepEqual(
    placingQuestionsFor("district_manager", context).map((item) => item.key),
    ["background", "experience", "oc_start_date", "military", "dm_only"],
    "a District Manager is not asked the Medical Rep's salary or age, and is asked his own",
  );
}

function typedRoleTests(): void {
  // The form saves the chosen role's LABEL as the answer; every role it can offer must read back as itself.
  for (const family of placingRoleFamilies([...workspaceRoleTabs])) {
    assert.equal(roleFamilyForTypedRole(placingRoleLabel(family)), family, `"${placingRoleLabel(family)}" files as ${family}`);
  }
  assert.equal(roleFamilyForTypedRole("Medical Representative"), "medical_rep", "the form saves the role's label, and it files by it");
  assert.equal(roleFamilyForTypedRole("  district manager "), "district_manager", "whatever its case and spacing");
  assert.equal(roleFamilyForTypedRole("hr_section_head"), "hr_section_head", "a family key still reads as itself");
  assert.equal(roleFamilyForTypedRole(""), null);
  assert.equal(roleFamilyForTypedRole(null), null);
}

export function runRecruitmentWorkspaceTableTests(): void {
  fitZoomTests();
  columnTests();
  tableSourceTests();
  refusalTests();
  questionTests();
  typedRoleTests();
}
