import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isDevelopment } from "@/lib/env";
import {
  payrollMoneyHeaders,
  payrollSheetHeaders,
  payrollSheetSections,
  payrollSheetValue,
  type PayrollSheetHeader,
} from "@/lib/payroll/salary-sheet-fields";
import { getSalaryBatchExport } from "@/lib/payroll/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import type { SalaryBatch, SalaryRecord } from "@/lib/payroll/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const date = dateOnlyMatch
    ? new Date(Date.UTC(
        Number(dateOnlyMatch[1]),
        Number(dateOnlyMatch[2]) - 1,
        Number(dateOnlyMatch[3]),
      ))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

function isLikelyUuidError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("invalid input syntax for type uuid") || normalized.includes("malformed uuid");
}

function periodLabel(month: number, year: number) {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function payslipStatusLabel(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isPublishedPayslipStatus(status: string) {
  return status === "approved" || status === "locked";
}

function payslipStatusClass(status: SalaryBatch["status"]) {
  return isPublishedPayslipStatus(status) ? "published" : "draft";
}

function infoRow(label: string, value: unknown) {
  return `
    <div class="info-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "-")}</strong>
    </div>
  `;
}

function formatPayrollSheetCell(header: PayrollSheetHeader, value: unknown) {
  if (header === "Hire Date") return escapeHtml(formatDate(value ? String(value) : null));
  if (payrollMoneyHeaders.has(header)) return formatEGP(Number(value ?? 0));
  return escapeHtml(value || "-");
}

const payslipHiddenHeaders = new Set<PayrollSheetHeader>([
  "#",
  "Month",
  "Year",
  "HR_ID",
  "Full Name",
  "Arabic Name",
  "Job Title",
  "Line",
  "Area",
  "Hire Date",
  "Payment Group",
  "Policy Comment",
]);

const payslipDisplayHeaders = payrollSheetHeaders.filter((header) => !payslipHiddenHeaders.has(header));

const payslipTotalRowClassByHeader: Partial<Record<PayrollSheetHeader, string>> = {
  "Governmental Deductions": "total-row governmental-deductions-row",
  "Total Additions": "total-row total-additions-row",
  "Total Deductions": "total-row total-deductions-row",
};

function payslipRowClass(header: PayrollSheetHeader) {
  return payslipTotalRowClassByHeader[header] ?? "";
}

function monthlySheetRows(record: SalaryRecord, month: number, year: number, recordIndex: number) {
  return payrollSheetSections.map((section) => {
    const rows = payrollSheetHeaders
      .slice(section.start - 1, section.end)
      .filter((header) => payslipDisplayHeaders.includes(header))
      .map((header) => {
        const value = payrollSheetValue(record, month, year, recordIndex, header);
        const rowClass = payslipRowClass(header);

        return `
          <tr${rowClass ? ` class="${rowClass}"` : ""}>
            <td><span class="component-name">${escapeHtml(header)}</span></td>
            <td>${formatPayrollSheetCell(header, value)}</td>
          </tr>
        `;
      })
      .join("");

    if (!rows) return "";

    return `
      <tbody>
        <tr class="section-row section-${escapeHtml(section.tone)}"><td colspan="2">${escapeHtml(section.label)}</td></tr>
        ${rows}
      </tbody>
    `;
  }).join("");
}

function payslip(record: SalaryRecord, month: number, year: number, batchStatus: SalaryBatch["status"], recordIndex: number) {
  return `
    <article class="payslip">
      <header class="statement-header">
        <div>
          <div class="eyebrow">Payroll Statement</div>
          <h1>Payslip</h1>
          <p>${escapeHtml(periodLabel(month, year))}</p>
        </div>
        <img alt="Phoenix" src="/brand/phoenix-main-logo.png" />
        <div class="statement-meta">
          <div>
            <span>Period</span>
            <strong>${escapeHtml(periodLabel(month, year))}</strong>
          </div>
          <div>
            <span>Status</span>
            <strong class="status-chip ${payslipStatusClass(batchStatus)}">${escapeHtml(payslipStatusLabel(batchStatus))}</strong>
          </div>
        </div>
      </header>

      <main class="payslip-body">
        <section class="grid two">
          <div class="card employee-card">
            <div class="card-title">
              <span class="icon">i</span>
              <div>
                <h2>Employee information</h2>
                <p>Master data snapshot for this payroll document.</p>
              </div>
            </div>
            <div class="info-list">
              ${infoRow("HR ID", record.employeeCode)}
              ${infoRow("Employee name", record.fullName)}
              ${infoRow("Arabic name", record.nameAr)}
              ${infoRow("Job title", record.jobTitle)}
              ${infoRow("Area", record.area)}
              ${infoRow("Line", record.line)}
              ${infoRow("Hire Date", formatDate(record.hireDate))}
            </div>
          </div>

          <div class="card summary-card">
            <div class="card-title">
              <div>
                <h2>Payroll summary</h2>
                <p>Gross pay, adjustments, deductions, and final salary.</p>
              </div>
            </div>
            <div class="summary-stack">
              <div class="metric muted">
                <span>Base Salary</span>
                <strong>${formatEGP(record.baseSalary)}</strong>
              </div>
              <div class="metric add">
                <span>Gross Salary</span>
                <strong>${formatEGP(record.grossSalary)}</strong>
              </div>
              <div class="metric deduct">
                <span>Net Salary</span>
                <strong>${formatEGP(record.netSalary)}</strong>
              </div>
              <div class="metric net">
                <span>Month Salary</span>
                <strong>${formatEGP(record.monthSalary)}</strong>
              </div>
            </div>
          </div>
        </section>

        <section class="card table-card uploaded-sheet">
          <div class="sheet-scroll">
            <table class="payslip-components">
              <thead><tr><th>Component</th><th>Amount / Value</th></tr></thead>
              ${monthlySheetRows(record, month, year, recordIndex)}
            </table>
          </div>
        </section>

        <section class="parts">
          <div class="part-card">
            <span>First Part</span>
            <strong>${formatEGP(record.firstPart)}</strong>
          </div>
          <div class="part-card">
            <span>Second Part</span>
            <strong>${formatEGP(record.secondPart)}</strong>
          </div>
          <div class="part-card net">
            <span>Month Salary</span>
            <strong>${formatEGP(record.monthSalary)}</strong>
          </div>
        </section>

        ${record.payrollComment ? `
          <section class="comment">
            <h2>Comment</h2>
            <p>${escapeHtml(record.payrollComment)}</p>
          </section>
        ` : ""}
      </main>
    </article>
  `;
}

function page(records: SalaryRecord[], month: number, year: number, batchStatus: SalaryBatch["status"]) {
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Phoenix Payslips - ${escapeHtml(periodLabel(month, year))}</title>
      <style>
        :root {
          --ink: #0f172a;
          --muted: #64748b;
          --paper: #f8fafc;
          --card: #ffffff;
          --line: #e2e8f0;
          --navy: #0f172a;
          --orange: #f97316;
          --green: #15803d;
          --green-soft: #dcfce7;
          --red: #dc2626;
          --red-soft: #fee2e2;
          --purple: #6d28d9;
          --purple-soft: #ede9fe;
          --teal: #0f766e;
          --teal-soft: #ccfbf1;
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          background: #e2e8f0;
          color: var(--ink);
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          overflow-x: hidden;
        }
        .payslip {
          background: var(--paper);
          border: 1px solid rgba(15, 23, 42, 0.08);
          border-radius: 18px;
          box-shadow: 0 24px 60px rgba(15, 23, 42, 0.16);
          margin: 28px auto;
          max-width: calc(100% - 32px);
          overflow: hidden;
          page-break-after: always;
          width: 960px;
        }
        .statement-header {
          align-items: center;
          background: linear-gradient(135deg, #0f172a 0%, #111827 54%, #7c2d12 100%);
          border-top: 5px solid var(--orange);
          color: white;
          display: grid;
          grid-template-columns: 1fr auto auto;
          gap: 24px;
          min-height: 136px;
          padding: 26px 32px;
        }
        .statement-header img {
          max-height: 54px;
          max-width: 190px;
          object-fit: contain;
        }
        .eyebrow {
          color: #fed7aa;
          font-size: 10px;
          font-weight: 900;
          letter-spacing: 0.2em;
          text-transform: uppercase;
        }
        h1, h2, p { margin: 0; }
        h1 {
          font-size: 28px;
          font-weight: 900;
          margin-top: 8px;
        }
        .statement-header p {
          color: #cbd5e1;
          font-size: 15px;
          font-weight: 800;
          margin-top: 9px;
        }
        .statement-meta {
          background: rgba(15, 23, 42, 0.34);
          border: 1px solid rgba(255, 255, 255, 0.22);
          border-radius: 14px;
          color: #f9fafb;
          display: grid;
          gap: 10px;
          min-width: 190px;
          padding: 14px 16px;
        }
        .statement-meta div {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
        }
        .statement-meta span {
          color: #cbd5e1;
          font-size: 11px;
          font-weight: 800;
          text-transform: uppercase;
        }
        .statement-meta strong {
          font-size: 13px;
          font-weight: 900;
          text-align: right;
        }
        .status-chip {
          border-radius: 999px;
          padding: 5px 10px;
        }
        .status-chip.published {
          background: #dcfce7;
          color: #166534;
        }
        .status-chip.draft {
          background: #fff7ed;
          color: #9a3412;
        }
        .payslip-body { padding: 28px 30px 32px; }
        .grid.two {
          display: grid;
          gap: 20px;
          grid-template-columns: 1fr 1fr;
        }
        .card {
          background: var(--card);
          border: 1px solid var(--line);
          border-radius: 14px;
          box-shadow: 0 10px 25px rgba(15, 23, 42, 0.04);
          overflow: hidden;
          padding: 20px;
        }
        .employee-card {
          border-top: 4px solid var(--teal);
        }
        .summary-card {
          border-top: 4px solid var(--orange);
        }
        .card-title {
          align-items: flex-start;
          display: flex;
          gap: 12px;
          margin-bottom: 16px;
        }
        .icon {
          align-items: center;
          background: var(--teal-soft);
          border-radius: 50%;
          color: var(--teal);
          display: inline-flex;
          font-size: 11px;
          font-weight: 900;
          height: 28px;
          justify-content: center;
          width: 28px;
        }
        .card-title h2, .table-card h2, .comment h2 {
          color: #0f172a;
          font-size: 16px;
          font-weight: 900;
        }
        .card-title p {
          color: var(--muted);
          font-size: 13px;
          margin-top: 3px;
        }
        .info-list {
          display: grid;
          gap: 10px;
        }
        .info-row {
          align-items: center;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          display: flex;
          gap: 14px;
          justify-content: space-between;
          min-height: 46px;
          padding: 0 14px;
        }
        .info-row span {
          color: #64748b;
          font-size: 14px;
          font-weight: 700;
        }
        .info-row strong {
          color: #0f172a;
          font-size: 15px;
          font-weight: 800;
          text-align: right;
          overflow-wrap: anywhere;
        }
        .summary-stack {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }
        .metric {
          border: 1px solid var(--line);
          border-radius: 12px;
          min-height: 96px;
          padding: 16px;
        }
        .metric span, .part-card span {
          display: block;
          color: inherit;
          font-size: 10px;
          font-weight: 900;
          letter-spacing: 0.1em;
          opacity: 0.78;
          text-transform: uppercase;
        }
        .metric strong {
          display: block;
          font-size: 22px;
          margin-top: 12px;
          white-space: nowrap;
        }
        .metric.muted { background: #f1f5f9; color: #334155; }
        .metric.add { background: var(--green-soft); border-color: #86efac; color: #166534; }
        .metric.deduct { background: var(--red-soft); border-color: #fecaca; color: #991b1b; }
        .metric.net { background: var(--navy); border-color: var(--navy); color: white; }
        .table-card {
          border-top: 4px solid var(--navy);
          padding: 0;
        }
        .uploaded-sheet {
          margin-top: 22px;
        }
        .sheet-scroll {
          max-height: 660px;
          overflow: auto;
          scrollbar-color: #94a3b8 #f1f5f9;
          scrollbar-width: thin;
        }
        .sheet-scroll::-webkit-scrollbar {
          height: 10px;
          width: 10px;
        }
        .sheet-scroll::-webkit-scrollbar-track {
          background: #f1f5f9;
        }
        .sheet-scroll::-webkit-scrollbar-thumb {
          background: #94a3b8;
          border: 2px solid #f1f5f9;
          border-radius: 999px;
        }
        table {
          border-collapse: collapse;
          min-width: 620px;
          table-layout: fixed;
          width: 100%;
        }
        th, td {
          border-bottom: 1px solid #e2e8f0;
          font-size: 15px;
          padding: 16px 22px;
          text-align: left;
        }
        th {
          background: #e2e8f0;
          color: #475569;
          font-size: 12px;
          font-weight: 900;
          letter-spacing: 0.1em;
          position: sticky;
          top: 0;
          text-transform: uppercase;
          z-index: 1;
        }
        tbody tr:not(.section-row):nth-child(odd) td {
          background: #ffffff;
        }
        tbody tr:not(.section-row):nth-child(even) td {
          background: #f8fafc;
        }
        tbody tr:not(.section-row):hover td {
          background: #fff7ed;
        }
        td:last-child, th:last-child {
          color: #0f172a;
          font-weight: 900;
          text-align: right;
          width: 36%;
        }
        .component-name {
          color: #334155;
          font-size: 15px;
          font-weight: 800;
        }
        .section-row td {
          background: var(--navy);
          border-bottom: 0;
          color: white;
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.12em;
          padding: 11px 22px;
          text-transform: uppercase;
        }
        .section-row td:last-child {
          text-align: left;
        }
        .section-fixed td { background: var(--teal); }
        .section-additions td { background: var(--green); }
        .section-governmental td { background: var(--purple); }
        .section-deductions td { background: var(--red); }
        .section-payment td { background: #ea580c; }
        .total-row td {
          border-bottom: 1px solid transparent;
          border-top: 2px solid transparent;
          font-weight: 900;
        }
        .total-row .component-name {
          color: inherit;
        }
        .total-additions-row td {
          background: var(--green-soft) !important;
          border-color: #86efac;
          color: #166534;
        }
        .governmental-deductions-row td {
          background: var(--purple-soft) !important;
          border-color: #c4b5fd;
          color: #5b21b6;
        }
        .total-deductions-row td {
          background: var(--red-soft) !important;
          border-color: #fecaca;
          color: #991b1b;
        }
        .parts {
          display: grid;
          gap: 16px;
          grid-template-columns: 1fr 1fr 1fr;
          margin-top: 22px;
        }
        .part-card {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          box-shadow: 0 10px 25px rgba(15, 23, 42, 0.04);
          padding: 18px;
        }
        .part-card strong {
          display: block;
          font-size: 22px;
          margin-top: 10px;
          white-space: nowrap;
        }
        .part-card.net {
          background: var(--navy);
          border-color: var(--navy);
          color: white;
        }
        .comment {
          background: white;
          border: 1px solid var(--line);
          border-radius: 12px;
          margin-top: 20px;
          padding: 18px;
        }
        .comment p {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.55;
          margin-top: 10px;
        }
        @media print {
          body { background: white; }
          .sheet-scroll {
            max-height: none;
            overflow: visible;
          }
          .payslip {
            border: 0;
            border-radius: 0;
            box-shadow: none;
            margin: 0;
            width: 100%;
          }
          .card, .parts, .comment {
            break-inside: avoid;
          }
          @page { margin: 10mm; size: A4; }
        }
        @media (max-width: 980px) {
          .payslip {
            border-radius: 0;
            margin: 0;
            max-width: 100%;
            width: 100%;
          }
          .statement-header,
          .grid.two,
          .parts {
            grid-template-columns: 1fr;
          }
          .statement-header img {
            justify-self: start;
          }
          .summary-stack {
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 720px) {
          body {
            background: var(--paper);
          }
          .statement-header {
            gap: 18px;
            padding: 22px 20px;
          }
          .statement-header img {
            max-height: 48px;
            max-width: 170px;
          }
          h1 {
            font-size: 25px;
          }
          .statement-header p {
            font-size: 14px;
          }
          .statement-meta {
            min-width: 0;
            width: 100%;
          }
          .payslip-body {
            padding: 18px 14px 22px;
          }
          .card {
            border-radius: 12px;
            padding: 16px;
          }
          .card-title {
            gap: 10px;
            margin-bottom: 14px;
          }
          .card-title h2, .table-card h2, .comment h2 {
            font-size: 15px;
          }
          .card-title p {
            font-size: 12px;
          }
          .info-row {
            align-items: flex-start;
            flex-direction: column;
            gap: 5px;
            justify-content: center;
            min-height: 56px;
            padding: 10px 12px;
          }
          .info-row strong {
            text-align: left;
          }
          .metric {
            min-height: 86px;
          }
          .metric strong,
          .part-card strong {
            font-size: 20px;
          }
          .sheet-scroll {
            max-height: 68vh;
            -webkit-overflow-scrolling: touch;
          }
          th, td {
            font-size: 14px;
            padding: 14px 16px;
          }
          .component-name {
            font-size: 14px;
          }
          .section-row td {
            font-size: 10px;
            padding: 10px 16px;
          }
        }
        @media (max-width: 520px) {
          .statement-header {
            padding: 20px 16px;
          }
          .eyebrow {
            font-size: 9px;
            letter-spacing: 0.16em;
          }
          h1 {
            font-size: 23px;
          }
          .statement-meta div {
            align-items: flex-start;
            flex-direction: column;
            gap: 5px;
          }
          .statement-meta strong {
            text-align: left;
          }
          .payslip-body {
            padding: 14px 10px 18px;
          }
          .grid.two,
          .parts {
            gap: 12px;
          }
          .card {
            padding: 14px;
          }
          .info-row span {
            font-size: 13px;
          }
          .info-row strong {
            font-size: 14px;
          }
          .uploaded-sheet,
          .parts {
            margin-top: 14px;
          }
          table {
            min-width: 560px;
          }
          th, td {
            font-size: 13px;
            padding: 13px 14px;
          }
          .component-name {
            font-size: 13px;
          }
          .metric,
          .part-card {
            padding: 15px;
          }
        }
      </style>
    </head>
    <body>
      ${records.map((record, index) => payslip(record, month, year, batchStatus, index + 1)).join("")}
    </body>
  </html>`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let batchId = "";
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "payslips", "read");
    const { id } = await params;
    batchId = id;

    if (isDevelopment) {
      console.debug("[employee-portal] API GET /api/payroll/[id]/payslips:", { 
        batchId: id, 
        user: access.loginId, 
        role: access.role,
        hrId: access.hrId 
      });
    }

    const exportData = await getSalaryBatchExport(id, access);
    if (exportData && !isPublishedPayslipStatus(exportData.batch.status)) {
      return NextResponse.json(
        {
          error: "payslips_not_published",
          message: "Payslips are available only after payroll is approved or locked.",
        },
        { status: 409 },
      );
    }

    const url = new URL(request.url);
    const employeeHrId = url.searchParams.get("employeeHrId")?.trim().toLowerCase() ?? "";
    const employeeName = url.searchParams.get("employeeName")?.trim().toLowerCase() ?? "";
    const records = exportData?.records.filter((record) => {
      const matchesHrId =
        !employeeHrId ||
        record.hrId.toLowerCase() === employeeHrId ||
        record.employeeCode.toLowerCase() === employeeHrId;
      const matchesName = !employeeName || record.fullName.toLowerCase().includes(employeeName);
      return matchesHrId && matchesName;
    }) ?? [];

    if (!exportData || records.length === 0) {
      if (isDevelopment) {
        console.debug("[employee-portal] API GET /api/payroll/[id]/payslips: No records found or not found.");
      }
      return NextResponse.json({ error: "not_found", message: "No payslip records found for this batch and user." }, { status: 404 });
    }

    return new Response(
      page(records, exportData.batch.month, exportData.batch.year, exportData.batch.status),
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
        },
      },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return "Unknown payroll API error.";
            }
          })();
    const responseMessage = isDevelopment ? message : "Failed to load payslip";

    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: responseMessage }, { status: 403 });
    }

    if (isDevelopment && isLikelyUuidError(message)) {
      return NextResponse.json(
        { error: "payslips_failed", message: "Invalid batch identifier format." },
        { status: 400 },
      );
    }

    if (isDevelopment) {
      console.error("[employee-portal] /api/payroll/[id]/payslips failed", {
        batchId,
        error,
      });
    }

    return NextResponse.json({ error: "payslips_failed", message: responseMessage }, { status: 500 });
  }
}
