import type { VenueType } from "@/lib/venues/venue-type";

/**
 * Every customer type the database accepts — `marketing_customers_type_check` allows exactly these
 * five, so this list is the schema, not a preference.
 *
 * `doctor` is legacy-only by design: the create dropdown in the Customer Validation workspace
 * deliberately offers the other four, so no NEW customer is typed `doctor`. But 130 active
 * customers imported by the 2026-07-02 ROI backfill ARE `doctor`, and they must still be readable,
 * completable, and writable. Leaving `doctor` out of a runtime guard does not stop anyone creating
 * one — it only breaks the rows that already exist.
 *
 * The union is DERIVED from this list rather than written out beside it. It was written out
 * beside it until 2026-08-21, the two drifted, and `normalizeCustomerType` rejected `doctor` while
 * the union, the DB constraint and 130 live rows all still allowed it.
 */
export const MARKETING_CUSTOMER_TYPES = [
  "doctor",
  "hospital",
  "clinic",
  "account",
  "other",
] as const;

export type MarketingCustomerType = (typeof MARKETING_CUSTOMER_TYPES)[number];

export type MarketingEvidenceStatus = "missing" | "pending" | "complete";

export type MarketingValidationStatus =
  | "pending"
  | "system_validated"
  | "sfe_validated"
  | "rejected";

export type MarketingPharmacyCodeReferenceStatus =
  | "pending"
  | "matched"
  | "ambiguous"
  | "not_found"
  | "manual_approved"
  | "rejected";

export type MarketingRequestStatus =
  | "draft"
  | "pending_validation"
  | "pending_approval"
  | "returned"
  | "rejected"
  | "approved"
  | "active"
  | "roi_tracking"
  | "closed"
  | "finance_hold"
  | "archived";

export type MarketingRoiStatus =
  | "not_calculated"
  | "covers_required"
  | "under_target";

export type MarketingWorkflowApprovalScope =
  | "direct_manager"
  | "role"
  | "finance"
  | "final";

export type MarketingStepKind = "managerial_chain" | "role" | "finance";

export type MarketingDecisionLabels = {
  approve: string;
  reject: string;
  return: string;
};

export type MarketingApprovalStepStatus =
  | "pending"
  | "current"
  | "approved"
  | "rejected"
  | "returned"
  | "skipped";

export type MarketingRequestPharmacyTrackingStatus =
  | "pending_validation"
  | "active"
  | "inactive";

export type MarketingInvoiceStatus =
  | "not_required"
  | "pending"
  | "submitted"
  | "cleared"
  | "overdue"
  | "hold";

export type MarketingEvidenceEntityType = "customer" | "pharmacy";
export type MarketingEvidenceType = "location_photo" | "sign_photo" | "other";

export type MarketingRequestType = {
  active: boolean;
  code: string;
  createdAt: string;
  description: string | null;
  id: number;
  name: string;
  requiresDescription: boolean;
  sortOrder: number;
  updatedAt: string;
};

export type MarketingWorkflowStep = {
  active: boolean;
  allowReject: boolean;
  allowReturn: boolean;
  approvalScope: MarketingWorkflowApprovalScope;
  assignedRole: string;
  ccRoles: string[];
  chainTargetRole: string | null;
  createdAt: string;
  decisionLabels: MarketingDecisionLabels;
  defaultSlaDays: number | null;
  id: number;
  required: boolean;
  sequence: number;
  stepCode: string;
  stepKind: MarketingStepKind;
  stepName: string;
  terminalStatus: MarketingRequestStatus | null;
  updatedAt: string;
};

export type MarketingControlSettingGroup = "roi" | "finance" | "validation";

export type MarketingControlSetting = {
  adminOnly: boolean;
  createdAt: string;
  key: string;
  label: string;
  group: MarketingControlSettingGroup;
  updatedAt: string;
  updatedByHrId: string | null;
  value: Record<string, unknown>;
};

export type MarketingControlWorkspace = {
  canManageValidationRules: boolean;
  requestTypes: MarketingRequestType[];
  settings: MarketingControlSetting[];
  workflowSteps: MarketingWorkflowStep[];
};

export type MarketingDistributor = {
  active: boolean;
  createdAt: string;
  displayName: string;
  distributorCode: string;
  id: number;
  normalizedName: string;
  sourceName: string | null;
  updatedAt: string;
};

export type MarketingProduct = {
  active: boolean;
  createdAt: string;
  factoryPrice: number;
  family: string | null;
  id: number;
  line: string | null;
  lineId: number | null;
  normalizedName: string;
  productCode: string;
  productName: string;
  sourceCompany: string | null;
  sourceFile: string | null;
  updatedAt: string;
};

