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

/**
 * Which list a customer sits on. `Pharmacy` joined AM and PM on 2026-10-02, when each rep's
 * iReports360 pharmacies were imported (`src/lib/phoenix-crm/pharmacy-call-rules.ts`).
 *
 * 🔴 A SURFACE THAT MEASURES DOCTORS MUST NARROW THIS, NOT ACCEPT IT. A plan, a capacity, a coverage
 * or frequency figure and a grade target are all AM-and-PM things; a pharmacy is never planned and
 * is in no KPI. `doctorListType` is the narrowing — it answers null for a pharmacy so the caller has
 * to decide what to do with the row, which is exactly what the old `=== "AM" ? "AM" : "PM"` hid by
 * answering "PM".
 */
export type PhoenixCrmListType = "AM" | "PM" | "Pharmacy";

/** The two halves of a rep's day: what a plan, a target, a capacity and a coverage figure are about. */
export type PhoenixCrmDoctorListType = "AM" | "PM";

export type PhoenixCrmGrade = "A" | "B" | "C";

/** Normal timings, or the "special visit time" that is read only in Ramadan. */
export type PhoenixCrmSeason = "normal" | "ramadan";

/**
 * Who was on the visit. Single: the rep alone. Double: rep + ONE manager above the territory. Chain: rep
 * + a manager + ONE more (a senior manager above him, or — since 2026-10-06 — one of the line's product
 * managers). Product manager: the rep with one of HIS LINE's product managers (owner, 2026-10-02) — the
 * same four words a visit ASK uses, so the request and the visit it became read alike (`VisitAskKind`
 * in visit-ask-rules.ts). The rep never picks that last kind by name: he ticks one person under "Double
 * visit" and `visit-company.ts` files it as `product_manager` when that person is one.
 *
 * 🔴 A PRODUCT MANAGER IS NOT A DOUBLE VISIT AND MUST NEVER BE FILED AS ONE. He holds no seat in the
 * organogram at all (`au.v_org_tree` is sales-only), so he is not in the territory's manager chain and
 * cannot be checked against it; and a double visit means the rep with a MANAGER of the territory, which
 * `double_visits` is counted from on every board. He rides in his own column,
 * `phoenix_crm_visits.product_manager_hr_id`, and in no other.
 */
export type PhoenixCrmVisitKind = "single" | "double" | "product_manager" | "chain";

export type PhoenixCrmPlanStatus = "draft" | "submitted" | "approved" | "returned";

/**
 * grade: one step, the district manager. drop, add and restore: the district manager, then SFE
 * (owner, 2026-09-29). An add admits a customer the rep met outside his list; a restore brings one
 * back from the Archive.
 */
export type PhoenixCrmRequestKind = "grade" | "drop" | "add" | "restore";

/** Who decides a two-step request next. Null once it is decided, and always null for a grade. */
export type PhoenixCrmRequestStage = "manager" | "sfe";

/**
 * pending: carried over from iReports360, not validated yet. active: validated, on the list.
 * outside: met and validated at the door, not on the list until the district manager and SFE admit him
 * (owner, 2026-09-29). dropped: in the Archive.
 */
export type PhoenixCrmCustomerStatus = "active" | "pending" | "outside" | "dropped";

export type PhoenixCrmRequestStatus = "pending" | "approved" | "refused" | "withdrawn";

/** A visit's location check against the customer's validated place. A far visit still saves. */
export type PhoenixCrmLocationFlag = "ok" | "far" | "weak_gps" | "no_place";

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
  /**
   * The visits ONE shared place holds in one visit day, whatever the number of customers seated in it
   * (owner, 2026-10-09: three). Unlike the two caps above it binds the plan AND the door — the visit
   * trigger reads this same column — because a polyclinic's day is physically one queue.
   */
  sharedPlaceDailyCap: number;
  /**
   * The most DOCTORS one rep may visit OUT OF PLAN in one visit day (owner, 2026-10-10: two) and in one
   * field week, Saturday to Thursday (eight). Like the polyclinic cap it binds the DOOR — the visit
   * trigger reads these same columns — and never the plan, which an off-plan visit is not on.
   */
  offPlanDailyCap: number;
  offPlanWeeklyCap: number;
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
  gradeTargets: Record<PhoenixCrmDoctorListType, Record<PhoenixCrmGrade, number | null>>;
  /**
   * The call rate the monthly plan is measured against: AM accounts a working day (owner: 2) and PM
   * doctors a working day (owner: 10), reported APART and NEVER averaged (the call-rate golden rule).
   * Copied from src/lib/crm/call-rate.ts's standard, not imported, so the phone bundle never pulls that
   * module in; tests/phoenix-crm-rules.test.ts keeps the two equal.
   */
  callRateAmTarget: number;
  callRatePmTarget: number;
  /**
   * The visit retry's off switch (owner, 3 Nov 2026), so it can be stopped without a merge. Off, a rep's
   * press behaves as it did before the queue existed and nothing held is sent by itself.
   */
  visitResendEnabled: boolean;
};

export const PHOENIX_CRM_DEFAULT_SETTINGS: PhoenixCrmSettings = {
  // On (owner, 3 Nov 2026) — the column's own SQL default, the same way the caps below copy theirs.
  visitResendEnabled: true,
  pmDailyCap: 15,
  amDailyCap: 5,
  // Three (owner, 2026-10-09). The same number as SHARED_PLACE_DAILY_CAP_DEFAULT in
  // shared-place-rules.ts and as the column's own SQL default — copied, not imported, so this type
  // module stays free of the rules module; tests/phoenix-crm-shared-place.test.ts keeps all three equal.
  sharedPlaceDailyCap: 3,
  // Two a day and eight a week (owner, 2026-10-10) — the columns' own SQL defaults, copied here so this
  // type module stays free of the rules module; tests/phoenix-crm-offplan-cap.test.ts keeps them equal.
  offPlanDailyCap: 2,
  offPlanWeeklyCap: 8,
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
  // The company's standard call rate (src/lib/crm/call-rate.ts, owner): 2 AM accounts and 10 PM
  // doctors a working day. Copied, not imported; tests/phoenix-crm-rules.test.ts keeps the two equal.
  callRateAmTarget: 2,
  callRatePmTarget: 10,
};

/**
 * A list type has NO other name on any Phoenix CRM screen — it is "AM" and "PM", nothing else (owner,
 * 2026-09-23). The two label maps that turned them into "Accounts" and "Doctors" were removed here, so
 * the words cannot come back through a lookup; every screen prints the code itself. `listText`
 * (src/components/phoenix-crm/labels.ts) is the one place that decides how it reads.
 * Pinned by tests/phoenix-crm-am-pm-words.test.ts.
 */
