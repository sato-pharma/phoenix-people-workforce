import { NextResponse } from "next/server";

import { isDevelopment } from "@/lib/env";
import { getSalaryBatchExport } from "@/lib/payroll/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import type { SalaryRecord } from "@/lib/payroll/types";

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

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
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

function moneyRow(label: string, value: number) {
  return `
    <tr>
      <td>${escapeHtml(label)}</td>
      <td>${formatEGP(value)}</td>
    </tr>
  `;
}

function infoRow(label: string, value: unknown) {
  return `
    <div class="info-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "-")}</strong>
    </div>
  `;
}

function payslip(record: SalaryRecord, month: number, year: number) {
  const additions = [
    ["Expenses", record.expenses],
    ["Incentive", record.incentive],
    ["Overtime", record.overtime],
    ["Bonus", record.bonus],
    ["Cost of Living", record.extraCostOfLiving],
    ["Fuel Allowance", record.fuelAllowance],
    ["Other Additions", record.otherAdditions],
  ] as const;
  const deductions = [
    ["Social Insurance", record.socialInsurance],
    ["Employment Income Tax", record.employmentIncomeTax],
    ["CRM", record.crm],
    ["Finger Print", record.fingerPrint],
    ["Vacations", record.unpaidVacations],
    ["Medical Insurance", record.medicalInsurance],
    ["Loans", record.loans],
    ["Other Deductions", record.otherDeductions],
  ] as const;

  return `
    <article class="payslip">
      <header class="statement-header">
        <div>
          <div class="eyebrow">Payroll Statement</div>
          <h1>Payslip</h1>
          <p>${String(year)}-${String(month).padStart(2, "0")}</p>
        </div>
        <img alt="Phoenix" src="/brand/phoenix-main-logo.png" />
        <div class="period-pill">
          <span>Month: <strong>${month}</strong></span>
          <span>Year: <strong>${year}</strong></span>
          <span>Status: <strong>Posted</strong></span>
        </div>
      </header>

      <main class="payslip-body">
        <section class="grid two">
          <div class="card">
            <div class="card-title">
              <span class="icon">i</span>
              <div>
                <h2>Employee information</h2>
                <p>Master data snapshot for this payroll document.</p>
              </div>
            </div>
            <div class="info-list">
              ${infoRow("Employee code", record.employeeCode)}
              ${infoRow("Employee name", record.fullName)}
              ${infoRow("Job title", record.jobTitle)}
              ${infoRow("Area", record.area)}
              ${infoRow("Line", record.line)}
              ${infoRow("Hiring date", formatDate(record.hireDate))}
            </div>
          </div>

          <div class="card">
            <div class="card-title">
              <div>
                <h2>Payroll summary</h2>
                <p>Gross pay, adjustments, deductions, and final salary.</p>
              </div>
            </div>
            <div class="summary-stack">
              <div class="metric muted">
                <span>Gross Salary</span>
                <strong>${formatEGP(record.grossSalary)}</strong>
              </div>
              <div class="metric add">
                <span>Total Add-ons</span>
                <strong>${formatEGP(record.totalAdditions)}</strong>
              </div>
              <div class="metric deduct">
                <span>Total Deductions</span>
                <strong>${formatEGP(record.totalDeductions)}</strong>
              </div>
              <div class="metric net">
                <span>Net Salary</span>
                <strong>${formatEGP(record.netSalary)}</strong>
              </div>
            </div>
          </div>
        </section>

        <section class="grid two tables">
          <div class="card table-card add-table">
            <h2>Additions</h2>
            <table>
              <thead><tr><th>Item</th><th>Amount</th></tr></thead>
              <tbody>
                ${additions.map(([label, value]) => moneyRow(label, value)).join("")}
                ${moneyRow("Total add-ons", record.totalAdditions)}
              </tbody>
            </table>
          </div>

          <div class="card table-card deduct-table">
            <h2>Deductions</h2>
            <table>
              <thead><tr><th>Item</th><th>Amount</th></tr></thead>
              <tbody>
                ${deductions.map(([label, value]) => moneyRow(label, value)).join("")}
                ${moneyRow("Total deductions", record.totalDeductions)}
              </tbody>
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
            <span>Net Salary</span>
            <strong>${formatEGP(record.netSalary)}</strong>
          </div>
        </section>

        <section class="comment">
          <h2>Comment</h2>
          <p>Payroll period: ${escapeHtml(periodLabel(month, year))}. Generated by Phoenix Workforce.</p>
        </section>
      </main>
    </article>
  `;
}

