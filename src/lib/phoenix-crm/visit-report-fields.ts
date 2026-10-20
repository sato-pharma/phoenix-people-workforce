/**
 * Phoenix CRM — the Visit report generator's catalogue: every field a visit can be reported with,
 * grouped the way the owner listed them (2026-10-15), with who may read each one.
 *
 * No server imports and no I/O: the page draws its buttons from this list, the loader reads what the
 * list names, and the workbook prints the labels it carries — so a field exists in exactly one place.
 *
 * 🔴 THREE SIGHTS, AND ONLY THREE (owner, 2026-10-15). The Super Admin reads every field. The SFE Manager
 * reads every field except the mock-location evidence, which is the Super Admin's alone (the integrity
 * board's `readsPositionCases`). The district manager reads his own team's visits through the fields
 * marked `manager`, which leave out the two things the owner ruled his: the measurement BEHIND a distance
 * (accuracy, phone clock, a place's raw readings and where its point came from — "District Managers see
 * the distance only", 2026-10-02) and the integrity board's cases and the capture telemetry that feeds
 * them (the board is the Super Admin's and the SFE Manager's). A field above the viewer's sight is
 * never READ for him and is absent from the answer, never blank or zero — Golden Rule #1's
 * server-shaping, applied to a report.
 *
 * 🔴 NO WORD OF "account" OR "doctor" IN A LABEL — the module guard refuses them in any string under
 * src/lib/phoenix-crm, and a customer is a customer. Labels are names, never codes.
 */

export type VisitReportCategoryId =
  | "when"
  | "org"
  | "customer"
  | "place"
  | "content"
  | "location"
  | "approval"
  | "validation"
  | "day"
  | "computed";

/** How a value is drawn on the screen and in the workbook. */
export type VisitReportFormat =
  | "text"
  | "date"
  | "datetime"
  | "integer"
  | "decimal"
  | "meters"
  | "km"
  | "seconds"
  | "minutes"
  | "coordinate"
  | "yesno"
  | "list";

/**
 * The least sight that reads a field. `manager`: the district manager (and so everyone above). `sfe`: the
 * SFE Manager and the Super Admin. `superAdmin`: the Super Admin alone.
 */
export type VisitReportSight = "manager" | "sfe" | "superAdmin";

/** What a reader is: the same three names as the sight a field needs. */
export type VisitReportReaderTier = VisitReportSight;

const TIER_RANK: Record<VisitReportReaderTier, number> = { manager: 1, sfe: 2, superAdmin: 3 };

export type VisitReportField = {
  key: string;
  label: string;
  category: VisitReportCategoryId;
  format: VisitReportFormat;
  /** Workbook column width, in characters. */
  width: number;
  sight: VisitReportSight;
  /** True for a field the rep fills only sometimes — the screen says how many visits carry it. */
  sparse?: boolean;
  /** One sentence on how to read it, shown on the button and on the workbook's cover. */
  hint?: string;
};

export type VisitReportCategory = { id: VisitReportCategoryId; label: string; blurb: string };

export const VISIT_REPORT_CATEGORIES: ReadonlyArray<VisitReportCategory> = [
  { id: "when", label: "When and how it was logged", blurb: "The day, the time it was saved and how the entry was made" },
  { id: "org", label: "Who and where in the org", blurb: "The rep, the seat and the managers above it" },
  { id: "customer", label: "Customer", blurb: "Who was visited and where they stand on the list" },
  { id: "place", label: "Place visited", blurb: "The validated place, its hours and its checks" },
  { id: "content", label: "What happened in the visit", blurb: "Products, samples, objections, next step and the comment" },
  { id: "location", label: "Location on the visit", blurb: "Where the phone was, how far from the place, and the integrity cases" },
  { id: "approval", label: "Approval of off-plan visits", blurb: "Why it was off plan and who approved it" },
  { id: "validation", label: "Validation of the place", blurb: "How the place was validated and the Google Maps check" },
  { id: "day", label: "The day around the visit", blurb: "The plan, the start of the day, activities, leave and requests" },
  { id: "computed", label: "Computed per visit", blurb: "Order, gaps, distance and speed between visits, repeat visits" },
];

