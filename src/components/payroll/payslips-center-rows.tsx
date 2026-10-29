"use client";

import { humanizeCode } from "@/lib/format/code-label";
import Link from "next/link";
import { FileDown } from "lucide-react";

import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import type { PayslipCenterRow } from "@/lib/payroll/payslip-center";
import { formatEmployeeDisplayName } from "@/lib/utils";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";

/**
 * The Payslips Center history, as cards on a phone and a table from `md` up.
 *
 * ## Why this is a component and not ten more lines in the page
 *
 * The page is a server component, and PortalResponsiveDataList takes `renderCard`/`renderTable`
 * render props — functions cannot cross the server/client boundary, so the list has to live inside
 * a client component or not use the house primitive at all. It uses the primitive: every other
 * table reachable from the HR sidebar does, and the owner's standing rule is to match the sibling
 * pages rather than invent a second look for one screen.
 *
 * ## Why it exists at all
 *
 * The table is ten columns on a 980px floor. That was fine while the page was Finance's, reached
 * from a desktop hub; it stopped being fine on 2026-09-01 when the owner asked for a Payslips
 * Center row in the HR sidebar, because the HR shell is used on a phone and the fits-the-screen
 * rule is a golden rule — content must FIT, never sit behind a sideways drag. The desktop table is
 * unchanged and still carries all ten columns; only the sub-`md` half is new.
 *
 * Read-only pattern deliberately: no row here holds an unsaved edit — both actions are links to an
 * API route — so PortalResponsiveDataList rendering each row twice is safe.
 */
export function PayslipsCenterRows({
  canExportPayslipImage,
  rows,
}: {
  canExportPayslipImage: boolean;
  rows: PayslipCenterRow[];
}) {
  return (
    <PortalResponsiveDataList
      empty={
        <PortalEmptyState
          message="Try a different spelling, HR ID, or employee code."
          title="No payslips found"
        />
      }
      getKey={(row) => `${row.batchId}-${row.recordId}`}
      items={rows}
      renderCard={(row) => (
        <PortalRecordCard
          accent={row.status === "approved" || row.status === "locked" ? "emerald" : "slate"}
          actions={
            <>
              <Link
                className="inline-flex h-9 items-center justify-center border border-phx-line px-4 text-sm font-semibold text-phx-ink"
                href={`/api/payroll/${row.batchId}/payslips?employeeHrId=${encodeURIComponent(row.hrId || row.employeeCode)}`}
                target="_blank"
              >
                Open Payslip
              </Link>
              {canExportPayslipImage ? (
                <Link
                  className="inline-flex h-9 items-center justify-center border border-phx-accent-line bg-phx-accent-soft px-4 text-sm font-semibold text-[#9A3412]"
                  href={`/api/payroll/${row.batchId}/payslips/image?employeeHrId=${encodeURIComponent(row.hrId || row.employeeCode)}`}
                >
                  <FileDown className="mr-2 h-4 w-4" />
                  Export PDF
                </Link>
              ) : null}
            </>
          }
          meta={
            <span>{row.jobTitle}</span>
          }
          status={
            <Badge variant={row.status === "approved" || row.status === "locked" ? "success" : "neutral"}>
              {humanizeCode(row.status)}
            </Badge>
          }
          title={formatEmployeeDisplayName(row.fullName)}
        >
          <PortalRecordFields
            fields={[
              { label: "Period", value: periodLabel(row.month, row.year) },
              { label: "Line", value: row.line },
              { label: "Gross", value: formatMoney(row.grossSalary) },
              { label: "Net", value: formatMoney(row.netSalary) },
              { label: "Additions", value: formatMoney(row.totalAdditions) },
              { label: "Deductions", value: formatMoney(row.totalDeductions) },
            ]}
          />
        </PortalRecordCard>
      )}
      renderTable={() => (
        <PortalDesktopTable
          cols={
            <colgroup>
              <col className="w-[18%]" />
              <col className="w-[12%]" />
              <col className="w-[10%]" />
              <col className="w-[10%]" />
              <col className="w-[10%]" />
              <col className="w-[10%]" />
              <col className="w-[10%]" />
              <col className="w-[20%]" />
            </colgroup>
          }
        >
            <thead>
              <tr className="border-b border-phx-line bg-phx-paper text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">
                {["Employee", "Period / Line", "Gross", "Additions", "Deductions", "Net", "Status", "Action"].map((column) => (
                  <th className="px-3 py-3" key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-phx-line">
              {rows.map((row) => (
                <tr className="transition hover:bg-[#FCFDFE]" key={`${row.batchId}-${row.recordId}`}>
                  <td className="break-words px-3 py-3">
                    <p className="font-semibold text-phx-ink">{formatEmployeeDisplayName(row.fullName)}</p>
                    <p className="mt-1 text-xs text-phx-ink-soft">{row.jobTitle}</p>
                  </td>
                  <td className="break-words px-3 py-3">
                    <p className="font-semibold text-phx-ink">{periodLabel(row.month, row.year)}</p>
                    <p className="mt-1 text-xs text-phx-ink-soft">{row.line}</p>
                  </td>
                  <td className="break-words px-3 py-3 font-semibold text-phx-ink">{formatMoney(row.grossSalary)}</td>
                  <td className="break-words px-3 py-3 text-emerald-700">{formatMoney(row.totalAdditions)}</td>
                  <td className="break-words px-3 py-3 text-rose-700">{formatMoney(row.totalDeductions)}</td>
                  <td className="break-words px-3 py-3 font-black text-phx-ink">{formatMoney(row.netSalary)}</td>
                  <td className="break-words px-3 py-3">
                    <Badge variant={row.status === "approved" || row.status === "locked" ? "success" : "neutral"}>
                      {humanizeCode(row.status)}
                    </Badge>
                  </td>
                  <td className="break-words px-3 py-3">
                    <div className="flex flex-wrap gap-2">
                      <Link
                        className="inline-flex h-9 items-center justify-center border border-phx-line px-4 text-sm font-semibold text-phx-ink transition hover:bg-phx-paper"
                        href={`/api/payroll/${row.batchId}/payslips?employeeHrId=${encodeURIComponent(row.hrId || row.employeeCode)}`}
                        target="_blank"
                      >
                        Open Payslip
                      </Link>
                      {canExportPayslipImage ? (
                        <Link
                          className="inline-flex h-9 items-center justify-center border border-phx-accent-line bg-phx-accent-soft px-4 text-sm font-semibold text-[#9A3412] transition hover:bg-[#FFEDD5]"
                          href={`/api/payroll/${row.batchId}/payslips/image?employeeHrId=${encodeURIComponent(row.hrId || row.employeeCode)}`}
                        >
                          <FileDown className="mr-2 h-4 w-4" />
                          Export PDF
                        </Link>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
        </PortalDesktopTable>
      )}
    />
  );
}

function formatMoney(value: number) {
  return stableCurrencyFormatter("en-EG", {
    currency: "EGP",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

function periodLabel(month: number, year: number) {
  return new Intl.DateTimeFormat("en", { month: "short", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}