export type MarketingPharmacyCodeReference = {
  createdAt: string;
  distributorId: number | null;
  id: number;
  importBatchId: string | null;
  normalizedDistributorName: string;
  rawArea: string | null;
  rawDistributorName: string;
  rawPharmacyAddress: string | null;
  rawPharmacyCode: string;
  rawRegion: string | null;
  sourceFile: string;
  sourceRow: number;
};

export type MarketingCapturedLocation = {
  capturedAccuracyMeters: number | null;
  capturedAddress: string | null;
  capturedAt: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
};

export type MarketingEvidenceCapture = {
  evidenceHasTimestamp: boolean;
  evidencePhotoCapturedAt: string | null;
  evidencePhotoName: string | null;
};

export type MarketingCustomer = MarketingCapturedLocation & MarketingEvidenceCapture & {
  active: boolean;
  areaId: number | null;
  createdAt: string;
  createdByHrId: string | null;
  customerCode: string;
  customerType: MarketingCustomerType;
  displayName: string;
  evidenceStatus: MarketingEvidenceStatus;
  extractedAreaName: string | null;
  extractedGovernorateName: string | null;
  id: string;
  lineId: number | null;
  managerHrId: string | null;
  normalizedName: string;
  otherTypeDescription: string | null;
  ownerHrId: string | null;
  regionName: string | null;
  updatedAt: string;
  updatedByHrId: string | null;
  validatedAt: string | null;
  validatedByHrId: string | null;
  validationNotes: string | null;
  validationStatus: MarketingValidationStatus;
};

export type MarketingCustomerContact = {
  active: boolean;
  contactCode: string;
  contactName: string;
  createdAt: string;
  createdByHrId: string | null;
  crmCode: string | null;
  customerId: string;
  id: string;
  mobileNumber: string | null;
  notes: string | null;
  specialty: string | null;
  updatedAt: string;
};

export type MarketingPharmacy = MarketingCapturedLocation & MarketingEvidenceCapture & {
  active: boolean;
  areaId: number | null;
  createdAt: string;
  createdByHrId: string | null;
  displayName: string;
  evidenceStatus: MarketingEvidenceStatus;
  extractedAreaName: string | null;
  extractedGovernorateName: string | null;
  id: string;
  lineId: number | null;
  managerHrId: string | null;
  /** When the merge happened. Null unless `mergedIntoPharmacyId` is set. */
  mergedAt: string | null;
  /**
   * Who performed the merge. Null for a row backfilled from a duplicate the system had already
   * deactivated, because no person made that call through the application.
   */
  mergedByHrId: string | null;
  /**
   * The surviving venue this duplicate was folded into, or null for a venue that is not a
   * duplicate — which is nearly all of them. Deliberately the same shape as
   * `direct_order_pharmacies`, so one mental model covers both modules.
   */
  mergedIntoPharmacyId: string | null;
  normalizedName: string;
  ownerHrId: string | null;
  pharmacyCode: string;
  regionName: string | null;
  updatedAt: string;
  updatedByHrId: string | null;
  validatedAt: string | null;
  validatedByHrId: string | null;
  validationNotes: string | null;
  validationStatus: MarketingValidationStatus;
  /** `pharmacy` or `nursery`. Reads back as `pharmacy` for every row written before 2026-08-23. */
  venueType: VenueType;
};

/**
 * What a venue merge actually moved. Every count is rows that CHANGED — a child already sitting on
 * the survivor is counted as `alreadyOnSurvivor`, not as moved, because reporting it as moved would
 * overstate what the merge did.
 */
/**
 * One venue as the merge picker sees it. Deliberately NOT derived from the Customer Database rows:
 * those are customer LINKS, so a duplicate venue that was created and never linked to anybody —
 * the easiest duplicate to make and the one most worth retiring — would be absent from the very
 * list you need it in.
 *
 * `mergedIntoPharmacyId` travels with the row so the picker can label an already-merged venue
 * instead of offering it, which the service would refuse anyway.
 */
export type MarketingVenueMergeCandidate = {
  active: boolean;
  area: string | null;
  displayName: string;
  governorate: string | null;
  id: string;
  mergedIntoPharmacyId: string | null;
  pharmacyCode: string;
  venueType: VenueType;
};

export type MarketingVenueMergeResult = {
  alreadyOnSurvivor: number;
  codesMoved: number;
  customerLinksMoved: number;
  loserId: string;
  requestTargetsMoved: number;
  survivorId: string;
  transfersMoved: number;
};