const F = (
  category: VisitReportCategoryId,
  key: string,
  label: string,
  format: VisitReportFormat,
  width: number,
  extra: { sight?: VisitReportSight; sparse?: boolean; hint?: string } = {},
): VisitReportField => ({
  category,
  format,
  key,
  label,
  sight: extra.sight ?? "manager",
  width,
  ...(extra.sparse ? { sparse: true } : {}),
  ...(extra.hint ? { hint: extra.hint } : {}),
});

/**
 * 🔴 A VISIT'S SAVE TIME IS WHEN THE REP LOGGED IT, NOT WHEN HE WAS AT THE DOOR (owner, 2026-10-02). He may
 * log the morning from the car and the day at night, so an order, a gap or a speed worked out from save
 * times describes how he LOGS, and an honest rep trips all of them. These three fields say so wherever they
 * are shown, are never flagged and never coloured, and the speed is worked out ONLY from the two readings'
 * own phone-clock times (`fix_taken_at`), never from a save time.
 */
const SAVE_ORDER_HINT = "Counted in the order the visits were saved, which is how the rep logged them — not when the rep was at the door.";
const GAP_HINT = "The time between two saves, which is how the day was logged — not travel time and never a finding.";
const SPEED_HINT = "Worked out only when both visits carry the phone's own reading time; blank otherwise. Never a finding on its own.";

