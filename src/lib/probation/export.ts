import ExcelJS from "exceljs";

import type { ProbationRow, TrafficStatus } from "@/lib/probation/types";

const headerFill = "FFF97316";
const headerFont = "FFFFFFFF";
const borderColor = "FFE2E8F0";

function cleanText(value: unknown, maxLength = 32767) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .slice(0, maxLength);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function trafficStatus(daysRemaining: number): TrafficStatus {
  if (daysRemaining > 60) return "safe";
  if (daysRemaining >= 30) return "warning";
  return "critical";
}

function workflowLabel(status: string | null | undefined) {
  return status ? status.replace(/_/g, " ") : "not requested";
}

function decisionLabel(value: string | null | undefined) {
  return value ? value.replace(/_/g, " ") : "";
}

export async function generateProbationWorkbook(rows: ProbationRow[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.company = "Phoenix Workforce";
  workbook.subject = "Probation Export";
  workbook.title = "Phoenix Workforce | Probation Export";
  workbook.created = new Date();
  workbook.modified = new Date();

  const worksheet = workbook.addWorksheet("Probation");
  worksheet.columns = [
    { header: "HR ID", key: "hrId", width: 16 },
    { header: "CRM ID", key: "crmId", width: 16 },
    { header: "Full Name", key: "fullName", width: 30 },
    { header: "Job Title", key: "jobTitle", width: 26 },
    { header: "Line", key: "line", width: 18 },
    { header: "Area", key: "area", width: 18 },
    { header: "Employment Status", key: "employmentStatus", width: 20 },
    { header: "Hire Date", key: "hireDate", width: 14 },
    { header: "Probation End Date", key: "probationEndDate", width: 20 },
    { header: "Days Remaining", key: "daysRemaining", width: 16 },
    { header: "Risk Zone", key: "riskZone", width: 14 },
    { header: "Probation Status", key: "workflowStatus", width: 22 },
    { header: "Decision", key: "decision", width: 16 },
    { header: "Manager Feedback", key: "managerFeedback", width: 36 },
    { header: "HR Recommendation", key: "hrRecommendation", width: 36 },
    { header: "Decision Reason", key: "decisionReason", width: 36 },
  ];

  for (const row of rows) {
    worksheet.addRow({
      area: cleanText(row.area_name),
      crmId: cleanText(row.crm_id),
      daysRemaining: row.days_remaining,
      decision: decisionLabel(row.workflow?.decision),
      decisionReason: cleanText(row.workflow?.decisionReason),
      employmentStatus: cleanText(row.employment_status),
      fullName: cleanText(row.full_name),
      hireDate: cleanText(row.hire_date),
      hrId: cleanText(row.hr_id),
      hrRecommendation: cleanText(row.workflow?.hrRecommendation),
      jobTitle: cleanText(row.job_title),
      line: cleanText(row.line_name),
      managerFeedback: cleanText(row.workflow?.managerFeedback),
      probationEndDate: cleanText(row.probation_end_date),
      riskZone: trafficStatus(row.days_remaining),
      workflowStatus: workflowLabel(row.workflow?.status),
    });
  }

  const header = worksheet.getRow(1);
  header.font = { bold: true, color: { argb: headerFont } };
  header.fill = { fgColor: { argb: headerFill }, pattern: "solid", type: "pattern" };
  header.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  header.eachCell((cell) => {
    cell.border = {
      bottom: { color: { argb: borderColor }, style: "thin" },
      left: { color: { argb: borderColor }, style: "thin" },
      right: { color: { argb: borderColor }, style: "thin" },
      top: { color: { argb: borderColor }, style: "thin" },
    };
  });

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    worksheet.getRow(rowNumber).eachCell((cell) => {
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = {
        bottom: { color: { argb: borderColor }, style: "thin" },
        left: { color: { argb: borderColor }, style: "thin" },
        right: { color: { argb: borderColor }, style: "thin" },
        top: { color: { argb: borderColor }, style: "thin" },
      };
    });
  }

  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = {
    from: { column: 1, row: 1 },
    to: { column: worksheet.columns.length, row: Math.max(1, worksheet.rowCount) },
  };

  const output = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}

function pdfText(value: unknown, maxLength = 130) {
  return String(value ?? "")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .slice(0, maxLength);
}

function pdfLine(row: ProbationRow) {
  return [
    row.hr_id,
    row.full_name,
    row.job_title,
    row.line_name,
    row.area_name,
    row.probation_end_date,
    `${row.days_remaining}d`,
    trafficStatus(row.days_remaining),
    workflowLabel(row.workflow?.status),
  ].map((value) => String(value ?? "").replace(/\s+/g, " ").trim()).join(" | ");
}

export function generateProbationPdf(rows: ProbationRow[]) {
  const generatedAt = new Date().toISOString().slice(0, 10);
  const lines = [
    "Phoenix Workforce - Probation Export",
    `Generated: ${generatedAt}`,
    `Records: ${rows.length}`,
    "",
    "HR ID | Name | Job Title | Line | Area | End Date | Days | Zone | Probation Status",
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