export type MarketingPharmacyDistributorCode = {
  active: boolean;
  createdAt: string;
  createdByHrId: string | null;
  distributorId: number;
  distributorPharmacyCode: string;
  id: string;
  normalizedPharmacyCode: string;
  pharmacyId: string;
  referenceId: number | null;
  referenceMatchCount: number;
  referenceStatus: MarketingPharmacyCodeReferenceStatus;
  updatedAt: string;
  validatedAt: string | null;
  validatedByHrId: string | null;
  validationNotes: string | null;
};

/** One selectable target venue, already resolved to what the picker needs to show. */
export type MarketingRequestPharmacyOption = {
  /**
   * The distributor code sales attribute through, or null for a venue that has no distributor
   * account. Was the option's identity until 2026-08-23; `targetId` is now, because a nursery has
   * no code and two codeless nurseries would otherwise be the same option.
   */
  distributorCodeId: string | null;
  /** Null for a venue with no distributor account. */
  distributorName: string | null;
  pharmacyCode: string;
  /** Always set. The venue itself, whether or not a code hangs off it. */
  pharmacyId: string;
  pharmacyName: string;
  /** Lets the form warn about an unverified code before submitting, not after being refused. */
  referenceStatus: MarketingPharmacyCodeReferenceStatus;
  /**
   * The value the form submits and keys its checkboxes on. For a pharmacy this IS the distributor
   * code id, byte for byte — so a draft saved before this field existed still submits exactly what
   * it always did and still resolves. Build and read it only through `encodeVenueTarget` /
   * `decodeVenueTarget` in ./venue-type; never assemble the string by hand.
   */
  targetId: string;
  venueType: VenueType;
};

export type MarketingCustomerPharmacy = {
  active: boolean;
  createdAt: string;
  createdByHrId: string | null;
  customerId: string;
  /** Null only for a venue with no distributor account — see VenueType. */
  distributorCodeId: string | null;
  id: string;
  pharmacyId: string;
  updatedAt: string;
  updatedByHrId: string | null;
  validationNotes: string | null;
  validationStatus: MarketingValidationStatus;
};

/**
 * One already-validated pharmacy offered back on the validation form's "My Pharmacies" tab.
 *
 * Exists because two customers a street apart routinely dispense through the SAME shop, and until
 * now the only way to record that was to re-enter the pharmacy from scratch under the second
 * customer — a second shop-front photo, a second GPS fix, and the distributor codes typed again.
 * Measured on production 2026-08-19: 7 of the 25 field-validated pharmacies were the same code
 * entered twice by the same rep. Picking one of these instead creates only the customer↔pharmacy
 * link, so one physical shop stays one record however many customers it serves.
 */
export type MarketingReusablePharmacy = {
  areaName: string | null;
  capturedAddress: string | null;
  displayName: string;
  /**
   * Carried so the picker can warn BEFORE the pick: linking a pharmacy whose own live photo and
   * location are short parks the new customer on "Not Usable Yet", exactly as capturing an
   * incomplete one would. Flagged, never hidden — the owner's standing rule.
   */
  evidenceStatus: MarketingEvidenceStatus;
  governorateName: string | null;
  id: string;
  /** False when it belongs to a colleague the viewer shares an area or a reporting line with. */
  isOwn: boolean;
  /** How many customers already dispense through it — the reason the rep recognises the shop. */
  linkedCustomerCount: number;
  ownerHrId: string | null;
  ownerName: string | null;
  pharmacyCode: string;
  validationStatus: MarketingValidationStatus;
  /**
   * Every active distributor code on the pharmacy. Picking it links all of them, as capturing would.
   *
   * Empty for a nursery, which has no distributor account — that is the whole point of the venue
   * type. Do NOT reintroduce a "hide rows with no codes" filter here without checking `venueType`:
   * one existed until 2026-08-23 and it is what would have hidden every nursery from the picker.
   */
  vendorCodes: Array<{
    distributorCodeId: string;
    distributorId: number;
    distributorName: string;
    distributorPharmacyCode: string;
    referenceStatus: MarketingPharmacyCodeReferenceStatus;
  }>;
  /** `pharmacy` or `nursery` — see `venueRequiresDistributorCode` in ./venue-type. */
  venueType: VenueType;
};

/**
 * The speciality options offered on a validated customer.
 *
 * Deliberately a fixed list rather than the raw `speciality` text iReports360 syncs onto
 * `crm_visits`: that vendor field is free text with inconsistent casing and near-duplicates, and
 * feeding it into a picker would reproduce the mess it already contains. A closed list keeps the
 * spelling stable so these can ever be grouped or counted. Server-validated in
 * `normalizeMarketingValidationInput` — a value outside this list is rejected, so the dropdown is
 * a real constraint and not just a UI convenience.
 */