export const VISIT_REPORT_FIELDS: ReadonlyArray<VisitReportField> = [
  // ── When and how it was logged (15) ──
  F("when", "visitDate", "Visit date", "date", 13),
  F("when", "dayOfWeek", "Day of week", "text", 12),
  F("when", "month", "Month", "text", 11),
  F("when", "savedAt", "Saved at (Cairo time)", "datetime", 20, { hint: "When the rep saved the visit, which can be hours after the rep stood at the door." }),
  F("when", "visitType", "Visit type", "text", 16),
  F("when", "plannedOrNot", "Planned or unplanned", "text", 14),
  F("when", "unplannedKind", "Unplanned kind", "text", 14),
  F("when", "enteredBy", "Entered by", "text", 22),
  F("when", "entryRoute", "Entry route", "text", 18),
  F("when", "editedBySuperAdmin", "Edited by Super Admin", "text", 24),
  // The rep writing up his OWN visit afterwards — a different act from the correction above, and told
  // in the open (owner, 2026-10-15: "anything edited, it should appear that this is edited in the date
  // and time"). Kept apart from that field deliberately: the Super Admin's correction is told to
  // nobody, so one shared column would say which visits he had been through.
  F("when", "detailEdited", "Detail written up by the rep", "text", 26),
  F("when", "clockOffsetMinutes", "Phone clock offset (min)", "integer", 14, { sight: "sfe" }),
  F("when", "dwellSeconds", "Time at the door (sec)", "seconds", 14),
  F("when", "formOpenSeconds", "Form open time (sec)", "seconds", 14),
  F("when", "offlineSeconds", "Offline time (sec)", "seconds", 14),
  F("when", "syncedAt", "Synced at (Cairo time)", "datetime", 20),

  // ── Who and where in the org (10) ──
  // 🔴 "Who visited", never "Rep name": a district manager's own call on a rep's territory carries no rep,
  // and printing his name under "Rep" is false about a real person (the integrity board's "Who", 2026-10-13).
  F("org", "repName", "Who visited", "text", 24, {
    hint: "The rep, or the manager when it was a manager's own visit with no rep on it.",
  }),
  F("org", "repSeat", "Rep seat", "text", 28),
  F("org", "line", "Line", "text", 16),
  F("org", "district", "Team / district", "text", 22),
  F("org", "area", "Area", "text", 20),
  F("org", "region", "Region", "text", 20),
  F("org", "districtManager", "District manager", "text", 24),
  F("org", "regionalManager", "Regional manager", "text", 24),
  F("org", "managerOnVisit", "Manager on the visit", "text", 24),
  F("org", "productManagerOnVisit", "Product manager on the visit", "text", 24),

  // ── Customer (12) ──
  F("customer", "customerName", "Customer name", "text", 28),
  F("customer", "listType", "List", "text", 11),
  F("customer", "speciality", "Speciality", "text", 20),
  F("customer", "grade", "Grade", "text", 8),
  F("customer", "potentialGrade", "Potential grade", "text", 10),
  F("customer", "origin", "Origin", "text", 18),
  F("customer", "customerStatus", "Customer status", "text", 14),
  F("customer", "validatedAt", "Validated at", "datetime", 20),
  F("customer", "validatedBy", "Validated by", "text", 22),
  F("customer", "customerPhone", "Customer phone", "text", 16),
  F("customer", "primaryPharmacy", "Primary pharmacy", "text", 24),
  F("customer", "pharmacyOnVisit", "Pharmacy named on the visit", "text", 24),

  // ── Place visited (17) ──
  F("place", "placeLabel", "Place label", "text", 24),
  F("place", "placeAddress", "Address", "text", 34),
  F("place", "brick", "Brick", "text", 20),
  F("place", "zone", "Zone", "text", 16),
  F("place", "governorate", "Governorate", "text", 16),
  F("place", "placeStatus", "Place status", "text", 12),
  F("place", "placeSession", "Session (AM / PM)", "text", 12),
  F("place", "pointSource", "How the point was set", "text", 18, { sight: "sfe" }),
  F("place", "placeLat", "Place latitude", "coordinate", 12),
  F("place", "placeLon", "Place longitude", "coordinate", 12),
  F("place", "placeAccuracy", "Place accuracy (m)", "meters", 12, { sight: "sfe" }),
  F("place", "openingHours", "Opening hours", "text", 30),
  F("place", "signboardVerdict", "Signboard check verdict", "text", 20),
  F("place", "scheduleVerdict", "Schedule-sign check verdict", "text", 20),
  F("place", "sharedPlace", "Shared place (clinic name)", "text", 24),
  F("place", "placeNotes", "Place notes", "text", 36, { sparse: true }),
  F("place", "managerRecommendation", "Manager recommendation", "text", 28, { sparse: true }),

  // ── What happened in the visit (12) ──
  F("content", "productsDetailed", "Products detailed", "list", 28),
  F("content", "productsAvailable", "Products available at the pharmacy", "list", 28, { sparse: true }),
  F("content", "productsMissing", "Products missing at the pharmacy", "list", 28, { sparse: true }),
  F("content", "samplesGiven", "Samples given", "list", 24, { sparse: true }),
  F("content", "objection", "Objection", "text", 14, { sparse: true }),
  F("content", "objectionNote", "Objection note", "text", 30, { sparse: true }),
  F("content", "nextStep", "Next step", "text", 18, { sparse: true }),
  F("content", "nextStepDate", "Next-step date", "date", 13, { sparse: true }),
  F("content", "comment", "Comment", "text", 44),
  F("content", "detailComment", "Detailed comment", "text", 44, {
    hint: "The longer write-up the rep added after the visit. The comment above it was written at the door and is never changed.",
  }),
  F("content", "voiceNote", "Voice note", "yesno", 10),
  F("content", "voiceNoteSeconds", "Voice note length (sec)", "seconds", 12, { sparse: true }),
  F("content", "visitPhoto", "Visit photo", "yesno", 10),

  // ── Location on the visit (17) ──
  F("location", "visitLat", "Visit latitude", "coordinate", 12),
  F("location", "visitLon", "Visit longitude", "coordinate", 12),
  F("location", "visitAccuracy", "Visit accuracy (m)", "meters", 12, { sight: "sfe" }),
  F("location", "distanceFromPlace", "Distance from the place (m)", "meters", 14),
  F("location", "locationFlag", "Location flag", "text", 14),
  F("location", "photoLat", "Photo latitude", "coordinate", 12, { sight: "sfe" }),
  F("location", "photoLon", "Photo longitude", "coordinate", 12, { sight: "sfe" }),
  F("location", "photoAccuracy", "Photo accuracy (m)", "meters", 12, { sight: "sfe" }),
  F("location", "photoTakenAt", "Photo taken at (Cairo time)", "datetime", 20, { sight: "sfe" }),
  F("location", "fixAgeSeconds", "Fix age (sec)", "seconds", 10, { sight: "sfe" }),
  F("location", "deviceInstall", "Device install id", "text", 18, { sight: "sfe" }),
  F("location", "appRevision", "App revision", "text", 14, { sight: "sfe" }),
  F("location", "browser", "Browser", "text", 28, { sight: "sfe" }),
  F("location", "integrityDetectors", "Integrity detectors raised", "text", 28, { sight: "sfe" }),
  F("location", "integrityStrength", "Integrity strength", "text", 12, { sight: "sfe" }),
  F("location", "mockDevice", "Mock-location device", "yesno", 12, { sight: "superAdmin" }),
  F("location", "caseSettled", "Case settled", "text", 30, { sight: "sfe" }),

  // ── Approval of off-plan visits (9) ──
  F("approval", "offPlanReason", "Reason the rep gave", "text", 34),
  F("approval", "approvalStatus", "Approval status", "text", 16),
  F("approval", "managerDecidedBy", "Manager decided by", "text", 22),
  F("approval", "managerDecidedAt", "Manager decided at (Cairo time)", "datetime", 20),
  F("approval", "managerNote", "Manager note", "text", 30),
  F("approval", "sfeDecidedBy", "SFE decided by", "text", 22),
  F("approval", "sfeDecidedAt", "SFE decided at (Cairo time)", "datetime", 20),
  F("approval", "sfeNote", "SFE note", "text", 30),
  F("approval", "superAdminDecision", "Super Admin decision", "text", 34),

  // ── Validation of the place (5) ──
  F("validation", "validationStatus", "Validation status", "text", 16),
  F("validation", "validationDecidedBy", "Validation decided by", "text", 22),
  F("validation", "validationDecidedAt", "Validation decided at (Cairo time)", "datetime", 20),
  F("validation", "validationNote", "Validation note or refusal reason", "text", 36),
  F("validation", "googleResult", "Google Maps result", "text", 40),

  // ── The day around the visit (8) ──
  F("day", "plannedThatDay", "Planned that day", "yesno", 12, { hint: "On the plan the rep sent, or that was approved, for that day." }),
  F("day", "plannedStart", "Planned start time", "text", 12),
  F("day", "planException", "Plan exception", "text", 28),
  F("day", "dayStartedAt", "Day started at (Cairo time)", "datetime", 20),
  F("day", "dayActivity", "Day activity", "text", 26),
  // The manager's plan to go with the rep that day — never a double visit, which only the rep's own logged
  // visit naming him makes (owner, 2026-10-16). The key keeps its old name so saved report layouts still find it.
  F("day", "doubleVisitPlan", "Manager's plan with the rep", "text", 26),
  F("day", "visitRequest", "Visit request", "text", 26),
  F("day", "onLeave", "On approved leave that day", "yesno", 14),

  // ── Computed per visit (8) ──
  F("computed", "visitNumberInDay", "Visit number in the day", "integer", 12, { hint: SAVE_ORDER_HINT }),
  F("computed", "visitsThatDay", "Visits that day", "integer", 12),
  F("computed", "gapMinutes", "Gap since previous visit (min)", "minutes", 14, { hint: GAP_HINT }),
  F("computed", "distanceFromPreviousKm", "Distance from previous visit (km)", "km", 14, {
    hint: "The straight line between the two readings; it carries no time.",
  }),
  F("computed", "speedKmh", "Speed from previous visit (km/h)", "decimal", 14, { sight: "sfe", hint: SPEED_HINT }),
  F("computed", "customerVisitsThisMonth", "Visits to this customer this month", "integer", 14),
  F("computed", "daysSinceCustomerVisit", "Days since last visit to this customer", "integer", 14, {
    hint: "Looked up over the month before the period too; blank when none is found.",
  }),
  F("computed", "repMonthFlags", "Monthly behaviour flags for the rep", "text", 30, { sight: "sfe" }),
];