function page(records: SalaryRecord[], month: number, year: number) {
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Phoenix Payslips - ${year}-${String(month).padStart(2, "0")}</title>
      <style>
        :root {
          --ink: #111827;
          --muted: #6b7280;
          --paper: #f3f4f6;
          --card: #ffffff;
          --line: #dfe3e8;
          --navy: #111827;
          --green: #00a676;
          --green-soft: #e7fff4;
          --red: #e9003f;
          --red-soft: #fff0f3;
          --orange: #f97316;
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          background: #e5e7eb;
          color: var(--ink);
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .toolbar {
          align-items: center;
          background: var(--navy);
          color: white;
          display: flex;
          justify-content: space-between;
          padding: 12px 18px;
          position: sticky;
          top: 0;
          z-index: 5;
        }
        .toolbar button {
          background: var(--orange);
          border: 0;
          border-radius: 8px;
          color: white;
          cursor: pointer;
          font-weight: 800;
          padding: 10px 14px;
        }
        .payslip {
          background: var(--paper);
          border-radius: 18px;
          box-shadow: 0 22px 55px rgba(15, 23, 42, 0.16);
          margin: 24px auto;
          overflow: hidden;
          page-break-after: always;
          width: 920px;
        }
        .statement-header {
          align-items: center;
          background: var(--navy);
          color: white;
          display: grid;
          grid-template-columns: 1fr auto auto;
          gap: 20px;
          min-height: 124px;
          padding: 22px 28px;
        }
        .statement-header img {
          max-height: 54px;
          max-width: 190px;
          object-fit: contain;
        }
        .eyebrow {
          color: #9ca3af;
          font-size: 10px;
          font-weight: 900;
          letter-spacing: 0.26em;
          text-transform: uppercase;
        }
        h1, h2, p { margin: 0; }
        h1 {
          font-size: 25px;
          letter-spacing: -0.01em;
          margin-top: 8px;
        }
        .statement-header p {
          color: #e5e7eb;
          font-size: 12px;
          font-weight: 700;
          margin-top: 9px;
        }
        .period-pill {
          border: 1px solid rgba(255,255,255,0.18);
          border-radius: 18px;
          color: #f9fafb;
          display: grid;
          font-size: 11px;
          gap: 3px;
          padding: 12px 16px;
        }
        .payslip-body { padding: 26px; }
        .grid.two {
          display: grid;
          gap: 18px;
          grid-template-columns: 1fr 1fr;
        }
        .card {
          background: var(--card);
          border: 1px solid var(--line);
          border-radius: 16px;
          overflow: hidden;
          padding: 18px;
        }
        .card-title {
          align-items: flex-start;
          display: flex;
          gap: 12px;
          margin-bottom: 16px;
        }
        .icon {
          align-items: center;
          background: #eaf2ff;
          border-radius: 50%;
          color: #3b82f6;
          display: inline-flex;
          font-size: 11px;
          font-weight: 900;
          height: 28px;
          justify-content: center;
          width: 28px;
        }
        .card-title h2, .table-card h2, .comment h2 {
          font-size: 13px;
          font-weight: 900;
        }
        .card-title p {
          color: var(--muted);
          font-size: 11px;
          margin-top: 3px;
        }
        .info-list {
          display: grid;
          gap: 9px;
        }
        .info-row {
          align-items: center;
          background: #eef2f6;
          border: 1px solid #dbe1e8;
          border-radius: 9px;
          display: flex;
          justify-content: space-between;
          min-height: 38px;
          padding: 0 12px;
        }
        .info-row span {
          color: #64748b;
          font-size: 11px;
        }
        .info-row strong {
          font-size: 11px;
          text-align: right;
        }
        .summary-stack {
          display: grid;
          gap: 10px;
        }
        .metric {
          border: 1px solid var(--line);
          border-radius: 14px;
          padding: 14px 16px;
        }
        .metric span, .part-card span {
          display: block;
          font-size: 9px;
          font-weight: 900;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }
        .metric strong {
          display: block;
          font-size: 20px;
          margin-top: 8px;
        }
        .metric.muted { background: #eef2f6; }
        .metric.add { background: var(--green-soft); border-color: #7ddfb8; color: #007a55; }
        .metric.deduct { background: var(--red-soft); border-color: #ffb5c5; color: #cf0036; }
        .metric.net { background: var(--navy); border-color: var(--navy); color: white; }
        .tables { margin-top: 20px; }
        .table-card {
          padding: 0;
        }
        .table-card h2 {
          color: white;
          padding: 16px 18px;
        }
        .add-table h2 { background: var(--green); }
        .deduct-table h2 { background: var(--red); }
        table {
          border-collapse: collapse;
          width: 100%;
        }
        th, td {
          border-bottom: 1px solid #e5e7eb;
          font-size: 11px;
          padding: 11px 18px;
          text-align: left;
        }
        th {
          background: #eef2f6;
          color: #475569;
          font-size: 9px;
          font-weight: 900;
          letter-spacing: 0.13em;
          text-transform: uppercase;
        }
        td:last-child, th:last-child {
          font-weight: 900;
          text-align: right;
        }
        tbody tr:last-child td {
          border-bottom: 0;
          font-weight: 900;
        }
        .parts {
          display: grid;
          gap: 16px;
          grid-template-columns: 1fr 1fr 1fr;
          margin-top: 20px;
        }
        .part-card {
          background: #eef2f6;
          border: 1px solid #d6dde6;
          border-radius: 13px;
          padding: 16px;
        }
        .part-card strong {
          display: block;
          font-size: 20px;
          margin-top: 8px;
        }
        .part-card.net {
          background: var(--navy);
          border-color: var(--navy);
          color: white;
        }
        .comment {
          background: white;
          border: 1px solid var(--line);
          border-radius: 15px;
          margin-top: 20px;
          padding: 18px;
        }
        .comment p {
          color: var(--muted);
          font-size: 11px;
          margin-top: 10px;
        }
        @media print {
          body { background: white; }
          .toolbar { display: none; }
          .payslip {
            box-shadow: none;
            margin: 0;
            width: 100%;
          }
          @page { margin: 10mm; size: A4; }
        }
      </style>
    </head>
    <body>
      <div class="toolbar">
        <strong>Phoenix Workforce Payslips - ${escapeHtml(periodLabel(month, year))}</strong>
        <button onclick="window.print()">Print / Save PDF</button>
      </div>
      ${records.map((record) => payslip(record, month, year)).join("")}
    </body>
  </html>`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let batchId = "";
  try {
    const access = await resolveAccessContext(_request);
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

    if (!exportData || exportData.records.length === 0) {
      if (isDevelopment) {
        console.debug("[employee-portal] API GET /api/payroll/[id]/payslips: No records found or not found.");
      }
      return NextResponse.json({ error: "not_found", message: "No payslip records found for this batch and user." }, { status: 404 });
    }

    return new Response(
      page(exportData.records, exportData.batch.month, exportData.batch.year),
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