export const MARKETING_CUSTOMER_SPECIALITIES = [
  "General Practitioner",
  "Internal Medicine",
  "Cardiology",
  "Chest",
  "Dermatology",
  "Endocrinology",
  "ENT",
  "Gastroenterology",
  "General Surgery",
  "Nephrology",
  "Neurology",
  "Obstetrics & Gynaecology",
  "Oncology",
  "Ophthalmology",
  "Orthopaedics",
  "Paediatrics",
  "Psychiatry",
  "Rheumatology",
  "Urology",
] as const;

export type MarketingCustomerSpeciality = (typeof MARKETING_CUSTOMER_SPECIALITIES)[number];

/**
 * How a governorate hold is recognised on a stored `validation_notes` string.
 *
 * `buildGovernorateMismatchNote` writes it and the Customer Validation workspace reads it, so the
 * marker is a constant rather than prose either side pattern-matches: reword the sentence freely,
 * but keep this at the front of it. It lives HERE, not in `service.ts`, because the workspace is a
 * `"use client"` component and importing the service into the browser bundle would drag the
 * service-role Supabase client in with it.
 */
export const MARKETING_GOVERNORATE_HOLD_PREFIX = "Held for review:";

/**
 * How a hold placed by a PERSON, rather than by the evidence rules, is recognised on a stored
 * `validation_notes` string.
 *
 * Written on 2026-08-21 to 39 links whose customers had no evidence *and* no field activity of any
 * kind, after a production audit; the owner ruled on those rows himself. Nothing in the code may
 * release such a link automatically — completing a customer's evidence removes the *evidence* half
 * of the reason it was held, never the human half. Only a Super Admin or the CEO releases it, from
 * Customer Pharmacy Mapping.
 *
 * Deliberately NOT `MARKETING_GOVERNORATE_HOLD_PREFIX`: the workspace renders that one as
 * "Code location mismatch", which would mislabel these rows as a geography contradiction they do
 * not have.
 */
export const MARKETING_MANUAL_HOLD_MARKER = "by owner decision:";

export type MarketingValidationCustomerInput = {
  capturedAccuracyMeters?: number | null;
  capturedAddress?: string | null;
  capturedAt?: string | null;
  capturedLatitude?: number | null;
  capturedLongitude?: number | null;
  customerType: MarketingCustomerType;
  displayName: string;
  evidenceHasTimestamp?: boolean;
  evidencePhotoCapturedAt?: string | null;
  /**
   * The captured JPEG itself, as `data:image/jpeg;base64,…`.
   *
   * Until 2026-08-04 the browser sent only `evidencePhotoName` and dropped the bytes, so
   * `evidence_status` could reach 'complete' on a filename alone. The image is now carried to the
   * server, written to the `marketing-evidence` bucket, and indexed in `marketing_evidence_files` —
   * a name arriving WITHOUT this field is refused rather than saved as proof.
   */
  evidencePhotoDataUrl?: string | null;
  evidencePhotoName?: string | null;
  /**
   * "This capture completes the customer that is ALREADY on record" — the Pending tab's path.
   *
   * Without it every submission inserts a fresh `MKT-HCP-…` row, so a rep who owned a customer with
   * missing evidence had no way to supply it: walking to the shop and capturing it properly minted a
   * SECOND customer beside the first, and the original stayed pending for ever. Production carried
   * 39 such customers (all imported 2026-07-02, all with a real owner and real CRM visits) plus the
   * duplicate rows the workaround left behind — including the same doctor spelled two ways.
   *
   * The capture fields still arrive in full and are still normalized identically; this id only
   * redirects the write from an INSERT to an UPDATE of that row. Identity is NOT rewritten — name,
   * code, owner and area stay as they are, so the tie to ROI history survives.
   */
  existingCustomerId?: string | null;
  extractedAreaName?: string | null;
  extractedGovernorateName?: string | null;
  mobileNumber?: string | null;
  otherTypeDescription?: string | null;
  regionName?: string | null;
  /** Optional — a hospital or chain account often has no single speciality. */
  speciality?: string | null;
};

