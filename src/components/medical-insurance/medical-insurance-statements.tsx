"use client";

import { FileDown } from "lucide-react";
import * as React from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-kit";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { costLetterRows, LIFE_INSURANCE_PER_PERSON_MONTHLY, type MonthlySplitRow } from "@/lib/medical-insurance/monthly-split";
import { egpWords, MEMBER_TYPE_WORDS, type MedicalInsuranceMoneyView } from "@/lib/medical-insurance/view";

import { downloadGot, SaveError } from "./medical-insurance-parts";

/** What each person on the row costs the employee a month, exactly as the statement prints it. */
function monthlyLines(row: MonthlySplitRow): Array<{ key: string; name: string; as: string; plan: string; monthly: number | null }> {
  const lines: Array<{ key: string; name: string; as: string; plan: string; monthly: number | null }> = [];
  if (row.employee) {
    lines.push({ as: "Employee", key: row.employee.memberId, monthly: row.employee.monthly === null ? null : row.employeeOwnShare + LIFE_INSURANCE_PER_PERSON_MONTHLY, name: row.employee.name, plan: row.employee.category });
  }
  for (const relative of row.family) {
    lines.push({ as: MEMBER_TYPE_WORDS[relative.memberType], key: relative.memberId, monthly: relative.monthly === null ? null : relative.monthly + LIFE_INSURANCE_PER_PERSON_MONTHLY, name: relative.name, plan: relative.category });
  }
  return lines;
}

/**
 * THE MEDICAL COVER STATEMENT, ONE EMPLOYEE AT A TIME (owner, 2026-11-21: "a combo box, start typing, a drop
 * list appears, choose, export PDF"). The PDF shows the employee their grade, what they pay each month with
 * their family beside them, and their grade's table of benefits — amounts only, never the split's
 * percentages. Super Admin only: the tab rides in the money view and the route asserts the same permission.
 */
export function MedicalInsuranceStatementsTab({ money }: { money: MedicalInsuranceMoneyView }) {
  const rows = React.useMemo(() => costLetterRows(money.monthlySplit.rows), [money.monthlySplit.rows]);
  const [memberId, setMemberId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const row = rows.find((candidate) => candidate.employee?.memberId === memberId) ?? null;
  const lines = row ? monthlyLines(row) : [];
  const short = lines.some((line) => line.monthly === null);

  async function exportPdf() {
    if (!row?.employee) return;
    setBusy(true);
    setError(null);
    try {
      await downloadGot(`/api/medical-insurance/cost-letter?member=${encodeURIComponent(row.employee.memberId)}`, "Medical-Cover-Statement.pdf");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The statement could not be made. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminTableShell
      description="Choose an employee and export their Medical Cover Statement: their grade, what they pay each month with their family beside them, and their grade's table of benefits. It shows amounts only, never how the cost is shared. It sends nothing; you hand it on."
      title="Medical Cover Statement"
    >
      <div className="space-y-5 p-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <FormField htmlFor="mi-statement-employee" label="Employee">
            <SearchableSelect
              className={phxSelectClassName}
              id="mi-statement-employee"
              onValueChange={(value) => {
                setMemberId(value);
                setError(null);
              }}
              placeholder="Start typing a name"
              value={memberId}
            >
              <option value="">Start typing a name</option>
              {rows.map((candidate) => (
                <option key={candidate.key} value={candidate.employee?.memberId ?? ""}>
                  {candidate.employee?.name}
                  {candidate.family.length > 0 ? ` · with ${candidate.family.length} family` : ""}
                </option>
              ))}
            </SearchableSelect>
          </FormField>
          <Button className="h-10 gap-2" disabled={!row || short || busy} onClick={() => void exportPdf()} type="button">
            <FileDown className="h-4 w-4" />
            {busy ? "Preparing the PDF" : "Export PDF"}
          </Button>
        </div>
        <SaveError error={error} />

        {row ? (
          <div className="border border-phx-line">
            <div className="grid grid-cols-2 gap-px border-b border-phx-line bg-phx-line md:grid-cols-3">
              <Fact label="Grade" value={row.employee?.category ?? ""} />
              <Fact label="People on the statement" value={String(lines.length)} />
              <Fact label="Total a month" value={short ? "Cannot be priced yet" : egpWords(row.employeePays)} />
            </div>
            <ul className="divide-y divide-phx-line">
              {lines.map((line) => (
                <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3" key={line.key}>
                  <span className="min-w-0">
                    <span className="block break-words text-sm font-bold text-phx-ink">{line.name}</span>
                    <span className="block break-words text-phx-xs font-semibold text-phx-ink-soft">
                      {line.as} · Grade {line.plan}
                    </span>
                  </span>
                  <span className="text-right text-sm font-black tabular-nums text-phx-ink">{line.monthly === null ? "Cannot be priced" : egpWords(line.monthly)}</span>
                </li>
              ))}
            </ul>
            {short ? (
              <p className="break-words border-t border-phx-line p-4 text-phx-xs font-bold text-phx-warn">
                Someone on this statement cannot be priced yet (no date of birth, no plan, or an age band the offer did not quote), so no PDF is made until their record is fixed.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{rows.length} employees are covered today. Start typing a name to choose one.</p>
        )}
      </div>
    </AdminTableShell>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-white px-4 py-3">
      <span className="block break-words text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">{label}</span>
      <span className="mt-1 block break-words text-lg font-black tabular-nums text-phx-ink">{value}</span>
    </div>
  );
}
