/**
 * Road km as the expense desk prints it: whole km, except when rounding would carry a distance that is
 * under the trip minimum up to the minimum itself. Then it prints the exact km, cut (never rounded) to two
 * decimals, so a trip under the minimum never reads as being at it.
 *
 * Why: claim 335 (23 Nov 2026) was 59.75 km to the first double visit and the desk said "60 km from home,
 * under the 60 km minimum for a trip" — a sentence that contradicts itself (owner: "Fix the wording").
 *
 * No imports: the opened trip (a client component) and the desk's server sentence share this one rule.
 */
export function tripKmText(km: number | null, minimumKm: number | null = null): string {
  if (km === null || !Number.isFinite(km)) return "an unknown distance";
  const whole = Math.round(km);
  if (minimumKm !== null && km < minimumKm && whole >= minimumKm) {
    return `${(Math.floor(km * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} km`;
  }
  return `${whole.toLocaleString("en-US")} km`;
}