const BY_KEY = new Map(VISIT_REPORT_FIELDS.map((field) => [field.key, field]));

export function visitReportField(key: string): VisitReportField | undefined {
  return BY_KEY.get(key);
}

/** The fields a reader may be offered: those whose sight is no higher than his own. */
export function visitReportFieldsFor(tier: VisitReportReaderTier): VisitReportField[] {
  return VISIT_REPORT_FIELDS.filter((field) => TIER_RANK[field.sight] <= TIER_RANK[tier]);
}

/**
 * The chosen keys, cleaned: unknown keys dropped, keys above the viewer's sight dropped, duplicates
 * removed, and the catalogue's own order kept — the workbook's columns and the screen's detail follow it.
 */
export function resolveVisitReportSelection(keys: ReadonlyArray<unknown>, tier: VisitReportReaderTier): VisitReportField[] {
  const wanted = new Set(keys.filter((key): key is string => typeof key === "string"));
  return visitReportFieldsFor(tier).filter((field) => wanted.has(field.key));
}

export function visitReportCategoryOf(id: VisitReportCategoryId): VisitReportCategory {
  return VISIT_REPORT_CATEGORIES.find((category) => category.id === id) ?? VISIT_REPORT_CATEGORIES[0];
}

// ── The lead columns and the ready-made sets ─────────────────────────────────────────────────────

