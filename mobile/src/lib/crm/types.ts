/**
 * Phoenix CRM — the shapes the app's screens read.
 *
 * NARROW CLIENT MIRRORS, not the server's own types. The web app re-exports the service types through
 * `src/lib/phoenix-crm/view-types.ts`, but `mobile/` is its own TypeScript project and cannot import
 * server code (a database client, node:crypto) into the phone's bundle. So the fields these screens
 * actually use are transcribed here, field for field, from the server services:
 *   - overview:   src/lib/phoenix-crm/server/overview.ts
 *   - visits:     src/lib/phoenix-crm/server/visits.ts
 *   - list:       src/lib/phoenix-crm/server/list.ts
 *   - territory:  src/lib/phoenix-crm/server/territory.ts
 * When a field changes there it changes here; nothing enforces it but the shape of the JSON.
 */

export type CrmListType = "AM" | "PM";
export type CrmGrade = "A" | "B" | "C";
export type CrmVisitKind = "single" | "double" | "chain";
export type CrmSeason = "normal" | "ramadan";
export type CrmLocationFlag = "ok" | "far" | "weak_gps" | "no_place";

export type TerritorySummary = {
  seatId: string;
  name: string;
  lineCode: string | null;
  lineName: string | null;
  areaName: string | null;
  regionName: string | null;
  repHrId: string | null;
  repName: string | null;
  reviewerHrId: string | null;
  reviewerName: string | null;
};

export type CrmOverview = {
  viewer: {
    name: string;
    role: string;
    isSuperAdmin: boolean;
    isSfeManager: boolean;
    isRep: boolean;
    isManager: boolean;
  };
  cairoToday: string;
  tabs: {
    visits: boolean;
    list: boolean;
    plan: boolean;
    team: boolean;
    doctors: boolean;
    reports: boolean;
    settings: boolean;
  };
  territories: TerritorySummary[];
  ownSeatIds: string[];
  visitSeatIds: string[];
  waiting: Array<{ territory: TerritorySummary; message: string }>;
  waitingForYou: { requests: number; plans: number; isTest: boolean };
  closedMessage: string | null;
};

// ── Visits ────────────────────────────────────────────────────────────────────────────────────────

export type VisitRow = {
  visitId: string;
  visitDate: string;
  capturedAt: string;
  customerId: string;
  customerName: string;
  listType: CrmListType;
  kind: CrmVisitKind;
  kindLabel: string;
  repName: string | null;
  managerName: string | null;
  seniorName: string | null;
  enteredByName: string;
  products: string[];
  comment: string | null;
  photoPath: string;
  locationFlag: CrmLocationFlag;
  locationLabel: string;
  clockOff: boolean;
  /**
   * Off the plan, and where its approval has got to. Null on the ordinary planned visit.
   *
   * The rep sees this on his own day deliberately: it is his own visit, it is not counting yet, and
   * knowing who it sits with is the only way he can chase it.
   */
  unplanned: { status: "manager_pending" | "sfe_pending" | "approved" | "refused"; statusLabel: string; note: string; clarification: string } | null;
};

export type VisitDayView = {
  territory: TerritorySummary;
  isTest: boolean;
  date: string;
  visits: VisitRow[];
  canAdd: boolean;
};

export type VisitCustomerPlace = {
  placeId: string;
  label: string | null;
  address: string | null;
  lat: number;
  lon: number;
  photoPath: string;
  capturedAt: string;
  todayWindows: string;
};

export type VisitCustomerOption = {
  customerId: string;
  name: string;
  listType: CrmListType;
  grade: CrmGrade | null;
  speciality: string | null;
  places: VisitCustomerPlace[];
  plannedToday: boolean;
  /** The brick the customer's first place sits in, so the picker can group a day geographically. */
  brickId: string | null;
  brickName: string | null;
  /** What he discussed with this customer last time — null when there is no earlier visit. */
  lastVisit: { date: string; products: string[] } | null;
  visitedToday: boolean;
  visitsThisMonth: number;
  target: number | null;
  pending: boolean;
  referenceContactCrmId: number | null;
};

