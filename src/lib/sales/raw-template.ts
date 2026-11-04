import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import { salesDistributorCode } from "@/lib/sales/normalizer/distributor-templates";
import { resolveDistributorProfile } from "@/lib/sales/normalizer/distributor-profile-store";
import { secondLayoutProfile } from "@/lib/sales/normalizer/profiles";
import type { DistributorProfile } from "@/lib/sales/normalizer/types";

// ── Per-distributor RAW emergency template ─────────────────────────────────────────────────────
// Each distributor gets its OWN blank template whose columns mimic that distributor's real raw
// export (pulled from its recognition profile) — NOT a unified Phoenix layout. When a distributor
// sends an unreadable file and the business must upload urgently, the user copies the data into
// this template and uploads; because the headers match the profile, the normalizer recognizes it.

// Pure: the ordered list of raw column headers this distributor's sheet is expected to carry.
// Product columns are genuine separate columns (code and/or name), so all are included; the other
// groups are fallback aliases, so only the first (canonical) alias is emitted. Order mirrors a
// typical sales export: item → qty → date → customer → territory → brick → discount → bonus.
export function rawTemplateHeaders(profile: DistributorProfile): string[] {
  const out: string[] = [];
  const push = (header: string | undefined) => {
    const h = (header ?? "").trim();
    if (h && !out.includes(h)) out.push(h);
  };
  for (const c of profile.productColumns ?? []) push(c);
  push((profile.qtyColumns ?? [])[0]);
  push((profile.dateColumns ?? [])[0]);
  push((profile.customerCodeColumns ?? [])[0]);
  push((profile.customerNameColumns ?? [])[0]);
  push((profile.customerAddressColumns ?? [])[0]);
  push((profile.territoryColumns ?? [])[0]);
  push((profile.brickIdColumns ?? [])[0]);
  push((profile.discountColumns ?? [])[0]);
  push((profile.bonusColumns ?? [])[0]);
  return out;
}

// Pure-ish workbook builder (no I/O beyond ExcelJS in-memory) so it can be unit-tested.
export function buildRawTemplateWorkbook(input: {
  distributorCode: string;
  distributorName: string;
  headers: string[];
  hasDateColumn: boolean;
}): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;

  const sheet = workbook.addWorksheet("Raw");
  const header = sheet.addRow(input.headers);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((cell) => { cell.fill = { fgColor: { argb: "FF0B0B0B" }, pattern: "solid", type: "pattern" }; });
  for (let c = 1; c <= input.headers.length; c += 1) sheet.getColumn(c).width = 20;
  // A few blank rows so the file opens ready to paste into.
  for (let r = 0; r < 100; r += 1) sheet.addRow(input.headers.map(() => ""));

  const notes = workbook.addWorksheet("How to use");
  notes.getColumn(1).width = 100;
  const lines = [
    `Emergency raw template — ${input.distributorName} (${input.distributorCode})`,
    "",
    "Use this ONLY when the distributor's own file cannot be read by the system but you must upload now.",
    "1. Paste each sale as one row under the matching column on the 'Raw' sheet.",
    "2. Keep the header row exactly as-is — the columns mimic this distributor's real export.",
    "3. Do not add Phoenix code columns; the system codes the rows for you on upload.",
    input.hasDateColumn
      ? "4. Fill the date column for every row."
      : "4. This distributor's sheet has no date column — pick the period in the upload screen.",
    "5. Upload on Sales Upload → this distributor → Upload Monthly Sales.",
  ];
  lines.forEach((line) => notes.addRow([line]));

  return workbook.xlsx.writeBuffer();
}

// Resolve the distributor's profile (DB-first, honoring overrides) and emit its raw template.
export async function buildRawDistributorTemplate(distributorCode: string): Promise<{ buffer: ExcelJS.Buffer; distributorName: string; headers: string[] }> {
  // EPDA Bulk 2 downloads its own layout. Its code goes no further than this: the sheet is stamped with the real distributor.
  const realCode = salesDistributorCode(distributorCode);
  const profile = realCode !== distributorCode ? secondLayoutProfile(realCode) : await resolveDistributorProfile(distributorCode);
  if (!profile) throw new Error(`No distributor profile for ${distributorCode}.`);
  const headers = rawTemplateHeaders(profile);
  if (headers.length === 0) throw new Error(`Distributor ${distributorCode} has no recognizable columns to template.`);
  const buffer = await buildRawTemplateWorkbook({
    distributorCode: profile.distributorCode,
    distributorName: profile.distributorName,
    headers,
    hasDateColumn: (profile.dateColumns ?? []).length > 0,
  });
  return { buffer, distributorName: profile.distributorName, headers };
}
