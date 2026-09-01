/**
 * The Reps List board's chrome — the section frame and the KPI tile, shared by both tabs.
 *
 * The vocabulary is copied verbatim from doctor-list-board.tsx, the board Reps List replaced: flat
 * borders, slate-900 header bar, KPI tiles, orange accent. Never a one-off look (owner's standing
 * rule).
 *
 * EXTRACTED so the Contact List tab and the Reps Weekly Plans tab cannot drift apart visually. Two
 * tabs inside one border that each define their own header bar is two headers that differ the first
 * time either is touched — and the whole reason the owner asked for a tab rather than a second page
 * is that these are one screen.
 */

export function Section({
  action,
  children,
  description,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <div className="border-b border-slate-200 bg-white last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 bg-slate-900 px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{title}</h2>
          {description ? <p className="mt-0.5 text-phx-2xs text-slate-400">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function Tile({
  label,
  sub,
  tone,
  value,
}: {
  label: string;
  sub?: string;
  tone?: "amber" | "emerald" | "rose" | "sky";
  value: string;
}) {
  const valueClass =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "rose"
          ? "text-rose-700"
          : tone === "sky"
            ? "text-sky-700"
            : "text-slate-900";
  return (
    <div className="border border-slate-200 px-3 py-2.5">
      <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className={`text-lg font-black ${valueClass}`}>{value}</p>
      {sub ? <p className="text-phx-2xs text-slate-400">{sub}</p> : null}
    </div>
  );
}

/** Cairo wall-clock, per the owner's standing rule that no raw UTC is ever shown. */
export function cairoStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date(iso));
}
