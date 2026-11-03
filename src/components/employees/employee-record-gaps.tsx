"use client";

import { AlertTriangle, FileWarning, RefreshCw, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";

import { AdminCallout, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { phxFieldClassName, phxLabelClassName } from "@/components/ui/form-tokens";
import { formatLeftDay } from "@/lib/employees/left-flag";
import {
  matchesRecordGapSearch,
  recordGapBankLetterHref,
  recordGapBankWord,
  recordGapCounts,
  recordGapInsuranceWord,
  recordGapRecordHref,
  recordGapTone,
  rowHasRecordGap,
  type EmployeeRecordGapRow,
  type EmployeeRecordGapsData,
  type RecordGapBankStanding,
  type RecordGapFilter,
  type RecordGapInsuranceStanding,
} from "@/lib/employees/record-gaps-logic";
import { cn } from "@/lib/utils";

type Props = {
  canEdit: boolean;
  canOpenBankLetter: boolean;
  data: EmployeeRecordGapsData | null;
  error: string | null;
};

const FILTERS: Array<{ id: RecordGapFilter; label: string; note: string }> = [
  { id: "all", label: "Anything missing", note: "People with at least one gap" },
  { id: "bank", label: "Bank account", note: "No account number on record" },
  { id: "social", label: "Social insurance", note: "Status is not yes" },
  { id: "medical", label: "Medical insurance", note: "Status is not yes" },
];

const TONE_CLASS = { muted: "text-phx-ink-soft", ok: "text-phx-ok", warn: "text-phx-warn" } as const;

const headerClassName =
  "bg-phx-accent-soft px-3 py-3 text-left text-phx-2xs font-black uppercase tracking-[0.16em] text-phx-ink-soft";
const cellClassName = "border-b border-phx-line px-3 py-3 align-top";

function Standing({ standing, word }: { standing: RecordGapBankStanding | RecordGapInsuranceStanding; word: string }) {
  return <span className={cn("break-words text-phx-xs font-bold", TONE_CLASS[recordGapTone(standing)])}>{word}</span>;
}

/**
 * WHO HAS A BANK OR INSURANCE DETAIL MISSING (owner, 2026-11-03: "build 6"). Every active employee with a
 * gap, one line each, in words and never the numbers themselves. It changes nothing: a gap is filled on
 * the person's Employee Master record, and a failed read says so, never "nothing is missing".
 */
export function EmployeeRecordGaps({ canEdit, canOpenBankLetter, data, error }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const [filter, setFilter] = React.useState<RecordGapFilter>("all");
  const [query, setQuery] = React.useState("");

  const rows = React.useMemo(() => data?.rows ?? [], [data]);
  const counts = React.useMemo(() => recordGapCounts(rows), [rows]);
  const visible = rows.filter((row) => rowHasRecordGap(row, filter) && matchesRecordGapSearch(row, query));

  function renderPerson(row: EmployeeRecordGapRow) {
    return (
      <>
        <p className="break-words text-sm font-black text-phx-ink" dir="auto">{row.displayName}</p>
        {row.jobTitle ? <p className="mt-0.5 break-words text-phx-xs font-semibold text-phx-ink-soft">{row.jobTitle}</p> : null}
        {row.lineName ? <p className="break-words text-phx-xs font-semibold text-phx-ink-faint">{row.lineName}</p> : null}
        <p className="break-words text-phx-xs font-semibold text-phx-ink-faint">
          {row.hireDate ? `Joined ${formatLeftDay(row.hireDate)}` : "Joining date not recorded"}
        </p>
        {row.joinedRecently ? <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">Recent joiner, these details often come later</p> : null}
        {row.payrollEligible ? null : <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">Not on payroll</p>}
      </>
    );
  }

  function renderAction(row: EmployeeRecordGapRow) {
    if (!canEdit) return null;
    return (
      <a
        className="inline-block text-phx-xs font-bold text-phx-accent hover:underline"
        href={recordGapRecordHref(pathname, row.hrId)}
      >
        Open record
      </a>
    );
  }

  return (
    <div className="space-y-5">
      <AdminPageHero
        actions={
          <div className="flex flex-wrap gap-2">
            {canOpenBankLetter ? (
              <a
                className="inline-flex h-10 items-center border border-phx-line bg-white px-3 text-sm font-bold text-phx-ink hover:border-phx-accent"
                href={recordGapBankLetterHref(pathname)}
              >
                Bank account letter
              </a>
            ) : null}
            <Button className="h-10 gap-2" onClick={() => router.refresh()} variant="secondary">
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
        description="Active employees with a bank or insurance detail missing from their record. Some of these may be correct, and this list changes nothing."
        eyebrow="People Operations"
        icon={<FileWarning className="h-3.5 w-3.5" />}
        title="Record Gaps"
      />

      {error ? (
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-[#B91C1C]" />
          <div>
            <h2 className="text-sm font-bold text-[#B91C1C]">The record gaps could not be read</h2>
            <p className="mt-1 text-sm text-[#991B1B]">{error}</p>
            <Button className="mt-3 h-9 gap-2" onClick={() => router.refresh()} variant="secondary">
              <RefreshCw className="h-4 w-4" />
              Try again
            </Button>
          </div>
        </AdminCallout>
      ) : null}

      {data ? (
        <>
          <div className="grid grid-cols-2 gap-px border border-phx-line bg-phx-line lg:grid-cols-4">
            {FILTERS.map(({ id, label, note }) => (
              <button
                aria-pressed={filter === id}
                className={cn(
                  "border-b-2 border-transparent bg-white px-4 py-3 text-left hover:bg-phx-accent-soft",
                  filter === id && "border-phx-accent bg-phx-accent-soft",
                )}
                key={id}
                onClick={() => setFilter(id)}
                type="button"
              >
                <span className="block text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">{label}</span>
                <span className="mt-1 block text-2xl font-black tabular-nums text-phx-ink">
                  {counts[id]}
                  <span className="text-sm font-bold text-phx-ink-soft"> of {data.activeEmployees}</span>
                </span>
                <span className="mt-0.5 block text-phx-xs font-semibold text-phx-ink-soft">{note}</span>
              </button>
            ))}
          </div>

          <AdminTableShell
            action={
              <div className="w-full sm:w-72">
                <label className={phxLabelClassName} htmlFor="record-gaps-search">Search</label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-soft" />
                  <input
                    className={cn(phxFieldClassName, "pl-9")}
                    id="record-gaps-search"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Name, job title or line"
                    type="search"
                    value={query}
                  />
                </div>
              </div>
            }
            description="Most gaps first, then whoever has been here longest. Only whether a detail exists is shown, never the number."
            title="Employees with a gap"
          >
            {visible.length === 0 ? (
              <p className="p-4 text-sm font-semibold text-phx-ink-soft">
                {rows.length === 0 ? "Every active employee has these details recorded." : "Nobody matches this search and filter."}
              </p>
            ) : (
              <>
                <div className="hidden md:block">
                  <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
                    <colgroup>
                      <col className="w-[32%]" />
                      <col className="w-[16%]" />
                      <col className="w-[19%]" />
                      <col className="w-[19%]" />
                      <col className="w-[14%]" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th className={headerClassName}>Employee</th>
                        <th className={headerClassName}>Bank account</th>
                        <th className={headerClassName}>Social insurance</th>
                        <th className={headerClassName}>Medical insurance</th>
                        <th className={headerClassName}><span className="sr-only">Their record</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((row) => (
                        <tr key={row.hrId}>
                          <td className={cellClassName}>{renderPerson(row)}</td>
                          <td className={cellClassName}><Standing standing={row.bank} word={recordGapBankWord(row.bank)} /></td>
                          <td className={cellClassName}><Standing standing={row.socialInsurance.standing} word={recordGapInsuranceWord(row.socialInsurance)} /></td>
                          <td className={cellClassName}><Standing standing={row.medicalInsurance.standing} word={recordGapInsuranceWord(row.medicalInsurance)} /></td>
                          <td className={cellClassName}>{renderAction(row)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="space-y-3 p-4 md:hidden">
                  {visible.map((row) => (
                    <div className="space-y-3 border border-phx-line bg-white p-4 shadow-none" key={row.hrId}>
                      <div>{renderPerson(row)}</div>
                      <ul className="space-y-1">
                        <li className="break-words text-phx-xs font-semibold">
                          <span className="text-phx-ink-soft">Bank account: </span>
                          <Standing standing={row.bank} word={recordGapBankWord(row.bank)} />
                        </li>
                        <li className="break-words text-phx-xs font-semibold">
                          <span className="text-phx-ink-soft">Social insurance: </span>
                          <Standing standing={row.socialInsurance.standing} word={recordGapInsuranceWord(row.socialInsurance)} />
                        </li>
                        <li className="break-words text-phx-xs font-semibold">
                          <span className="text-phx-ink-soft">Medical insurance: </span>
                          <Standing standing={row.medicalInsurance.standing} word={recordGapInsuranceWord(row.medicalInsurance)} />
                        </li>
                      </ul>
                      {renderAction(row)}
                    </div>
                  ))}
                </div>
              </>
            )}
          </AdminTableShell>
        </>
      ) : null}
    </div>
  );
}
