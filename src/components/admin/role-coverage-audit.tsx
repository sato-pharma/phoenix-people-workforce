import Link from "next/link";
import { AlertCircle, CheckCircle2, CircleSlash, Users } from "lucide-react";

import { AdminInsightChip, AdminTableShell } from "@/components/admin/admin-design-system";
import { COVERAGE_ROLE_LABELS, type RoleCoverageCell, type RoleCoverageModuleResult } from "@/lib/admin/role-coverage/coverage-roles";
import type { RoleCoverageAudit } from "@/lib/admin/role-coverage/audit";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";

/**
 * The Role Coverage section of the Super Admin's Data Health audit. One row per module that lists
 * people or offers a person filter; for each, every role it must show, how many of today's active
 * people in that role it offers, and who is missing by name. A role the module leaves out on
 * purpose is shown with the reason, never as a gap.
 *
 * Fits the screen at every width: a fixed table with merged columns once the section is wide
 * enough (`@container` — it can sit in a narrow column), cards below that, and the missing names
 * wrap rather than scroll or truncate.
 */

/** A YYYY-MM-DD start date as "24 Oct 2026", read as the calendar day itself (no time zone shift). */
function startDateLabel(isoDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  return formatStableEnGb(new Date(`${isoDate}T00:00:00Z`), { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function measuredAtLabel(iso: string) {
  try {
    return formatStableEnGb(new Date(iso), {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Africa/Cairo",
    });
  } catch {
    return iso;
  }
}

const cellTone: Record<RoleCoverageCell["status"], string> = {
  complete: "border-emerald-200 bg-emerald-50 text-emerald-800",
  partial: "border-amber-200 bg-amber-50 text-amber-900",
  absent: "border-rose-300 bg-rose-50 text-rose-800",
  "nobody-in-role": "border-slate-200 bg-slate-50 text-slate-500",
  "left-out": "border-slate-200 bg-white text-slate-500",
  "left-out-but-shown": "border-amber-200 bg-amber-50 text-amber-900",
};

function cellText(cell: RoleCoverageCell) {
  const label = COVERAGE_ROLE_LABELS[cell.role];
  switch (cell.status) {
    case "complete":
      return `${label} · all ${cell.headcount}`;
    case "partial":
      return `${label} · ${cell.present} of ${cell.headcount}`;
    case "absent":
      return `${label} · none of ${cell.headcount}`;
    case "nobody-in-role":
      return `${label} · nobody holds this role today`;
    case "left-out":
      return `${label} · left out on purpose`;
    case "left-out-but-shown":
      return `${label} · left out on purpose, yet ${cell.present} shown`;
  }
}

function RoleCells({ result }: { result: RoleCoverageModuleResult }) {
  if (result.status === "probe-failed") {
    return (
      <p className="text-xs font-semibold text-rose-700">
        Could not be measured: {result.error ?? "the module did not answer."}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap gap-1.5">
        {result.cells.map((cell) => (
          <li
            className={`border px-2 py-1 text-phx-xs font-semibold leading-snug ${cellTone[cell.status]}`}
            key={cell.role}
            title={cell.leftOutReason ?? undefined}
          >
            {cellText(cell)}
          </li>
        ))}
      </ul>
      {result.cells
        .filter((cell) => cell.missing.length > 0)
        .map((cell) => (
          <details className="text-xs text-slate-700" key={`missing-${cell.role}`}>
            <summary className="cursor-pointer font-semibold text-slate-800">
              {cell.missing.length} {COVERAGE_ROLE_LABELS[cell.role].toLowerCase()} not shown
            </summary>
            <p className="mt-1 break-words leading-relaxed">
              {cell.missing.map((person) => person.name).join(" · ")}
            </p>
          </details>
        ))}
      {result.cells
        .filter((cell) => cell.leftOutReason)
        .map((cell) => (
          <p className="text-xs leading-relaxed text-slate-500" key={`reason-${cell.role}`}>
            <span className="font-semibold text-slate-600">{COVERAGE_ROLE_LABELS[cell.role]} left out:</span>{" "}
            {cell.leftOutReason}
          </p>
        ))}
    </div>
  );
}

function StatusBadge({ result }: { result: RoleCoverageModuleResult }) {
  if (result.status === "complete") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" /> Every role shown
      </span>
    );
  }
  if (result.status === "probe-failed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-bold text-slate-600">
        <CircleSlash className="h-3.5 w-3.5" /> Not measured
      </span>
    );
  }
  const parts: string[] = [];
  if (result.absentRoles.length > 0) {
    parts.push(`${result.absentRoles.length} role${result.absentRoles.length === 1 ? "" : "s"} missing`);
  }
  if (result.partialRoles.length > 0) {
    parts.push(`${result.partialRoles.length} incomplete`);
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-bold text-rose-700">
      <AlertCircle className="h-3.5 w-3.5" /> {parts.join(" · ")}
    </span>
  );
}

function ModuleName({ result }: { result: RoleCoverageModuleResult }) {
  return (
    <div className="min-w-0">
      <Link className="text-sm font-bold text-slate-950 underline-offset-2 hover:underline" href={result.href}>
        {result.label}
      </Link>
      <p className="mt-0.5 break-words text-xs leading-relaxed text-slate-500">{result.population}</p>
    </div>
  );
}

export function RoleCoverageAuditView({ audit }: { audit: RoleCoverageAudit }) {
  // Gaps first, then the ones that could not be measured, then the complete ones.
  const order = { gaps: 0, "probe-failed": 1, complete: 2 } as const;
  const modules = [...audit.modules].sort(
    (a, b) => order[a.status] - order[b.status] || a.label.localeCompare(b.label),
  );
  const rosterLine = audit.roster
    .filter((entry) => entry.headcount > 0)
    .map((entry) => `${entry.headcount} ${COVERAGE_ROLE_LABELS[entry.role].toLowerCase()}`)
    .join(" · ");
  const notStartedLine = audit.notStartedYet.length
    ? ` Not counted until they start: ${audit.notStartedYet
        .map((person) => `${person.name} (${COVERAGE_ROLE_LABELS[person.role]}, starts ${startDateLabel(person.startDate)})`)
        .join("; ")}.`
    : "";

  return (
    <section className="@container" id="role-coverage">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="mt-1 h-9 w-1.5 shrink-0 bg-gradient-to-b from-orange-500 to-amber-400" />
          <div>
            <p className="text-phx-xs font-bold uppercase tracking-[0.22em] text-orange-600">Who each module can see</p>
            <h2 className="mt-1 text-xl font-bold tracking-[-0.025em] text-slate-950">Role Coverage</h2>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <AdminInsightChip tone={audit.totals.withGaps > 0 ? "orange" : "emerald"}>
            {audit.totals.withGaps} of {audit.totals.modules} modules with a missing role
          </AdminInsightChip>
          {audit.totals.probeFailed > 0 ? (
            <AdminInsightChip tone="slate">{audit.totals.probeFailed} not measured</AdminInsightChip>
          ) : null}
        </div>
      </div>

      <AdminTableShell
        description={`Each module's own people list, read live and compared with today's ${audit.activeEmployees} active employees: ${rosterLine}. Measured ${measuredAtLabel(audit.measuredAt)} Cairo.${notStartedLine}`}
        title="Every role each module must show"
      >
        {modules.length === 0 ? (
          <p className="flex items-center gap-2 px-4 py-6 text-sm text-slate-500">
            <Users className="h-4 w-4" /> No module is registered for this audit yet.
          </p>
        ) : (
          <>
            <table className="hidden w-full table-fixed text-left @min-[760px]:table">
              <colgroup>
                <col className="w-[30%]" />
                <col className="w-[16%]" />
                <col />
              </colgroup>
              <thead className="bg-slate-50 text-phx-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Module</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Roles</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {modules.map((result) => (
                  <tr className="align-top" key={result.id}>
                    <td className="px-4 py-3"><ModuleName result={result} /></td>
                    <td className="px-4 py-3"><StatusBadge result={result} /></td>
                    <td className="px-4 py-3"><RoleCells result={result} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-slate-200 @min-[760px]:hidden">
              {modules.map((result) => (
                <li className="space-y-2 px-4 py-3" key={result.id}>
                  <ModuleName result={result} />
                  <StatusBadge result={result} />
                  <RoleCells result={result} />
                </li>
              ))}
            </ul>
          </>
        )}
      </AdminTableShell>
    </section>
  );
}
