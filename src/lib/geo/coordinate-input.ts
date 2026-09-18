/**
 * One coordinate exactly as a client posted it, read as a number, or null when it posted none.
 *
 * Deliberately NOT `Number(value)`. `Number(null)`, `Number("")` and `Number(" ")` are all 0,
 * which is finite, so a client with no GPS fix sailed past every `Number.isFinite` check and was
 * stored at 0°N 0°E, in the Gulf of Guinea. Only a finite number or a non-blank numeric string is
 * a coordinate here. Null, a missing key, "", whitespace, booleans, objects and non-numeric strings
 * are all "no number".
 *
 * This reads ONE value and decides nothing else. Whether half a pair, or the exact pair 0,0, is a
 * position is each domain's own rule, and the domains differ: outstation drops both
 * (src/lib/outstation/captured-coordinates.ts), while a direct-order pharmacy claim keeps each
 * coordinate on its own and refuses a field claim missing either
 * (src/lib/direct-orders/pharmacy-validation.ts). There is no range check, because no caller has
 * one.
 *
 * Pure and dependency-free.
 */
export function readCoordinateInput(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
