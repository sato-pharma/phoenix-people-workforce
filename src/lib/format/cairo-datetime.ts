// One Africa/Cairo timestamp format, for screens that show when something happened.
//
// The owner reports and reads every time in Cairo local, never raw UTC. This was a private function
// inside recruitment-candidates-portal.tsx until the candidate comment thread needed the same
// format on 2026-08-30; it is here rather than copied so the two cannot drift into showing the same
// instant two ways on one card.
//
// Client-safe: no database, no server-only import. That matters — it is called from "use client"
// components, and a formatter that reached for anything server-side would drag it into the bundle.

/** e.g. `30 Aug 2026 · 14:05`. An absent or unparseable value renders as an em dash, never as now. */
export function cairoDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "—";
  const date = value.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
  const time = value.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" });
  return `${date} · ${time}`;
}
