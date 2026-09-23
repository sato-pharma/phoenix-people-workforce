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
  label: string | null;
  timings: TimingDraftPayload[];
};
