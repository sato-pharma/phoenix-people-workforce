"use client";

// The interview's Area and Line — optional, and both shown in the calendar and the share link so an
// outside viewer can read the interviewer, the area and the line at a glance (owner, 2026-09-26).
// Choosing the interviewer auto-fills these from their org seat (handled by the dialog); they stay
// editable here. Line is the small fixed set of sales lines; Area is a name, usually auto-filled.

const LINES = ["CNS", "Anti Infective", "Pedia", "Head Office", "Other"] as const;

const inputClass = "mt-1 block w-full border border-slate-200 px-2 py-1.5 text-[13px] text-slate-800 focus:border-orange-500 focus:outline-none";

export function OrgFields({
  area,
  line,
  onArea,
  onLine,
}: {
  area: string;
  line: string;
  onArea: (value: string) => void;
  onLine: (value: string) => void;
}) {
  // Keep an auto-filled line that is not one of the fixed options selectable rather than dropping it.
  const lineOptions = line && !(LINES as readonly string[]).includes(line) ? [line, ...LINES] : [...LINES];
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      <label className="block">
        <span className="text-[12px] font-bold text-slate-700">Line (optional)</span>
        <select className={inputClass} onChange={(event) => onLine(event.target.value)} value={line}>
          <option value="">—</option>
          {lineOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-[12px] font-bold text-slate-700">Area (optional)</span>
        <input autoComplete="off" className={inputClass} maxLength={80} onChange={(event) => onArea(event.target.value)} placeholder="e.g. Delta (1)" value={area} />
      </label>
    </div>
  );
}