export type MarketingValidationInput = {
  /**
   * Super-Admin-only: validate this customer FOR another employee. The records are owned by the
   * named employee (so the customer reaches their marketing request dropdown) while the audit
   * columns keep naming the admin who actually typed it. Rejected with 403 for every other role —
   * see `assertMarketingOnBehalfAccess`. Omit for the normal field-rep flow.
   */
  onBehalfOfHrId?: string | null;
  /**
   * One submission may validate several customers, each carrying ITS OWN pharmacies — two doctors
   * in the same building are not assumed to dispense through the same pharmacy, so the lists never
   * merge. Takes precedence over the single-customer fields below when present.
   */
  customers?: Array<MarketingValidationCustomerInput & {
    pharmacies?: MarketingValidationPharmacyEntry[];
  }>;
  /** Legacy single-customer shape. Still accepted so an in-flight offline replay cannot 400. */
  customer?: MarketingValidationCustomerInput;
  distributorCode?: {
    distributorId: number | string;
    distributorPharmacyCode: string;
  };
  pharmacies?: MarketingValidationPharmacyEntry[];
  pharmacy?: Omit<MarketingValidationPharmacyInput, "vendorCodes">;
};

/**
 * "Link the pharmacy I already validated" — the My Pharmacies half of the form's pharmacy tabs.
 *
 * Carries the id, and NOTHING that could re-describe the shop. Name, distributor codes, area and
 * owner are still read from the stored record on the server, so a client pointing at a record can
 * never rename it or move it.
 *
 * The evidence fields below are the one exception, added 2026-08-23. Until then a venue's GPS and
 * live photo were writable only by the INSERT that created it: the reuse branch updated the link
 * row and returned, so a venue first captured without proof — a desk validation, or a rep who
 * could not photograph the front — stayed `evidence_status = 'pending'` for the rest of its life,
 * no matter who stood in front of it afterwards. Three production venues carrying four
 * desk-validated doctors were in exactly that state with no route out of it.
 *
 * Optional, always. Supplying them completes a venue that is short of proof; omitting them behaves
 * exactly as attaching always has. The rep is not asked to be at the shop to attach it — the
 * system flags what is missing, it does not refuse (owner's standing rule).
 */
export type MarketingValidationExistingPharmacyInput = {
  capturedAccuracyMeters?: number | null;
  capturedAddress?: string | null;
  capturedAt?: string | null;
  capturedLatitude?: number | null;
  capturedLongitude?: number | null;
  evidenceHasTimestamp?: boolean;
  evidencePhotoCapturedAt?: string | null;
  /** See `MarketingValidationCustomerInput.evidencePhotoDataUrl`. */
  evidencePhotoDataUrl?: string | null;
  evidencePhotoName?: string | null;
  existingPharmacyId: string;
  extractedAreaName?: string | null;
  extractedGovernorateName?: string | null;
  regionName?: string | null;
};

/** Either half of the pharmacy tabs: capture a new shop, or point at one already validated. */
export type MarketingValidationPharmacyEntry =
  | MarketingValidationPharmacyInput
  | MarketingValidationExistingPharmacyInput;

export type MarketingValidationPharmacyInput = {
  capturedAccuracyMeters?: number | null;
  capturedAddress?: string | null;
  capturedAt?: string | null;
  capturedLatitude?: number | null;
  capturedLongitude?: number | null;
  displayName: string;
  evidenceHasTimestamp?: boolean;
  evidencePhotoCapturedAt?: string | null;
  /** See `MarketingValidationCustomerInput.evidencePhotoDataUrl`. */
  evidencePhotoDataUrl?: string | null;
  evidencePhotoName?: string | null;
  extractedAreaName?: string | null;
  extractedGovernorateName?: string | null;
  regionName?: string | null;
  /**
   * Empty ONLY when `venueType` is a type that carries no distributor account. A pharmacy with an
   * empty list is refused at capture, as it always has been — a shop nobody can invoice cannot
   * attribute a sale, and inventing a code to get past that gate is exactly the damage this venue
   * type was added to stop.
   */
  vendorCodes: Array<{
    distributorId: number | string;
    distributorPharmacyCode: string;
  }>;
  /** Defaults to `pharmacy` when absent, so an offline replay of an older draft still means what it did. */
  venueType?: VenueType;
};

export type MarketingValidationLegacyPharmacyInput = {
    capturedAccuracyMeters?: number | null;
    capturedAddress?: string | null;
    capturedAt?: string | null;
    capturedLatitude?: number | null;
    capturedLongitude?: number | null;
    displayName: string;
    evidenceHasTimestamp?: boolean;
  evidencePhotoCapturedAt?: string | null;
  /** See `MarketingValidationCustomerInput.evidencePhotoDataUrl`. */
  evidencePhotoDataUrl?: string | null;
  evidencePhotoName?: string | null;
  extractedAreaName?: string | null;
  extractedGovernorateName?: string | null;
  regionName?: string | null;
};

