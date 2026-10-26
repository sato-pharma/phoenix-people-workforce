/**
 * Field Activity — the few wordings the screen and the PDF must say identically.
 *
 * Pure and import-free, so the client view can call it without pulling the model's server-side
 * imports into the browser, and the PDF (`document.ts`) says the same sentence the screen does.
 */

/**
 * A straight-line leg between two stops: metres below a kilometre, kilometres with two decimals from
 * one kilometre up. "21054 m" made a reader count digits; "21.05 km" is the same distance at a glance.
 */
export function legDistanceLabel(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(2)} km`;
}

type LagStop = { logLagMinutes: number | null; phoenixVisit?: boolean; formOpenSeconds?: number | null };

/**
 * What the "logged at" line says under one stop.
 *
 * 🔴 A PHOENIX CRM VISIT HAS NO DOOR-TO-LOG LAG: its check-in IS the log, so the old subtraction read
 * "0 min later" on every stop — a number nobody measured. It says where the log came from instead, and
 * how long the visit form was open when Phoenix recorded that.
 */
export function stopLogNote(stop: LagStop): string {
  if (stop.phoenixVisit) {
    const formOpen = stop.formOpenSeconds != null && stop.formOpenSeconds > 0 ? ` · form open ${stop.formOpenSeconds} s` : "";
    return `Phoenix CRM, saved at check-in${formOpen}`;
  }
  return stop.logLagMinutes == null ? "" : `${stop.logLagMinutes} min later`;
}

/**
 * The LOGGING WINDOW fact's second line. The average is of iReports360 calls only (a Phoenix stop's lag
 * is null in the model), so a day of Phoenix visits alone says the lag is not measured rather than
 * "average 0 min after the door".
 */
export function loggingWindowNote(day: {
  averageLogLagMinutes: number | null;
  logsLandedNextDay: boolean;
  stops: LagStop[];
}): string {
  if (day.logsLandedNextDay) {
    return `the NEXT day — average ${((day.averageLogLagMinutes ?? 0) / 60).toFixed(1)} hours after the door`;
  }
  const hasPhoenix = day.stops.some((stop) => stop.phoenixVisit);
  if (day.averageLogLagMinutes != null) {
    return hasPhoenix
      ? `average ${day.averageLogLagMinutes} min after the door, iReports360 calls only — not measured for Phoenix CRM visits`
      : `average ${day.averageLogLagMinutes} min after the door`;
  }
  return hasPhoenix ? "lag not measured for Phoenix CRM visits — the check-in is the log" : "";
}
