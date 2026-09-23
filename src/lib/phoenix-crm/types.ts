/**
 * Phoenix CRM — the field-force module built clean on 2026-09-16.
 *
 * The owner's brief ("forget what is on the system now"): a rep builds a clean customer list for the
 * territory (a live photo of the clinic sign or door, the location captured on the spot, and the
 * days and hours the customer receives), then plans the week on those timings, then enters every
 * visit live. Reports are native to this module; nothing here reads or feeds the iReports360 mirror
 * except the rep's iReports360 list, which is shown as a REFERENCE only.
 *
 * Vocabulary (owner, 2026-09-16):
 *   AM = accounts (hospitals, centres), visited in the morning.
 *   PM = doctors in their clinics, visited in the evening. The owner's sheet calls them "HCPS".
 *   (TRAP: src/lib/crm/contact-taxonomy.ts calls a PLACE "hcp". This module never uses that word.)
 *   Territory = a REP seat of the organogram. The list, its timings and its visits stay with the seat
 *   when a rep leaves or moves.
 *
 * This file is types only, shared by the server and the phone.
 */

export type PhoenixCrmListType = "AM" | "PM";

export type PhoenixCrmGrade = "A" | "B" | "C";

/** Normal timings, or the "special visit time" that is read only in Ramadan. */
export type PhoenixCrmSeason = "normal" | "ramadan";

/** Single: the rep alone. Double: rep + district manager. Chain: rep + district manager + a senior manager. */
export type PhoenixCrmVisitKind = "single" | "double" | "chain";

export type PhoenixCrmPlanStatus = "draft" | "submitted" | "approved" | "returned";

export type PhoenixCrmRequestKind = "grade" | "drop";

export type PhoenixCrmRequestStatus = "pending" | "approved" | "refused" | "withdrawn";

/** A visit's location check against the customer's validated place. A far visit still saves. */
export type PhoenixCrmLocationFlag = "ok" | "far" | "weak_gps";

/** One window in which a customer receives visits. */
export type PhoenixCrmTiming = {
  /** 0 = Sunday … 6 = Saturday, read from the calendar date. */
  weekday: number;
  /** Minutes after midnight, 0–1439. */
  startMinute: number;
  /**
   * Minutes after midnight of the same day; null when the owner's sheet style gives a start time only.
   * Above 1440 for a clinic that runs past midnight (10:00 PM – 1:00 AM is 1320–1500).
   */
  endMinute: number | null;
  season: PhoenixCrmSeason;
};

export type PhoenixCrmSettings = {
  /** The most PM doctors one plan day can hold (owner: 15). Plans only — visits are never capped. */
  pmDailyCap: number;
  /** The most AM accounts one plan day can hold (owner: 5). */
  amDailyCap: number;
  /** Two customers of one plan day further apart than this are highlighted to the reviewer. */
  farApartKm: number;
  /** A visit saved further than this from the validated place is flagged (it still saves). */
  visitFarMeters: number;
  /** A GPS fix less accurate than this is flagged as weak. */
  weakGpsMeters: number;
  /**
   * Visits a month each grade expects, per list. Null = no number for that grade, so its customers
   * count for coverage but never for frequency.
   */
  gradeTargets: Record<PhoenixCrmListType, Record<PhoenixCrmGrade, number | null>>;
};

export const PHOENIX_CRM_DEFAULT_SETTINGS: PhoenixCrmSettings = {
  pmDailyCap: 15,
  amDailyCap: 5,
  farApartKm: 10,
  visitFarMeters: 300,
  weakGpsMeters: 100,
  // The company's standard today (DEFAULT_REP_KPI_STANDARDS in src/lib/crm/rep-kpi-reports.ts, owner
  // 2026-09-06): PM A 3 · B 2 · C 1, AM A 1 with B and C unscored. Copied, not imported, so the phone
  // bundle never pulls the report module in; tests/phoenix-crm-rules.test.ts keeps the two equal.
  gradeTargets: {
    PM: { A: 3, B: 2, C: 1 },
    AM: { A: 1, B: null, C: null },
  },
};

/**
 * A list type has NO other name on any Phoenix CRM screen — it is "AM" and "PM", nothing else (owner,
 * 2026-09-23). The two label maps that turned them into "Accounts" and "Doctors" were removed here, so
 * the words cannot come back through a lookup; every screen prints the code itself. `listText`
 * (src/components/phoenix-crm/labels.ts) is the one place that decides how it reads.
 * Pinned by tests/phoenix-crm-am-pm-words.test.ts.
 */