export type MarketingValidationReportRow = {
  customer: MarketingCustomer;
  /**
   * True when this link was validated at a desk — an admin picked the location from a map search
   * rather than a rep capturing it on site. Every `sfe_validated` link in production is one of
   * these, so without it the screens have no way to tell a map pin from a street capture.
   */
  deskValidated: boolean;
  /** Null for a venue with no distributor account. */
  distributorCode: MarketingPharmacyDistributorCode | null;
  distributorName: string | null;
  id: string;
  /**
   * True when this link's `system_validated` was written by the 2026-07-02 history backfill rather
   * than earned by a field capture.
   *
   * A report row is labelled with its LINK's status, not its customer's, so 154 backfilled links
   * across 82 `ROI-C-…` customers read as validated on this screen while the customer behind them
   * is still `pending` with `evidence_status = 'missing'` and no photo at all. The backfill said so
   * in its own `validation_notes` — "not GPS field-validated" — and the Customer Pharmacy Mapping
   * page has always badged them. This carries the same admission onto the validation report, so a
   * customer nobody ever stood in front of stops reading as field-proven.
   */
  inferredFromHistory: boolean;
  pharmacy: MarketingPharmacy;
  validationNotes: string | null;
  validationStatus: MarketingValidationStatus;
};

/** One selectable target in the Super Admin "validate on behalf of" picker. */
export type MarketingOnBehalfEmployee = {
  areaName: string | null;
  hrId: string;
  jobTitle: string | null;
  lineName: string | null;
  name: string;
};

export type MarketingValidationWorkspace = {
  /** True only for Super Admin — drives whether the on-behalf panel renders at all. */
  canValidateOnBehalf: boolean;
  distributors: MarketingDistributor[];
  /** Empty unless `canValidateOnBehalf`; active employees holding a marketing-capable role. */
  onBehalfEmployees: MarketingOnBehalfEmployee[];
  /**
   * Pharmacies the viewer may attach to a new customer instead of capturing one — his own, plus
   * those of colleagues he shares an area or a reporting line with (owner ruling 2026-08-19: a
   * shop is captured once for the whole area). Never includes the history-seeded pharmacies, which
   * belong to nobody and carry no evidence at all.
   */
  reusablePharmacies: MarketingReusablePharmacy[];
  rows: MarketingValidationReportRow[];
  summary: Record<MarketingValidationStatus, number>;
  /**
   * Who is looking at this workspace. Carried only so the browser's crash-recovery draft can be
   * scoped to one person — field phones are shared, and a recovered capture must never be offered
   * to whoever logs in next, who would then save another rep's visit under his own name.
   */
  viewerHrId: string;
};

export type MarketingCustomerDatabaseRow = {
  createdAt: string;
  customerAddress: string | null;
  customerArea: string | null;
  customerCode: string;
  /**
   * The customer row's evidence AS IT STANDS NOW. Carried beside `deskValidated` and
   * `inferredFromHistory` because those two are frozen the day the link is written while this is
   * not: a customer can be completed on a later visit, and the badge must not go on calling a rep
   * who made that visit a liar. `customerValidationPhoto` is the photo's NAME and says nothing
   * about the location or the timestamp, so it cannot stand in for this.
   */
  customerEvidenceStatus: MarketingEvidenceStatus;
  customerGovernorate: string | null;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  customerType: MarketingCustomerType;
  customerValidationPhoto: string | null;
  /**
   * True when this link was validated at a desk from a map search rather than captured on site.
   * Pairs with `inferredFromHistory`: both mean "no field evidence", from different origins.
   */
  deskValidated: boolean;
  /**
   * All four distributor columns are null together, and only for a venue with no distributor
   * account. Render them as the venue type rather than as a blank or a zero — the row is complete,
   * it simply has no sales channel to name.
   */
  distributorCode: string | null;
  distributorId: number | null;
  distributorName: string | null;
  /**
   * True when this row's `system_validated` was written by the 2026-07-02 history backfill rather
   * than earned by a field capture. `validationStatus` here comes from the LINK while
   * `customerValidationPhoto` comes from the CUSTOMER, which is why this screen can show
   * "system validated" beside an empty photo cell and be telling the truth about both.
   */
  inferredFromHistory: boolean;
  pharmacyAddress: string | null;
  pharmacyArea: string | null;
  pharmacyCode: string;
  pharmacyDistributorCodeId: string | null;
  /**
   * The venue's evidence as it stands now. `complete` means a rep photographed this shop on site —
   * which since #2352 can happen years after the link was written, and is often the ONLY capture
   * still obtainable, because the customer is rarely at the shop when a rep calls.
   */
  pharmacyEvidenceStatus: MarketingEvidenceStatus;
  pharmacyGovernorate: string | null;
  pharmacyId: string;
  pharmacyName: string;
  rowId: string;
  validationStatus: MarketingValidationStatus;
  vendorPharmacyCode: string | null;
  venueType: VenueType;
};

