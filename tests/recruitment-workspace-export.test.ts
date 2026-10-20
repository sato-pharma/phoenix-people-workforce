import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import {
  EXPORT_NOT_ANSWERED,
  buildWorkspaceWorkbook,
  workspaceExportAnswerColumns,
  workspaceExportFilename,
  workspaceExportFilterLine,
  workspaceExportHeaders,
  workspaceExportRowValues,
} from "../src/lib/recruitment/workspace/export-workbook.ts";
import { emptyWorkspaceFilters } from "../src/lib/recruitment/workspace/filters.ts";
import type { WorkspaceAnswerChip, WorkspaceRow } from "../src/lib/recruitment/workspace/types.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The recruitment workspace's current view as a workbook (owner's plan, 20 Oct 2026).
//
// One column per question, from the applicant's own replies: "Not answered" where they were asked and
// did not answer, "(added by HR)" where HR typed it, BLANK where they were never asked. Every name a
// link to the CV. The route gates on `recruitment: export` AND the workspace's own viewer, so the tabs
// and the Talent Acquisition fence are the screen's, applied in the database filter.
// ─────────────────────────────────────────────────────────────────────────────

const ORIGIN = "https://phoenix-hr.satopharma.com";
const ID_A = "0b5c8a52-3f0e-4d55-9a4c-2f1d6e7a8b90";
const ID_B = "7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

function chip(key: string, label: string, value: string | null, overrides: Partial<WorkspaceAnswerChip> = {}): WorkspaceAnswerChip {
  return { addedByHr: null, key, label, lead: false, rawValue: value, value, ...overrides };
}

function person(overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    answers: [],
    archivedAt: null,
    completeness: null,
    duplicate: null,
    email: null,
    folders: [],
    hasCvFile: true,
    id: ID_A,
    interview: null,
    latestCall: null,
    latestSend: null,
    name: "Mona Adel",
    offerId: null,
    overdue: null,
    phone: null,
    placements: [],
    receivedAt: "2026-10-20T09:05:00.000Z", // 12:05 Cairo
    rejection: null,
    returned: null,
    source: "whatsapp",
    status: "new",
    statusChangedAt: null,
    ...overrides,
  };
}

const MONA = person({
  answers: [
    chip("role", "Applying for", "Medical Rep", { lead: true }),
    chip("background", "Graduated in", "Pharmacy", { lead: true }),
    chip("salary", "Expected monthly net salary", null, { lead: true }),
    chip("car_owner", "Do you own a car?", "Yes"),
  ],
  email: "mona@example.com",
  interview: { bookingId: "b1", outcome: "attended", startsAt: "2026-10-22T08:00:00.000Z" },
  latestCall: { at: "2026-10-20T10:00:00.000Z", byName: "Yasmeena", note: null, result: "no_answer" },
  phone: "01001234567",
  placements: [
    {
      areaCode: "AB2",
      areaName: "Smouha",
      botRoleFamily: "medical_rep",
      placedAt: "2026-10-20T09:05:00.000Z",
      placedBy: "whatsapp",
      placedByName: null,
      regionCode: "AB",
      regionName: "Alex-BHR",
      tab: "medical_rep",
    },
  ],
});

// Asked a different set: the extra question first, then a lead the HR desk typed for them.
const KARIM = person({
  answers: [
    chip("field_age_band", "Age", "25 to 30", { lead: true }),
    chip("experience", "Years of experience", "3", {
      addedByHr: { at: "2026-10-20T11:00:00.000Z", hrId: "B-20", name: "Yasmeena" },
      lead: true,
    }),
    chip("governorate", "Which governorate?", null),
  ],
  archivedAt: "2026-10-19T00:00:00.000Z",
  id: ID_B,
  name: "Karim Samir",
  rejection: { note: null, reason: "salary_too_high" },
  source: "email",
  status: "rejected",
});

function flat(file: string): string {
  return stripComments(readFileSync(file, "utf8")).replace(/\s+/g, " ");
}

