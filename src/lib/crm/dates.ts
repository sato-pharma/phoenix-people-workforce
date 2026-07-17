/** Small UTC date helpers shared by the CRM sync + read code. */

/** Today's date as YYYY-MM-DD (UTC). */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `dateIso` shifted by `days` (may be negative), as YYYY-MM-DD (UTC). */
export function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
