import { buildPhoenixTableWorkbook, type ExportRow } from "@/lib/export/table-workbook";
import type { EmployeePlan } from "@/lib/weekly-planning/service";

const planExportColumns = [
  { key: "employeeName", label: "Employee", width: 28 },
  { key: "employeeHrId", label: "HR ID", width: 16 },
  { key: "planKind", label: "Plan", width: 12 },
  { key: "periodKey", label: "Period", width: 14 },
  { key: "revision", label: "Revision", numeric: true, width: 10 },
  { key: "status", label: "Status", width: 18 },
  { key: "managerName", label: "Manager", width: 24 },
  { key: "activityDate", label: "Date", width: 14 },
  { key: "time", label: "Time", width: 16 },
  { key: "activityType", label: "Activity Type", width: 18 },
  { key: "activityTitle", label: "Title", width: 28 },
  { key: "objective", label: "Objective", width: 34 },
  { key: "attendees", label: "Attendees", width: 26 },
  { key: "locationText", label: "Location", width: 24 },
  { key: "area", label: "Area", width: 18 },
  { key: "doubleVisitMedicalRepName", label: "Double Visit Medical Rep", width: 28 },
  { key: "notes", label: "Notes", width: 36 },
  { key: "returnNotes", label: "Return Notes", width: 40 },
  { key: "managerDecision", label: "Manager Decision", width: 20 },
  { key: "ceoDecision", label: "CEO Decision", width: 20 },
] as const;

function statusLabel(value: string | null | undefined) {
  return value ? value.replace(/_/g, " ") : "";
}

function compactText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function flattenEmployeePlansForExport(plans: EmployeePlan[]): ExportRow[] {
  return plans.flatMap((plan) => {
    const items = plan.items.length > 0
      ? plan.items
      : [{
          activityDate: plan.periodStartDate,
          activityTitle: "",
          activityType: "",
          area: null,
          attendees: null,
          doubleVisitMedicalRepName: null,
          endTime: null,
          locationText: null,
          notes: "",
          objective: null,
          returnNotes: [],
          startTime: null,
        }];

    return items.map((item) => ({
      activityDate: item.activityDate,
      activityTitle: item.activityTitle,
      activityType: item.activityType,
      area: item.area,
      attendees: item.attendees,
      ceoDecision: statusLabel(plan.status.startsWith("ceo_") || plan.status === "final_approved" || plan.status === "hr_acknowledged" ? plan.status : ""),
      doubleVisitMedicalRepName: item.doubleVisitMedicalRepName,
      employeeHrId: plan.employeeHrId,
      employeeName: plan.employeeName,
      locationText: item.locationText,
      managerDecision: statusLabel(plan.status === "manager_approved" || plan.status.startsWith("manager_") ? plan.status : ""),
      managerName: plan.managerName,
      notes: item.notes,
      objective: item.objective,
      periodKey: plan.periodKey,
      planKind: plan.planKind,
      returnNotes: item.returnNotes.map((note) => `${note.actorRole ?? "Reviewer"}: ${note.note}`).join(" | "),
      revision: plan.revision,
      status: statusLabel(plan.status),
      time: [item.startTime, item.endTime].filter(Boolean).join(" - "),
    }));
  });
}

export async function buildEmployeePlansWorkbook(plans: EmployeePlan[]) {
  const output = await buildPhoenixTableWorkbook({
    columns: [...planExportColumns],
    rows: flattenEmployeePlansForExport(plans),
    sheetName: "Plans",
    subtitle: `Phoenix Workforce - ${plans.length} plan(s) exported ${new Date().toLocaleString("en-GB")}`,
    title: "Weekly / Monthly Plans",
  });
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}

function pdfText(value: unknown, maxLength = 150) {
  return compactText(value)
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .slice(0, maxLength);
}

function pdfLine(row: ExportRow) {
  return [
    row.employeeName,
    row.planKind,
    row.periodKey,
    row.status,
    row.activityDate,
    row.activityType,
    row.activityTitle,
    row.area,
  ].map(compactText).join(" | ");
}

export function buildEmployeePlansPdf(plans: EmployeePlan[]) {
  const rows = flattenEmployeePlansForExport(plans);
  const lines = [
    "Weekly / Monthly Plans",
    `Generated: ${new Date().toISOString().slice(0, 10)}`,
    `Plans: ${plans.length}`,
    `Rows: ${rows.length}`,
    "",
    "Employee | Plan | Period | Status | Date | Type | Title | Area",
    ...rows.map(pdfLine),
  ];
  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += 48) {
    pages.push(lines.slice(index, index + 48));
  }
  if (pages.length === 0) pages.push(lines);

  const objects: string[] = [];
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  const kids: string[] = [];
  pages.forEach((pageLines, index) => {
    const pageObjectNumber = 4 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    kids.push(`${pageObjectNumber} 0 R`);
    const content = `BT /F1 9 Tf 36 792 Td 12 TL ${pageLines.map((line) => `(${pdfText(line)}) Tj`).join(" T* ")} ET`;
    objects[pageObjectNumber - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`;
    objects[contentObjectNumber - 1] = `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`;
  });

  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(pdf, "utf8");
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}
