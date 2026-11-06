/**
 * The row shapes of the retired iReports360 Reporting API — a visit and a check-in exactly as the
 * vendor sent them. The vendor sync stopped for good on 6 November 2026
 * (crm_cutover.vendor_sync_retired_at, on the owner's word) and its HTTP client went with it; these
 * two types stay because the stored mirror rows are still read in this shape (the rep-day
 * drill-down, the Field Workforce Compliance matrix). Nothing here talks to the vendor.
 *
 * VENDOR TIMESTAMP INVARIANT (load-bearing — do not "helpfully" convert; it lived in the retired
 * sync engine until 6 November 2026 and every stored vendor row still carries it): iReports360 sent
 * `saveDate`/`checkDate`/`visitDate` as zone-less strings that are ALREADY Africa/Cairo wall-clock
 * (e.g. "2026-07-16T18:13:18", no offset). They were stored verbatim into `timestamptz` columns under
 * a UTC DB session, so the stored instant reads back as the same Cairo wall-clock and every display
 * renders it with timeZone:"UTC" (no shift). Never append a Cairo offset or run AT TIME ZONE on
 * these — that double-shifts the clock 2–3h. `visit_date_time` is a 00:00 placeholder (no real
 * time-of-day); the authoritative visit time is derived by resolveVisitTime (crm/reads.ts): GPS
 * check-in → save time → none, never visit_date_time.
 */

export type IReports360Visit = {
  agentID: number;
  agentName: string | null;
  ampm: string | null;
  attendance: number | null;
  callType: number | null;
  comment: string | null;
  contactID: number | null;
  contactName: string | null;
  // Added by the vendor 2026-07-24: the visited contact's commercial potential grade
  // (A+/A/B/C — A highest). Sent with inconsistent casing/whitespace ("b", " A", "B   ") — the
  // retired sync normalized it before storing. Same customer-visits-only population pattern as
  // region/speciality below.
  contactGrade: string | null;
  customerName: string | null;
  doubleID: number | null;
  doubleName: string | null;
  id: number;
  // Added by the vendor 2026-07-22: the visited contact's locality (region/regionID) and medical
  // specialty. Populated on regular customer visits only (visitType 0); null on campaign/meeting/
  // leave entries, which carry no real contact. Finer-grained than Phoenix's own au.regions.
  region: string | null;
  regionID: number | null;
  saveDate: string | null;
  speciality: string | null;
  visitDate: string;
  visitType: number;
  visitTypeDescription: string | null;
};

export type IReports360Checkin = {
  address: string | null;
  agentID: number;
  checkDate: string;
  contactID: number | null;
  contactName: string | null;
  id: number;
  lat: number | null;
  lon: number | null;
};
