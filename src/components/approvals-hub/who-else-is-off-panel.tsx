import { adminPanelClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import type { WhoElseIsOff } from "@/lib/vacation/who-else-is-off";

/** A stored calendar day as a person reads it. UTC on purpose: a date has no time of day to place in a zone. */
function calendarDay(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(parsed);
}

function dateRange(fromDate: string, toDate: string): string {
  return fromDate === toDate ? calendarDay(fromDate) : `${calendarDay(fromDate)} to ${calendarDay(toDate)}`;
}

function summaryLine(data: Extract<WhoElseIsOff, { state: "ready" }>): string {
  if (data.teamSize === 0) return "Nobody else reports to this manager.";
  const people = new Set(data.rows.map((row) => row.name)).size;
  const team = `${data.teamSize} ${data.teamSize === 1 ? "teammate" : "teammates"} under the same manager`;
  if (people === 0) return `Nobody else is off on these dates, out of ${team}.`;
  const peak = data.peak && data.peak.count > 1 ? ` At most ${data.peak.count} on one day, ${calendarDay(data.peak.day)}.` : "";
  return `${people} of ${team} ${people === 1 ? "has" : "have"} leave on these dates.${peak}`;
}

/** Shown to the person deciding, and it decides nothing: no warning colour, no limit, no suggestion. */
export function WhoElseIsOffPanel({ data }: { data: WhoElseIsOff }) {
  return (
    <section className={adminPanelClassName}>
      <header className={`${adminPanelHeaderClassName} px-4 py-2.5`}>
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Who else is off</h3>
      </header>
      <div className="px-4 py-3">
        {data.state === "unavailable" ? (
          <p className="text-sm font-semibold text-slate-700">
            The team&rsquo;s leave could not be read just now, so this does not mean nobody is off.
          </p>
        ) : data.state === "no_manager" ? (
          <p className="text-sm font-semibold text-slate-700">
            This person has no manager on record, so there is no team to compare these dates with.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-slate-800">{summaryLine(data)}</p>
            {data.rows.length > 0 ? (
              <ul className="divide-y divide-slate-100 border-t border-slate-100">
                {data.rows.map((row) => (
                  <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2" key={row.id}>
                    <span className="min-w-0 break-words text-sm font-bold text-slate-900" dir="auto">{row.name}</span>
                    <span className="text-phx-xs font-semibold text-slate-600">
                      {dateRange(row.fromDate, row.toDate)} · {row.dayPartLabel} ·{" "}
                      {row.isApproved ? "Approved" : "Waiting for a decision"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