/**
 * 🔴 THE WORKBOOK ALWAYS STARTS WITH THE DATE, WHO VISITED AND THE CUSTOMER, ticked or not (owner,
 * 2026-10-16, reversing the 15 Oct "only the chosen data" for these three alone). A file of distances or
 * approval notes with no date and no name on each line cannot be read on its own. A ticked lead field is
 * not printed twice: it moves to the front.
 */
export const VISIT_REPORT_LEAD_KEYS: ReadonlyArray<string> = ["visitDate", "repName", "customerName"];

export type VisitReportStarterSet = { id: string; label: string; blurb: string; keys: ReadonlyArray<string> };

/**
 * Three ready-made choices a reader starts from instead of ticking a hundred boxes (owner, 2026-10-16).
 * Each is cut to the reader's own sight by `visitReportStarterFields`, so a set may name a field a
 * district manager is never offered and it is simply left out.
 */
export const VISIT_REPORT_STARTER_SETS: ReadonlyArray<VisitReportStarterSet> = [
  {
    blurb: "Who saw which customer, when, and what was said",
    id: "daily",
    keys: [
      "visitDate", "dayOfWeek", "savedAt", "visitType", "plannedOrNot",
      "repName", "managerOnVisit", "productManagerOnVisit",
      "customerName", "listType", "speciality", "grade",
      "placeLabel", "brick",
      "productsDetailed", "samplesGiven", "comment",
      "plannedThatDay", "dayActivity", "visitsThatDay",
    ],
    label: "Daily activity",
  },
  {
    blurb: "Where each visit was saved against the place",
    id: "location",
    keys: [
      "visitDate", "repName", "customerName",
      "placeLabel", "placeAddress", "brick", "governorate", "placeLat", "placeLon", "placeAccuracy", "pointSource",
      "visitLat", "visitLon", "visitAccuracy", "distanceFromPlace", "locationFlag",
      "photoAccuracy", "integrityDetectors", "integrityStrength", "mockDevice",
    ],
    label: "Location",
  },
  {
    blurb: "Every visit off the plan, the reason and who decided",
    id: "offPlan",
    keys: [
      "visitDate", "repName", "customerName", "plannedOrNot", "unplannedKind", "offPlanReason",
      "approvalStatus", "managerDecidedBy", "managerDecidedAt", "managerNote",
      "sfeDecidedBy", "sfeDecidedAt", "sfeNote", "superAdminDecision",
    ],
    label: "Off-plan approvals",
  },
];