export type MarketingCustomerDatabaseWorkspace = {
  rows: MarketingCustomerDatabaseRow[];
  summary: {
    customers: number;
    pharmacies: number;
    rows: number;
    vendors: number;
  };
};

/**
 * One row of the company-wide request register (Marketing Manager / SFE Manager / Super Admin).
 *
 * Distinct from MarketingApprovedRequestRow (approved-and-later only) and from the personal
 * workspace, which deliberately narrows company-wide roles to their OWN requests so their Drafts
 * tab is not flooded. This register is the opposite: every request at every status, each carrying
 * where it is stopped and who it is pending with right now.
 */
export type MarketingAllRequestsRow = {
  areaName: string | null;
  /** Null only while a request has no approval chain yet (a draft). */
  currentApproverName: string | null;
  currentStepName: string | null;
  customerName: string;
  estimatedCost: number;
  id: string;
  /**
   * True when the request was raised in Phoenix; false when it came from the legacy spreadsheet
   * import. This is the axis the register splits on — deliberately NOT `status`. In production 217
   * of 218 rows are `xlsx_import`, and only 106 of those are `archived`; the other 111 are
   * approved/rejected imports. Splitting on status alone would leave those 111 legacy rows sitting
   * in the live view. Owner instruction, 2026-08-03: separate the archived from what was submitted
   * on Phoenix.
   */
  isPhoenixSubmission: boolean;
  lineName: string | null;
  origin: string | null;
  payDate: string | null;
  requestCode: string;
  requesterName: string;
  roiCoverageRatio: number | null;
  roiStatus: string | null;
  status: MarketingRequest["status"];
  /** "step 2 of 4" — sequence is null for a request with no chain. */
  stepSequence: number | null;
  submittedAt: string | null;
  totalGatingSteps: number | null;
};

export type MarketingAllRequestsWorkspace = {
  rows: MarketingAllRequestsRow[];
  summary: {
    approved: number;
    /** Everything not raised in Phoenix — the legacy import, whatever its status. */
    imported: number;
    inApproval: number;
    /** Raised in Phoenix, at any status. */
    phoenix: number;
    returned: number;
    total: number;
  };
};

export type MarketingApprovedRequestRow = {
  contactForMoneyTransfer: string;
  customerName: string;
  financeProofFileName: string | null;
  financeProofStoragePath: string | null;
  id: string;
  invoiceFileName: string | null;
  invoiceStoragePath: string | null;
  line: string | null;
  moneyTransferDate: string | null;
  notes: string | null;
  requestCode: string;
  requesterHrId: string;
  status: MarketingRequestStatus;
  sumOfAmount: number;
};

export type MarketingRoiAttributionQuality = "exact_customer" | "brick_fallback" | "mixed" | "no_sales";

export type MarketingRequest = {
  approvedAt: string | null;
  areaId: number | null;
  closedAt: string | null;
  createdAt: string;
  createdByHrId: string | null;
  customerContactId: string | null;
  customerId: string;
  estimatedCost: number;
  executedAt: string | null;
  expectedRoiValue: number;
  id: string;
  lineId: number | null;
  managerHrId: string | null;
  notes: string | null;
  otherRequestType: string | null;
  payDate: string | null;
  rejectedAt: string | null;
  returnedAt: string | null;
  returnedStepSequence: number | null;
  requestCode: string;
  requestDate: string;
  requestTypeId: number;
  requesterHrId: string;
  requiredRoiValue: number;
  roiCoverageRatio: number;
  roiDurationMonths: number;
  roiStatus: MarketingRoiStatus;
  status: MarketingRequestStatus;
  submittedAt: string | null;
  updatedAt: string;
  updatedByHrId: string | null;
};

export type MarketingRequestProduct = {
  createdAt: string;
  expectedValue: number;
  factoryPriceSnapshot: number;
  forecastQuantity: number;
  id: string;
  lineSnapshot: string | null;
  productId: number;
  productNameSnapshot: string;
  requestId: string;
  updatedAt: string;
  valueShare: number;
};

export type MarketingRequestPharmacy = {
  createdAt: string;
  /** Null only for a venue with no distributor account, whose spend can never attribute to sales. */
  distributorCodeId: string | null;
  id: string;
  notes: string | null;
  pharmacyId: string;
  requestId: string;
  trackingStatus: MarketingRequestPharmacyTrackingStatus;
  updatedAt: string;
};

