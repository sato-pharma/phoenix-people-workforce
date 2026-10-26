/**
 * A person's name as a CHART axis label: first word and last word, so "Hany Mohamed Ali Saad" reads
 * "Hany Saad" and fits the axis on one line. Tables, cards and tooltips keep the full name; this is
 * for the narrow places only (owner, 2026-10-26: the DSM charts wrapped full legal names one word
 * per line and collided). A label that is not a person's name — "Giza — no regional manager" — is
 * returned untouched, as is a one- or two-word name.
 */
export function chartPersonName(value: string | null | undefined, fallback = "Employee"): string {
  const full = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!full) return fallback;
  if (full.includes("—")) return full;
  const words = full.split(" ");
  if (words.length <= 2) return full;
  return `${words[0]} ${words[words.length - 1]}`;
}
