import { todayInCairo } from "@/lib/date-only";

/**
 * The last month that has FINISHED in Cairo, as `YYYY-MM` — the ceiling of the loaded-sales
 * frontier. A batch whose period says otherwise (a direct order dated next month) is not "loaded".
 */
export function lastFinishedCairoMonth(now: Date = new Date()): string {
  const [year, month] = todayInCairo(now).split("-").map(Number) as [number, number];
  const previous = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  return `${previous.y}-${String(previous.m).padStart(2, "0")}`;
}

/**
 * The pure form of the SQL helper `phx_marketing_roi_latest_validated_period()` — the two must not
 * drift. 🔴 The direct-orders feed (template `direct_orders`, distributor `DirectReq`) is one batch
 * per month dated by the ORDER, so it exists for months whose distributor files have not arrived and
 * for months that have not happened; counting it emptied the every-month set and walked the frontier
 * to Nov 2026 on 26 Oct 2026. It never decides a month is loaded, and nothing past `ceiling` is.
 */
export function pickLoadedFrontier(
  batches: ReadonlyArray<{ period?: string | null; distributor_code?: string | null; template_key?: string | null }>,
  ceiling: string,
): string | null {
  const byPeriod = new Map<string, Set<string>>();
  for (const row of batches) {
    const period = (row.period ?? "").trim();
    const distributor = (row.distributor_code ?? "").trim();
    if (!period || !distributor || period > ceiling) continue;
    if ((row.template_key ?? "") === "direct_orders" || distributor.toUpperCase() === "DIRECTREQ") continue;
    const held = byPeriod.get(period) ?? new Set<string>();
    held.add(distributor);
    byPeriod.set(period, held);
  }
  const months = [...byPeriod.keys()].sort();
  if (months.length === 0) return null;
  // One month of history is no history: there is no every-month set, the test below would pass
  // vacuously, and reporting nothing would leave every campaign waiting for ever.
  if (months.length === 1) return months[0] ?? null;

  const settled = months.slice(0, -1);
  const everyMonth = [...(byPeriod.get(settled[0] ?? "") ?? new Set<string>())].filter((distributor) =>
    settled.every((period) => byPeriod.get(period)?.has(distributor)),
  );

  for (const period of [...months].reverse()) {
    const present = byPeriod.get(period) ?? new Set<string>();
    if (everyMonth.every((distributor) => present.has(distributor))) return period;
  }
  return null;
}