export type VisitPerson = {
  hrId: string;
  name: string;
  title: string;
  position: number;
};

export type VisitFormView = {
  territory: TerritorySummary;
  isTest: boolean;
  cairoToday: string;
  enteredAs: "rep" | "manager";
  managers: VisitPerson[];
  viewerPosition: number | null;
  products: string[];
  rules: { visitFarMeters: number; weakGpsMeters: number };
  customers: VisitCustomerOption[];
  todayVisits: VisitRow[];
  blockedReason: string | null;
};

export type SavedVisit = {
  visitId: string;
  visitDate: string;
  capturedAt: string;
  customerId: string;
  duplicate: boolean;
  locationFlag: CrmLocationFlag;
  locationLabel: string;
};

// ── List ──────────────────────────────────────────────────────────────────────────────────────────

export type CrmTiming = {
  weekday: number;
  startMinute: number;
  endMinute: number | null;
  season: CrmSeason;
};

export type ListPlace = {
  placeId: string;
  label: string | null;
  address: string | null;
  brickName: string | null;
  areaName: string | null;
  regionName: string | null;
  zone: string | null;
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  timings: CrmTiming[];
  photoPath: string;
  capturedAt: string;
  clockOff: boolean;
};

export type ListCustomerReference = {
  address: string | null;
  city: string | null;
  zone: string | null;
  lastVisitedOn: string | null;
};

export type ListCustomer = {
  customerId: string;
  listType: CrmListType;
  name: string;
  speciality: string | null;
  grade: CrmGrade | null;
  origin: "reference" | "new";
  referenceContactCrmId: number | null;
  status: "active" | "pending" | "dropped";
  validatedAt: string | null;
  validatedByName: string | null;
  reference: ListCustomerReference | null;
  droppedReason: string | null;
  droppedNote: string | null;
  statusChangedAt: string;
  places: ListPlace[];
  visitsThisMonth: number;
  target: number | null;
  pendingGradeRequestId: string | null;
  pendingGrade: CrmGrade | null;
  pendingDropRequestId: string | null;
};

export type ReferenceState = "new" | "validated" | "dropped" | "drop_pending";

export type ListReferenceEntry = {
  contactCrmId: number;
  listType: CrmListType;
  grade: CrmGrade | null;
  name: string;
  speciality: string | null;
  address: string | null;
  city: string | null;
  zone: string | null;
  lastVisitedOn: string | null;
  state: ReferenceState;
  customerId: string | null;
  pendingDropRequestId: string | null;
};

export type TerritoryListView = {
  territory: TerritorySummary;
  isTest: boolean;
  canEdit: boolean;
  canReview: boolean;
  readiness: { total: number; validated: number; dropped: number; open: number; dropPending: number; ready: boolean; readyAt: string | null };
  referenceSource: { name: string | null; isCurrent: boolean } | null;
  reference: ListReferenceEntry[];
  customers: ListCustomer[];
  monthStart: string;
  rules: { weakGpsMeters: number; placesMax: number };
  ramadan: { startsOn: string; endsOn: string } | null;
};

export type ValidateResult = {
  customerId: string;
  customerName: string;
  listType: CrmListType;
  placeId: string;
  capturedAt: string;
  restored: boolean;
  gradeRequestId: string | null;
};

// ── Plan ────────────────────────────────────────────────────────────────────────────────────────
// Transcribed from src/lib/phoenix-crm/server/plans.ts (PlanSummary, PlanItemView, PlanDayView,
// PlannerView, SavedPlan), src/lib/phoenix-crm/suggestions.ts (PlannerCustomer, PlannerPlace) and
// src/lib/phoenix-crm/plan-rules.ts (PlanItemDraft, PlanExceptionType). Same fields, same names.

export type CrmPlanStatus = "draft" | "submitted" | "approved" | "returned";

