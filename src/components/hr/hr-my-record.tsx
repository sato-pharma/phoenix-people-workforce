/**
 * "My record" — the viewer's own employment facts, on her own landing page.
 *
 * WHY IT IS HERE. Until 2026-09-01 an HR seat had TWO overview pages: this one, and a personal
 * dashboard at /workspace one sidebar row below it, carrying her leave balance, her excuse
 * allowance and her attendance for the month. The owner's instruction that day was to merge them —
 * "make the overview dashboard merged between HR overview and my workspace into one landing
 * overview page" — so this section is that page's content, in this page's language, and the
 * /workspace address now redirects the two HR seats straight here.
 *
 * IT IS DELIBERATELY THE LAST SECTION. The page reads in the order her day does: what is waiting
 * on her, then how the function she runs is doing, then her own record. Putting a personal leave
 * balance above a queue of people waiting on her would be the wrong emphasis for a seat whose job
 * is other people.
 *
 * IT LOOKS DIFFERENT FROM THE TILES ABOVE, ON PURPOSE. Every other figure on this page is a
 * COMPANY figure and is orange-accented and centred; these four are HERS. They are left-aligned,
 * slate-accented rows rather than centred cards, so that no glance can mistake "3 days of annual
 * leave left" for a company total. The type scale, weights and tracking are the page's own — this
 * is a different arrangement of the same design system, never a second one.
 *
 * NO PAYROLL FIGURE, EVER. The owner's standing rule for any overview or landing page, for every
 * role: no payslip amount and not even the month label. Payslips are a link in "My pages".
 *
 * A NULL SOURCE RENDERS AN EM DASH AND SAYS SO. A zero would read as "you have no leave left" or
 * "you were never at work this month", which is the misleading zero this repo's rules forbid.
 *
 * NEVER A HORIZONTAL SCROLL (owner's golden rule). No table, no `min-width`, no `overflow-x-auto`.
 * Every row is flex-wrap and every value carries `break-words`; nothing is truncated.
 */