export async function runRecruitmentWorkspaceExportTests(): Promise<void> {
  // ── 1 · One column per question, the Medical Rep six first ───────────────────────────────────
  const columns = workspaceExportAnswerColumns([MONA, KARIM]);
  assert.deepEqual(
    columns.map((column) => column.key),
    ["role", "background", "salary", "field_age_band", "experience", "car_owner", "governorate"],
    "RED every lead question first, then the rest, each in the order it first appears",
  );
  const headers = workspaceExportHeaders(columns);
  assert.deepEqual(headers.slice(0, 7), ["Name", "Phone", "Email", "Source", "Received (Cairo)", "Status", "Filed in"]);
  assert.deepEqual(headers.slice(7, 14), ["Applying for", "Graduated in", "Expected monthly net salary", "Age", "Years of experience", "Do you own a car?", "Which governorate?"]);
  assert.deepEqual(headers.slice(14), ["Latest call (Cairo)", "Returned by a manager (Cairo)", "Interview (Cairo)"]);

  // ── 2 · One person's row ─────────────────────────────────────────────────────────────────────
  const mona = workspaceExportRowValues(MONA, columns, { origin: `${ORIGIN}/`, tab: "medical_rep" });
  const at = (label: string) => headers.indexOf(label);
  assert.equal(mona.cells[at("Name")], "Mona Adel");
  assert.equal(mona.cells[at("Phone")], "01001234567");
  assert.equal(mona.cells[at("Source")], "WhatsApp");
  assert.equal(mona.cells[at("Received (Cairo)")], "20 Oct 2026, 12:05 PM", "Cairo, never UTC");
  assert.equal(mona.cells[at("Status")], "New");
  assert.equal(mona.cells[at("Filed in")], "Medical Rep · Alex-BHR · Smouha", "names, never codes");
  assert.equal(mona.cells[at("Expected monthly net salary")], EXPORT_NOT_ANSWERED, "RED asked and not answered");
  assert.equal(mona.cells[at("Age")], "", "RED never asked: blank, never 'Not answered'");
  assert.equal(mona.cells[at("Do you own a car?")], "Yes");
  assert.equal(mona.cells[at("Latest call (Cairo)")], "No answer · 20 Oct 2026, 1:00 PM · Yasmeena");
  assert.equal(mona.cells[at("Interview (Cairo)")], "22 Oct 2026, 11:00 AM · Attended");
  assert.equal(mona.cells[at("Returned by a manager (Cairo)")], "");
  const link = new URL(mona.nameHref ?? "");
  assert.equal(link.origin, ORIGIN, "the trailing slash on the origin does not double up");
  assert.equal(link.searchParams.get("candidate"), ID_A, "RED the name opens that CV");
  assert.equal(link.searchParams.get("tab"), "medical_rep", "in the tab the file was taken from");

  const karim = workspaceExportRowValues(KARIM, columns, { origin: ORIGIN, tab: "folders" });
  assert.equal(karim.cells[at("Status")], "Rejected — Salary too high (archived)", "the reason and the archive, in words");
  assert.equal(karim.cells[at("Filed in")], "Needs placing");
  assert.equal(karim.cells[at("Years of experience")], "3 (added by HR)", "RED HR's own answer is marked as HR's");
  assert.equal(karim.cells[at("Applying for")], "");
  assert.equal(karim.cells[at("Which governorate?")], EXPORT_NOT_ANSWERED);
  assert.equal(karim.cells[at("Source")], "Email");
  assert.equal(new URL(karim.nameHref ?? "").searchParams.get("tab"), null, "the folders view is not a tab a CV opens in");
  assert.equal(workspaceExportRowValues(KARIM, columns).nameHref, null, "no origin, no link");

  const other = workspaceExportRowValues(person({ rejection: { note: "Moved abroad", reason: "other" }, status: "rejected" }), []);
  assert.equal(other.cells[5], "Rejected — Other: Moved abroad");

  // The screen's word, one source: answer-chips.ts is read as text (it talks to the database).
  assert.match(
    readFileSync("src/lib/recruitment/workspace/answer-chips.ts", "utf8"),
    new RegExp(`export const NOT_ANSWERED_LABEL = "${EXPORT_NOT_ANSWERED}";`),
    "the file says exactly what the screen's amber chip says",
  );

  // ── 3 · The file's name and its subtitle say what it holds, in words ─────────────────────────
  assert.equal(workspaceExportFilename("medical_rep", "2026-10-20T21:30:00.000Z"), "recruitment-cvs-medical-rep-21-oct-2026.xlsx", "RED the Cairo day, not the UTC one");
  assert.equal(workspaceExportFilename(null, "2026-10-20T09:00:00.000Z"), "recruitment-cvs-every-tab-20-oct-2026.xlsx");
  assert.equal(workspaceExportFilterLine(emptyWorkspaceFilters(), "medical_rep"), "Medical Rep · no other filter");
  assert.equal(
    workspaceExportFilterLine(
      { ...emptyWorkspaceFilters(), area: "AB2", datePick: "today", overdue: false, region: "AB", statuses: ["new", "shortlisted"] },
      "medical_rep",
      [MONA],
    ),
    "Medical Rep · Alex-BHR · Smouha · New or Shortlisted · received today · not overdue",
  );
  assert.equal(
    workspaceExportFilterLine({ ...emptyWorkspaceFilters(), fromDate: "2026-10-01", toDate: "2026-10-15", archived: "include" }, "district_manager"),
    "District Manager · received 1 Oct 2026 to 15 Oct 2026 (Cairo) · archived included",
  );

  // ── 4 · The emitted workbook: read it back, never trust the builder ──────────────────────────
  const buffer = await buildWorkspaceWorkbook({
    filters: emptyWorkspaceFilters(),
    generatedAtIso: "2026-10-20T12:00:00.000Z",
    origin: ORIGIN,
    rows: [MONA, KARIM],
    tab: "medical_rep",
    truncatedAt: null,
  });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as Parameters<typeof book.xlsx.load>[0]);
  const sheet = book.getWorksheet("CVs");
  assert.ok(sheet, "one sheet, named for what it holds");
  let headerRow = 0;
  sheet.eachRow((excelRow, number) => {
    if (!headerRow && excelRow.getCell(1).value === "Name") headerRow = number;
  });
  assert.ok(headerRow > 0, "the header row is in the file");
  const written = headers.map((_, index) => sheet.getRow(headerRow).getCell(index + 1).value);
  assert.deepEqual(written, headers, "the file's headings are the headings");
  const nameCell = sheet.getRow(headerRow + 1).getCell(1).value as { hyperlink?: string; text?: string };
  assert.equal(nameCell.text, "Mona Adel");
  assert.equal(nameCell.hyperlink, mona.nameHref, "RED the name in the FILE is the link to the CV");
  assert.equal(sheet.getRow(headerRow + 2).getCell(at("Years of experience") + 1).value, "3 (added by HR)");

  const empty = new ExcelJS.Workbook();
  await empty.xlsx.load(
    (await buildWorkspaceWorkbook({ filters: emptyWorkspaceFilters(), generatedAtIso: "2026-10-20T12:00:00.000Z", rows: [], tab: "other" })) as unknown as Parameters<typeof empty.xlsx.load>[0],
  );
  const said: string[] = [];
  empty.getWorksheet("CVs")?.eachRow((excelRow) => said.push(String(excelRow.getCell(1).value ?? "")));
  assert.ok(said.includes("No CVs match these filters."), "an empty export says so rather than handing over a blank grid");

  // ── 5 · The route: two gates, the screen's own filter, a rate limit, never cached ────────────
  const route = flat("app/api/recruitment/workspace/export/route.ts");
  assert.match(route, /requireRecruitmentAccess\(request, "recruitment", "export"\)/, "RED taking CVs off the system is the export grant");
  assert.match(route, /const viewer = workspaceViewer\(access\); if \(!viewer\.canRead\) throw forbiddenError/, "RED and the workspace's own rule");
  assert.match(route, /assertExportRateLimit\(\{ actor: access\.hrId \?\? access\.loginId, request, scope: "export:recruitment:workspace", \}\)/);
  assert.match(route, /isApiRateLimitError\(error\)\) \{ return NextResponse\.json\( .*status: 429/, "a rate-limited export answers 429");
  assert.match(
    route,
    /loadWorkspaceRowsForExport\(filters, viewer, \{ max: ceiling \+ 1 \}\)/,
    "RED the rows come from the workspace's own loader, behind the viewer's tabs and the fence",
  );
  assert.match(route, /origin: trustedOriginForRedirect\(request\)/, "a link in the file cannot be pointed at another host");
  assert.match(route, /"Cache-Control": "no-store"/);
}
