import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Clock } from "lucide-react";

import { cn } from "@/lib/utils";
import type { CompanyActivityDayOutcome, CompanyActivityDayRow, CompanyActivityEmployeeSummary } from "@/lib/company-activity-report/types";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Helpers ──────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

/**
 * The Phoenix field set on one visit, as one line — the work first, then the proof.
 *
 * A vendor visit returns null and the row reads exactly as it did. What this reader may see was decided
 * on the server (`phoenix-visit-detail.ts`): a `distance` reader simply has no accuracy to print, so
 * there is nothing to hide here.
 */
function phoenixVisitLine(visit: CompanyActivityDayRow["crmVisits"][number]): string | null {
  const detail = visit.phoenix;
  if (!detail) return null;
  const parts = [
    detail.kindLabel,
    detail.products.length > 0 ? detail.products.join(", ") : null,
    detail.samples,
    detail.availability,
    detail.objection,
    detail.nextStep,
    detail.pharmacyFeedback,
    detail.offPlan,
    detail.location,
    detail.evidence,
    detail.capture,
  ]
    .map((part) => (part ?? "").trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function minutesToClock(minutes: number | null): string {
  if (minutes == null) return "—";
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  const period = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHour}:${String(mins).padStart(2, "0")} ${period}`;
}

// DATE-ONLY (the activity day, a `date` column), which `new Date` parses as UTC midnight. UTC here is
// CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset. Not an
// instant — do not "fix" this one to Cairo.
function formatFullDate(dateIso: string, weekday: string) {
  const formatted = new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${dateIso}T00:00:00Z`));
  return `${weekday}, ${formatted}`;
}

/** The secondary "day type" badge next to the outcome chip — only for the non-working calendar/
 * lifecycle day types, each with its own honest label so "after_exit" is never lumped in with
 * "Company holiday" the way a two-way ternary would. */
const DAY_TYPE_BADGE_LABEL: Partial<Record<CompanyActivityDayRow["dayType"], string>> = {
  after_exit: "Post-exit",
  holiday: "Company holiday",
  weekly_off: "Non-working",
};

/** Same 12-value vocabulary export.ts colors for the Excel sheet — kept in visual sync so the
 * on-screen list and the downloaded workbook read as the same report, not two different ones. */
const OUTCOME_STYLE: Record<CompanyActivityDayOutcome, { chip: string; label: string }> = {
  after_exit: { chip: "border-slate-300 bg-slate-100 text-slate-600", label: "No Longer Employed" },
  crm_field_visit: { chip: "border-sky-200 bg-sky-50 text-sky-700", label: "CRM Field Visit" },
  crm_leave: { chip: "border-violet-200 bg-violet-50 text-violet-700", label: "CRM-Reported Leave" },
  device_outage: { chip: "border-slate-300 bg-slate-100 text-slate-600", label: "Device Outage" },
  future: { chip: "border-slate-200 bg-white text-slate-400", label: "Future" },
  holiday: { chip: "border-slate-200 bg-slate-100 text-slate-600", label: "Holiday" },
  leave_approved: { chip: "border-emerald-200 bg-emerald-50 text-emerald-700", label: "Leave Approved" },
  leave_pending: { chip: "border-amber-200 bg-amber-50 text-amber-700", label: "Leave Pending" },
  no_entry: { chip: "border-rose-300 bg-rose-50 text-rose-700", label: "No Entry" },
  no_signal: { chip: "border-slate-300 border-dashed bg-white text-slate-500", label: "No Signal Available" },
  office_present: { chip: "border-blue-200 bg-blue-50 text-blue-700", label: "Office Present" },
  weekly_off: { chip: "border-slate-200 bg-slate-100 text-slate-500", label: "Weekly Off" },
};

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Summary strip ────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function Stat({ tone, label, sub, value }: { label: string; sub?: string; tone: "danger" | "neutral" | "warn"; value: number }) {
  const toneClass = {
    danger: value > 0 ? "text-rose-700" : "text-slate-900",
    neutral: "text-slate-900",
    warn: value > 0 ? "text-amber-700" : "text-slate-900",
  }[tone];
  return (
    <div className="rounded-sm border border-slate-200 bg-white px-3 py-2.5 text-center">
      <p className={cn("text-xl font-extrabold leading-none tracking-[-0.03em]", toneClass)}>{value}</p>
      <p className="mt-1.5 whitespace-nowrap text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">{label}</p>
      {sub ? <p className="mt-0.5 whitespace-nowrap text-phx-2xs font-medium text-slate-400">{sub}</p> : null}
    </div>
  );
}