export type MarketingRequestApprovalStep = {
  allowReject: boolean;
  allowReturn: boolean;
  assignedHrId: string | null;
  assignedRole: string;
  createdAt: string;
  decisionAt: string | null;
  decisionByHrId: string | null;
  decisionLabels: MarketingDecisionLabels | null;
  decisionNote: string | null;
  executedAt: string | null;
  id: string;
  isCc: boolean;
  requestId: string;
  sequence: number;
  status: MarketingApprovalStepStatus;
  stepCode: string;
  stepKind: MarketingStepKind | null;
  stepName: string;
  terminalStatus: MarketingRequestStatus | null;
  updatedAt: string;
  workflowStepId: number | null;
};

export type MarketingRequestFinanceRequirement = {
  createdAt: string;
  financeReviewerHrId: string | null;
  invoiceDeadlineDate: string | null;
  invoiceOriginalFileName: string | null;
  invoiceRequired: boolean;
  invoiceStatus: MarketingInvoiceStatus;
  invoiceStoragePath: string | null;
  invoiceUploadedAt: string | null;
  invoiceUploadedByHrId: string | null;
  moneyTransferProofOriginalFileName: string | null;
  moneyTransferProofStoragePath: string | null;
  moneyTransferProofUploadedAt: string | null;
  moneyTransferProofUploadedByHrId: string | null;
  notes: string | null;
  requestId: string;
  reviewedAt: string | null;
  updatedAt: string;
};

export type MarketingEvidenceFile = {
  capturedAccuracyMeters: number | null;
  capturedAddress: string | null;
  capturedAt: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
  contentType: string | null;
  createdAt: string;
  entityId: string;
  entityType: MarketingEvidenceEntityType;
  evidenceType: MarketingEvidenceType;
  hasTimestamp: boolean;
  id: string;
  originalFileName: string | null;
  storageBucket: string;
  storagePath: string;
  uploadedByHrId: string | null;
};

export type MarketingRoiInputProduct = {
  factoryPrice: number;
  productId?: number | string | null;
  productName?: string | null;
  quantity: number;
};

export type MarketingRoiPreview = {
  expectedRoiValue: number;
  products: Array<MarketingRoiInputProduct & {
    expectedValue: number;
    valueShare: number;
  }>;
  requiredRoiValue: number;
  roiCoverageRatio: number;
  roiStatus: MarketingRoiStatus;
};

export type MarketingRequestCreateDraft = {
  areaId?: number | null;
  customerContactId?: string | null;
  customerId: string;
  estimatedCost: number;
  lineId?: number | null;
  notes?: string | null;
  otherRequestType?: string | null;
  payDate?: string | null;
  pharmacies?: MarketingRequestDraftPharmacyInput[];
  products: MarketingRequestDraftProductInput[];
  requestDate: string;
  requestTypeId: number;
  roiDurationMonths: number;
};

export type MarketingRequestDraftProductInput = {
  productId: number | string;
  quantity: number;
};

/**
 * Minimum length for an unverified-code justification. A one-word entry ("ok", "yes") is not a
 * reason and would turn the gate into a formality — the repo already treats too-short cleanup
 * reasons as blank elsewhere for the same reason.
 *
 * Lives here, in the import-free types module, because BOTH sides need it: the server refuses a
 * shorter reason in `buildMarketingRequestRows`, and the portal form disables Save until the rep
 * has written one. Two copies would drift, and the drift shows up as a form that lets you submit
 * something the API then rejects.
 */
export const UNVERIFIED_CODE_REASON_MIN_LENGTH = 10;

export type MarketingRequestDraftPharmacyInput = {
  /**
   * Legacy key, still accepted so a draft saved before 2026-08-23 replays unchanged. New clients
   * send `targetId`; when both are absent the entry is rejected.
   */
  distributorCodeId?: string;
  notes?: string | null;
  /** See `MarketingRequestPharmacyOption.targetId`. */
  targetId?: string;
  /**
   * Written justification for using a pharmacy code the reference database cannot find.
   *
   * Required — and only consulted — when that specific code is `not_found`. Per-pharmacy rather
   * than per-request on purpose: a request may target five pharmacies where only one code is bad,
   * and a single request-level reason would say nothing about which.
   */
  unverifiedCodeReason?: string | null;
};

export type MarketingRequestDraftDetail = MarketingRequest & {
  pharmacies: MarketingRequestPharmacy[];
  products: MarketingRequestProduct[];
};
