import { NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { assertPermission } from "@/lib/auth/permissions";
import { isDevelopment } from "@/lib/env";
import { canExportPayslipDocument } from "@/lib/payroll/payslip-center";
import { getSalaryBatchExport } from "@/lib/payroll/service";
import {
  payrollMoneyHeaders,
  payrollSheetHeaders,
  payrollSheetSections,
  payrollSheetValue,
} from "@/lib/payroll/salary-sheet-fields";
import type { SalaryBatch, SalaryRecord } from "@/lib/payroll/types";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { filterPayslipRecords, isPublishedPayslipStatus, periodLabel } from "../route";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── helpers ──────────────────────────────────────────────────────────────────

function hx(hex: string) {
  const n = hex.replace("#", "");
  return rgb(
    parseInt(n.slice(0, 2), 16) / 255,
    parseInt(n.slice(2, 4), 16) / 255,
    parseInt(n.slice(4, 6), 16) / 255,
  );
}

function safeFilePart(value: string) {
  return value.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "payslip";
}

function asciiSafe(value: unknown): string {
  return String(value ?? "")
    .replace(/[•·]/g, "-").replace(/[—–]/g, "-").replace(/…/g, "...")
    .replace(/[""]/g, '"').replace(/['']/g, "'")
    .replace(/[^\x20-\x7E]/g, "");
}

function formatEGP(value: number) {
  return new Intl.NumberFormat("en-EG", {
    currency: "EGP",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(Number(value ?? 0));
}

function formatDate(value: string | null) {
  if (!value) return "-";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(d);
}

const HIDDEN_HEADERS = new Set([
  "#", "Month", "Year", "HR_ID", "Full Name", "Arabic Name",
  "Job Title", "Line", "Area", "Hire Date", "Payment Group", "Policy Comment",
]);

const VISIBLE_HEADERS = payrollSheetHeaders.filter(h => !HIDDEN_HEADERS.has(h));

// ─── palette ──────────────────────────────────────────────────────────────────

const P = {
  navy:      hx("#0F172A"),
  slate700:  hx("#334155"),
  slate500:  hx("#64748B"),
  slate200:  hx("#E2E8F0"),
  slate50:   hx("#F8FAFC"),
  white:     hx("#FFFFFF"),
  orange:    hx("#F97316"),
  orangeRed: hx("#EA580C"),
  teal:      hx("#0F766E"),
  green:     hx("#166534"),
  greenBg:   hx("#DCFCE7"),
  red:       hx("#991B1B"),
  redBg:     hx("#FEE2E2"),
  purple:    hx("#6D28D9"),
  purpleBg:  hx("#EDE9FE"),
  headerText: hx("#CBD5E1"),
  eyebrow:   hx("#FED7AA"),
  success:   hx("#4ADE80"),
};

function sectionFill(tone: typeof payrollSheetSections[0]["tone"]) {
  switch (tone) {
    case "employee":     return P.navy;
    case "fixed":        return P.teal;
    case "additions":    return P.green;
    case "governmental": return P.purple;
    case "deductions":   return hx("#DC2626");
    case "payment":      return P.orangeRed;
  }
}

// ─── PDF render ───────────────────────────────────────────────────────────────

const PW = 595;
const PH = 842;
const M  = 34;
const CW = PW - M * 2;

async function renderPayslipPdf(
  record: SalaryRecord,
  month: number,
  year: number,
  batchStatus: SalaryBatch["status"],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Phoenix Payslip — ${periodLabel(month, year)}`);
  doc.setCreator("Phoenix Workforce");

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold    = await doc.embedFont(StandardFonts.HelveticaBold);

  const PERIOD = periodLabel(month, year);
  const STATUS = batchStatus.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const isPublished = batchStatus === "approved" || batchStatus === "locked";

  // mutable page state — closures below capture the binding, not the value
  let page = doc.addPage([PW, PH]);
  let y    = PH;

  function addPage() {
    page = doc.addPage([PW, PH]);
    y    = PH - M;
  }

  function need(h: number) {
    if (y - h < M + 24) addPage();
  }

  type Color = ReturnType<typeof hx>;
  type Font  = typeof regular;

  function rect(x: number, top: number, w: number, h: number, color: Color) {
    page.drawRectangle({ x, y: top - h, width: w, height: h, color });
  }

  function txt(
    str: string,
    x: number,
    baseline: number,
    size: number,
    font: Font,
    color: Color,
    maxW?: number,
  ) {
    let s = asciiSafe(str);
    if (maxW !== undefined) {
      while (s.length > 1 && font.widthOfTextAtSize(s, size) > maxW) s = s.slice(0, -1);
      if (s.length < asciiSafe(str).length) s += "..";
    }
    page.drawText(s, { x, y: baseline, size, font, color });
  }

  // ── header band ─────────────────────────────────────────────────────────────
  // Compact header: 72pt band + 4pt stripe + 10pt gap = 86pt total
  const HEADER_H = 72;
  rect(0, PH, PW, 4, P.orange);
  rect(0, PH - 4, PW, HEADER_H, P.navy);

  txt("PAYROLL STATEMENT", M, PH - 16, 7, bold, P.eyebrow);
  txt("Payslip", M, PH - 36, 19, bold, P.white);
  txt(PERIOD, M, PH - 54, 9, bold, P.headerText);

  const RX = PW - M - 148;
  txt("PERIOD", RX, PH - 20, 6, bold, P.headerText);
  txt(PERIOD, RX, PH - 33, 9, bold, P.white, 148);
  txt("STATUS", RX, PH - 49, 6, bold, P.headerText);
  txt(STATUS, RX, PH - 62, 9, bold, isPublished ? P.success : P.eyebrow, 148);

  y = PH - 4 - HEADER_H - 10;

  // ── employee info + summary ──────────────────────────────────────────────────
  // Compact rows: 20pt each, 18pt title bar, 4pt card padding = 142pt card
  const HALF    = (CW - 10) / 2;
  const ROW_H   = 20;
  const TITLE_H = 18;

  const empFields: [string, string][] = [
    ["HR ID",     asciiSafe(record.employeeCode || record.hrId)],
    ["Full Name", asciiSafe(record.fullName)],
    ["Job Title", asciiSafe(record.jobTitle || "-")],
    ["Area",      asciiSafe(record.area || "-")],
    ["Line",      asciiSafe(record.line || "-")],
    ["Hire Date", formatDate(record.hireDate)],
  ];
  const CARD_H = TITLE_H + empFields.length * ROW_H + 4;
  const CARD_TOP = y;

  // employee card
  rect(M, CARD_TOP, HALF, 2, P.teal);
  rect(M, CARD_TOP - 2, HALF, CARD_H - 2, P.white);
  txt("EMPLOYEE INFORMATION", M + 8, CARD_TOP - TITLE_H + 6, 7, bold, P.slate700);

  let ery = CARD_TOP - TITLE_H - 3;
  for (const [lbl, val] of empFields) {
    rect(M + 6, ery, HALF - 12, ROW_H - 2, P.slate50);
    txt(lbl, M + 10, ery - ROW_H + 12, 6.5, bold, P.slate500);
    txt(val, M + 10, ery - ROW_H + 4,  8, bold, P.navy, HALF - 20);
    ery -= ROW_H;
  }

  // summary card
  const SX = M + HALF + 10;
  rect(SX, CARD_TOP, HALF, 2, P.orange);
  rect(SX, CARD_TOP - 2, HALF, CARD_H - 2, P.white);
  txt("PAYROLL SUMMARY", SX + 8, CARD_TOP - TITLE_H + 6, 7, bold, P.slate700);

  const metrics: { lbl: string; val: string; bg: Color; tc: Color }[] = [
    { lbl: "BASE SALARY",  val: formatEGP(record.baseSalary),  bg: P.slate50,  tc: P.navy },
    { lbl: "GROSS SALARY", val: formatEGP(record.grossSalary), bg: P.greenBg,  tc: P.green },
    { lbl: "NET SALARY",   val: formatEGP(record.netSalary),   bg: P.redBg,    tc: P.red },
    { lbl: "MONTH SALARY", val: formatEGP(record.monthSalary), bg: P.navy,     tc: P.white },
  ];
  const MH = (CARD_H - TITLE_H - 14 - 6) / 2;
  const MW = (HALF - 20 - 6) / 2;
  for (let i = 0; i < 4; i++) {
    const mc = i % 2;
    const mr = Math.floor(i / 2);
    const mx = SX + 8 + mc * (MW + 6);
    const mTop = CARD_TOP - TITLE_H - 6 - mr * (MH + 6);
    rect(mx, mTop, MW, MH, metrics[i].bg);
    txt(metrics[i].lbl, mx + 6, mTop - 10, 6, bold, metrics[i].tc);
    txt(asciiSafe(metrics[i].val), mx + 6, mTop - MH + 7, 10, bold, metrics[i].tc, MW - 10);
  }

  y = CARD_TOP - CARD_H - 10;

  // ── components table ─────────────────────────────────────────────────────────
  // 15pt rows, 12pt section bands, 16pt column header = fits 24 rows in ~436pt
  const RH = 15;
  const C1 = CW * 0.60;

  need(22);
  rect(M, y, CW, 16, P.navy);
  txt("COMPONENT",      M + 8,      y - 11, 6.5, bold, P.headerText);
  txt("AMOUNT / VALUE", M + C1 + 8, y - 11, 6.5, bold, P.headerText);
  y -= 16;

  let ri = 0;
  for (const section of payrollSheetSections) {
    const rows = payrollSheetHeaders
      .slice(section.start - 1, section.end)
      .filter(h => (VISIBLE_HEADERS as readonly string[]).includes(h));

    if (!rows.length) continue;

    need(13 + rows.length * RH);

    rect(M, y, CW, 12, sectionFill(section.tone));
    txt(section.label.toUpperCase(), M + 8, y - 8, 6.5, bold, P.white);
    y -= 12;

    for (const header of rows) {
      const raw = payrollSheetValue(record, month, year, 0, header);
      const fmtVal = asciiSafe(
        payrollMoneyHeaders.has(header)
          ? formatEGP(Number(raw ?? 0))
          : String(raw ?? "-"),
      );

      const isTotal =
        header === "Total Additions" ||
        header === "Governmental Deductions" ||
        header === "Total Deductions";

      const rowBg = isTotal
        ? (header === "Total Additions" ? P.greenBg : header === "Total Deductions" ? P.redBg : P.purpleBg)
        : (ri % 2 === 0 ? P.white : P.slate50);
      const rowColor = isTotal
        ? (header === "Total Additions" ? P.green : header === "Total Deductions" ? P.red : P.purple)
        : P.navy;

      rect(M, y, CW, RH, rowBg);
      page.drawLine({
        start: { x: M, y: y - RH },
        end:   { x: M + CW, y: y - RH },
        thickness: 0.5,
        color: P.slate200,
      });

      txt(asciiSafe(header), M + 8, y - RH + 4, 8, isTotal ? bold : regular, rowColor, C1 - 16);

      const vw = bold.widthOfTextAtSize(fmtVal, 8);
      txt(fmtVal, M + CW - 8 - vw, y - RH + 4, 8, bold, rowColor);

      y -= RH;
      ri++;
    }
  }

  // ── payment parts ─────────────────────────────────────────────────────────
  need(54);
  y -= 8;

  const parts: { lbl: string; val: string; bg: Color; tc: Color }[] = [
    { lbl: "FIRST PART",   val: formatEGP(record.firstPart),   bg: P.slate50, tc: P.navy },
    { lbl: "SECOND PART",  val: formatEGP(record.secondPart),  bg: P.slate50, tc: P.navy },
    { lbl: "MONTH SALARY", val: formatEGP(record.monthSalary), bg: P.navy,    tc: P.white },
  ];
  const PB = 40;
  const PW2 = (CW - 14) / 3;
  for (let i = 0; i < parts.length; i++) {
    const px = M + i * (PW2 + 7);
    rect(px, y, PW2, PB, parts[i].bg);
    txt(parts[i].lbl, px + 8, y - 11, 6, bold, parts[i].tc);
    txt(asciiSafe(parts[i].val), px + 8, y - 30, 11, bold, parts[i].tc, PW2 - 16);
  }
  y -= PB;

  // ── comment (single line, truncated to keep on page) ──────────────────────
  if (record.payrollComment) {
    need(30);
    y -= 8;
    txt("Comment:", M, y - 8, 7, bold, P.navy);
    txt(asciiSafe(record.payrollComment).slice(0, 200), M + 58, y - 8, 7, regular, P.slate500, CW - 58);
  }

  // ── footer on every page ──────────────────────────────────────────────────
  const pages = doc.getPages();
  const total = pages.length;
  for (let i = 0; i < total; i++) {
    const pg = pages[i];
    pg.drawLine({ start: { x: M, y: 26 }, end: { x: PW - M, y: 26 }, thickness: 0.5, color: P.slate200 });
    pg.drawText("Phoenix Workforce — Confidential Payroll Document", {
      x: M, y: 14, size: 7, font: regular, color: P.slate500,
    });
    const label = `Page ${i + 1} of ${total}`;
    pg.drawText(label, {
      x: PW - M - regular.widthOfTextAtSize(label, 7),
      y: 14, size: 7, font: regular, color: P.slate500,
    });
  }

  return doc.save();
}

// ─── route ────────────────────────────────────────────────────────────────────

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let batchId = "";

  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "payslips", "export");

    // Shared predicate, not a role literal: the admin page derives its own button visibility from
    // this same function, so the two cannot drift. See canExportPayslipDocument for why this is
    // narrower than Payslips Center page access (the CEO reads the Center but must not carry the
    // document out).
    if (!canExportPayslipDocument(access)) {
      return NextResponse.json(
        { error: "forbidden", message: "You are not allowed to export payslip documents." },
        { status: 403 },
      );
    }

    const { id } = await params;
    batchId = id;
    const exportData = await getSalaryBatchExport(id, access);

    if (exportData && !isPublishedPayslipStatus(exportData.batch.status)) {
      return NextResponse.json(
        { error: "payslips_not_published", message: "Payslips are available only after payroll is approved or locked." },
        { status: 409 },
      );
    }

    const records = exportData ? filterPayslipRecords(exportData.records, request.url) : [];
    if (!exportData || records.length === 0) {
      return NextResponse.json(
        { error: "not_found", message: "No payslip records found for this batch and user." },
        { status: 404 },
      );
    }

    if (records.length > 1) {
      return NextResponse.json(
        { error: "single_payslip_required", message: "Choose one employee before exporting a payslip." },
        { status: 400 },
      );
    }

    const pdf = await renderPayslipPdf(
      records[0],
      exportData.batch.month,
      exportData.batch.year,
      exportData.batch.status,
    );

    const employee = safeFilePart(records[0].hrId || records[0].employeeCode || records[0].fullName);
    const period   = safeFilePart(periodLabel(exportData.batch.month, exportData.batch.year));

    return new Response(Buffer.from(pdf), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="phoenix-payslip-${employee}-${period}.pdf"`,
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Failed to export payslip.");
    const responseMessage = isDevelopment ? message : "Failed to export payslip.";

    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: responseMessage }, { status: 403 });
    }

    if (isDevelopment) {
      console.error("[admin] /api/payroll/[id]/payslips/image failed", { batchId, error });
    }

    return NextResponse.json({ error: "payslip_image_failed", message: responseMessage }, { status: 500 });
  }
}