import {
  ArrowUpRight,
  CalendarClock,
  CircleAlert,
  Fingerprint,
  Plane,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";

import type { HrPersonalRecord } from "@/lib/hr/command-center";

/** Cairo-formatted day. The owner reports every time in Africa/Cairo, never raw UTC. */
function cairoDate(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(parsed);
}

const STATUS_LABELS: Record<
  string,
  { label: string; tone: "amber" | "emerald" | "rose" | "slate" }
> = {
  approved: { label: "Approved", tone: "emerald" },
  cancelled: { label: "Cancelled", tone: "slate" },
  pending_manager: { label: "With your manager", tone: "amber" },
  rejected: { label: "Rejected", tone: "rose" },
};

function StatusPill({ status }: { status: string }) {
  const resolved = STATUS_LABELS[status] ?? {
    label: status.replace(/_/g, " "),
    tone: "slate" as const,
  };
  const toneClass = {
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    rose: "border-rose-200 bg-rose-50 text-rose-800",
    slate: "border-slate-200 bg-slate-50 text-slate-600",
  }[resolved.tone];
  return (
    <span
      className={`inline-flex shrink-0 whitespace-nowrap border px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.12em] ${toneClass}`}
    >
      {resolved.label}
    </span>
  );
}

/**
 * One of her own figures. Left-aligned rather than centred — see the header for why these must not
 * read as company tiles. `value` is null when the source did not answer, and the card then says so
 * in the caption instead of printing a number nobody measured.
 */
function OwnStat({
  caption,
  icon: Icon,
  label,
  tone,
  value,
}: {
  caption: string;
  icon: LucideIcon;
  label: string;
  tone: "amber" | "emerald" | "slate";
  value: number | null;
}) {
  const valueClass = {
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    slate: "text-slate-900",
  }[tone];

  return (
    <div className="min-w-0 border border-slate-200 bg-white px-4 py-3.5">
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <span className="break-words text-[9px] font-black uppercase leading-tight tracking-[0.14em] text-slate-500">
          {label}
        </span>
      </div>
      <p className={`mt-2.5 text-2xl font-black leading-none tabular-nums ${valueClass}`}>
        {value === null ? "—" : value.toLocaleString("en-US")}
      </p>
      <p className="mt-2 break-words text-[10px] font-bold uppercase leading-4 tracking-[0.1em] text-slate-400">
        {caption}
      </p>
    </div>
  );
}

export function HrMyRecord({ record }: { record: HrPersonalRecord }) {
  const { attendance, excuses, leave, pages, requests } = record;

  return (
    <section className="border-t border-slate-100" id="hr-group-my-record">
      <div className="flex items-start gap-3 border-b border-slate-200/70 bg-gradient-to-b from-white to-slate-50/60 px-5 py-4">
        {/* Slate, not orange. Every other section header on this page is a company function; this
            badge is the one that says "this part is about you". */}
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-gradient-to-br from-slate-50 to-slate-100 text-slate-600">
          <UserRound aria-hidden="true" className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-950">
              My Record
            </span>
            <span className="whitespace-nowrap border border-slate-200 bg-white px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.12em] text-slate-500">
              Only yours
            </span>
          </div>
          <p className="mt-1 break-words text-[11px] font-semibold leading-relaxed text-slate-500">
            Your own leave, excuses and attendance — the same figures the pages below hold, on the
            page you land on.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 p-5 lg:grid-cols-4">
        <OwnStat
          // "0 of 0 days taken" is what a brand-new joiner's entitlement reads as, and it looks
          // like a bug rather than the truth that nothing has accrued yet. Amber is wrong for the
          // same person: she has not used up her leave, she has not earned any.
          caption={
            !leave
              ? "Balance did not load"
              : leave.entitlementDays === 0
                ? "No entitlement accrued yet"
                : `${leave.usedDays} of ${leave.entitlementDays} days taken`
          }
          icon={Plane}
          label="Annual leave left"
          tone={
            !leave || leave.entitlementDays === 0
              ? "slate"
              : leave.balanceDays > 0
                ? "emerald"
                : "amber"
          }
          value={leave ? leave.balanceDays : null}
        />
        <OwnStat
          caption={
            excuses
              ? `${excuses.used} of ${excuses.allowance} used${excuses.pending ? ` · ${excuses.pending} awaiting a decision` : ""}`
              : "Allowance did not load"
          }
          icon={CalendarClock}
          label="Excuses left this month"
          tone={excuses ? (excuses.remaining > 0 ? "emerald" : "amber") : "slate"}
          value={excuses ? excuses.remaining : null}
        />
        <OwnStat
          caption={attendance ? `Fingerprint · ${attendance.monthLabel}` : "Attendance did not load"}
          icon={Fingerprint}
          label="Days recorded"
          tone="slate"
          value={attendance ? attendance.recordedDays : null}
        />
        <OwnStat
          caption={attendance ? "Days needing a look this month" : "Attendance did not load"}
          icon={CircleAlert}
          label="Attendance flags"
          tone={attendance ? (attendance.exceptions > 0 ? "amber" : "emerald") : "slate"}
          value={attendance ? attendance.exceptions : null}
        />
      </div>

      {/* Her own requests. Shown only when there are some — an empty list here would be a third
          "nothing to see" panel on a page that already answers that question twice, and the
          Submit Excuse link below covers the case where she has never filed one. */}
      {requests && requests.length > 0 ? (
        <div className="border-t border-slate-100 px-5 pb-5 pt-4">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">
            My excuse requests
          </p>
          <ul className="mt-2 divide-y divide-slate-100">
            {requests.map((request) => (
              <li
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5"
                key={request.id}
              >
                <span className="min-w-0">
                  <span className="block break-words text-[12.5px] font-bold leading-snug text-slate-900">
                    {cairoDate(request.date)}
                  </span>
                  <span className="mt-0.5 block break-words text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
                    {request.type.replace(/_/g, " ")} · {request.durationHours}h
                  </span>
                </span>
                <StatusPill status={request.status} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {pages.length > 0 ? (
        <div className="border-t border-slate-100 px-5 pb-6 pt-4">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">
            My pages
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {pages.map((page) => (
              <Link
                className="group/page inline-flex items-center gap-1.5 border border-slate-200 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-slate-600 transition-colors hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                href={page.href}
                key={page.href}
              >
                {page.label}
                <ArrowUpRight
                  aria-hidden="true"
                  className="h-3 w-3 text-slate-300 transition-colors group-hover/page:text-orange-500"
                />
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
