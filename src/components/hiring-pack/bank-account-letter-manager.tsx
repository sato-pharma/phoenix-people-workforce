"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Download, Landmark, Loader2, Search, Users } from "lucide-react";
import Link from "next/link";

import { AdminCallout, AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BANK_LETTER_BANK_NAME_AR,
  BANK_LETTER_FIELD_LABELS,
  bankLetterGaps,
  bankLetterJobTitle,
  formatBankLetterSalary,
  hasFabAccount,
  preselectedForBankLetter,
} from "@/lib/hiring-pack/bank-account-letter";
import type { BankLetterEmployee } from "@/lib/hiring-pack/bank-account-letter";
import { cn } from "@/lib/utils";

// Tick the people the bank should open accounts for and download the Word letter. Everyone whose
// record shows no First Abu Dhabi Bank account arrives ticked; HR unticks whoever is not on this
// letter. What each row shows is exactly what the letter prints — the same `bankLetterRows` the
// server builds the file from — and a blank the letter would print is named beside the person.

type View = "without-fab" | "everyone";

const BANK_LABELS: Record<string, string> = { CIB: "CIB", FAB: "First Abu Dhabi Bank", QNB: "QNB" };

function bankLabel(code: string | null): string {
  const value = (code ?? "").trim();
  if (!value) return "No bank on file";
  return BANK_LABELS[value.toUpperCase()] ?? value;
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function matches(employee: BankLetterEmployee, query: string): boolean {
  if (!query) return true;
  return [
    employee.displayName,
    employee.nameAr,
    employee.nationalId,
    employee.mobile,
    employee.address,
    employee.jobTitleAr,
    employee.jobTitleEn,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function Gaps({ employee }: { employee: BankLetterEmployee }) {
  const gaps = bankLetterGaps(employee);
  if (gaps.length === 0) return null;
  return (
    <p className="mt-1 text-xs font-semibold text-amber-800">
      Prints blank: {gaps.map((gap) => BANK_LETTER_FIELD_LABELS[gap]).join(", ")}
    </p>
  );
}

export function BankAccountLetterManager({
  employees,
  initialError,
}: {
  employees: BankLetterEmployee[];
  initialError: string | null;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preselectedForBankLetter(employees)));
  const [view, setView] = useState<View>("without-fab");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const withoutFab = useMemo(() => employees.filter((employee) => !hasFabAccount(employee)), [employees]);
  const query = search.trim().toLowerCase();
  const shown = (view === "without-fab" ? withoutFab : employees).filter((employee) => matches(employee, query));
  // The letter keeps the screen's order — grouped by job title, then name — whichever view is open.
  const chosen = employees.filter((employee) => selected.has(employee.hrId));
  const withGaps = chosen.filter((employee) => bankLetterGaps(employee).length > 0);
  const chosenWithFab = chosen.filter(hasFabAccount);

  function toggle(hrId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(hrId)) next.delete(hrId);
      else next.add(hrId);
      return next;
    });
  }

  function tickShown() {
    setSelected((current) => new Set([...current, ...shown.map((employee) => employee.hrId)]));
  }

  async function exportLetter() {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ format: "docx" });
      for (const employee of chosen) params.append("hr", employee.hrId);
      const response = await fetch(`/api/hiring-pack/bank-account-letter?${params.toString()}`);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payload?.message ?? "The letter could not be generated. Try again.");
      }
      const fileName =
        /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "sato-pharma-bank-accounts.docx";
      saveBlob(await response.blob(), fileName);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The letter could not be generated. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const count = chosen.length;

  return (
    <div className="border border-phx-line bg-phx-paper p-4 sm:p-6">
      <div className="flex flex-col gap-5">
        <AdminPageHero
          actions={
            <Button asChild className="h-10 rounded-none" variant="ghost">
              <Link href="/hiring-pack">
                <ArrowLeft />
                HR Forms
              </Link>
            </Button>
          }
          badges={
            <>
              <AdminInsightChip tone="orange">{employees.length} on staff</AdminInsightChip>
              <AdminInsightChip tone="orange">{withoutFab.length} without a First Abu Dhabi Bank account</AdminInsightChip>
              <AdminInsightChip>Word · Sato letterhead</AdminInsightChip>
            </>
          }
          description={`The account-opening letter to ${BANK_LETTER_BANK_NAME_AR}: name, national ID, mobile, address, job title and base salary for each person, on the Sato letterhead. Everyone without a First Abu Dhabi Bank account arrives ticked.`}
          eyebrow="Employee documents"
          icon={<Landmark className="h-5 w-5" />}
          title="Bank Account Letter"
        />

        {error ? (
          <AdminCallout tone="danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </AdminCallout>
        ) : null}

        <div className="border border-slate-200/90 bg-white/95 px-4 py-3 sm:px-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <span className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">
              <Users className="h-4 w-4 text-phx-accent-press" />
              Employees
            </span>
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Search employees</span>
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-soft" />
              <Input
                className="pl-9"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Type a name, national ID, mobile, address or job title"
                value={search}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                aria-pressed={view === "without-fab"}
                className="h-10 rounded-none"
                onClick={() => setView("without-fab")}
                type="button"
                variant={view === "without-fab" ? "default" : "outline"}
              >
                Without FAB ({withoutFab.length})
              </Button>
              <Button
                aria-pressed={view === "everyone"}
                className="h-10 rounded-none"
                onClick={() => setView("everyone")}
                type="button"
                variant={view === "everyone" ? "default" : "outline"}
              >
                Everyone ({employees.length})
              </Button>
              <Button className="h-10 rounded-none" disabled={shown.length === 0} onClick={tickShown} type="button" variant="outline">
                Tick all shown ({shown.length})
              </Button>
              <Button className="h-10 rounded-none" disabled={count === 0} onClick={() => setSelected(new Set())} type="button" variant="ghost">
                Clear
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 border border-slate-200/90 bg-white/95 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className="min-w-0 text-sm font-semibold text-phx-ink-soft">
            {count === 0 ? "Nobody ticked yet." : `${count} ${count === 1 ? "person" : "people"} on the letter`}
            {withGaps.length ? ` · ${withGaps.length} with a blank` : ""}
          </p>
          <Button className="h-10 rounded-none" disabled={busy || count === 0} onClick={() => void exportLetter()} type="button">
            {busy ? <Loader2 className="animate-spin" /> : <Download />}
            Export Word letter
          </Button>
        </div>

        {withGaps.length ? (
          <AdminCallout tone="warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              The letter prints a blank for {withGaps.length === 1 ? "one person" : `${withGaps.length} people`}:{" "}
              {withGaps.map((employee) => employee.displayName).join(", ")}. Fill the missing details on their HR Forms record
              first, or send the letter with the blank.
            </span>
          </AdminCallout>
        ) : null}

        {chosenWithFab.length ? (
          <AdminCallout tone="warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Already with First Abu Dhabi Bank on their record, and ticked: {chosenWithFab.map((employee) => employee.displayName).join(", ")}.
            </span>
          </AdminCallout>
        ) : null}

        {shown.length === 0 ? (
          <div className="border border-dashed border-phx-line bg-white/70 px-5 py-10 text-center text-sm font-semibold text-phx-ink-soft">
            Nobody matches.
          </div>
        ) : (
          <>
            {/* Desktop: the five columns the letter prints, merged so the table always fits. */}
            <div className="hidden border border-slate-200/90 bg-white md:block">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-[30%]" />
                  <col className="w-[18%]" />
                  <col className="w-[26%]" />
                  <col className="w-[10%]" />
                  <col className="w-[16%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-phx-xs font-black uppercase tracking-[0.08em] text-phx-ink-soft">
                    <th className="px-3 py-2">Employee · job title</th>
                    <th className="px-3 py-2">National ID · mobile</th>
                    <th className="px-3 py-2">Address</th>
                    <th className="px-3 py-2">Base salary</th>
                    <th className="px-3 py-2">Bank on file</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((employee) => {
                    const ticked = selected.has(employee.hrId);
                    return (
                      <tr
                        className={cn("border-b border-slate-100 align-top last:border-b-0", ticked ? "bg-white" : "bg-slate-50 text-phx-ink-soft")}
                        key={employee.hrId}
                      >
                        <td className="px-3 py-2">
                          <label className="flex min-w-0 cursor-pointer items-start gap-2">
                            <input
                              checked={ticked}
                              className="mt-1 h-4 w-4 shrink-0 accent-orange-500"
                              onChange={() => toggle(employee.hrId)}
                              type="checkbox"
                            />
                            <span className="min-w-0 break-words">
                              <span className="block font-semibold text-phx-ink">{employee.displayName}</span>
                              <span className="block" dir="auto">
                                {employee.nameAr || "—"}
                              </span>
                              <span className="block text-xs" dir="auto">
                                {bankLetterJobTitle(employee) || "—"}
                              </span>
                            </span>
                          </label>
                        </td>
                        <td className="break-words px-3 py-2 tabular-nums">
                          <span className="block">{employee.nationalId || "—"}</span>
                          <span className="block text-xs">{employee.mobile || "—"}</span>
                        </td>
                        <td className="break-words px-3 py-2" dir="auto">
                          {employee.address || "—"}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{formatBankLetterSalary(employee.baseSalary) || "—"}</td>
                        <td className="break-words px-3 py-2">
                          <span className="block">{bankLabel(employee.bankName)}</span>
                          <Gaps employee={employee} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile: one card per person. */}
            <div className="flex flex-col gap-2 md:hidden">
              {shown.map((employee) => {
                const ticked = selected.has(employee.hrId);
                return (
                  <label
                    className={cn("flex cursor-pointer items-start gap-3 border border-slate-200/90 p-3", ticked ? "bg-white" : "bg-slate-50 text-phx-ink-soft")}
                    key={employee.hrId}
                  >
                    <input
                      checked={ticked}
                      className="mt-1 h-4 w-4 shrink-0 accent-orange-500"
                      onChange={() => toggle(employee.hrId)}
                      type="checkbox"
                    />
                    <span className="min-w-0 flex-1 break-words text-sm">
                      <span className="block font-semibold text-phx-ink">{employee.displayName}</span>
                      <span className="block" dir="auto">
                        {employee.nameAr || "—"}
                      </span>
                      <span className="block text-xs" dir="auto">
                        {bankLetterJobTitle(employee) || "—"}
                      </span>
                      <span className="mt-1 block text-xs tabular-nums">
                        {employee.nationalId || "No national ID"} · {employee.mobile || "No mobile"} ·{" "}
                        {formatBankLetterSalary(employee.baseSalary) || "No base salary"}
                      </span>
                      <span className="block text-xs" dir="auto">
                        {employee.address || "No address"}
                      </span>
                      <span className="block text-xs">{bankLabel(employee.bankName)}</span>
                      <Gaps employee={employee} />
                    </span>
                  </label>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
