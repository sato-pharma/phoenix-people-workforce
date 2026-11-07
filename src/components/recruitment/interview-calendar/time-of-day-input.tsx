"use client";

// A time of day typed freely, to the minute — the owner, 7 Nov 2026: "make hr freely add any time".
// It holds minutes after midnight, like every other time on the calendar; the browser's own time
// field draws it in the viewer's 12- or 24-hour style. An interview may start at any minute of the
// day and must end by midnight (`isBookableWindow`).

/** "19:05" → 1145; anything that is not a time of day → null. */
export function parseTimeOfDay(text: string): number | null {
  const match = /^(\d{2}):(\d{2})/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 1145 → "19:05", the value a time field takes. */
export function timeOfDayValue(minutes: number | null): string {
  if (minutes === null || !Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60) return "";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function TimeOfDayInput({
  ariaLabel,
  className,
  id,
  onChange,
  value,
}: {
  ariaLabel?: string;
  className: string;
  id?: string;
  onChange: (minutes: number | null) => void;
  value: number | null;
}) {
  return (
    <input
      aria-label={ariaLabel}
      className={className}
      id={id}
      onChange={(event) => onChange(parseTimeOfDay(event.target.value))}
      step={60}
      type="time"
      value={timeOfDayValue(value)}
    />
  );
}