export type PlanExceptionType = "another_place" | "by_appointment" | "timings_changed" | "other";

export type PlanGradeTargets = Record<CrmListType, Record<CrmGrade, number | null>>;

/** One customer on one day of the rep's draft. `placeId` is null for a customer not validated yet. */
export type PlanItemDraft = {
  planDate: string;
  customerId: string;
  placeId: string | null;
  exceptionType: PlanExceptionType | null;
  exceptionNote: string | null;
};

export type PlanSummary = {
  planId: string;
  weekStart: string;
  status: CrmPlanStatus;
  statusLabel: string;
  version: number;
  submittedAt: string | null;
  submittedByName: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  /** The SFE Manager decided it, not the reviewing manager. */
  decidedBySfe: boolean;
  decisionNote: string | null;
  updatedAt: string;
};

export type PlanItemView = {
  customerId: string;
  placeId: string | null;
  /** Carried over from iReports360 and not validated yet. */
  pending: boolean;
  name: string;
  listType: CrmListType;
  grade: CrmGrade | null;
  speciality: string | null;
  placeLabel: string | null;
  brickName: string | null;
  zone: string | null;
  receives: boolean;
  windowsText: string;
  startMinute: number | null;
  exceptionType: string | null;
  exceptionLabel: string | null;
  exceptionNote: string | null;
  /** The customer left the list, or this place was removed, after planning. */
  stale: boolean;
  isolated: boolean;
  nearestKm: number | null;
};

export type PlanDayView = {
  date: string;
  /** ["AM","PM"], or ["AM"] on Thursday, or [] on Friday. */
  listTypes: CrmListType[];
  ramadan: boolean;
  /** Today or later: the rep may still change it. */
  editable: boolean;
  items: PlanItemView[];
  counts: Record<CrmListType, number>;
  spanKm: number;
  farApart: boolean;
};

export type PlannerPlace = {
  placeId: string;
  label: string | null;
  lat: number;
  lon: number;
  brick: string | null;
  zone: string | null;
  timings: CrmTiming[];
};

export type PlannerCustomer = {
  customerId: string;
  name: string;
  listType: CrmListType;
  grade: CrmGrade | null;
  speciality: string | null;
  visitsThisMonth: number;
  pending: boolean;
  places: PlannerPlace[];
};

export type PlannerView = {
  territory: TerritorySummary;
  isTest: boolean;
  cairoToday: string;
  weekStart: string;
  weeks: Array<{ weekStart: string; status: CrmPlanStatus | null; statusLabel: string }>;
  readiness: { ready: boolean; total: number; open: number; dropPending: number };
  pendingCount: number;
  rules: { pmDailyCap: number; amDailyCap: number; farApartKm: number; gradeTargets: PlanGradeTargets };
  plan: PlanSummary | null;
  days: PlanDayView[];
  customers: PlannerCustomer[];
  viewerIsRep: boolean;
  viewerIsReviewer: boolean;
  canEdit: boolean;
  canSubmit: boolean;
  canReopen: boolean;
  canApprove: boolean;
  canReturn: boolean;
  blockedReason: string | null;
};

export type SavedPlan = { planId: string; status: CrmPlanStatus; version: number; itemCount: number };

/** What /plans/submit and /plans/decide answer with. */
export type PlanTransition = { planId: string; status: CrmPlanStatus; version: number };

// ── What the phone sends ───────────────────────────────────────────────────────────────────────────

/** One receiving window, as the routes parse it: clock strings, the shape a time input gives. */
export type TimingDraftPayload = {
  weekday: number;
  start: string;
  end: string;
  season: CrmSeason;
};

/** A captured place, as /list/validate reads it. The location is resolved on the server, never sent. */
export type PlacePayload = {
  photoPath: string;
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  deviceCapturedAt: string | null;
  /** Android's mock-provider flag; null on iOS. Recorded on the server, shown to no rep. */
  deviceMocked: boolean | null;
  label: string | null;
  timings: TimingDraftPayload[];
};