/** A ready-made set as THIS reader may have it: the catalogue's order, nothing above the reader's sight. */
export function visitReportStarterFields(set: VisitReportStarterSet, tier: VisitReportReaderTier): VisitReportField[] {
  return resolveVisitReportSelection(set.keys, tier);
}

// ── Saved views ──────────────────────────────────────────────────────────────────────────────────

/** How many saved views one person may keep, and how long a view's name may be. */
export const VISIT_REPORT_SAVED_VIEWS_MAX = 20;
export const VISIT_REPORT_VIEW_NAME_MAX = 60;

/** One saved choice of fields — its owner's alone (owner, 2026-10-16: "Only its owner", "Fields only"). */
export type VisitReportSavedView = { id: string; name: string; fields: string[] };

/** A view's name, cleaned: spaces collapsed and trimmed; null when nothing is left or it is too long. */
export function cleanVisitReportViewName(value: unknown): string | null {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > VISIT_REPORT_VIEW_NAME_MAX) return null;
  return name;
}

// ── The period ───────────────────────────────────────────────────────────────────────────────────

/**
 * One rep may be read over a quarter; a district is several reps' worth of rows, so a month — and so is a
 * manager (owner, 2026-10-20), whose visits run across every territory he went out on.
 */
export const VISIT_REPORT_MAX_DAYS_REP = 92;
export const VISIT_REPORT_MAX_DAYS_DISTRICT = 31;

/**
 * Who a report is about: one rep's territory, a district, or a MANAGER — every visit he was on with a rep, as the
 * double or chain visit's manager or senior, or as the product manager the rep ticked (owner, 2026-10-20: "when
 * filter by manager u find no manager"). A manager's report ALSO lists the single visits he logged alone, as rows
 * under his own name (owner, 2026-10-20, multiple choice: "Show, keep out of reps") — `ownVisit` marks them, no
 * rep's row and no dashboard figure ever counts one, and none is asked for a location or a photo.
 */
export type VisitReportTargetKind = "rep" | "district" | "manager";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / 86_400_000;
}

export type VisitReportPeriodResult = { ok: true; from: string; to: string; days: number } | { ok: false; error: string };

/** Validates a from/to pair. `to` may not pass today (Cairo): a visit cannot be in the future. */
export function resolveVisitReportPeriod(input: {
  from: unknown;
  to: unknown;
  cairoToday: string;
  kind: VisitReportTargetKind;
}): VisitReportPeriodResult {
  const from = typeof input.from === "string" ? input.from.trim() : "";
  const to = typeof input.to === "string" ? input.to.trim() : "";
  if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(dayNumber(from)) || Number.isNaN(dayNumber(to))) {
    return { ok: false, error: "Choose the first and the last day." };
  }
  if (from > to) return { ok: false, error: "The first day comes after the last day." };
  const last = to > input.cairoToday ? input.cairoToday : to;
  if (from > last) return { ok: false, error: "Choose days up to today." };
  const days = dayNumber(last) - dayNumber(from) + 1;
  const cap = input.kind === "rep" ? VISIT_REPORT_MAX_DAYS_REP : VISIT_REPORT_MAX_DAYS_DISTRICT;
  if (days > cap) {
    const forWhom = input.kind === "rep" ? "one rep" : input.kind === "manager" ? "a manager" : "a district";
    return { ok: false, error: `Choose at most ${cap} days for ${forWhom}.` };
  }
  return { ok: true, days, from, to: last };
}

