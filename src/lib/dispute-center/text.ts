// Pure text rules shared by every dispute conversation — safe to import from anywhere.

/**
 * Line breaks kept (a reply written as a list stays a list), runs of spaces and blank lines tidied.
 * The old deduction comment collapsed every line break into one long line; a dispute is often a
 * list of times and places, so it no longer does.
 */
export function tidyDisputeText(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * "Sat 4 Oct 2026" for a DATE-ONLY value — read in UTC on purpose, the rule the private calendar
 * follows, so no zone offset can move the day being argued about.
 */
export function dayLabel(dateIso: string): string {
  const parsed = new Date(`${String(dateIso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return String(dateIso);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    weekday: "short",
    year: "numeric",
  })
    .format(parsed)
    .replace(",", "");
}

/** "4 Oct 2026, 14:05" in Cairo time for an instant. */
export function cairoTimeLabel(iso: string | null | undefined): string {
  const parsed = new Date(String(iso ?? ""));
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(parsed);
}

/** "1 day", "0.5 day", "2 days". */
export function daysLabel(days: number): string {
  const rounded = Math.round(days * 100) / 100;
  return `${rounded} ${rounded > 0 && rounded <= 1 ? "day" : "days"}`;
}

/** "1,234.50 EGP". */
export function moneyLabel(amount: number): string {
  return `${amount.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} EGP`;
}

/** The body a reply of pictures alone is saved with, because a message row cannot be blank. */
export function picturesOnlyBody(count: number): string {
  return count === 1 ? "Picture attached." : "Pictures attached.";
}

/** The line a notification adds when the reply carries pictures the notification cannot show. */
export function picturesNotice(count: number): string {
  if (count <= 0) return "";
  return count === 1
    ? "(1 picture is attached - open the dispute to see it.)"
    : `(${count} pictures are attached - open the dispute to see them.)`;
}
