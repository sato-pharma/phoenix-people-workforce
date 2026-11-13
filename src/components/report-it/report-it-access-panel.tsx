"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";

import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  phxButtonDangerClassName,
  phxButtonPrimaryClassName,
  phxFormErrorClassName,
  phxFormPanelClassName,
  phxLabelClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { cairoDateTime12h } from "@/lib/format/cairo-datetime";
import type { ReportItAccessGrant, ReportItAuditEntry } from "@/lib/report-it/service";

type Overview = { grants: ReportItAccessGrant[]; log: ReportItAuditEntry[] };

const ACTION_LABELS: Record<string, string> = {
  report_viewed: "Opened a report",
  reports_listed: "Listed reports",
  dashboard_access_granted: "Gave read-all access",
  dashboard_access_revoked: "Removed read-all access",
};

function describeEntry(entry: ReportItAuditEntry): string {
  const label = ACTION_LABELS[entry.action] ?? entry.action;
  if (entry.action === "report_viewed" && entry.reportNumber) return `${label} ${entry.reportNumber}`;
  if (entry.action === "reports_listed" && entry.count !== null) return `${label} (${entry.count})`;
  if (entry.subjectName) return `${label}: ${entry.subjectName}`;
  return label;
}

/**
 * Who may read every safety report, beside the log of every read and every change to that list.
 * Shown only to `report_it:export` holders; the route enforces the same permission on its own.
 */
export function ReportItAccessPanel({
  initial,
  employees,
}: {
  initial: Overview;
  employees: Array<{ hrId: string; name: string }>;
}) {
  const [overview, setOverview] = useState<Overview>(initial);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(hrId: string, grant: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/report-it/access", {
        body: JSON.stringify({ grant, hrId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<Overview> & { error?: string };
      if (!response.ok) {
        setError(payload.error ?? "The change was not saved.");
        return;
      }
      setOverview({ grants: payload.grants ?? [], log: payload.log ?? [] });
      if (grant) setChosen("");
    } catch {
      setError("The change was not saved. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const granted = new Set(overview.grants.map((grant) => grant.hrId.toLowerCase()));
  const candidates = employees.filter((employee) => !granted.has(employee.hrId.toLowerCase()));

  return (
    <section className={`mt-6 min-w-0 ${phxFormPanelClassName}`}>
      <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
        <ShieldCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-orange-600" />
        <h2 className="text-sm font-black text-slate-900">Who can read every report</h2>
      </header>
      <div className="grid gap-6 p-4 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="text-xs leading-relaxed text-slate-600">
            The Super Admin, the CEO and the Finance Manager read every report through their role. The people
            below were given the same access by name. Every change is logged.
          </p>
          <ul className="mt-3 space-y-1">
            {overview.grants.length === 0 ? (
              <li className="border border-slate-200 px-3 py-2 text-xs text-slate-500">Nobody has been given access by name.</li>
            ) : (
              overview.grants.map((grant) => (
                <li key={grant.hrId} className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 px-3 py-2">
                  <span className="min-w-0 break-words text-xs">
                    <span className="font-bold text-slate-900">{grant.name ?? "Unknown employee"}</span>
                    <span className="block text-slate-500">
                      Since {cairoDateTime12h(grant.grantedAt)}
                      {grant.grantedByName ? ` · by ${grant.grantedByName}` : ""}
                    </span>
                  </span>
                  <button
                    className={phxButtonDangerClassName}
                    disabled={busy}
                    onClick={() => void change(grant.hrId, false)}
                    type="button"
                  >
                    Remove
                  </button>
                </li>
              ))
            )}
          </ul>
          <div className="mt-4">
            <label className={phxLabelClassName} htmlFor="report-it-access-employee">
              Give access to
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <SearchableSelect
                  className={phxSelectClassName}
                  id="report-it-access-employee"
                  onValueChange={setChosen}
                  placeholder="Choose an employee"
                  value={chosen}
                >
                  <option value="">Choose an employee</option>
                  {candidates.map((employee) => (
                    <option key={employee.hrId} value={employee.hrId}>
                      {employee.name}
                    </option>
                  ))}
                </SearchableSelect>
              </div>
              <button
                className={phxButtonPrimaryClassName}
                disabled={busy || !chosen}
                onClick={() => void change(chosen, true)}
                type="button"
              >
                Give access
              </button>
            </div>
          </div>
          {error ? (
            <p className={`mt-3 ${phxFormErrorClassName}`} role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">Read log — latest first</p>
          <ul className="mt-2 max-h-96 space-y-1 overflow-y-auto">
            {overview.log.length === 0 ? (
              <li className="border border-slate-200 px-3 py-2 text-xs text-slate-500">No report has been read yet.</li>
            ) : (
              overview.log.map((entry) => (
                <li key={entry.id} className="border border-slate-200 px-3 py-2 text-xs">
                  <span className="block break-words font-bold text-slate-900">{describeEntry(entry)}</span>
                  <span className="block text-slate-500">
                    {entry.actorName ?? "Unknown person"} · {cairoDateTime12h(entry.createdAt)}
                  </span>
                </li>
              ))
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}
