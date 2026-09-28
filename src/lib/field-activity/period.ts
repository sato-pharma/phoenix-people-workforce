/**
 * Field Activity — the period a request asks for, validated.
 *
 * A report that silently accepts a year-long range is a report that times out on the first manager
 * who tries it, and one that silently narrows a range is a report that answers a question nobody
 * asked. Both ends are therefore explicit: a bad date is refused with its reason, and a range wider
 * than the cap is refused with the cap named.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 100 days. Long enough for a quarter of double visits, short enough to stay inside one request. */
export const MAX_PERIOD_DAYS = 100;

export type PeriodResult =
  | { ok: true; fromIso: string; toIso: string; days: number }
  | { ok: false; reason: string };

export function resolvePeriod(fromRaw: string | null, toRaw: string | null): PeriodResult {
  const fromIso = (fromRaw ?? "").trim();
  const toIso = (toRaw ?? "").trim();
  if (!ISO_DATE.test(fromIso) || !ISO_DATE.test(toIso)) {
    return { ok: false, reason: "Both dates are required, as YYYY-MM-DD." };
  }
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return { ok: false, reason: "That is not a real date." };
  if (to < from) return { ok: false, reason: "The end of the period is before its start." };
  const days = Math.round((to - from) / 86_400_000) + 1;
  if (days > MAX_PERIOD_DAYS) {
    return { ok: false, reason: `A period may cover at most ${MAX_PERIOD_DAYS} days; this one covers ${days}.` };
  }
  return { days, fromIso, ok: true, toIso };
}

/** The default a page opens on: the last full week, Sunday to Friday, in Cairo terms. */
export function defaultPeriod(todayIso: string): { fromIso: string; toIso: string } {
  const today = new Date(`${todayIso}T00:00:00Z`);
  const day = today.getUTCDay(); // 0 = Sunday, the first working day of the Egyptian week
  const startOfThisWeek = new Date(today.getTime() - day * 86_400_000);
  const start = new Date(startOfThisWeek.getTime() - 7 * 86_400_000);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return { fromIso: start.toISOString().slice(0, 10), toIso: end.toISOString().slice(0, 10) };
}