// ── What the loader answers ──────────────────────────────────────────────────────────────────────

export type VisitReportValue = string | number | boolean | null;

/**
 * One visit. The head is always sent — the table, the map and the dashboard read it — and holds nothing
 * a viewer below his sight could not read; `values` holds ONLY the fields that were chosen.
 */
export type VisitReportRow = {
  visitId: string;
  visitDate: string;
  savedAtIso: string;
  /** Whose visit it is: the rep, or the manager on his own visit — never the seat's occupant. */
  repName: string;
  /**
   * EVERYONE on the visit, by name: the person it is credited to first, then the manager, the senior manager and
   * the product manager who came along (owner, 2026-10-20). "Who visited" matches any of them, so the manager on
   * a double visit can be chosen as well as the rep; `repName` still says whose visit it is.
   */
  participants: string[];
  customerName: string;
  listType: string;
  visitType: string;
  planned: boolean;
  placeLabel: string | null;
  visitLat: number | null;
  visitLon: number | null;
  placeLat: number | null;
  placeLon: number | null;
  distanceMeters: number | null;
  locationFlag: string | null;
  values: Record<string, VisitReportValue>;
  /**
   * A single visit the manager logged ALONE, shown under his own name (owner, 2026-10-20: "Show, keep out of
   * reps"). A display row: the dashboard's figures leave it out, it is on no rep's row, and it carries no
   * distance, no location verdict and no photo verdict — his own visit needs none of them. Absent on every
   * visit a rep logged.
   */
  ownVisit?: boolean;
};

export type VisitReportDashboardTile = { label: string; value: string; hint?: string };

export type VisitReportDashboardPanel = {
  id: string;
  category: VisitReportCategoryId;
  title: string;
  /** `columns`: a value per day or step in order; `bars`: ranked labels. */
  kind: "columns" | "bars";
  items: Array<{ label: string; value: number; text?: string }>;
  /** Said under the panel — how many visits carried the field, never a bare zero. */
  note?: string;
};

export type VisitReportDashboard = { tiles: VisitReportDashboardTile[]; panels: VisitReportDashboardPanel[] };

export type VisitReportTarget = { kind: VisitReportTargetKind; id: string };

export type VisitReportView = {
  target: { kind: VisitReportTargetKind; id: string; name: string; reps: string[] };
  period: { from: string; to: string; days: number };
  selected: string[];
  total: number;
  rows: VisitReportRow[];
  /** For each sparse chosen field, how many visits carry a value. */
  filled: Record<string, number>;
  days: string[];
  dashboard: VisitReportDashboard;
  generatedAtIso: string;
};

export type VisitReportScopeRep = { id: string; label: string; repName: string; lineName: string | null; districtName: string | null };
export type VisitReportScopeDistrict = { id: string; label: string; lineName: string | null; repCount: number };
/** A manager the picker offers: `id` is the person, since a product manager holds no seat and a manager may hold two. */
export type VisitReportScopeManager = { id: string; label: string; name: string; title: string };

export type VisitReportScopeView = {
  cairoToday: string;
  defaults: { from: string; to: string };
  reps: VisitReportScopeRep[];
  /** Every district of the viewer's reach — an all-vacant one too, since its visits are still somebody's work. */
  districts: VisitReportScopeDistrict[];
  /**
   * Every manager the viewer reads (`managersInScope`, never upward) who stands above one of his territories, and the
   * lines' product managers where he is given them (`loadScopeProductManagers`) — owner, 2026-10-20.
   */
  managers: VisitReportScopeManager[];
  /** What this reader is — the page offers exactly the fields up to this sight. */
  sight: VisitReportReaderTier;
};
