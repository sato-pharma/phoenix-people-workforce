import type { PrivateCalendarEntry } from "@/lib/phoenix-crm/team-calendar";

/** The sentence a page shows when private-calendar sources could not be read — said, never an empty day. */
export function privateCalendarUnreadNote(unread: readonly string[]): string {
  return `The private calendar's ${unread.join(", ")} could not be read just now, so an entry from ${unread.length === 1 ? "it" : "them"} is not shown here.`;
}

/**
 * Phoenix CRM — one day's entries from the PRIVATE calendar (owner, 2026-11-27: "every single entry … must appear in
 * both calendars"). The private calendar's own words: what kind of entry, the time, what it says and its status.
 * Display only — nothing here counts toward a figure.
 */
export function PrivateCalendarEntriesList({ entries }: { entries: readonly PrivateCalendarEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-2 min-w-0">
      <p className="break-words text-sm font-black leading-6 text-slate-900">From the private calendar</p>
      <ul className="mt-1 grid min-w-0 gap-1">
        {entries.map((entry, index) => (
          <li className="break-words text-sm font-semibold leading-6 text-slate-700" key={`${entry.source}-${entry.time}-${index}`}>
            <span className="font-black text-slate-900">{entry.label}</span>
            {entry.time ? ` · ${entry.time}` : ""}
            {" — "}
            <span dir="auto">{entry.title}</span>
            {entry.status ? ` · ${entry.status}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