function SummaryStrip({ summary }: { summary: CompanyActivityEmployeeSummary | null }) {
  const s = summary ?? {
    campaignVisits: 0,
    campaignVisitDays: 0,
    conflictDays: 0,
    crmFieldVisitDays: 0,
    leaveApprovedDays: 0,
    leavePendingDays: 0,
    noEntryDays: 0,
    noSignalDays: 0,
    officePresentDays: 0,
    totalCrmVisits: 0,
    workingDays: 0,
  };
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-8">
      <Stat label="Working Days" tone="neutral" value={s.workingDays} />
      <Stat label="Office" tone="neutral" value={s.officePresentDays} />
      <Stat label="CRM Visits" tone="neutral" value={s.totalCrmVisits} />
      <Stat
        label="Unplanned"
        sub={s.campaignVisitDays > 0 ? `${s.campaignVisitDays} ${s.campaignVisitDays === 1 ? "day" : "days"} · ${(s.campaignVisits / s.campaignVisitDays).toFixed(1)}/day` : "0 days"}
        tone="neutral"
        value={s.campaignVisits}
      />
      <Stat label="Leave Appr." tone="neutral" value={s.leaveApprovedDays} />
      <Stat label="Leave Pend." tone="warn" value={s.leavePendingDays} />
      <Stat label="No Entry" tone="danger" value={s.noEntryDays} />
      <Stat label="Conflict" tone="danger" value={s.conflictDays} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── One day row ──────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function DayRow({ day, hrId }: { day: CompanyActivityDayRow; hrId: string }) {
  const style = OUTCOME_STYLE[day.outcome];
  const gpsHref = `/admin/field-workforce-compliance/visits/${encodeURIComponent(hrId)}/${encodeURIComponent(day.dateIso)}`;

  return (
    <div
      className={cn(
        "rounded-sm border bg-white p-3.5",
        day.conflict ? "border-rose-300 ring-1 ring-rose-100" : "border-slate-200",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="whitespace-nowrap text-phx-md font-bold text-slate-900">{formatFullDate(day.dateIso, day.weekday)}</p>
          <span className={cn("inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-phx-xs font-bold", style.chip)}>
            {style.label}
          </span>
          {DAY_TYPE_BADGE_LABEL[day.dayType] ? (
            <span className="inline-flex items-center whitespace-nowrap rounded-full border border-slate-200 bg-white px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-[0.06em] text-slate-400">
              {DAY_TYPE_BADGE_LABEL[day.dayType]}
            </span>
          ) : null}
          {day.conflict ? (
            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-rose-300 bg-rose-100 px-2.5 py-0.5 text-phx-xs font-bold text-rose-800">
              <AlertTriangle className="h-3 w-3" />
              Conflict
            </span>
          ) : null}
          {day.hasNoSignal ? (
            <span className="whitespace-nowrap text-phx-xs font-semibold text-amber-600">⚠ no device / no Phoenix CRM seat</span>
          ) : null}
        </div>
        {day.crmVisitCount > 0 ? (
          <Link
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-slate-200 bg-white px-2.5 py-1 text-phx-xs font-bold text-slate-600 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
            href={gpsHref}
          >
            GPS detail <ArrowUpRight className="h-3 w-3" />
          </Link>
        ) : null}
      </div>

      <p className="mt-1.5 text-phx-sm font-medium leading-5 text-slate-500">{day.reason}</p>

      {day.hasOfficePunch ? (
        <p className="mt-2 inline-flex items-center gap-1.5 whitespace-nowrap text-phx-xs font-semibold text-slate-600">
          <Clock className="h-3 w-3 text-blue-500" />
          {minutesToClock(day.firstPunchMinutes)} &rarr; {minutesToClock(day.lastPunchMinutes)}
        </p>
      ) : null}

      {day.crmVisits.length > 0 ? (
        <ul className="mt-2.5 space-y-1.5 border-t border-slate-100 pt-2.5">
          {day.crmVisits.map((visit, index) => (
            <li key={index} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-phx-sm">
              <span className={cn("font-bold", visit.isCampaign ? "text-orange-700" : "text-slate-800")}>{visit.label}</span>
              {visit.session ? <span className="whitespace-nowrap text-phx-xs font-medium text-slate-400">{visit.session}</span> : null}
              {visit.customerName ? <span className="font-medium text-slate-600">{visit.customerName}</span> : null}
              {visit.contactName ? <span className="text-phx-xs font-medium text-slate-400">({visit.contactName})</span> : null}
              {visit.attributionUncertain ? (
                <span className="whitespace-nowrap text-phx-2xs font-bold uppercase tracking-[0.06em] text-amber-600">unmapped identity</span>
              ) : null}
              {visit.partner2Name ? <span className="font-medium text-slate-600">and {visit.partner2Name}</span> : null}
              {visit.comment ? <span className="basis-full text-phx-xs font-medium leading-4 text-slate-500">{visit.comment}</span> : null}
              {/* The Phoenix field set, on its own full-width line under the visit. `basis-full` is why
                  it needs no column of its own: the list already wraps, so the fits-the-screen rule is
                  satisfied by the flex it is already in. Nothing here is printed for a vendor visit. */}
              {phoenixVisitLine(visit) ? (
                <span className="basis-full text-phx-2xs font-semibold leading-4 text-slate-500">{phoenixVisitLine(visit)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {day.leave ? (
        <div className="mt-2.5 rounded-sm border border-violet-100 bg-violet-50/60 px-3 py-2 text-phx-sm">
          <p className="font-bold text-violet-800">
            {day.leave.vacationType ?? "Leave"} — <span className="font-semibold">{day.leave.status}</span>
            {day.leave.dayPart ? <span className="font-medium text-violet-600"> · {day.leave.dayPart}</span> : null}
          </p>
          {day.leave.managerDecision ? (
            <p className="mt-0.5 text-phx-xs font-medium text-violet-600">Manager decision: {day.leave.managerDecision}</p>
          ) : null}
          {day.leave.notes ? <p className="mt-0.5 text-phx-xs font-medium leading-4 text-violet-600">{day.leave.notes}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── View ─────────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

export function EmployeeDayDetailView({
  days,
  employee,
  endDate,
  startDate,
  summary,
}: {
  days: CompanyActivityDayRow[];
  employee: EmployeeDirectoryRow;
  endDate: string;
  startDate: string;
  summary: CompanyActivityEmployeeSummary | null;
}) {
  const sortedDays = [...days].sort((left, right) => left.dateIso.localeCompare(right.dateIso));

  return (
    <div className="space-y-4">
      <SummaryStrip summary={summary} />

      {summary && (!summary.hasAttendanceChannel || !summary.hasCrmChannel) ? (
        <p className="rounded-sm border border-amber-200 bg-amber-50/70 px-4 py-2.5 text-phx-xs font-medium leading-5 text-amber-900">
          <strong className="font-bold">{employee.displayName} has {[!summary.hasAttendanceChannel && "no fingerprint device", !summary.hasCrmChannel && "no Phoenix CRM seat"].filter(Boolean).join(" and ")} on file.</strong>{" "}
          Every day below marked &ldquo;No Signal Available&rdquo; reflects that gap in what the system can see — it is not evidence
          that nothing happened.
        </p>
      ) : null}

      {sortedDays.length === 0 ? (
        <div className="rounded-sm border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
          <p className="text-base font-extrabold tracking-tight text-slate-900">No days in this range</p>
          <p className="mx-auto mt-2 max-w-md text-phx-md font-medium leading-6 text-slate-500">
            {startDate} &rarr; {endDate} produced nothing to show for {employee.displayName}.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {sortedDays.map((day) => (
            <DayRow key={day.dateIso} day={day} hrId={employee.hrId} />
          ))}
        </div>
      )}
    </div>
  );
}
