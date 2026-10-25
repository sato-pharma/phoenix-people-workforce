"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  History,
  MapPin,
  Paperclip,
  Plus,
  RefreshCcw,
  Save,
  ShieldCheck,
  ShieldX,
  Store,
  Trash2,
  UserCheck,
  WifiOff,
} from "lucide-react";

import {
  buildEvidenceStampLines,
  fetchEvidenceLocation,
  formatEvidenceDateTime,
  readEvidenceLocationStamp,
  resolveEvidenceLocationStamp,
} from "@/components/outstation/evidence-watermark";
import { PortalRecordFields } from "@/components/employee-portal/portal-primitives";
import { NotFieldValidatedBadge } from "@/components/marketing-requests/not-field-validated-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import {
  MARKETING_CUSTOMER_SPECIALITIES,
  MARKETING_GOVERNORATE_HOLD_PREFIX,
} from "@/lib/marketing-requests/types";
import {
  type RankedPharmacyCode,
  proximityLabel,
} from "@/lib/venues/pharmacy-code-suggestions";
import type {
  MarketingCustomerType,
  MarketingDistributor,
  MarketingOnBehalfEmployee,
  MarketingReusablePharmacy,
  MarketingValidationReportRow,
  MarketingValidationStatus,
  MarketingValidationWorkspace as MarketingValidationWorkspacePayload,
} from "@/lib/marketing-requests/types";
import { NO_SHUTTER_FIX, readShutterFix, type ShutterFix } from "@/lib/evidence/read-shutter-fix";
import { LINK_STATUS_PRECEDENCE, linkStatusIsSelectable } from "@/lib/marketing-requests/code-link-reach";
import {
  describeRestoredDraft,
  isDraftWorthKeeping,
  MARKETING_DRAFT_EVIDENCE_MAX_AGE_MS,
  MARKETING_DRAFT_VERSION,
  parseStoredDraft,
  restoreDraft,
  type MarketingValidationDraft,
} from "@/lib/marketing-requests/validation-draft";
import {
  clearValidationDraft,
  clearValidationQueue,
  readValidationDraft,
  readValidationQueue,
  saveValidationDraft,
  saveValidationQueue,
} from "@/lib/marketing-requests/validation-draft-store";
import {
  customerFieldEvidenceGap,
  customerIsEvidenceValidated,
  type FieldEvidenceGap,
  fieldEvidenceGapInput,
} from "@/lib/marketing-requests/validation-report";
import {
  NOT_ON_CRM_LIST_FLAG,
  type CrmDoctorAreasPayload,
  type CrmDoctorOption,
} from "@/lib/marketing-requests/crm-doctor-pick";
import {
  canSaveMarketingValidation,
  withoutBlankCodeRows,
  describeMissingSaveRequirement,
  hasCompleteCapture,
} from "@/lib/marketing-requests/validation-save-gate";
import {
  choiceRequiresDistributorCode,
  VENUE_TYPE_UNANSWERED_MESSAGE,
  VENUE_TYPES,
  venueRequiresDistributorCode,
  venueTypeIsAnswered,
  venueTypeLabel,
  type VenueTypeChoice,
} from "@/lib/venues/venue-type";
import {
  PHARMACY_LICENSE_ACCEPT_ATTRIBUTE,
  PHARMACY_LICENSE_MAX_BYTES,
  isPharmacyLicenseContentType,
  isLicenseOnlyPharmacyNote,
} from "@/lib/venues/pharmacy-license";
import { CODELESS_VENUES_GO_TO_DIRECT_ORDERS } from "@/lib/marketing-requests/coded-venues-only";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { isOwnedByViewer, normalizeOwnerHrId } from "@/lib/browser-storage/owner-scoped";
import { adminChipDepthClassName, adminControlDepthClassName, adminPanelDepthClassName, adminRecessedDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";


/* --------------------------------------------------------------------- Focus Trap Hook --------------------------------------------------------------------- */

function useFocusTrap(active: boolean) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const focusableSelector =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const focusableElements = container!.querySelectorAll<HTMLElement>(focusableSelector);
      if (focusableElements.length === 0) return;

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];

      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    // Focus first focusable element on mount
    const firstEl = container.querySelector<HTMLElement>(focusableSelector);
    firstEl?.focus();

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [active]);

  return containerRef;
}

/* --------------------------------------------------------------------- Offline Queue --------------------------------------------------------------------- */

type QueuedSubmission = {
  id: string;
  /**
   * Who queued it. Absent on entries queued before 2026-10-26, which are never sent: the replay
   * posts under the SIGNED-IN session, so on a shared tablet rep A's visit was filed as rep B's
   * (src/lib/browser-storage/owner-scoped.ts).
   */
  ownerHrId?: string;
  payload: unknown;
  timestamp: number;
};

/**
 * The queue is per BROWSER and a tablet is shared, so only `viewerHrId`'s own entries are replayed,
 * counted or added; everyone's entries stay mirrored to disk for their owners. `viewerHrId` arrives
 * with the workspace load, and until it does nothing is replayed or queued.
 */
function useOfflineQueue(onReplay: (payload: unknown) => Promise<void>, viewerHrId: string) {
  const [queue, setQueue] = useState<QueuedSubmission[]>([]);
  // Always start `true` to match SSR output --- sync real value in useEffect
  const [isOnline, setIsOnline] = useState(true);
  /**
   * The owners of the offline submissions found on disk that can no longer be sent: too old, or
   * queued before entries said whose they are ("" for those). Surfaced, never dropped quietly.
   */
  const [unsendableOwners, setUnsendableOwners] = useState<string[]>([]);
  const replayingRef = useRef(false);
  // Set once the stored queue has been read back, so the persist effect below cannot write its
  // empty initial state over a real queue in the moment before the read returns.
  const hydratedRef = useRef(false);

  // Reload the queue left behind by a previous tab.
  //
  // Until 2026-08-23 this queue lived only in React state, so a rep who pressed Save with no signal
  // was told "Saved offline. Will sync automatically when connection returns." and then lost the
  // submission outright on the next reload --- no error, no row, nothing to notice it by. That is
  // worse than losing an unsaved form, because he has already been told the work is safe.
  //
  // A restored entry still has to age out. Its payload carries a complete GPS fix and live photo,
  // and `evidenceStatusFromInput` on the server grants `system_validated` on their PRESENCE without
  // ever comparing the timestamp to now --- so replaying a two-day-old queue would quietly assert a
  // visit that did not happen that day. `timestamp` is stamped at enqueue, seconds after the
  // capture, so it is a fair proxy for when the rep actually stood there.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await readValidationQueue();
      if (cancelled) return;
      if (Array.isArray(stored) && stored.length > 0) {
        const entries = stored as QueuedSubmission[];
        const cutoff = Date.now() - MARKETING_DRAFT_EVIDENCE_MAX_AGE_MS;
        const usable = entries.filter(
          (entry) => Number(entry.timestamp) >= cutoff && normalizeOwnerHrId(entry.ownerHrId) !== "",
        );
        if (usable.length > 0) {
          setQueue(usable);
        }
        if (usable.length < entries.length) {
          setUnsendableOwners(
            entries.filter((entry) => !usable.includes(entry)).map((entry) => normalizeOwnerHrId(entry.ownerHrId)),
          );
        }
      }
      hydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Mirror every change to disk. Runs after the read above has settled.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (queue.length === 0) {
      void clearValidationQueue();
      return;
    }
    void saveValidationQueue(queue);
  }, [queue]);

  useEffect(() => {
    // Sync real browser state after hydration --- must live in useEffect to avoid SSR mismatch
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsOnline(navigator.onLine);

    function handleOnline() {
      setIsOnline(true);
    }
    function handleOffline() {
      setIsOnline(false);
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Replay queue when back online --- the signed-in person's own entries only.
  useEffect(() => {
    const pending = queue.filter((item) => isOwnedByViewer(item.ownerHrId, viewerHrId));
    if (!isOnline || pending.length === 0 || replayingRef.current) return;
    replayingRef.current = true;

    (async () => {
      for (const item of pending) {
        try {
          await onReplay(item.payload);
          setQueue((current) => current.filter((q) => q.id !== item.id));
        } catch {
          // Stop replaying on first failure --- will retry next time online
          break;
        }
      }
      replayingRef.current = false;
    })();
  }, [isOnline, queue, onReplay, viewerHrId]);

  /** False, and nothing queued, while the page does not yet know who is signed in. */
  function enqueue(payload: unknown): boolean {
    const owner = normalizeOwnerHrId(viewerHrId);
    if (!owner) return false;
    const submission: QueuedSubmission = {
      id: `q-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ownerHrId: owner,
      payload,
      timestamp: Date.now(),
    };
    setQueue((current) => [...current, submission]);
    return true;
  }

  const viewer = normalizeOwnerHrId(viewerHrId);
  return {
    dismissExpired: () => setUnsendableOwners([]),
    enqueue,
    // Another person's lost submission is theirs to be told about, not the viewer's.
    expiredCount: unsendableOwners.filter((owner) => owner === "" || owner === viewer).length,
    isOnline,
    queueLength: queue.filter((item) => isOwnedByViewer(item.ownerHrId, viewerHrId)).length,
  };
}

/* --------------------------------------------------------------------- Types --------------------------------------------------------------------- */

type CaptureState = {
  accuracy: number | null;
  address: string;
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  /**
   * The burned-in location block: full address, Phoenix brick/area/region, coordinates.
   *
   * Separate from `address` on purpose. `address` is the SHOP's address and is stored on the
   * customer record; these lines describe where the PHOTO was taken, which is evidence about the
   * rep, not about the pharmacy. Empty until the lookup returns — the camera stays locked until
   * then, so no photo is ever stamped with a half-resolved place.
   */
  locationLines: string[];
  /**
   * The photo's OWN GPS fix, read fresh at the shutter — never a copy of the location fix above.
   *
   * Until 2026-09-29 the evidence row was written with the coordinates from *Capture Location*,
   * so `marketing_evidence_files.captured_latitude/longitude` and the venue row's own capture were
   * always byte-identical and the distance between them was structurally zero. A real case that
   * day had 18m31s between the location fix and the shutter, and nothing in Phoenix could say
   * whether the camera had stayed put — the comparison the columns imply was never being made.
   *
   * Null when the browser refuses or times out at the shutter. That is deliberate: a photo is
   * never blocked on a second fix, and the server falls back to the location fix rather than
   * refusing the save. Null therefore means "not measured", never "same place".
   */
  photoAccuracy: number | null;
  photoCapturedAt: string | null;
  photoDataUrl: string | null;
  photoLatitude: number | null;
  photoLongitude: number | null;
  photoName: string;
};

type VendorCodeLine = {
  distributorCode: string;
  distributorId: string;
  key: string;
};

/**
 * Which of the two pharmacy tabs this block is on.
 *
 * `new` is the original flow — name the shop, capture its GPS and live photo, type its distributor
 * codes. `existing` attaches a pharmacy already validated by this rep or by a colleague in his
 * area, creating only the link. Two customers a street apart routinely dispense through the same
 * shop, and until now the only way to record that was to capture the shop a second time.
 */
type PharmacySource = "new" | "existing";

type PharmacyLicenseAttachment = {
  /** `data:image/jpeg|image/png|application/pdf;base64,…` — revalidated on the server. */
  dataUrl: string;
  fileName: string;
  isPdf: boolean;
};

type PharmacyLine = {
  capture: CaptureState;
  /** Set only while `source` is "existing" — the pharmacy chosen from My Pharmacies. */
  existingPharmacyId: string;
  governorate: string;
  key: string;
  name: string;
  area: string;
  source: PharmacySource;
  vendorCodes: VendorCodeLine[];
  /**
   * The pharmacy trade licence (رخصة الصيدلية), when the rep attached one.
   *
   * Optional on every venue and highlighted on the one it exists for: a pharmacy with no
   * distributor code in any distributor. Nothing else then ties the name on the record to a real
   * business, and the licence's trade name is read against the name on the shop sign in the
   * storefront photo this same submission carries. Owner's instruction, 2026-08-25.
   *
   * NOT part of the capture state above, deliberately. A capture claims "taken at this place, at
   * this time"; a licence is a document that may arrive as a PDF or a scan, and folding it into
   * `CaptureState` would let it count toward evidence completeness — which would mean a shop
   * nobody visited could reach `system_validated` on a forwarded file.
   */
  license: PharmacyLicenseAttachment | null;
  /**
   * What kind of venue this is. A nursery has no distributor account, so it carries no vendor codes
   * at all — which is why the codes block below disappears when this is set. Before this existed
   * the form demanded a code from every venue, and reps supplied invented ones (`0000`,
   * `0001000000`, `0001511111` are all in production) because there was no other way to save.
   *
   * Starts NULL — unanswered. It defaulted to `pharmacy` until 2026-08-26, which meant the picker
   * asked a question that was already filled in, and a venue saved without touching it was filed
   * as a pharmacy on the rep's behalf.
   */
  venueType: VenueTypeChoice;
};

/**
 * One submission can validate several customers. Each carries ITS OWN pharmacies rather than the
 * form keeping a single shared list — two doctors in the same building do not necessarily dispense
 * through the same pharmacy, and pooling them would silently attach one customer's pharmacy to
 * another, so any request raised later would attribute sales from a pharmacy they never used.
 */
type CustomerLine = {
  area: string;
  capture: CaptureState;
  /**
   * The area chosen BY HAND to open the doctor list (owner, 2026-10-23) — a CRM rep seat standing for
   * its area. Never written over `area`, which is what the GPS capture resolved and stays that way.
   */
  crmAreaSeatId: string;
  /** The rep's Phoenix CRM doctor picked from that area's lists; empty while none is picked. */
  crmCustomerId: string;
  /** "Not on the list — type the name": the name is typed, and every approver sees it flagged. */
  notOnCrmList: boolean;
  /**
   * Set only by "Capture evidence" on the Pending tab: the id of the customer already on record
   * that this capture completes. Empty on the ordinary path, which mints a new customer.
   */
  existingCustomerId: string;
  /**
   * True when the customer on record already has complete evidence and the rep is here only to
   * capture its venue. The customer's own capture, phone and speciality are then not offered — the
   * server leaves that row untouched, so a field the save would ignore is worse than no field.
   */
  customerComplete: boolean;
  governorate: string;
  key: string;
  mobile: string;
  name: string;
  otherType: string;
  pharmacies: PharmacyLine[];
  speciality: string;
  type: MarketingCustomerType;
};

type CodeCheckStatus = "checking" | "tracked" | "untracked" | "unknown";

/** Which location block a GPS capture, map pin, or camera shot applies to. */
type LocationTarget = {
  customerKey: string;
  /** Absent for the customer's own location. */
  pharmacyKey?: string;
};

type ValidatedCustomerGroup = {
  customerName: string;
  customerType: string;
  /**
   * Why this customer's validated status is not field evidence, or null when it is. Set when EVERY
   * link behind it came from the 2026-07-02 history backfill or from a desk entry AND none of those
   * links has since been given a complete capture on either half — i.e. nobody has ever stood in
   * front of the customer or of the shop it was recorded at. One genuine capture among the links
   * clears it, whichever half it landed on.
   */
  fieldEvidenceGap: FieldEvidenceGap | null;
  /** True when a Super Admin validated this at the desk rather than a rep capturing it in the field. */
  isAdminValidated: boolean;
  key: string;
  rows: MarketingValidationReportRow[];
  status: MarketingValidationStatus;
};

type ValidatedPharmacyDetail = {
  /** Confirmed cross-system names (owner, 2026-10-02). Never a suggestion, never a verdict. */
  alsoKnownAs: string[];
  area: string;
  governorate: string;
  id: string;
  name: string;
  /** Name-based wholesaler suspicion (owner rule, 2026-09-22) — advisory only, ambiguous فارما tier. */
  suspectedWholesaler: boolean;
  suspectedWholesalerNote: string | null;
  vendorCodes: Array<{
    code: string;
    distributorName: string;
    id: string;
    status: string;
  }>;
};

/* --------------------------------------------------------------------- Constants --------------------------------------------------------------------- */

const customerTypes: Array<{ label: string; value: MarketingCustomerType }> = [
  { label: "Clinic", value: "clinic" },
  { label: "Hospital", value: "hospital" },
  { label: "Account", value: "account" },
  { label: "Other", value: "other" },
];

/* --------------------------------------------------------------------- Utility Helpers --------------------------------------------------------------------- */

/** Where this module resolves an evidence stamp. Gated on the marketing creator roles. */
const MARKETING_LOCATION_ENDPOINT = "/api/marketing-requests/reverse-geocode";

let keyCounter = 0;
function stableKey(prefix: string) {
  return `${prefix}-${++keyCounter}`;
}

function emptyCapture(): CaptureState {
  return {
    accuracy: null,
    address: "",
    capturedAt: null,
    latitude: null,
    longitude: null,
    locationLines: [],
    photoAccuracy: null,
    photoCapturedAt: null,
    photoDataUrl: null,
    photoLatitude: null,
    photoLongitude: null,
    photoName: "",
  };
}

function newVendorCodeLine(distributorId = ""): VendorCodeLine {
  return {
    distributorCode: "",
    distributorId,
    key: stableKey("vendor"),
  };
}

function newPharmacyLine(distributorId = ""): PharmacyLine {
  return {
    capture: emptyCapture(),
    existingPharmacyId: "",
    governorate: "",
    key: stableKey("pharmacy"),
    name: "",
    area: "",
    // Defaults to the capture flow so nothing about the existing habit changes until the rep
    // deliberately switches to the pharmacies he already has.
    source: "new",
    vendorCodes: [newVendorCodeLine(distributorId)],
    license: null,
    venueType: null,
  };
}

function newCustomerLine(distributorId = "", crmAreaSeatId = ""): CustomerLine {
  return {
    area: "",
    capture: emptyCapture(),
    crmAreaSeatId,
    crmCustomerId: "",
    notOnCrmList: false,
    existingCustomerId: "",
    customerComplete: false,
    governorate: "",
    key: stableKey("customer"),
    mobile: "",
    name: "",
    otherType: "",
    pharmacies: [newPharmacyLine(distributorId)],
    speciality: "",
    type: "clinic",
  };
}

/** A draft saved before the doctor pick existed has none of its fields; it opens with nothing picked. */
function withDoctorPickDefaults(line: CustomerLine): CustomerLine {
  return {
    ...line,
    crmAreaSeatId: typeof line.crmAreaSeatId === "string" ? line.crmAreaSeatId : "",
    crmCustomerId: typeof line.crmCustomerId === "string" ? line.crmCustomerId : "",
    notOnCrmList: line.notOnCrmList === true,
  };
}

/** The drop-list's value for "Not on the list — type the name". Never a CRM id. */
const NOT_ON_CRM_LIST_VALUE = "__not_on_crm_list__";

/** One doctor in the drop-list: name, then what tells two namesakes apart — speciality, list, rep. */
function crmDoctorOptionLabel(doctor: CrmDoctorOption): string {
  const rep = doctor.repName ? `${doctor.repName}${doctor.lineName ? ` (${doctor.lineName})` : ""}` : "Vacant territory";
  return [doctor.name, doctor.speciality, doctor.listType, rep].filter(Boolean).join(" · ");
}

function emptyWorkspace(): MarketingValidationWorkspacePayload {
  return {
    canValidateOnBehalf: false,
    distributors: [],
    onBehalfEmployees: [],
    reusablePharmacies: [],
    rows: [],
    summary: {
      admin_approved: 0,
      pending: 0,
      rejected: 0,
      sfe_validated: 0,
      system_validated: 0,
    },
    viewerHrId: "",
  };
}

/** Position in `LINK_STATUS_PRECEDENCE`; lower is stronger. */
function linkStatusRank(status: MarketingValidationStatus): number {
  return (LINK_STATUS_PRECEDENCE as readonly string[]).indexOf(status);
}

function statusVariant(status: MarketingValidationStatus): "success" | "warning" | "danger" | "neutral" {
  if (linkStatusIsSelectable(status)) return "success";
  if (status === "rejected") return "danger";
  if (status === "pending") return "warning";
  return "neutral";
}

/**
 * Whether any row on this customer is a pharmacy saved on its licence alone and STILL held without a
 * code. The marker stays in the notes after a release, so the status is read too - a released link is
 * not a hold.
 */
function hasLicenseOnlyHold(rows: MarketingValidationReportRow[]): boolean {
  return rows.some(
    (row) => isLicenseOnlyPharmacyNote(row.validationNotes) && row.validationStatus === "pending",
  );
}

/** Whether any row on this customer is held because its capture contradicts the code's region. */
function hasGovernorateHold(rows: MarketingValidationReportRow[]): boolean {
  return rows.some((row) => (row.validationNotes ?? "").includes(MARKETING_GOVERNORATE_HOLD_PREFIX));
}

/**
 * Why this customer is not in the marketing request list yet, said in the rep's terms.
 *
 * TWO things can park a field row. Evidence, which this derives from the capture statuses rather
 * than from the stored note, because the note cannot say WHICH capture failed. And, since
 * 2026-08-20, a capture whose governorate contradicts the one the distributor registers the code in
 * (see `resolveMarketingSystemValidationStatus`) — checked FIRST, because a rep told to "capture it
 * again" would retake a photo that was never the problem and land in exactly the same place. An
 * unmatched distributor code still does not block, and has not since 2026-08-12.
 */
function pendingBlockReason(rows: MarketingValidationReportRow[]): string {
  const customerShort = rows.some((row) => row.customer.evidenceStatus !== "complete");
  const pharmacyShort = rows.some((row) => row.pharmacy.evidenceStatus !== "complete");
  if (hasGovernorateHold(rows) && !customerShort && !pharmacyShort) {
    return "The location you captured is in a different governorate from the one this distributor code is registered in, so it needs a check before release.";
  }
  if (customerShort && pharmacyShort) {
    return "The live photo and location are incomplete on both the customer and the venue.";
  }
  if (customerShort) return "The customer's live photo and location are incomplete.";
  if (pharmacyShort) return "The venue's live photo and location are incomplete.";
  if (hasLicenseOnlyHold(rows)) {
    return "This pharmacy has no distributor code and was saved on its licence, so it is not usable in requests yet. A Super Admin or the CEO reads the licence and releases it from Customer Pharmacy Mapping.";
  }
  return "Waiting for a Super Admin or the CEO to release it.";
}

/**
 * The same finding as `pendingBlockReason`, short enough to sit in a table cell.
 *
 * The prose explanation lives once in the tab's banner and each row carries only this short label.
 * Text is never cut with an ellipsis; where that collides with the no-sideways-scroll rule, WRAPPING
 * WINS (the old "never wrap" rule is superseded), so a long label wraps inside its cell.
 */
function pendingBlockLabel(rows: MarketingValidationReportRow[]): string {
  const customerShort = rows.some((row) => row.customer.evidenceStatus !== "complete");
  const pharmacyShort = rows.some((row) => row.pharmacy.evidenceStatus !== "complete");
  // 22 characters — deliberately no longer than the longest label already here ("Customer capture
  // incomplete", 26), so the column stays narrow.
  if (hasGovernorateHold(rows) && !customerShort && !pharmacyShort) return "Code location mismatch";
  if (customerShort && pharmacyShort) return "Both captures incomplete";
  if (customerShort) return "Customer capture incomplete";
  if (pharmacyShort) return "Venue capture incomplete";
  if (hasLicenseOnlyHold(rows)) return "Licence only, no code";
  return "Awaiting release";
}

/**
 * Whether the rep can do anything about this customer from the field: either half is short of its
 * live photo and location. The button appears for the customer's own gap AND for its venue's,
 * because a customer whose own proof is complete can still be parked on a venue nobody photographed
 * — and that is the case where the rep stood in front of the shop with no way to record it. When
 * neither half is short the block is a Super Admin / CEO release, which nothing here can fix.
 */
function pendingHasCapturableGap(rows: MarketingValidationReportRow[]): boolean {
  return rows.some((row) => row.customer.evidenceStatus !== "complete" || row.pharmacy.evidenceStatus !== "complete");
}

/** Distributor codes on these rows that no sale can ever be matched to. */
function untrackedVendorCodes(rows: MarketingValidationReportRow[]) {
  const seen = new Map<string, { code: string; distributorName: string }>();
  for (const row of rows) {
    // A venue with no distributor account has no vendor code to be untracked. Listing it here
    // would report a fault it cannot have; the row's own note already states why its ROI is
    // unmeasurable.
    if (!row.distributorCode) continue;
    if (row.distributorCode.referenceStatus === "matched") continue;
    seen.set(row.distributorCode.id, {
      code: row.distributorCode.distributorPharmacyCode,
      distributorName: row.distributorName ?? "Unknown distributor",
    });
  }
  return Array.from(seen.values());
}

/**
 * The attached shop this rep could complete right now, or null.
 *
 * A venue's GPS and live photo used to be writable only by the capture that created it, so a shop
 * first recorded without proof — a desk validation, or a visit where the front could not be
 * photographed — stayed short of evidence for good, and every customer attached to it stayed on
 * "Not Usable Yet". A rep standing in front of that shop now has a way to supply what is missing.
 *
 * Never offered in desk mode: a point chosen from map search is not field proof, which is the whole
 * reason those rows are short in the first place.
 */
function reusableNeedingEvidence(
  options: MarketingReusablePharmacy[],
  selectedId: string,
  isDeskMode: boolean,
) {
  if (isDeskMode || !selectedId) return null;
  const selected = options.find((row) => row.id === selectedId);
  return selected && selected.evidenceStatus !== "complete" ? selected : null;
}

function buildValidatedPharmacyDetails(rows: MarketingValidationReportRow[]) {
  const pharmacies = new Map<string, ValidatedPharmacyDetail>();
  for (const row of rows) {
    const current = pharmacies.get(row.pharmacy.id);
    // Null for a venue with no distributor account. The pharmacy still gets its row — dropping it
    // would leave a validated venue out of the summary that lists what was just validated.
    const vendorCode = row.distributorCode
      ? {
        code: row.distributorCode.distributorPharmacyCode,
        distributorName: row.distributorName ?? "Unknown distributor",
        id: row.distributorCode.id,
        status: row.distributorCode.referenceStatus.replace(/_/g, " "),
      }
      : null;

    if (current) {
      if (vendorCode && !current.vendorCodes.some((line) => line.id === vendorCode.id)) {
        current.vendorCodes.push(vendorCode);
      }
      continue;
    }

    pharmacies.set(row.pharmacy.id, {
      // Per PHARMACY, so like the wholesaler note it is the same for every link of this venue.
      alsoKnownAs: row.alsoKnownAs,
      area: row.pharmacy.extractedAreaName ?? row.pharmacy.regionName ?? "",
      governorate: row.pharmacy.extractedGovernorateName ?? "",
      id: row.pharmacy.id,
      name: row.pharmacy.displayName,
      // Name-derived, so the same for every link of this pharmacy — carry the first row's answer.
      suspectedWholesaler: row.suspectedWholesaler,
      suspectedWholesalerNote: row.suspectedWholesalerNote,
      vendorCodes: vendorCode ? [vendorCode] : [],
    });
  }

  return Array.from(pharmacies.values());
}

/* --------------------------------------------------------------------- Sub-components --------------------------------------------------------------------- */

/**
 * The size of every capture control (GPS, Photo, camera Start / Capture / Confirm, the licence
 * buttons, the venue-type answer): 44px tall and sharing its row on a phone, where it is pressed
 * with a thumb standing in the street — they were 28–32px — and back to the compact 32px from `sm`
 * (640px) up, where a mouse is the pointer.
 */
const CAPTURE_BUTTON_SIZE = "h-11 flex-1 sm:h-8 sm:flex-none";

function Field({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function ReadOnlyCaptureValue({
  multiline,
  placeholder,
  value,
}: {
  multiline?: boolean;
  placeholder: string;
  value: string;
}) {
  const captureClassName = cn(phxTextareaClassName, "w-full px-3.5 text-phx-md");

  if (multiline) {
    return (
      <textarea
        aria-readonly="true"
        className={`${captureClassName} min-h-[72px] resize-none py-2.5`}
        placeholder={placeholder}
        readOnly
        value={value}
      />
    );
  }

  return (
    <Input
      aria-readonly="true"
      className="cursor-default text-phx-md"
      placeholder={placeholder}
      readOnly
      value={value}
    />
  );
}

function SelectField({
  children,
  disabled,
  onChange,
  value,
}: {
  children: ReactNode;
  disabled?: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  // `wrapValue`: the chosen value wraps onto as many lines as it needs instead of being cut on one
  // — a long distributor or employee name in a phone-width field was showing ~54px of itself.
  return (
    <SearchableSelect
      className="w-full px-3 text-phx-md"
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      value={value}
      wrapValue
    >
      {children}
    </SearchableSelect>
  );
}

/** Raw status keys, in words — a badge never shows "sfe_validated" or "admin approved" in snake form. */
const VALIDATION_STATUS_LABEL: Record<MarketingValidationStatus, string> = {
  admin_approved: "Admin approved",
  pending: "Pending",
  rejected: "Rejected",
  sfe_validated: "SFE validated",
  system_validated: "System validated",
};

function MetricCard({
  accent,
  className,
  icon: Icon,
  label,
  value,
}: {
  accent: "green" | "amber" | "blue" | "red";
  className?: string;
  icon: typeof CheckCircle2;
  label: string;
  value: number;
}) {
  const accentStyles = {
    green: "border-l-emerald-500 bg-gradient-to-r from-emerald-50/60 to-white",
    amber: "border-l-amber-500 bg-gradient-to-r from-amber-50/60 to-white",
    blue: "border-l-sky-500 bg-gradient-to-r from-sky-50/60 to-white",
    red: "border-l-rose-500 bg-gradient-to-r from-rose-50/60 to-white",
  };
  const iconStyles = {
    green: "text-emerald-600",
    amber: "text-amber-600",
    blue: "text-sky-600",
    red: "text-rose-600",
  };

  return (
    <div className={`min-w-0 rounded-none border border-slate-200 border-l-[3px] px-3.5 py-3 ${accentStyles[accent]} ${className ?? ""}`}>
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${iconStyles[accent]}`} />
        {/* Wraps, never runs past the card: "SYSTEM VALIDATED" in tracked capitals is wider than
            a card on a narrow row. */}
        <p className="min-w-0 break-words text-phx-2xs font-black uppercase leading-tight tracking-[0.14em] text-slate-500">
          {label}
        </p>
      </div>
      <p className="mt-1.5 text-phx-xl font-black leading-none text-slate-900">{value}</p>
    </div>
  );
}

/**
 * The two pharmacy tabs inside one pharmacy block.
 *
 * Sits at pharmacy level rather than page level on purpose: the choice is per pharmacy, so one
 * customer can carry a shop captured today alongside a shop attached from the rep's existing list.
 * Disabled — not hidden — when there is nothing to attach yet, so a rep on his first customer can
 * see the option exists and why it is empty.
 */
function PharmacySourceTab({
  active,
  children,
  disabled = false,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  // Wraps rather than clips: two tabs share a phone row (~105px each at 375px), and "Validate New
  // Venue" needs ~120px — it used to be cut off mid-word at every width under ~400px.
  return (
    <button
      className={`min-h-10 break-words rounded-none px-3 py-1.5 text-phx-sm font-bold leading-tight transition md:min-h-9 ${
        active
          ? "bg-orange-500 text-white shadow-[0_4px_12px_rgba(249,115,22,0.25)]"
          : disabled
            ? "cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400"
            : `border border-slate-200 bg-white text-slate-600 hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 ${adminControlDepthClassName}`
      }`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

/**
 * Picks one already-validated pharmacy to attach to the customer being validated.
 *
 * Shows the whole record before it is attached — whose it is, how many customers already dispense
 * through it, and every distributor code that will come with it — because the rep is vouching for a
 * shop he is not standing in front of right now. Two things are FLAGGED rather than filtered out,
 * per the owner's standing rule that the system flags and he decides: a pharmacy whose own live
 * photo is short (attaching it parks the new customer on Not Usable Yet), and a distributor code
 * the Phoenix reference database cannot match (its sales can never be attributed).
 */
function ReusablePharmacyPicker({
  onSelect,
  options,
  selectedId,
}: {
  onSelect: (pharmacyId: string) => void;
  options: MarketingReusablePharmacy[];
  selectedId: string;
}) {
  const selected = options.find((option) => option.id === selectedId) ?? null;

  if (options.length === 0) {
    return (
      <div className={`rounded-none border border-slate-200 bg-white px-3.5 py-3 text-phx-sm font-semibold text-slate-500 ${adminSoftDepthClassName}`}>
        No validated pharmacies yet. Validate one on the other tab and it will be here next time —
        for you and for your colleagues in the same area.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Field label="Venue Already Validated">
        <SearchableSelect
          className="w-full text-phx-md"
          onValueChange={onSelect}
          placeholder="Search by venue name, code, or area"
          value={selectedId}
          wrapValue
        >
          <option value="">Choose a venue</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {[
                option.displayName || option.pharmacyCode,
                option.vendorCodes.length > 0
                  ? option.vendorCodes.map((code) => code.distributorPharmacyCode).join(" / ")
                  : venueTypeLabel(option.venueType),
                option.areaName ?? "",
                option.isOwn ? "Yours" : option.ownerName ?? "",
              ].filter(Boolean).join(" · ")}
            </option>
          ))}
        </SearchableSelect>
      </Field>

      {selected ? (
        <div className="min-w-0 space-y-2.5 rounded-none border border-orange-200 bg-orange-50/40 px-3.5 py-3">
          {/* Wraps — it used to be one nowrap line scrolling sideways inside a ~220px box on a
              phone. Where "never cut off" and "never scroll sideways" collide, wrapping wins. */}
          <div className="min-w-0 space-y-2">
            <p className="break-words text-phx-md font-black text-slate-900">
              {selected.displayName || selected.pharmacyCode}
            </p>
            <PortalRecordFields
              fields={[
                { label: "Code", value: selected.pharmacyCode || "—" },
                {
                  label: "Area",
                  value: [selected.areaName, selected.governorateName].filter(Boolean).join(", ") || "Not captured",
                },
                { label: "Validated by", value: selected.isOwn ? "You" : selected.ownerName ?? "A colleague" },
                {
                  label: "Serving",
                  value: selected.linkedCustomerCount === 1 ? "1 customer" : `${selected.linkedCustomerCount} customers`,
                },
              ]}
            />
          </div>

          <div className="space-y-1.5">
            <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
              Vendor codes that will be attached
            </p>
            {/*
              An empty list is the correct, complete answer for a venue with no distributor account.
              Said in words, because a heading with nothing under it reads as a loading failure.
            */}
            {selected.vendorCodes.length === 0 ? (
              <p className="text-phx-sm font-semibold text-slate-600">
                None — a {venueTypeLabel(selected.venueType).toLowerCase()} has no distributor account, so sales
                cannot be attributed to it.
              </p>
            ) : null}
            {selected.vendorCodes.map((code) => (
              <p className="min-w-0 break-words text-phx-sm font-semibold text-slate-700" key={code.distributorCodeId}>
                {code.distributorName} — {code.distributorPharmacyCode}
                {code.referenceStatus === "matched" ? null : (
                  <span className="ml-2 font-bold text-amber-700">Sales not trackable</span>
                )}
              </p>
            ))}
          </div>

          {selected.evidenceStatus === "complete" ? (
            <p className="flex items-center gap-1.5 text-phx-xs font-bold text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              Live photo and location already on file — no need to capture it again.
            </p>
          ) : (
            <p className="flex items-start gap-1.5 text-phx-xs font-bold text-amber-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              This pharmacy has no complete live photo and location, so attaching it leaves the
              customer under Not Usable Yet until that is fixed.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`min-h-10 min-w-0 break-words rounded-none px-2 py-1.5 text-phx-md font-bold leading-tight transition sm:px-4 md:min-h-9 ${
        active
          ? "bg-orange-500 text-white shadow-[0_4px_12px_rgba(249,115,22,0.25)]"
          : `border border-slate-200 bg-white text-slate-600 hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 ${adminControlDepthClassName}`
      }`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function StatusBadge({ status }: { status: MarketingValidationStatus }) {
  const variant = statusVariant(status);
  const styles = {
    success: "border-emerald-200 bg-emerald-50 text-emerald-700",
    warning: "border-amber-200 bg-amber-50 text-amber-700",
    danger: "border-rose-200 bg-rose-50 text-rose-700",
    neutral: "border-slate-200 bg-slate-50 text-slate-600",
  };

  return (
    <span className={`inline-flex items-center rounded-none border px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide ${styles[variant]}`}>
      {VALIDATION_STATUS_LABEL[status] ?? "Unknown"}
    </span>
  );
}

/** Marks a customer a Super Admin validated at the desk, so it is never mistaken for a field capture. */
function AdminValidatedBadge() {
  return (
    <span className="inline-flex items-center rounded-none border border-sky-200 bg-sky-50 px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide text-sky-700">
      Admin validated
    </span>
  );
}

/**
 * Shown on a VALIDATED customer whose distributor code is not in the Phoenix reference database.
 *
 * Since 2026-08-12 such a customer is usable in a marketing request (owner ruling: flag, do not
 * block), so this badge is the only thing left saying that no sale can ever be matched back to it
 * and its ROI will read zero. The request form asks for a written reason before accepting the code.
 */
function UntrackedCodeBadge() {
  return (
    <span className="inline-flex items-center rounded-none border border-amber-200 bg-amber-50 px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide text-amber-700">
      Sales not trackable
    </span>
  );
}

/**
 * The pharmacy trade licence (رخصة الصيدلية) attach control.
 *
 * DELIBERATELY NOT A `CapturePanel`, and the difference is what each one claims. A capture asserts
 * "taken at this place, at this time", which is why it refuses a file picker and burns GPS into the
 * pixels. A licence asserts only "this is the document" — it is routinely a PDF or a scan the
 * pharmacist sends ahead — so it offers the camera AND the picker, and it feeds nothing into
 * `evidence_status`. A licence that could raise a status would be a way to validate a shop nobody
 * visited (owner's call, 2026-08-25).
 *
 * Offered on every venue that could have one; highlighted only where it is the proof genuinely
 * missing — a pharmacy with no distributor code in any distributor. Never required: the system
 * flags, it never rejects.
 */
function PharmacyLicensePanel({
  license,
  onChange,
  distributorCodeCount,
  venueType,
}: {
  license: PharmacyLicenseAttachment | null;
  onChange: (next: PharmacyLicenseAttachment | null) => void;
  distributorCodeCount: number;
  venueType: VenueTypeChoice;
}) {
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A nursery has no distributor account by its nature and no pharmacy trade licence to produce,
  // so the control is not shown for one at all rather than being shown and never used. An
  // unanswered venue is not shown it either — there is nothing yet to say it needs one. Two
  // statements rather than one: `venueTypeIsAnswered` is the guard that narrows the type away
  // from null, so everything below can be typed as a real venue.
  if (!venueTypeIsAnswered(venueType)) return null;
  if (!venueRequiresDistributorCode(venueType)) return null;

  // A licence never stands in for a distributor code in Marketing (owner, 2026-10-21): a pharmacy
  // with no code is validated in Direct Orders. So the licence is optional here, always, and the
  // panel says plainly that it does not replace the code when none has been typed.
  const note = distributorCodeCount === 0
    ? `The licence does not replace a distributor code. ${CODELESS_VENUES_GO_TO_DIRECT_ORDERS}`
    : null;

  function readFile(file: File | null | undefined) {
    setError(null);
    if (!file) return;
    if (!isPharmacyLicenseContentType(file.type)) {
      setError("The pharmacy licence must be a JPEG, a PNG, or a PDF.");
      return;
    }
    if (file.size > PHARMACY_LICENSE_MAX_BYTES) {
      setError("The pharmacy licence file is too large. Attach a file under 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError("That file could not be read. Try attaching it again.");
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl) {
        setError("That file could not be read. Try attaching it again.");
        return;
      }
      onChange({
        dataUrl,
        fileName: file.name || "pharmacy-licence",
        isPdf: file.type === "application/pdf",
      });
    };
    reader.readAsDataURL(file);
  }

  function clear() {
    onChange(null);
    setError(null);
    // Reset both inputs so re-choosing the SAME file fires `change` again — without this, removing
    // a licence and picking it straight back leaves the control silently dead.
    if (cameraRef.current) cameraRef.current.value = "";
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div
      className={`rounded-none border border-slate-200 bg-slate-50 p-3 ${adminSoftDepthClassName}`}
    >
      <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
        Pharmacy Licence · رخصة الصيدلية (optional)
      </p>
      <p className="mt-1 text-phx-xs font-semibold text-slate-500" dir="auto">
        {note ??
          "Attach it if you have it — the reviewer checks the trade name on the licence against the name on the shop sign."}
      </p>
      <input
        accept={PHARMACY_LICENSE_ACCEPT_ATTRIBUTE}
        capture="environment"
        className="hidden"
        onChange={(event) => readFile(event.target.files?.[0])}
        ref={cameraRef}
        type="file"
      />
      <input
        accept={PHARMACY_LICENSE_ACCEPT_ATTRIBUTE}
        className="hidden"
        onChange={(event) => readFile(event.target.files?.[0])}
        ref={fileRef}
        type="file"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          className={`${CAPTURE_BUTTON_SIZE} gap-1.5 rounded-none border border-slate-200 bg-white px-3 text-phx-sm font-bold text-slate-700 hover:bg-slate-50 ${adminControlDepthClassName}`}
          onClick={() => cameraRef.current?.click()}
          type="button"
        >
          <Camera className="h-3.5 w-3.5" />
          Photograph
        </Button>
        <Button
          className={`${CAPTURE_BUTTON_SIZE} gap-1.5 rounded-none border border-slate-200 bg-white px-3 text-phx-sm font-bold text-slate-700 hover:bg-slate-50 ${adminControlDepthClassName}`}
          onClick={() => fileRef.current?.click()}
          type="button"
        >
          <Paperclip className="h-3.5 w-3.5" />
          Choose file
        </Button>
        <span className="text-phx-xs font-medium text-slate-400">JPEG, PNG or PDF · up to 5 MB</span>
      </div>
      {license ? (
        <div className="mt-2 rounded-none border border-emerald-200 bg-emerald-50 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 break-all text-phx-sm font-bold leading-snug text-emerald-900" dir="auto">
              {license.fileName}
            </span>
            <button
              className="shrink-0 text-phx-xs font-bold text-orange-600"
              onClick={clear}
              type="button"
            >
              Remove
            </button>
          </div>
          {/* A PDF shows its name only — an inline preview needs a viewer, and the reviewer opens it
              on the desk anyway. An image is shown, so a rep who photographed the wrong page finds
              out here rather than after the record is written. */}
          {license.isPdf ? null : (
            <ZoomablePhoto
              alt="Pharmacy licence"
              caption="Pharmacy licence · رخصة الصيدلية"
              className="mt-2 max-h-64 w-full object-contain"
              src={license.dataUrl}
            />
          )}
        </div>
      ) : null}
      {error ? <p className="mt-1.5 text-phx-xs font-bold text-rose-600">{error}</p> : null}
    </div>
  );
}

function CapturePanel({
  capture,
  isCapturing,
  label,
  onCaptureLocation,
  onOpenCamera,
}: {
  capture: CaptureState;
  isCapturing: boolean;
  label: string;
  onCaptureLocation: () => void;
  onOpenCamera: () => void;
}) {
  const hasLocation = capture.latitude !== null && capture.longitude !== null && Boolean(capture.capturedAt);
  const hasPhoto = Boolean(capture.photoName && capture.photoCapturedAt);

  return (
    <div className={`rounded-none border border-slate-200 bg-slate-50 p-3 ${adminSoftDepthClassName}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-phx-md font-bold text-slate-800">{label}</p>
          {/* Address and territory, one per line. The coordinate pair stays on the photo and in
              the record — on screen it only ever answered a question nobody asked. */}
          {hasLocation && capture.locationLines.length > 0 ? (
            <div className="mt-0.5 space-y-0.5 break-words text-phx-sm font-medium text-slate-500">
              {capture.locationLines.slice(0, 2).map((line, index) => (
                <p key={`${index}-${line}`}>{line}</p>
              ))}
            </div>
          ) : (
            <p className="mt-0.5 text-phx-sm font-medium text-slate-500">
              {hasLocation ? "Resolving the address…" : "No GPS capture yet"}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            className={`${CAPTURE_BUTTON_SIZE} gap-1.5 rounded-none border border-orange-200 bg-white px-3 text-phx-sm font-bold text-orange-700 hover:bg-orange-50`}
            disabled={isCapturing}
            onClick={onCaptureLocation}
            type="button"
          >
            {isCapturing ? <LoadingSpinner /> : <MapPin className="h-3.5 w-3.5" />}
            GPS
          </Button>
          <Button
            className={`${CAPTURE_BUTTON_SIZE} gap-1.5 rounded-none border border-slate-200 bg-white px-3 text-phx-sm font-bold text-slate-700 hover:bg-slate-50 ${adminControlDepthClassName}`}
            disabled={!hasLocation}
            onClick={onOpenCamera}
            type="button"
          >
            <Camera className="h-3.5 w-3.5" />
            Photo
          </Button>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <span className={`inline-flex items-center rounded-none border px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide ${hasLocation ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
          {hasLocation ? "Location captured" : "Location required"}
        </span>
        <span className={`inline-flex items-center rounded-none border px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide ${hasPhoto ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
          {hasPhoto ? "Live photo captured" : "Live photo required"}
        </span>
      </div>
      {capture.photoDataUrl ? (
        <div className="mt-2.5 overflow-hidden rounded-none border border-slate-200 bg-slate-900">
          <ZoomablePhoto
            alt={`${label} captured evidence`}
            caption={`${label} · captured evidence`}
            className="h-36 w-full object-contain"
            src={capture.photoDataUrl}
          />
          {/* On the Cairo clock, the same time the stamp burned into the photo reads — it used to be
              the raw UTC ISO string ("2026-09-25T11:02:14.311Z"). */}
          <p className="bg-white px-3 py-1.5 text-phx-xs font-semibold text-slate-500">
            {capture.photoCapturedAt ? formatEvidenceDateTime(capture.photoCapturedAt) : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------- Map Place Search --------------------------------------------------------------------- */

type PlaceSuggestion = {
  description: string;
  placeId: string;
  primaryText: string;
  secondaryText: string | null;
};

type ResolvedPlace = {
  area: string | null;
  formattedAddress: string | null;
  governorate: string | null;
  lat: number;
  lng: number;
  name: string | null;
};

/**
 * The desk equivalent of standing at the door: type the place, pick the nearest match, and that
 * point becomes the location. Mirrors the Google Maps search box rather than asking an admin to
 * paste coordinates — the admin knows the clinic's name, not its latitude.
 */
function PlaceSearchPanel({
  capture,
  label,
  onResolved,
}: {
  capture: CaptureState;
  label: string;
  onResolved: (place: ResolvedPlace) => void;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLocation = capture.latitude !== null && capture.longitude !== null;

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  function runSearch(nextQuery: string) {
    setQuery(nextQuery);
    setNote(null);
    if (searchTimer.current) clearTimeout(searchTimer.current);

    const trimmed = nextQuery.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    // Debounced: every keystroke would otherwise be a billed Places call.
    searchTimer.current = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(
            `/api/marketing-requests/place-search?input=${encodeURIComponent(trimmed)}`,
            { cache: "no-store" },
          );
          const payload = await response.json();
          if (!response.ok) {
            setSuggestions([]);
            setNote(payload.message ?? "Map search is unavailable right now.");
            return;
          }
          const results = (payload.suggestions ?? []) as PlaceSuggestion[];
          setSuggestions(results);
          if (results.length === 0) setNote("No matching place. Try the district or a nearby landmark.");
        } catch {
          setSuggestions([]);
          setNote("Map search failed. Check the connection and try again.");
        } finally {
          setIsSearching(false);
        }
      })();
    }, 350);
  }

  async function choosePlace(suggestion: PlaceSuggestion) {
    setIsResolving(true);
    setNote(null);
    try {
      const response = await fetch(
        `/api/marketing-requests/place-search?placeId=${encodeURIComponent(suggestion.placeId)}`,
        { cache: "no-store" },
      );
      const payload = await response.json();
      if (!response.ok) {
        setNote(payload.message ?? "That place could not be resolved to a location.");
        return;
      }
      onResolved(payload.location as ResolvedPlace);
      setSuggestions([]);
      setQuery("");
    } catch {
      setNote("Could not resolve that place. Try again.");
    } finally {
      setIsResolving(false);
    }
  }

  return (
    <div className="rounded-none border border-sky-200 bg-sky-50/60 p-3">
      <div className="flex items-center gap-2">
        <MapPin className="h-3.5 w-3.5 shrink-0 text-sky-600" />
        <p className="text-phx-md font-bold text-slate-800">{label}</p>
      </div>
      {hasLocation && capture.locationLines.length > 0 ? (
        <div className="mt-0.5 space-y-0.5 text-phx-sm font-medium text-slate-500">
          {capture.locationLines.slice(0, 2).map((line, index) => (
            <p key={`${index}-${line}`}>{line}</p>
          ))}
        </div>
      ) : (
        <p className="mt-0.5 text-phx-sm font-medium text-slate-500">
          {hasLocation
            ? capture.address || "Resolving the address…"
            : "Search the address or place name, then pick the nearest point."}
        </p>
      )}

      <div className="relative mt-2.5">
        <Input
          className="text-phx-md"
          onChange={(event) => runSearch(event.target.value)}
          placeholder="Search address or place"
          value={query}
        />
        {suggestions.length > 0 ? (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-none border border-slate-200 bg-white shadow-[0_16px_36px_rgba(15,23,42,0.14)]">
            {suggestions.map((suggestion) => (
              <button
                className="flex min-h-10 w-full flex-col items-start gap-0.5 border-b border-slate-100 px-3 py-2 text-left transition last:border-b-0 hover:bg-orange-50"
                disabled={isResolving}
                key={suggestion.placeId}
                onClick={() => void choosePlace(suggestion)}
                type="button"
              >
                <span className="max-w-full break-words text-phx-md font-bold text-slate-800">{suggestion.primaryText}</span>
                {suggestion.secondaryText ? (
                  <span className="max-w-full break-words text-phx-xs font-medium text-slate-500">{suggestion.secondaryText}</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span
          className={`inline-flex items-center rounded-none border px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide ${
            hasLocation
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-amber-200 bg-amber-50 text-amber-700"
          }`}
        >
          {hasLocation ? "Location pinned from map" : "Location required"}
        </span>
        {isSearching || isResolving ? <LoadingSpinner /> : null}
        {note ? <span className="text-phx-xs font-semibold text-amber-700">{note}</span> : null}
      </div>
    </div>
  );
}

function ValidatedPharmaciesModal({
  group,
  onClose,
  pharmacies,
}: {
  group: ValidatedCustomerGroup;
  onClose: () => void;
  pharmacies: ValidatedPharmacyDetail[];
}) {
  const focusTrapRef = useFocusTrap(true);

  // Close on Escape
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Portalled to <body>, like every overlay in the portal: the page-transition wrapper keeps a
  // `transform`, so a `fixed` box left inside it anchors to the PAGE (not the screen) and paints
  // under the phone's bottom navigation (z-40). z-[300] sits above it, beside the photo viewer.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      aria-label={`Venues linked to ${group.customerName}`}
      aria-modal="true"
      className="fixed inset-0 z-[300] flex items-center justify-center bg-slate-950/70 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-sm"
      role="dialog"
    >
      <div className="max-h-[88dvh] w-full max-w-3xl overflow-hidden rounded-none border border-slate-200 bg-white shadow-2xl" ref={focusTrapRef}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-orange-600">Linked venues</p>
            <h3 className="mt-1 break-words text-lg font-black text-slate-900">{group.customerName}</h3>
          </div>
          <Button
            className={`h-10 shrink-0 rounded-none border border-slate-200 bg-white px-3 text-phx-sm font-bold text-slate-700 hover:bg-slate-50 sm:h-8 ${adminControlDepthClassName}`}
            onClick={onClose}
            type="button"
          >
            Close
          </Button>
        </div>
        <div className="max-h-[65dvh] overflow-y-auto p-4">
          {/* Phone card view — below `md` (768px) */}
          <div className="block md:hidden">
            <div className="space-y-3">
              {pharmacies.map((pharmacy) => (
                <div className={`rounded-none border border-slate-200 bg-white p-3 ${adminSoftDepthClassName}`} key={pharmacy.id}>
                  <p className="text-phx-md font-bold text-slate-900">{pharmacy.name}</p>
                  {/* 🔴 NEUTRAL INK ON PURPOSE. The warning below it is amber because it asks the
                      human to doubt something; this asks him to doubt nothing. A verdict here is
                      permanent and uncorrectable, so a line that LOOKED like evidence would be
                      read as evidence — it says only that somebody already decided these two
                      rows are one shop, in a colour that carries no instruction. */}
                  {pharmacy.alsoKnownAs.length > 0 ? (
                    <p dir="auto" className="mt-1 break-words text-phx-sm text-slate-500">
                      also known as {pharmacy.alsoKnownAs.join(" · ")}
                    </p>
                  ) : null}
                  {pharmacy.suspectedWholesaler ? (
                    <p className="mt-1.5 border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-phx-sm font-semibold text-amber-800">
                      {pharmacy.suspectedWholesalerNote ??
                        "This name could be a wholesaler rather than a pharmacy — check the storefront photo and the licence before validating it."}
                    </p>
                  ) : null}
                  <div className="mt-2 space-y-1 text-phx-sm">
                    <div className="flex justify-between gap-2">
                      <span className="shrink-0 font-medium text-slate-500">Area</span>
                      <span className="min-w-0 break-words text-right font-semibold text-slate-700">{pharmacy.area || "Not captured"}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="shrink-0 font-medium text-slate-500">Governorate</span>
                      <span className="min-w-0 break-words text-right font-semibold text-slate-700">{pharmacy.governorate || "Not captured"}</span>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {pharmacy.vendorCodes.map((line) => (
                      <span
                        className={`min-w-0 break-words rounded-none border border-slate-200 bg-slate-50 px-2 py-1 text-phx-xs font-semibold text-slate-700 ${adminSoftDepthClassName}`}
                        key={line.id}
                      >
                        {line.distributorName}: <span className="font-mono">{line.code}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {/* Desktop and tablet table view — `md` (768px) and up. Fixed columns, so a long venue
              name or a row of vendor codes wraps inside its cell instead of widening the table. */}
          <div className="hidden md:block">
            <div className="overflow-hidden rounded-none border border-slate-200">
              <table className="w-full table-fixed border-collapse text-left">
                <colgroup>
                  <col style={{ width: "34%" }} />
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "30%" }} />
                </colgroup>
                <thead className="bg-slate-50 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="border-r border-slate-100 px-3 py-2.5">Venue</th>
                    <th className="border-r border-slate-100 px-3 py-2.5">Area</th>
                    <th className="border-r border-slate-100 px-3 py-2.5">Governorate</th>
                    <th className="px-3 py-2.5">Vendor Codes</th>
                  </tr>
                </thead>
                <tbody className="bg-white text-phx-md">
                  {pharmacies.map((pharmacy) => (
                    <tr className="border-t border-slate-100" key={pharmacy.id}>
                      <td className="break-words border-r border-slate-100 px-3 py-2.5 font-bold text-slate-900">
                        {pharmacy.name}
                        {/* Neutral ink, for the reason the phone card gives: the amber note below
                            asks the human to doubt something, this asks him to doubt nothing. */}
                        {pharmacy.alsoKnownAs.length > 0 ? (
                          <span dir="auto" className="mt-1 block break-words text-phx-xs font-medium text-slate-500">
                            also known as {pharmacy.alsoKnownAs.join(" · ")}
                          </span>
                        ) : null}
                        {pharmacy.suspectedWholesaler ? (
                          <span className="mt-1 block border border-amber-200 bg-amber-50 px-2 py-1 text-phx-xs font-semibold text-amber-800">
                            {pharmacy.suspectedWholesalerNote ??
                              "Could be a wholesaler — check the photo and licence before validating."}
                          </span>
                        ) : null}
                      </td>
                      <td className="break-words border-r border-slate-100 px-3 py-2.5 font-medium text-slate-700">{pharmacy.area || "Not captured"}</td>
                      <td className="break-words border-r border-slate-100 px-3 py-2.5 font-medium text-slate-700">{pharmacy.governorate || "Not captured"}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1.5">
                          {pharmacy.vendorCodes.map((line) => (
                            <span
                              className={`min-w-0 break-words rounded-none border border-slate-200 bg-slate-50 px-2 py-1 text-phx-xs font-semibold text-slate-600 ${adminSoftDepthClassName}`}
                              key={line.id}
                            >
                              {line.distributorName}: <span className="font-mono">{line.code}</span>
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const nextLine = currentLine ? `${currentLine} ${word}` : word;
    if (context.measureText(nextLine).width <= maxWidth || !currentLine) {
      currentLine = nextLine;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}

function LiveCameraModal({
  capture,
  onCapture,
  onClose,
  targetLabel,
}: {
  capture: CaptureState;
  onCapture: (dataUrl: string, capturedAt: string, photoFix: ShutterFix) => void;
  onClose: () => void;
  targetLabel: string;
}) {
  const focusTrapRef = useFocusTrap(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [message, setMessage] = useState("Camera permission is required.");
  const [pendingPhoto, setPendingPhoto] = useState<
    { capturedAt: string; dataUrl: string; fix: ShutterFix } | null
  >(null);
  // `locationLines`, not `address`: the address used to be filled in with the raw coordinates the
  // instant the pin arrived, so this gate opened before the place was known and a rep could stamp
  // a photo whose caption was a number pair. It now waits for the resolved block.
  const hasLocationStamp = capture.latitude !== null &&
    capture.longitude !== null &&
    Boolean(capture.capturedAt) &&
    capture.locationLines.length > 0;

  const startCamera = useCallback(async () => {
    if (!window.isSecureContext) {
      setMessage("Camera requires HTTPS or localhost.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage("Camera is not available in this browser.");
      return;
    }

    setIsStarting(true);
    setCameraReady(false);
    setPendingPhoto(null);
    setMessage("Waiting for camera permission...");
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
        },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraReady(true);
      setMessage("Camera ready");
    } catch (error) {
      const errorName = error instanceof DOMException ? error.name : "CameraError";
      if (errorName === "NotAllowedError" || errorName === "PermissionDeniedError") {
        setMessage("Camera permission is blocked. Use the browser camera icon to allow this site, then retry.");
      } else if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
        setMessage("No camera device was found on this device.");
      } else if (errorName === "NotReadableError" || errorName === "TrackStartError") {
        setMessage("Camera is busy in another app. Close the other app and retry.");
      } else {
        setMessage(`Camera access failed: ${errorName}.`);
      }
    } finally {
      setIsStarting(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  // Close on Escape
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function captureFrame() {
    const video = videoRef.current;
    if (!cameraReady || !video || video.videoWidth === 0 || video.videoHeight === 0) {
      setMessage("Start the camera before capturing the photo.");
      return;
    }
    if (!hasLocationStamp) {
      setMessage("Capture GPS location before taking the live photo.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const photoCapturedAt = new Date();
    const photoCapturedAtIso = photoCapturedAt.toISOString();
    const fontSize = Math.max(16, Math.round(canvas.width * 0.022));
    const lineHeight = Math.round(fontSize * 1.38);
    const padding = Math.round(fontSize * 0.75);
    const maxTextWidth = canvas.width - padding * 2;
    // One shared wording for every Phoenix evidence photo (owner instruction 2026-08-23): full
    // address, then the Phoenix brick / area / region, then the coordinates as fine print. The
    // timestamps are Cairo local — they used to be printed as raw UTC ISO strings.
    const stampLines = buildEvidenceStampLines({
      capturedAt: photoCapturedAtIso,
      locationCapturedAt: capture.capturedAt,
      locationLines: capture.locationLines,
      title: `${targetLabel} live evidence`,
    });

    context.font = `700 ${fontSize}px sans-serif`;
    const wrappedLines = stampLines.flatMap((line) => wrapCanvasText(context, line, maxTextWidth));
    const maxLines = Math.max(1, Math.floor((canvas.height - padding * 2) / lineHeight));
    const visibleLines = wrappedLines.length > maxLines
      ? [...wrappedLines.slice(0, Math.max(1, maxLines - 1)), "..."]
      : wrappedLines;
    const stampHeight = Math.min(canvas.height, padding * 2 + visibleLines.length * lineHeight);
    const stampTop = canvas.height - stampHeight;
    context.fillStyle = "rgba(0, 0, 0, 0.72)";
    context.fillRect(0, stampTop, canvas.width, stampHeight);
    context.strokeStyle = "rgba(255, 255, 255, 0.35)";
    context.lineWidth = Math.max(1, Math.round(canvas.width * 0.002));
    context.strokeRect(0, stampTop, canvas.width, stampHeight);
    context.fillStyle = "#fff";
    context.textBaseline = "top";
    visibleLines.forEach((line, index) => {
      context.fillText(line, padding, stampTop + padding + lineHeight * index);
    });
    setPendingPhoto({
      capturedAt: photoCapturedAtIso,
      dataUrl: canvas.toDataURL("image/jpeg", 0.86),
      fix: NO_SHUTTER_FIX,
    });
    setMessage("Review the stamped photo before confirming.");

    // The photo's OWN position, read now rather than copied from *Capture Location*. Fired here and
    // awaited nowhere: the image is already on screen, so a slow or refused fix costs the rep
    // nothing and simply leaves the reading null. Guarded on `capturedAt` so a fix that lands after
    // the rep has retaken the shot cannot attach itself to the new photo.
    void readShutterFix().then((fix) => {
      setPendingPhoto((current) =>
        current && current.capturedAt === photoCapturedAtIso ? { ...current, fix } : current,
      );
    });
  }

  function confirmPhoto() {
    if (!pendingPhoto) return;
    onCapture(pendingPhoto.dataUrl, pendingPhoto.capturedAt, pendingPhoto.fix);
  }

  // Portalled to <body> at z-[300]: left inside the page it anchored to the page-transition wrapper
  // (which keeps a `transform`), not to the screen, and painted under the phone's bottom navigation.
  //
  // On a phone it is a bottom sheet that SCROLLS — the old centred box could not, so on a ~640px
  // screen the stamped photo pushed Confirm off the bottom. The outer layer scrolls and the inner
  // one is `min-h-full`, so a sheet taller than the screen grows downward and every part of it can
  // be reached. The live preview is `object-contain` — `object-cover` cropped a portrait camera
  // into a 16:9 strip, so what the rep saw was not what the capture kept.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      aria-label="Live timestamped photo capture"
      aria-modal="true"
      className="fixed inset-0 z-[300] overflow-y-auto bg-slate-950/70 backdrop-blur-sm"
      role="dialog"
    >
      <div className="flex min-h-full items-end justify-center sm:items-center sm:p-4">
        <div className="w-full max-w-xl rounded-none border border-slate-200 bg-white shadow-2xl" ref={focusTrapRef}>
          <div className="border-b border-slate-100 px-5 py-3">
            <p className="text-phx-md font-bold text-slate-900">Live timestamped photo</p>
            <p className="mt-0.5 text-phx-sm font-medium text-slate-500">{message}</p>
            {hasLocationStamp ? (
              <p className="mt-1.5 break-words text-phx-xs font-semibold text-slate-600">{capture.address}</p>
            ) : null}
          </div>
          <div className="bg-slate-900">
            {pendingPhoto ? (
              <ZoomablePhoto
                alt={`${targetLabel} stamped live evidence preview`}
                caption={`${targetLabel} · stamped live evidence`}
                className="max-h-[55dvh] w-full object-contain"
                src={pendingPhoto.dataUrl}
              />
            ) : null}
            {/* Stays mounted (only hidden) while the stamped photo is reviewed, so Re-take returns
                to a LIVE preview — unmounting it dropped the stream and left a black box. */}
            <video
              className={pendingPhoto ? "hidden" : "h-[55dvh] w-full object-contain sm:aspect-video sm:h-auto"}
              muted
              playsInline
              ref={videoRef}
            />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 bg-slate-50 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:pb-3">
            <Button
              className={`${CAPTURE_BUTTON_SIZE} rounded-none border border-slate-200 bg-white px-3 text-phx-sm font-bold text-slate-700 hover:bg-slate-50 ${adminControlDepthClassName}`}
              onClick={onClose}
              type="button"
            >
              Cancel
            </Button>
            {pendingPhoto ? (
              <>
                <Button
                  className={`${CAPTURE_BUTTON_SIZE} gap-1.5 rounded-none border border-orange-200 bg-white px-3 text-phx-sm font-bold text-orange-700 hover:bg-orange-50`}
                  onClick={() => {
                    setPendingPhoto(null);
                    setMessage("Camera ready");
                  }}
                  type="button"
                >
                  Re-take
                </Button>
                <Button
                  className={`${CAPTURE_BUTTON_SIZE} gap-1.5 rounded-none bg-orange-500 px-3 text-phx-sm font-bold text-white hover:bg-orange-600`}
                  onClick={confirmPhoto}
                  type="button"
                >
                  Confirm Photo
                </Button>
              </>
            ) : (
              <>
                <Button
                  className={`${CAPTURE_BUTTON_SIZE} gap-1.5 rounded-none border border-orange-200 bg-white px-3 text-phx-sm font-bold text-orange-700 hover:bg-orange-50`}
                  disabled={isStarting}
                  onClick={startCamera}
                  type="button"
                >
                  {isStarting ? <LoadingSpinner /> : <Camera className="h-3.5 w-3.5" />}
                  {cameraReady ? "Restart" : "Start Camera"}
                </Button>
                <Button
                  className={`${CAPTURE_BUTTON_SIZE} gap-1.5 rounded-none bg-orange-500 px-3 text-phx-sm font-bold text-white hover:bg-orange-600`}
                  disabled={!cameraReady || !hasLocationStamp}
                  onClick={captureFrame}
                  type="button"
                >
                  <Camera className="h-3.5 w-3.5" />
                  Capture
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* --------------------------------------------------------------------- Skeleton Loader --------------------------------------------------------------------- */

function MetricSkeleton({ className }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-none border border-slate-200 border-l-[3px] border-l-slate-300 px-3.5 py-3 ${className ?? ""}`}>
      <div className="h-3 w-24 rounded-none bg-slate-200" />
      <div className="mt-3 h-6 w-12 rounded-none bg-slate-200" />
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {[1, 2, 3].map((i) => (
        <div className="animate-pulse rounded-none border border-slate-100 bg-slate-50 p-3" key={i}>
          <div className="h-4 w-3/4 rounded-none bg-slate-200" />
          <div className="mt-2 h-3 w-1/2 rounded-none bg-slate-200" />
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------- Main Exported Component --------------------------------------------------------------------- */

export function MarketingValidationWorkspace() {
  const [workspace, setWorkspace] = useState<MarketingValidationWorkspacePayload>(emptyWorkspace);
  const [activeTab, setActiveTab] = useState<"validation" | "validated" | "pending">("validation");
  const [selectedValidatedCustomerKey, setSelectedValidatedCustomerKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [captureTarget, setCaptureTarget] = useState<string | null>(null);
  const [cameraTarget, setCameraTarget] = useState<LocationTarget | null>(null);
  /**
   * The banner text and the colour it is shown in, kept together.
   *
   * The colour used to be sniffed from the text at render time (`message.includes("saved")`), which
   * broke the moment the save messages started distinguishing a validated customer from a blocked
   * one — "Saved, but ... is NOT in your marketing request customer list" would have rendered green.
   * `setMessage` keeps its original one-argument shape so every existing caller is unchanged; the
   * two that know their own outcome pass the tone explicitly.
   */
  const [messageState, setMessageState] = useState<{ text: string; tone: "success" | "warning" } | null>(null);
  const message = messageState?.text ?? null;
  const setMessage = useCallback((text: string | null, tone?: "success" | "warning") => {
    setMessageState(
      text === null
        ? null
        : { text, tone: tone ?? (text.includes("saved") || text.includes("success") ? "success" : "warning") },
    );
  }, []);
  const [customers, setCustomers] = useState<CustomerLine[]>(() => [newCustomerLine()]);
  /**
   * The area → doctor pick (owner, 2026-10-23). `crmAreas` is null while loading; `crmAreasFailed`
   * when the areas could not be read, and then the only way to save is a typed name, flagged for the
   * approvers. `crmDoctors` holds each area's doctors once read, or "failed".
   */
  const [crmAreas, setCrmAreas] = useState<CrmDoctorAreasPayload | null>(null);
  const [crmAreasFailed, setCrmAreasFailed] = useState(false);
  const [crmDoctors, setCrmDoctors] = useState<Record<string, CrmDoctorOption[] | "failed">>({});
  const crmDoctorFetchesRef = useRef(new Set<string>());
  // Super Admin only. When set, the whole form switches to desk mode: the location comes from map
  // search instead of the phone's GPS, no live photo is required, and the saved customer is owned
  // by this employee so it lands in THEIR marketing request dropdown.
  const [onBehalfHrId, setOnBehalfHrId] = useState("");
  const [codeChecks, setCodeChecks] = useState<Record<string, CodeCheckStatus>>({});
  /** Ranked code candidates per vendor line. Ranked by the capture's place, never filtered by it. */
  const [codeSuggestions, setCodeSuggestions] = useState<Record<string, RankedPharmacyCode[]>>({});
  const codeCheckTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [hasMounted, setHasMounted] = useState(false);
  // Hydration flag - mount-only setState is the canonical React pattern.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setHasMounted(true); }, []);

  // Offline queue --- replay pending submissions when connectivity returns
  const replaySubmission = useCallback(async (payload: unknown) => {
    const response = await fetch("/api/marketing-requests/validation", {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw new Error("Replay failed");
    const result = await response.json();
    const rows = (result.rows ?? []).filter(Boolean) as MarketingValidationReportRow[];
    setWorkspace((current) => {
      const summary = { ...current.summary };
      for (const row of rows) summary[row.validationStatus] += 1;
      return { ...current, rows: [...rows, ...current.rows], summary };
    });
  }, []);
  const { dismissExpired, enqueue, expiredCount, isOnline, queueLength } = useOfflineQueue(replaySubmission, workspace.viewerHrId);

  const loadWorkspace = useCallback(async () => {
    try {
      const response = await fetch("/api/marketing-requests/validation", {
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) {
        setWorkspace(emptyWorkspace());
        setMessage(payload.message ?? "Unable to load validation workspace.");
        return;
      }

      setWorkspace({
        canValidateOnBehalf: payload.canValidateOnBehalf === true,
        distributors: payload.distributors ?? [],
        onBehalfEmployees: payload.onBehalfEmployees ?? [],
        reusablePharmacies: payload.reusablePharmacies ?? [],
        rows: payload.rows ?? [],
        summary: payload.summary ?? emptyWorkspace().summary,
        viewerHrId: typeof payload.viewerHrId === "string" ? payload.viewerHrId : "",
      });
      setCustomers((current) =>
        current.map((customer) => ({
          ...customer,
          pharmacies: customer.pharmacies.map((pharmacy) => ({
            ...pharmacy,
            vendorCodes: pharmacy.vendorCodes.map((line) => ({
              ...line,
              distributorId: line.distributorId || String(payload.distributors?.[0]?.id ?? ""),
            })),
          })),
        })),
      );
    } catch {
      setWorkspace(emptyWorkspace());
      setMessage("Unable to load validation workspace.");
    } finally {
      setIsLoading(false);
    }
  }, [setMessage]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadWorkspace();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadWorkspace]);

  // The areas he may choose. A Medical Rep's single area is pre-chosen on every new customer line.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/marketing-requests/crm-doctors", { cache: "no-store" });
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok || !Array.isArray(payload?.areas)) {
          setCrmAreasFailed(true);
          return;
        }
        const loaded: CrmDoctorAreasPayload = { areas: payload.areas, areaFixed: payload.areaFixed === true };
        setCrmAreas(loaded);
        const onlyArea = loaded.areaFixed && loaded.areas.length === 1 ? loaded.areas[0].seatId : "";
        if (onlyArea) {
          setCustomers((current) =>
            current.map((line) => (line.existingCustomerId || line.crmAreaSeatId ? line : { ...line, crmAreaSeatId: onlyArea })),
          );
        }
      } catch {
        if (!cancelled) setCrmAreasFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Each chosen area's doctors, read once. A failed read is forgotten, so the next change retries it.
  const wantedCrmAreaKey = useMemo(
    () =>
      [...new Set(customers.filter((line) => !line.existingCustomerId).map((line) => line.crmAreaSeatId).filter(Boolean))].join("|"),
    [customers],
  );
  useEffect(() => {
    for (const seatId of wantedCrmAreaKey.split("|").filter(Boolean)) {
      if (crmDoctorFetchesRef.current.has(seatId)) continue;
      crmDoctorFetchesRef.current.add(seatId);
      void (async () => {
        try {
          const response = await fetch(`/api/marketing-requests/crm-doctors?area=${encodeURIComponent(seatId)}`, {
            cache: "no-store",
          });
          const payload = await response.json();
          const doctors = response.ok && Array.isArray(payload?.doctors) ? (payload.doctors as CrmDoctorOption[]) : null;
          if (!doctors) crmDoctorFetchesRef.current.delete(seatId);
          setCrmDoctors((current) => ({ ...current, [seatId]: doctors ?? "failed" }));
        } catch {
          crmDoctorFetchesRef.current.delete(seatId);
          setCrmDoctors((current) => ({ ...current, [seatId]: "failed" }));
        }
      })();
    }
  }, [wantedCrmAreaKey]);

  /* --------- Crash / refresh recovery --------- */

  /**
   * What the recovery banner says, or null when there is nothing to recover.
   *
   * Written on 2026-08-23, after a Product Manager lost a captured doctor to a page refresh at a
   * clinic in Kafr Selim. The form had held the whole capture --- name, GPS fix and live photo ---
   * in React state and written it nowhere, so a full sweep of every table in production and of the
   * evidence bucket found no trace of it and the only recovery was to drive back.
   */
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  /**
   * Blocks the save effect below until the stored draft has been read back. Without it the empty
   * form mounts, the effect fires, and the draft is overwritten with nothing --- the exact bug this
   * feature exists to prevent, reintroduced by the fix for it.
   */
  const draftReadyRef = useRef(false);
  const draftRestoredRef = useRef(false);
  /**
   * A live mirror of the form, read by the restore below.
   *
   * The stored draft arrives after two awaits — the workspace GET, then the IndexedDB read — and
   * the form is typeable throughout. Without this check a rep who started typing in that window
   * would have his work replaced by the recovered draft, which is the same loss this feature exists
   * to prevent, arriving through the fix for it.
   */
  const customersRef = useRef(customers);
  useEffect(() => {
    customersRef.current = customers;
  }, [customers]);

  const viewerHrId = workspace.viewerHrId;

  useEffect(() => {
    // Waits for the workspace load, because a draft is only ever offered back to the person who
    // typed it and the viewer's id arrives with that payload. Field phones are shared.
    if (!viewerHrId || draftRestoredRef.current) return;
    draftRestoredRef.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const restore = restoreDraft<CustomerLine>({
          // The stored value is validated structurally before it is trusted; the cast carries the
          // concrete line type back, which the shape check cannot express on its own.
          draft: parseStoredDraft(await readValidationDraft()) as MarketingValidationDraft<CustomerLine> | null,
          nowMs: Date.now(),
          viewerHrId,
        });
        if (cancelled) return;

        if (!restore) {
          await clearValidationDraft();
          return;
        }

        // Whatever the rep has typed while waiting outranks anything on disk.
        if (isDraftWorthKeeping(customersRef.current)) return;

        setCustomers(restore.customers.map(withDoctorPickDefaults));
        setOnBehalfHrId(restore.onBehalfHrId);
        setDraftNotice(describeRestoredDraft(restore));
      } catch {
        // A draft that cannot be read is a draft that is thrown away. It must never be the reason
        // the capture screen fails to open --- a rep who cannot work at all is the worse outcome.
        await clearValidationDraft();
      } finally {
        if (!cancelled) draftReadyRef.current = true;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [viewerHrId]);

  useEffect(() => {
    if (!draftReadyRef.current || !viewerHrId) return;

    // Debounced: a capture holds base64 photos, and writing them on every keystroke would put a
    // megabyte-scale serialisation between the rep and the next character he types.
    const timeout = window.setTimeout(() => {
      if (!isDraftWorthKeeping(customers)) {
        void clearValidationDraft();
        return;
      }
      void saveValidationDraft({
        customers,
        onBehalfHrId,
        ownerHrId: viewerHrId,
        savedAt: new Date().toISOString(),
        version: MARKETING_DRAFT_VERSION,
      });
    }, 800);

    return () => window.clearTimeout(timeout);
  }, [customers, onBehalfHrId, viewerHrId]);

  const defaultDistributorId = String(workspace.distributors[0]?.id ?? "");
  // Desk mode is driven purely by whether an employee is selected. The server re-checks the role on
  // every submit, so this only controls what the form asks for, never what it is allowed to do.
  const isDeskMode = workspace.canValidateOnBehalf && Boolean(onBehalfHrId);
  const onBehalfEmployee = useMemo(
    () => workspace.onBehalfEmployees.find((employee) => employee.hrId === onBehalfHrId) ?? null,
    [onBehalfHrId, workspace.onBehalfEmployees],
  );
  /**
   * One group per customer, built over ALL of its links, then split into the Validated and Validate
   * tabs by the LIVE evidence — never by the stored `validation_status` stamp (owner, 2026-09-24).
   *
   * The tabs used to route on each link's stored status, which is written once and never rewritten:
   * a 2026-07-02 history backfill and the desk path both minted a validated status with no live
   * photo, and a link kept its validated status after its shop's evidence was cleared — so those
   * customers read "validated" for ever. `customerIsEvidenceValidated` decides it fresh instead: a
   * customer is validated only when a complete live photo + location stands on him AND on every shop
   * linked to him, so a desk pick (no live photo) and a stale stamp both fall back to the queue on
   * their own, and correct themselves the moment the real evidence lands.
   */
  const customerGroups = useMemo(() => {
    const groups = new Map<string, ValidatedCustomerGroup>();
    for (const row of workspace.rows) {
      const key = row.customer.id;
      const current = groups.get(key);
      if (current) {
        current.rows.push(row);
        // The group still shows its strongest link, in the same order a backfilled sibling inherits.
        if (linkStatusRank(row.validationStatus) < linkStatusRank(current.status)) {
          current.status = row.validationStatus;
        }
        // A desk entry is the only path that stamps validated_at — the honest "an admin typed this".
        if (row.customer.validatedAt) current.isAdminValidated = true;
      } else {
        groups.set(key, {
          customerName: row.customer.displayName,
          customerType: row.customer.customerType,
          // Placeholder: recomputed over the whole group below, because a per-row value here would
          // be wrong for any customer whose links disagree.
          fieldEvidenceGap: null,
          isAdminValidated: Boolean(row.customer.validatedAt),
          key,
          rows: [row],
          status: row.validationStatus,
        });
      }
    }
    // Decided once per customer, over ALL of its links — never accumulated row by row.
    return Array.from(groups.values()).map((group) => ({
      ...group,
      fieldEvidenceGap: customerFieldEvidenceGap(group.rows.map(fieldEvidenceGapInput)),
    }));
  }, [workspace.rows]);
  const validatedGroups = useMemo(
    () =>
      customerGroups.filter(
        (group) =>
          customerIsEvidenceValidated(group.rows.map(fieldEvidenceGapInput))
          // AND still reachable by the request form. Evidence alone was the test until 2026-09-29,
          // and it is not the same question: a capture can carry a perfect live photo and pin and
          // still be unusable because its LINK is held. That is exactly what the owner was sent a
          // screenshot of - “Validated · 1” beside an empty “0 customers” panel, for a customer
          // held on a governorate mismatch. linkStatusIsSelectable is the same predicate the
          // request form’s picker uses, so this tab now means what its name says: ready to use.
          && group.rows.some((row) => linkStatusIsSelectable(row.validationStatus)),
      ),
    [customerGroups],
  );
  /**
   * Everything NOT USABLE in a marketing request — the “Not Usable Yet” queue. This is now a strict complement
   * of `validatedGroups` over the same customer groups, so a customer can never sit in both tabs and
   * one whose capture is unfinished can never hide in Validated behind a stale stamp.
   */
  const pendingGroups = useMemo(
    () =>
      customerGroups.filter(
        (group) =>
          !customerIsEvidenceValidated(group.rows.map(fieldEvidenceGapInput))
          || !group.rows.some((row) => linkStatusIsSelectable(row.validationStatus)),
      ),
    [customerGroups],
  );
  /**
   * The tab actually RENDERED, which is not always the tab last clicked.
   *
   * The tab BUTTON for “Not Usable Yet” only exists while something is in it, but the panel body
   * rendered on the raw activeTab - so the moment a save emptied the queue the button vanished and
   * the empty panel stayed on screen, headed “0 customers”. That is what the owner was looking at.
   *
   * Derived during render rather than corrected in an effect: a setState inside useEffect is a lint
   * error in this repo, and it would also paint the empty panel once before fixing itself.
   */
  const effectiveTab = activeTab === "pending" && pendingGroups.length === 0 ? "validated" : activeTab;
  const selectedValidatedGroup = useMemo(
    () =>
      validatedGroups.find((group) => group.key === selectedValidatedCustomerKey)
      ?? pendingGroups.find((group) => group.key === selectedValidatedCustomerKey)
      ?? null,
    [pendingGroups, selectedValidatedCustomerKey, validatedGroups],
  );
  const selectedValidatedPharmacies = useMemo(
    () => (selectedValidatedGroup ? buildValidatedPharmacyDetails(selectedValidatedGroup.rows) : []),
    [selectedValidatedGroup],
  );

  // Save is a native `disabled` submit button, so once the form is incomplete a tap fires no click
  // event and `submitValidation` never runs to explain why — the rep just sees a button that does
  // nothing. So the button and the sentence come from ONE gate: `canSaveMarketingValidation` is
  // `describeMissingSaveRequirement` returning nothing. They were two parallel lists of checks
  // "kept in step" by comment, and they drifted — a nursery carries no distributor code, which the
  // sentence knew and the button did not, so answering "Nursery" greyed Save for good and printed
  // no reason at all.
  // While the areas load, the pick is still asked for; once they are known to be empty or unreadable,
  // only a typed name is possible, and it saves flagged.
  const crmAreasAvailable = crmAreas ? crmAreas.areas.length > 0 : !crmAreasFailed;
  const defaultCrmAreaSeatId = crmAreas?.areaFixed && crmAreas.areas.length === 1 ? crmAreas.areas[0].seatId : "";
  const gateCustomers = customers.map((line) =>
    line.existingCustomerId
      ? line
      : {
          ...line,
          doctorPick: {
            areasAvailable: crmAreasAvailable,
            areaSeatId: line.crmAreaSeatId,
            crmCustomerId: line.crmCustomerId,
            notOnList: line.notOnCrmList,
          },
        },
  );
  const missingRequirement = !isSaving ? describeMissingSaveRequirement(gateCustomers, isDeskMode) : null;
  const canSave = !isSaving && canSaveMarketingValidation(gateCustomers, isDeskMode);
  const totalPharmacyCount = customers.reduce((sum, customer) => sum + customer.pharmacies.length, 0);
  // Caught only once there are several customers: the same person entered twice would mint two
  // separate records that both show up in the request dropdown. The server refuses it too — this
  // just says so before the round trip.
  const duplicateCustomerName = (() => {
    const seen = new Set<string>();
    for (const customer of customers) {
      const key = customer.name.trim().replace(/\s+/g, " ").toLowerCase();
      if (!key) continue;
      if (seen.has(key)) return customer.name.trim();
      seen.add(key);
    }
    return null;
  })();

  /**
   * The location block for a pin, resolved through the shared evidence stamp so this screen, the
   * Direct Order storefront capture and the outstation arrival photo all word it identically.
   */
  function resolveStampLines(target: LocationTarget, latitude: number, longitude: number, accuracyMeters: number | null) {
    void resolveEvidenceLocationStamp(
      MARKETING_LOCATION_ENDPOINT,
      latitude,
      longitude,
      accuracyMeters,
    ).then((location) => patchLocation(target, { locationLines: location.lines }));
  }

  function updateCustomer(customerKey: string, patch: Partial<CustomerLine>) {
    setCustomers((current) =>
      current.map((customer) => (customer.key === customerKey ? { ...customer, ...patch } : customer)),
    );
  }

  /** A new area empties the doctor and the name: they belonged to the area he left. */
  function chooseCrmArea(customerKey: string, seatId: string) {
    updateCustomer(customerKey, { crmAreaSeatId: seatId, crmCustomerId: "", name: "", notOnCrmList: false });
  }

  /** The doctor fills the name, and the speciality when it is one of ours and none was chosen yet. */
  function chooseCrmDoctor(customer: CustomerLine, value: string) {
    if (value === NOT_ON_CRM_LIST_VALUE) {
      updateCustomer(customer.key, { crmCustomerId: "", name: customer.notOnCrmList ? customer.name : "", notOnCrmList: true });
      return;
    }
    const list = crmDoctors[customer.crmAreaSeatId];
    const doctor = Array.isArray(list) ? list.find((entry) => entry.crmCustomerId === value) ?? null : null;
    if (!doctor) {
      updateCustomer(customer.key, { crmCustomerId: "", name: "", notOnCrmList: false });
      return;
    }
    const knownSpeciality = (MARKETING_CUSTOMER_SPECIALITIES as readonly string[]).includes(doctor.speciality ?? "")
      ? (doctor.speciality ?? "")
      : "";
    updateCustomer(customer.key, {
      crmCustomerId: doctor.crmCustomerId,
      name: doctor.name,
      notOnCrmList: false,
      speciality: customer.speciality || knownSpeciality,
    });
  }

  /** Patch one pharmacy inside one customer. Both keys are required — pharmacy keys are unique, but
   *  scoping the write to its customer keeps the lists provably independent. */
  function updatePharmacy(customerKey: string, pharmacyKey: string, patch: Partial<PharmacyLine>) {
    setCustomers((current) =>
      current.map((customer) =>
        customer.key === customerKey
          ? {
              ...customer,
              pharmacies: customer.pharmacies.map((pharmacy) =>
                pharmacy.key === pharmacyKey ? { ...pharmacy, ...patch } : pharmacy,
              ),
            }
          : customer,
      ),
    );
  }

  function updateVendorCode(
    customerKey: string,
    pharmacyKey: string,
    vendorKey: string,
    patch: Partial<VendorCodeLine>,
  ) {
    setCustomers((current) =>
      current.map((customer) =>
        customer.key === customerKey
          ? {
              ...customer,
              pharmacies: customer.pharmacies.map((pharmacy) =>
                pharmacy.key === pharmacyKey
                  ? {
                      ...pharmacy,
                      vendorCodes: pharmacy.vendorCodes.map((line) =>
                        line.key === vendorKey ? { ...line, ...patch } : line,
                      ),
                    }
                  : pharmacy,
              ),
            }
          : customer,
      ),
    );
  }

  /** Apply a capture patch to either the customer's own location or one of its pharmacies. */
  function patchLocation(
    target: LocationTarget,
    capturePatch: Partial<CaptureState>,
    place?: { area: string; governorate: string },
  ) {
    setCustomers((current) =>
      current.map((customer) => {
        if (customer.key !== target.customerKey) return customer;
        if (!target.pharmacyKey) {
          return {
            ...customer,
            ...(place ? { area: place.area, governorate: place.governorate } : {}),
            capture: { ...customer.capture, ...capturePatch },
          };
        }
        return {
          ...customer,
          pharmacies: customer.pharmacies.map((pharmacy) =>
            pharmacy.key === target.pharmacyKey
              ? {
                  ...pharmacy,
                  ...(place ? { area: place.area, governorate: place.governorate } : {}),
                  capture: { ...pharmacy.capture, ...capturePatch },
                }
              : pharmacy,
          ),
        };
      }),
    );
  }

  /** Stable id for "which block is currently capturing", so two blocks never share a spinner. */
  const targetKey = (target: LocationTarget) =>
    target.pharmacyKey ? `${target.customerKey}::${target.pharmacyKey}` : target.customerKey;

  // Advisory, non-blocking check: does this (vendor, pharmacy code) already exist in the
  // Phoenix reference database (fed from the sales module)? Debounced so typing is smooth.
  // This never gates submission --- it only tells the rep whether sales can be tracked.
  const checkVendorCode = useCallback((
    lineKey: string,
    distributorId: string,
    code: string,
    // Where the rep just stood. Sent so the server can RANK the candidates; it never narrows them
    // (owner ruling, 2026-09-29 — "nothing filtered out"), so omitting it costs order, not members.
    place?: { area?: string | null; governorate?: string | null },
  ) => {
    const timers = codeCheckTimers.current;
    if (timers[lineKey]) {
      clearTimeout(timers[lineKey]);
      delete timers[lineKey];
    }

    const trimmedCode = code.trim();
    if (!distributorId || !trimmedCode) {
      setCodeChecks((current) => {
        if (!(lineKey in current)) return current;
        const next = { ...current };
        delete next[lineKey];
        return next;
      });
      setCodeSuggestions((current) => {
        if (!(lineKey in current)) return current;
        const next = { ...current };
        delete next[lineKey];
        return next;
      });
      return;
    }

    setCodeChecks((current) => ({ ...current, [lineKey]: "checking" }));
    timers[lineKey] = setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({ code: trimmedCode, distributorId });
          if (place?.area) params.set("area", place.area);
          if (place?.governorate) params.set("governorate", place.governorate);
          const response = await fetch(`/api/marketing-requests/pharmacy-code-lookup?${params.toString()}`, {
            cache: "no-store",
          });
          if (!response.ok) {
            setCodeChecks((current) => ({ ...current, [lineKey]: "unknown" }));
            return;
          }
          const payload = (await response.json()) as {
            suggestions?: RankedPharmacyCode[];
            tracked?: boolean;
          };
          setCodeChecks((current) => ({ ...current, [lineKey]: payload.tracked ? "tracked" : "untracked" }));
          setCodeSuggestions((current) => ({ ...current, [lineKey]: payload.suggestions ?? [] }));
        } catch {
          setCodeChecks((current) => ({ ...current, [lineKey]: "unknown" }));
        }
      })();
    }, 450);
  }, []);

  useEffect(() => {
    const timers = codeCheckTimers.current;
    return () => {
      Object.values(timers).forEach((timer) => clearTimeout(timer));
    };
  }, []);

  async function captureLocation(target: LocationTarget) {
    setMessage(null);
    if (!navigator.geolocation) {
      setMessage("GPS capture is not supported in this browser.");
      return;
    }

    setCaptureTarget(targetKey(target));
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const capturedAt = new Date(position.timestamp || Date.now()).toISOString();
        patchLocation(target, {
          accuracy: position.coords.accuracy,
          // Deliberately NOT seeded with the coordinate pair any more. That placeholder was what
          // reached the photo caption whenever a rep shot before the lookup returned.
          address: "",
          capturedAt,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          locationLines: [],
        });

        // ONE round trip carries both halves: Google's area/governorate for the customer record,
        // and the burned-in evidence block. It cannot hang — `fetchEvidenceLocation` aborts itself,
        // and a null result still produces a stamp, so the camera always unlocks.
        void fetchEvidenceLocation(
          MARKETING_LOCATION_ENDPOINT,
          position.coords.latitude,
          position.coords.longitude,
          position.coords.accuracy ?? null,
        ).then((result) => {
          const area = result?.area ?? "";
          const governorate = result?.governorate ?? result?.city ?? "";
          const label = result?.label || [area, governorate].filter(Boolean).join(", ");
          const stamp = readEvidenceLocationStamp(
            result,
            position.coords.latitude,
            position.coords.longitude,
            position.coords.accuracy ?? null,
          );
          // The place patch is applied ONLY when the lookup actually answered — the previous code
          // bailed out entirely on an empty label, and writing `{ area: "", governorate: "" }`
          // here would erase a customer's territory every time Google was unreachable. The stamp
          // lines are written either way: they say so when the lookup failed.
          patchLocation(
            target,
            { ...(label ? { address: label } : {}), locationLines: stamp.lines },
            label ? { area, governorate } : undefined,
          );
        });
        setCaptureTarget(null);
      },
      () => {
        setCaptureTarget(null);
        setMessage("GPS capture failed. Allow location access and try again.");
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 12000,
      },
    );
  }

  /**
   * Apply a map-picked place to the customer or a pharmacy. `capturedAt` is stamped here because the
   * evidence model treats a location without a timestamp as no location at all — for a desk entry it
   * records when the admin pinned it, which is the honest answer to "when was this decided".
   */
  function applyResolvedPlace(target: LocationTarget, place: ResolvedPlace) {
    const address = place.formattedAddress
      || [place.name, place.area, place.governorate].filter(Boolean).join(", ")
      || `${place.lat.toFixed(6)}, ${place.lng.toFixed(6)}`;

    patchLocation(
      target,
      {
        accuracy: null,
        address,
        capturedAt: new Date().toISOString(),
        latitude: place.lat,
        longitude: place.lng,
        locationLines: [],
      },
      { area: place.area ?? "", governorate: place.governorate ?? "" },
    );
    // A desk-picked pin gets the same address + brick/area/region block as a live GPS capture, so
    // the two are comparable on the screen that reviews them.
    resolveStampLines(target, place.lat, place.lng, null);
  }

  function applyLivePhoto(dataUrl: string, photoCapturedAt: string, photoFix: ShutterFix) {
    if (cameraTarget) {
      patchLocation(cameraTarget, {
        // The shutter's own reading, kept apart from the location fix on purpose — see
        // `CaptureState.photoLatitude`. Never defaulted to the location fix here: a fallback at this
        // layer would be indistinguishable downstream from a genuine second measurement.
        photoAccuracy: photoFix.accuracy,
        photoCapturedAt,
        photoDataUrl: dataUrl,
        photoLatitude: photoFix.latitude,
        photoLongitude: photoFix.longitude,
        photoName: `${cameraTarget.pharmacyKey ? "pharmacy" : "customer"}-live-${photoCapturedAt}.jpg`,
      });
    }
    setCameraTarget(null);
  }

  function payloadCapture(capture: CaptureState) {
    return {
      capturedAccuracyMeters: capture.accuracy,
      capturedAddress: capture.address || null,
      capturedAt: capture.capturedAt,
      capturedLatitude: capture.latitude,
      capturedLongitude: capture.longitude,
      evidenceHasTimestamp: Boolean(capture.photoName && capture.photoCapturedAt),
      // The shutter's own fix. Null when it could not be read — the server keeps that null rather
      // than substituting the location fix, so "not measured" never masquerades as "same place".
      evidencePhotoAccuracyMeters: capture.photoAccuracy,
      evidencePhotoCapturedAt: capture.photoCapturedAt,
      evidencePhotoLatitude: capture.photoLatitude,
      evidencePhotoLongitude: capture.photoLongitude,
      // The IMAGE, not just its name. This line is the fix: the stamped JPEG used to live only in
      // `photoDataUrl` for the on-screen preview and was dropped the moment the form was submitted,
      // so the server stored a filename and called it proof. The server now writes these bytes to
      // the private `marketing-evidence` bucket and REFUSES a name that arrives without them.
      evidencePhotoDataUrl: capture.photoDataUrl,
      evidencePhotoName: capture.photoName || null,
    };
  }

  function buildSubmissionPayload() {
    return {
      // Only sent in desk mode. The server rejects it with a 403 for any role other than Super
      // Admin, so this is a request, not a grant.
      onBehalfOfHrId: isDeskMode ? onBehalfHrId : null,
      // Each customer carries its own pharmacies — the server keeps them separate too, so nothing
      // pools across customers on either side of the wire.
      customers: customers.map((customer) => ({
        ...payloadCapture(customer.capture),
        customerType: customer.type,
        displayName: customer.name,
        // The area → doctor pick. The server re-reads the doctor from the CRM list and takes the name
        // from there; with no doctor picked the customer is saved flagged "not on the list".
        crmAreaSeatId: customer.existingCustomerId ? null : customer.crmAreaSeatId || null,
        crmCustomerId: customer.existingCustomerId || customer.notOnCrmList ? null : customer.crmCustomerId || null,
        // Present only when the rep came from the Pending tab. It redirects the server from
        // minting a new customer to completing the one already waiting, which is the whole point:
        // capturing a customer that exists used to create a second copy of it.
        existingCustomerId: customer.existingCustomerId || null,
        extractedAreaName: customer.area,
        extractedGovernorateName: customer.governorate,
        mobileNumber: customer.mobile,
        otherTypeDescription: customer.otherType,
        regionName: [customer.area, customer.governorate].filter(Boolean).join(", "),
        speciality: customer.speciality || null,
        pharmacies: customer.pharmacies.map((pharmacy) =>
          // An attached pharmacy sends its id, and describes the shop only when the rep actually
          // stood in front of it and completed the proof it was missing. Name and distributor codes
          // are never sent on this path — re-describing a shop the server already has on file is
          // how a stored name or code would drift — but a capture is not a re-description: it is
          // the evidence the record has been short of, and until now had no route to receive.
          pharmacy.source === "existing"
            ? {
              existingPharmacyId: pharmacy.existingPharmacyId,
              ...(hasCompleteCapture(pharmacy.capture)
                ? {
                  ...payloadCapture(pharmacy.capture),
                  extractedAreaName: pharmacy.area,
                  extractedGovernorateName: pharmacy.governorate,
                  regionName: [pharmacy.area, pharmacy.governorate].filter(Boolean).join(", "),
                }
                : {}),
              // OUTSIDE the capture spread, and after it so the spread stays adjacent to the id —
              // `tests/marketing-complete-existing-venue.test.ts` pins that adjacency to prove a
              // half-finished capture is never sent, and this feature has no business loosening it.
              //
              // Sent whether or not a capture came with it. A licence is not a capture: it can be
              // supplied for a shop whose storefront photo is already complete, and gating it on
              // the capture would drop it silently for exactly that venue.
              licenseFileDataUrl: pharmacy.license?.dataUrl ?? null,
              licenseFileName: pharmacy.license?.fileName ?? null,
            }
            : {
              ...payloadCapture(pharmacy.capture),
              displayName: pharmacy.name,
              extractedAreaName: pharmacy.area,
              extractedGovernorateName: pharmacy.governorate,
              regionName: [pharmacy.area, pharmacy.governorate].filter(Boolean).join(", "),
              // Empty for a codeless venue — the server refuses a code on one, so sending the
              // half-typed rows that were on screen before the rep switched type would 400. Also
              // empty while the type is unanswered; the submit gate refuses that case outright.
              vendorCodes: choiceRequiresDistributorCode(pharmacy.venueType)
                ? withoutBlankCodeRows(pharmacy).map((line) => ({
                  distributorId: Number(line.distributorId),
                  distributorPharmacyCode: line.distributorCode,
                }))
                : [],
              licenseFileDataUrl: pharmacy.license?.dataUrl ?? null,
              licenseFileName: pharmacy.license?.fileName ?? null,
              venueType: pharmacy.venueType,
            },
        ),
      })),
    };
  }

  /**
   * Clears the form AND the stored draft together.
   *
   * Every caller is a point where the work has left the browser for good --- saved, or queued for
   * replay. Leaving the draft behind would mean the next visit offers to "recover" a capture that
   * is already a row in production, and the rep would save it a second time.
   */
  function resetForm() {
    setCustomers([newCustomerLine(defaultDistributorId, defaultCrmAreaSeatId)]);
    setDraftNotice(null);
    void clearValidationDraft();
  }

  /** "Discard" on the recovery banner: throw the recovered capture away and start clean. */
  function discardRecoveredDraft() {
    resetForm();
    setMessage(null);
  }

  /**
   * "Capture evidence" on the Not Usable Yet tab.
   *
   * Seeds the Validate form with the customer ALREADY on record so the capture lands on that row
   * instead of minting a second copy of it. Until this existed the only way to photograph a
   * customer you already owned was to type it in again as a new one — which is how production ended
   * up holding the same doctor under two spellings, and why 39 imported customers sat with missing
   * evidence and no route to supply it. Identity is carried but locked: the server updates the
   * capture columns only, so re-labelling here would be a silent no-op.
   */
  function startCompletingCustomer(group: ValidatedCustomerGroup) {
    const customer = group.rows[0]?.customer;
    // Either half can be the one that is short, and the rep can only fix the half that is. When the
    // customer's own evidence is complete the block is the venue, so the form opens on the venue's
    // capture instead — the customer is locked and never written.
    const customerShort = !customer || customer.evidenceStatus !== "complete";

    // The venues this customer is waiting on, attached from the shops already on file so the
    // capture lands on the existing venue record rather than minting a second copy of it. Only
    // those the rep may reuse are offered — the same list, and the same scope, the server checks.
    const reusableIds = new Set(workspace.reusablePharmacies.map((option) => option.id));
    const seeded: PharmacyLine[] = [];
    const seen = new Set<string>();
    for (const row of group.rows) {
      const pharmacyId = row.pharmacy.id;
      if (seen.has(pharmacyId) || !reusableIds.has(pharmacyId)) continue;
      // With the customer complete, a venue that already has its proof has nothing to capture.
      if (!customerShort && row.pharmacy.evidenceStatus === "complete") continue;
      seen.add(pharmacyId);
      seeded.push({ ...newPharmacyLine(defaultDistributorId), existingPharmacyId: pharmacyId, source: "existing" });
    }
    if (!customerShort && seeded.length === 0) {
      setMessage(
        `"${group.customerName}" is waiting on a venue that is not in your My Venues list, so it cannot be captured from here. Ask a Super Admin to release it from Customer Pharmacy Mapping.`,
      );
      return;
    }

    setCustomers([{
      ...newCustomerLine(defaultDistributorId),
      area: customer?.extractedAreaName ?? "",
      customerComplete: !customerShort,
      existingCustomerId: group.key,
      governorate: customer?.extractedGovernorateName ?? "",
      name: group.customerName,
      // Falls back to the ordinary blank venue line when none of the customer's venues can be
      // reused — the behaviour before this seeded any, and the only way left to save one.
      pharmacies: seeded.length > 0 ? seeded : [newPharmacyLine(defaultDistributorId)],
      // The customer ROW, not `group.customerType` — the group widens it to `string` for display,
      // and the form field is the narrow union.
      type: customer?.customerType ?? "clinic",
    }]);
    setMessage(null);
    setActiveTab("validation");
  }

  async function submitValidation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    if (duplicateCustomerName) {
      setMessage(`"${duplicateCustomerName}" is entered twice. Remove the duplicate before saving.`);
      return;
    }
    if (!canSave) {
      // The gate always has a sentence unless there is no customer at all (or a save is already in
      // flight), which is the only thing the fallback can still be about.
      setMessage(
        describeMissingSaveRequirement(gateCustomers, isDeskMode)
          ?? "Add a customer before saving.",
      );
      return;
    }

    const submissionPayload = buildSubmissionPayload();

    // Offline path --- queue and optimistically update UI
    if (!isOnline) {
      if (!enqueue(submissionPayload)) {
        setMessage("This could not be saved offline because the page had not finished loading. Reconnect and save again.", "warning");
        return;
      }
      // Optimistic: increment pending count
      setWorkspace((current) => ({
        ...current,
        summary: { ...current.summary, pending: current.summary.pending + totalPharmacyCount },
      }));
      resetForm();
      setMessage("Saved offline. Will sync automatically when connection returns.");
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch("/api/marketing-requests/validation", {
        body: JSON.stringify(submissionPayload),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message ?? "Unable to save validation row.");
        return;
      }

      const rows = (payload.rows ?? []).filter(Boolean) as MarketingValidationReportRow[];
      setWorkspace((current) => {
        const summary = { ...current.summary };
        for (const row of rows) summary[row.validationStatus] += 1;
        return {
          ...current,
          rows: [...rows, ...current.rows],
          summary,
        };
      });
      resetForm();

      // Say what actually happened, per customer.
      //
      // This used to be a flat "Validation rows saved." whatever came back, and the page had
      // nowhere to show a row that landed pending — so a customer that would never reach the
      // marketing request list looked identical to one that had. Name the customers that are
      // blocked and why, and land the rep on the tab that shows them.
      const savedCustomers = new Map<string, MarketingValidationReportRow[]>();
      for (const row of rows) {
        savedCustomers.set(row.customer.id, [...(savedCustomers.get(row.customer.id) ?? []), row]);
      }
      const blocked = Array.from(savedCustomers.values()).filter((customerRows) =>
        customerRows.every((row) => row.validationStatus === "pending"),
      );
      const usable = savedCustomers.size - blocked.length;
      const untracked = untrackedVendorCodes(rows);

      if (blocked.length === 0) {
        setMessage(
          untracked.length > 0
            ? `Saved and validated. ${usable === 1 ? "The customer is" : `All ${usable} customers are`} now in your marketing request customer list. Note ${untracked.length === 1 ? "code" : "codes"} ${untracked.map((entry) => `${entry.code} (${entry.distributorName})`).join(", ")} ${untracked.length === 1 ? "is" : "are"} not in the Phoenix reference database, so no sale can be matched to ${untracked.length === 1 ? "it" : "them"} yet — you can still submit a request, but you will be asked to record why.`
            : `Saved and validated. ${usable === 1 ? "The customer is" : `All ${usable} customers are`} now in your marketing request customer list.`,
          "success",
        );
        setActiveTab("validated");
        return;
      }

      const blockedNames = blocked.map((customerRows) => customerRows[0].customer.displayName).join(", ");
      // "Capture it again" is the right advice for missing evidence and the WRONG advice for a
      // governorate hold — the photo and the pin are already there, and retaking them lands the rep
      // on the identical hold. A held-on-geography row is a question about the CODE, so send him to
      // the code instead.
      const blockedRemedy = hasGovernorateHold(blocked.flat())
        ? `Check the distributor code on ${blocked.length === 1 ? "it" : "them"} is the right one for that shop, then ask a Super Admin or the CEO to release ${blocked.length === 1 ? "it" : "them"}.`
        : `Ask a Super Admin or the CEO to release ${blocked.length === 1 ? "it" : "them"}, or capture ${blocked.length === 1 ? "it" : "them"} again with the live photo and location on both the customer and the pharmacy.`;
      setMessage(
        `Saved, but ${blockedNames} ${blocked.length === 1 ? "is" : "are"} NOT in your marketing request customer list yet. ${pendingBlockReason(blocked.flat())} ${blockedRemedy}${usable > 0 ? ` The other ${usable === 1 ? "customer is" : `${usable} customers are`} ready to use.` : ""}`,
        "warning",
      );
      setActiveTab("pending");
    } catch {
      // Network failure mid-request --- queue for retry
      if (!enqueue(submissionPayload)) {
        setMessage("Network error. This could not be queued because the page had not finished loading. Save again.", "warning");
        return;
      }
      resetForm();
      setMessage("Network error. Submission queued for automatic retry.");
    } finally {
      setIsSaving(false);
    }
  }

  const activeCameraCapture = (() => {
    if (!cameraTarget) return null;
    const customer = customers.find((entry) => entry.key === cameraTarget.customerKey);
    if (!customer) return null;
    if (!cameraTarget.pharmacyKey) return customer.capture;
    return customer.pharmacies.find((pharmacy) => pharmacy.key === cameraTarget.pharmacyKey)?.capture ?? null;
  })();
  const activeCameraLabel = cameraTarget?.pharmacyKey ? "Pharmacy" : "Customer";

  const totalValidated = LINK_STATUS_PRECEDENCE.reduce((sum, status) => sum + workspace.summary[status], 0);

  return (
    <WorkspaceErrorBoundary fallbackTitle="Validation workspace error">
    <div className="space-y-4" dir="auto">
      {/* --------- Offline Indicator --------- */}
      {hasMounted && (!isOnline || queueLength > 0) && (
        <div className="flex items-center gap-2 rounded-none border border-amber-200 bg-amber-50 px-3.5 py-2 text-phx-sm font-semibold text-amber-800">
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          {!isOnline
            ? "You are offline. Submissions will be queued and synced automatically."
            : `Syncing ${queueLength} queued submission${queueLength > 1 ? "s" : ""}...`}
        </div>
      )}

      {/* --------- Recovered Draft --------- */}
      {hasMounted && draftNotice ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-none border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-phx-md font-semibold text-amber-800">
          <span className="flex min-w-0 items-start gap-2">
            <History className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {draftNotice}
          </span>
          <button
            className="shrink-0 rounded-none border border-amber-300 bg-white px-2.5 py-1 text-phx-sm font-semibold text-amber-800 hover:bg-amber-100"
            onClick={discardRecoveredDraft}
            type="button"
          >
            Discard
          </button>
        </div>
      ) : null}

      {/* --------- Offline Submissions That Aged Out --------- */}
      {hasMounted && expiredCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-none border border-red-200 bg-red-50 px-3.5 py-2.5 text-phx-md font-semibold text-red-800">
          <span className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {`${expiredCount} offline submission${expiredCount > 1 ? "s were" : " was"} waiting to sync but the live photo and location on ${expiredCount > 1 ? "them are" : "it is"} now too old to count as evidence of the visit. Capture ${expiredCount > 1 ? "them" : "it"} again.`}
          </span>
          <button
            className="shrink-0 rounded-none border border-red-300 bg-white px-2.5 py-1 text-phx-sm font-semibold text-red-800 hover:bg-red-100"
            onClick={dismissExpired}
            type="button"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* --------- Summary Metrics --------- */}
      {/* Five cards: 2 · 3 · 5 across. The fifth spans the whole row on a phone rather than sitting
          alone at half width, and the refresh button has its own header row — beside the grid it
          took width the labels needed. */}
      <div className="rounded-none border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">Validation summary</p>
          <button
            aria-label="Refresh data"
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-none border border-slate-200 bg-white text-slate-600 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600 md:h-9 md:w-9 ${adminControlDepthClassName}`}
            onClick={() => {
              setIsLoading(true);
              setMessage(null);
              void loadWorkspace();
            }}
            title="Refresh data"
            type="button"
          >
            {isLoading ? <LoadingSpinner /> : <RefreshCcw className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {isLoading ? (
            <>
              <MetricSkeleton />
              <MetricSkeleton />
              <MetricSkeleton />
              <MetricSkeleton />
              <MetricSkeleton className="col-span-2 sm:col-span-1" />
            </>
          ) : (
            <>
              <MetricCard accent="green" icon={CheckCircle2} label="System Validated" value={workspace.summary.system_validated} />
              <MetricCard accent="blue" icon={UserCheck} label="SFE Validated" value={workspace.summary.sfe_validated} />
              {/* Blue like SFE: both are a person's decision. Green stays the evidence gate alone. */}
              <MetricCard accent="blue" icon={ShieldCheck} label="Admin Approved" value={workspace.summary.admin_approved} />
              <MetricCard accent="amber" icon={Clock} label="Pending" value={workspace.summary.pending} />
              <MetricCard accent="red" className="col-span-2 sm:col-span-1" icon={ShieldX} label="Rejected" value={workspace.summary.rejected} />
            </>
          )}
        </div>
        {/* Mini summary bar */}
        {!isLoading && (totalValidated + workspace.summary.pending + workspace.summary.rejected) > 0 && (
          <div className="mt-3 flex h-2 w-full overflow-hidden rounded-none bg-slate-100">
            {totalValidated > 0 && (
              <div
                className="bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-500"
                style={{ width: `${(totalValidated / (totalValidated + workspace.summary.pending + workspace.summary.rejected)) * 100}%` }}
              />
            )}
            {workspace.summary.pending > 0 && (
              <div
                className="bg-gradient-to-r from-amber-500 to-amber-300 transition-all duration-500"
                style={{ width: `${(workspace.summary.pending / (totalValidated + workspace.summary.pending + workspace.summary.rejected)) * 100}%` }}
              />
            )}
            {workspace.summary.rejected > 0 && (
              <div
                className="bg-gradient-to-r from-rose-600 to-rose-400 transition-all duration-500"
                style={{ width: `${(workspace.summary.rejected / (totalValidated + workspace.summary.pending + workspace.summary.rejected)) * 100}%` }}
              />
            )}
          </div>
        )}
      </div>

      {/* --------- Tab Buttons --------- */}
      {/* An equal-width grid, so the tabs share the row at every width instead of each label
          breaking onto three lines below ~500px. A phone reads the short labels; from `sm` up the
          full ones. */}
      <div
        className={`grid gap-2 rounded-none border border-slate-200 bg-white p-1.5 ${adminChipDepthClassName} ${
          pendingGroups.length > 0 ? "grid-cols-3" : "grid-cols-2"
        }`}
      >
        <TabButton active={effectiveTab === "validation"} onClick={() => setActiveTab("validation")}>
          <span className="sm:hidden">Validate</span>
          <span className="hidden sm:inline">Validate Customer</span>
        </TabButton>
        <TabButton active={effectiveTab === "validated"} onClick={() => setActiveTab("validated")}>
          <span className="sm:hidden">Validated · {validatedGroups.length}</span>
          <span className="hidden sm:inline">Validated ({validatedGroups.length})</span>
        </TabButton>
        {pendingGroups.length > 0 ? (
          <TabButton active={effectiveTab === "pending"} onClick={() => setActiveTab("pending")}>
            <span className="sm:hidden">Not usable · {pendingGroups.length}</span>
            <span className="hidden sm:inline">Not Usable Yet ({pendingGroups.length})</span>
          </TabButton>
        ) : null}
      </div>

      {/* --------- Alert Messages --------- */}
      {message ? (
        <div className={`rounded-none border px-3.5 py-2.5 text-phx-md font-semibold ${messageState?.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          {message}
        </div>
      ) : null}

      {/* --------- Validation Form Tab --------- */}
      {effectiveTab === "validation" ? (
        <Card className="overflow-hidden rounded-none border border-slate-200 bg-white p-0 shadow-sm">
          <form aria-busy={isSaving} onSubmit={submitValidation}>
            <div className="border-b border-slate-100 bg-gradient-to-r from-white via-orange-50/40 to-white px-4 py-4 sm:px-5">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-none bg-orange-50 text-orange-600 ring-1 ring-orange-100">
                  <ClipboardCheck className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-orange-600">
                    Customer Validation
                  </p>
                  <h2 className="text-lg font-black tracking-tight text-slate-900">
                    Customer and pharmacy evidence
                  </h2>
                </div>
              </div>
            </div>

            {/* --------- Super Admin: validate on behalf of an employee --------- */}
            {workspace.canValidateOnBehalf ? (
              <div className="border-b border-slate-100 bg-sky-50/50 px-4 py-4 sm:px-5">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-none bg-white text-sky-600 ring-1 ring-sky-100">
                    <ShieldCheck className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-sky-700">Super Admin</p>
                    <p className="text-phx-md font-bold text-slate-800">Validate on behalf of an employee</p>
                  </div>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-6">
                  <div className="md:col-span-3">
                    <Field label="Employee">
                      <SelectField onChange={setOnBehalfHrId} value={onBehalfHrId}>
                        <option value="">Not on behalf — validate as myself</option>
                        {workspace.onBehalfEmployees.map((employee: MarketingOnBehalfEmployee) => (
                          <option key={employee.hrId} value={employee.hrId}>
                            {[employee.name, employee.jobTitle, employee.lineName].filter(Boolean).join(" — ")}
                          </option>
                        ))}
                      </SelectField>
                    </Field>
                  </div>
                  <div className="md:col-span-3">
                    <Field label="What this does">
                      <div className={`flex min-h-10 items-center rounded-none border border-slate-200 bg-white px-3.5 py-2 ${adminSoftDepthClassName}`}>
                        <p className="text-phx-sm font-semibold text-slate-600">
                          {onBehalfEmployee
                            ? `Customer is owned by ${onBehalfEmployee.name} and appears in their marketing request list.`
                            : "Pick an employee to search the location on a map instead of capturing GPS."}
                        </p>
                      </div>
                    </Field>
                  </div>
                </div>
                {isDeskMode ? (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    <span className="inline-flex items-center rounded-none border border-sky-200 bg-white px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide text-sky-700">
                      Desk mode — map search, no live photo
                    </span>
                    <span className={`inline-flex items-center rounded-none border border-slate-200 bg-white px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide text-slate-600 ${adminChipDepthClassName}`}>
                      Saved as admin validated
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-4 p-4 sm:p-5">
              {customers.map((customer, customerIndex) => (
                <div
                  className={`overflow-hidden rounded-none border border-slate-200 bg-white ${adminSoftDepthClassName}`}
                  key={customer.key}
                >
                  <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/70 px-3 py-2.5 sm:px-4">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-none bg-white text-orange-600 ring-1 ring-orange-100">
                        <UserCheck className="h-3.5 w-3.5" />
                      </div>
                      <p className="min-w-0 text-phx-md font-bold text-slate-800">
                        Customer {customerIndex + 1}
                        {customer.name.trim() ? ` — ${customer.name.trim()}` : ""}
                      </p>
                    </div>
                    <button
                      aria-label="Remove customer"
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-none border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 sm:h-7 sm:w-7 ${adminControlDepthClassName}`}
                      disabled={customers.length === 1}
                      onClick={() =>
                        setCustomers((current) =>
                          current.length === 1 ? current : current.filter((item) => item.key !== customer.key),
                        )
                      }
                      type="button"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Completing a customer already on record supplies its MISSING EVIDENCE only.
                      Name and type are shown so the rep can see who she is standing in front of,
                      and locked because the server updates the capture columns alone — an editable
                      field the save would ignore is worse than no field at all. */}
                  {customer.existingCustomerId ? (
                    <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50 px-3 py-2 sm:px-4">
                      <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                      <p className="min-w-0 text-phx-sm font-bold text-amber-800">
                        {customer.customerComplete
                          ? "This customer's own photo and location are already complete — capture the venue below. Name and type are locked"
                          : "Completing a customer already on record — name and type are locked"}
                      </p>
                    </div>
                  ) : null}

                  <div className="grid gap-4 p-3 sm:p-4 md:grid-cols-6">
                    <div className="md:col-span-2">
                      <Field label="Customer Type">
                        <SelectField
                          disabled={Boolean(customer.existingCustomerId)}
                          onChange={(value) => updateCustomer(customer.key, { type: value as MarketingCustomerType })}
                          value={customer.type}
                        >
                          {customerTypes.map((type) => (
                            <option key={type.value} value={type.value}>
                              {type.label}
                            </option>
                          ))}
                        </SelectField>
                      </Field>
                    </div>
                    {customer.existingCustomerId ? (
                      <div className="md:col-span-4">
                        <Field label="Customer Name">
                          <Input className="text-phx-md" disabled placeholder="Customer name" value={customer.name} />
                        </Field>
                      </div>
                    ) : (<>
                    {/* The doctor is PICKED, never free-typed (owner, 2026-10-23): the area first, by
                        hand, then that area's reps' Phoenix CRM doctors. The area chosen here is its own
                        field; the GPS area below stays exactly what the capture resolved. */}
                    <div className="md:col-span-4">
                      <Field label="Area">
                        {!crmAreas && !crmAreasFailed ? (
                          <ReadOnlyCaptureValue placeholder="Loading your areas" value="" />
                        ) : !crmAreasAvailable ? (
                          <ReadOnlyCaptureValue
                            placeholder={crmAreasFailed ? "The areas could not load" : "No area with a rep's CRM list"}
                            value=""
                          />
                        ) : (
                          <SelectField
                            // A rep's one area is fixed once set; a restored draft that predates it can still take it.
                            disabled={Boolean(defaultCrmAreaSeatId) && customer.crmAreaSeatId === defaultCrmAreaSeatId}
                            onChange={(value) => chooseCrmArea(customer.key, value)}
                            value={customer.crmAreaSeatId}
                          >
                            <option value="">Choose the area</option>
                            {(crmAreas?.areas ?? []).map((area) => (
                              <option key={area.seatId} value={area.seatId}>
                                {area.areaName}
                              </option>
                            ))}
                          </SelectField>
                        )}
                      </Field>
                    </div>
                    {crmAreasAvailable ? (
                      <div className="md:col-span-6">
                        <Field label="Doctor (from the reps' CRM lists)">
                          <SelectField
                            disabled={!customer.crmAreaSeatId}
                            onChange={(value) => chooseCrmDoctor(customer, value)}
                            value={customer.notOnCrmList ? NOT_ON_CRM_LIST_VALUE : customer.crmCustomerId}
                          >
                            <option value="">
                              {!customer.crmAreaSeatId
                                ? "Choose the area first"
                                : crmDoctors[customer.crmAreaSeatId] === undefined
                                  ? "Loading the doctors"
                                  : "Choose the doctor"}
                            </option>
                            {(() => {
                              const list = crmDoctors[customer.crmAreaSeatId];
                              return Array.isArray(list)
                                ? list.map((doctor) => (
                                    <option key={doctor.crmCustomerId} value={doctor.crmCustomerId}>
                                      {crmDoctorOptionLabel(doctor)}
                                    </option>
                                  ))
                                : null;
                            })()}
                            <option value={NOT_ON_CRM_LIST_VALUE}>Not on the list — type the name</option>
                          </SelectField>
                        </Field>
                        {crmDoctors[customer.crmAreaSeatId] === "failed" ? (
                          <p className="mt-1.5 text-phx-sm font-bold text-amber-800">
                            The doctor list could not load. Choose &quot;Not on the list&quot; to type the name.
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {!crmAreasAvailable || customer.notOnCrmList ? (
                      <div className="md:col-span-6">
                        <Field label="Customer Name">
                          <Input
                            className="text-phx-md"
                            onChange={(event) => updateCustomer(customer.key, { name: event.target.value })}
                            placeholder="Type the doctor's name"
                            value={customer.name}
                          />
                        </Field>
                        <p className="mt-1.5 flex items-start gap-1.5 text-phx-sm font-bold text-amber-800">
                          <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>Typed by hand. Every approver will see: {NOT_ON_CRM_LIST_FLAG}</span>
                        </p>
                      </div>
                    ) : null}
                    </>)}
                    {/* A customer whose own evidence is complete is here for its venue only. The server
                        never writes that row, so its capture, phone and speciality are not offered. */}
                    {customer.customerComplete ? null : (<>
                    <div className={customer.type === "other" ? "md:col-span-2" : "md:col-span-3"}>
                      <Field label="Speciality">
                        <SelectField
                          onChange={(value) => updateCustomer(customer.key, { speciality: value })}
                          value={customer.speciality}
                        >
                          <option value="">No speciality</option>
                          {MARKETING_CUSTOMER_SPECIALITIES.map((speciality) => (
                            <option key={speciality} value={speciality}>
                              {speciality}
                            </option>
                          ))}
                        </SelectField>
                      </Field>
                    </div>
                    {customer.type === "other" ? (
                      <div className="md:col-span-2">
                        <Field label="Other Type">
                          <Input
                            className="text-phx-md"
                            onChange={(event) => updateCustomer(customer.key, { otherType: event.target.value })}
                            placeholder="Describe customer type"
                            value={customer.otherType}
                          />
                        </Field>
                      </div>
                    ) : null}
                    <div className={customer.type === "other" ? "md:col-span-2" : "md:col-span-3"}>
                      <Field label="Phone">
                        <Input
                          className="text-phx-md"
                          onChange={(event) => updateCustomer(customer.key, { mobile: event.target.value })}
                          placeholder="Mobile number"
                          type="tel"
                          value={customer.mobile}
                        />
                      </Field>
                    </div>
                    <div className="md:col-span-3">
                      <Field label={isDeskMode ? "Area (Map)" : "Area (GPS)"}>
                        <ReadOnlyCaptureValue placeholder={isDeskMode ? "From map search" : "From GPS"} value={customer.area} />
                      </Field>
                    </div>
                    <div className="md:col-span-3">
                      <Field label={isDeskMode ? "Governorate (Map)" : "Governorate (GPS)"}>
                        <ReadOnlyCaptureValue placeholder={isDeskMode ? "From map search" : "From GPS"} value={customer.governorate} />
                      </Field>
                    </div>
                    <div className="md:col-span-6">
                      <Field label={isDeskMode ? "Address (Map)" : "Address (GPS)"}>
                        <ReadOnlyCaptureValue
                          multiline
                          placeholder={isDeskMode ? "Full address from the chosen map point" : "Full address from GPS capture"}
                          value={customer.capture.address}
                        />
                      </Field>
                    </div>
                    <div className="md:col-span-6">
                      {isDeskMode ? (
                        <PlaceSearchPanel
                          capture={customer.capture}
                          label="Customer location"
                          onResolved={(place) => applyResolvedPlace({ customerKey: customer.key }, place)}
                        />
                      ) : (
                        <CapturePanel
                          capture={customer.capture}
                          isCapturing={captureTarget === customer.key}
                          label="Customer GPS + live sign photo"
                          onCaptureLocation={() => captureLocation({ customerKey: customer.key })}
                          onOpenCamera={() => setCameraTarget({ customerKey: customer.key })}
                        />
                      )}
                    </div>
                    </>)}

                    {/* Pharmacy section divider — scoped to THIS customer.
                        `min-w-0` here is the same load-bearing fix as on the pharmacy cards below:
                        a grid item sizes to its own min-content unless told otherwise, so without it
                        one long unbreakable line would widen the whole phone track and the customer
                        card's `overflow-hidden` would clip it mid-word. The sentence WRAPS — text is
                        never cut with an ellipsis, and where that collides with the no-sideways-scroll
                        rule, wrapping wins (the old "never wrap" rule is superseded; it used to
                        scroll sideways inside its own `overflow-x-auto` box below ~400px). */}
                    <div className="min-w-0 md:col-span-6">
                      <div className="flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 break-words">
                          <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-orange-600">Venue Validation</p>
                          <p className="mt-0.5 text-phx-sm font-medium text-slate-500">
                            Capture a new venue, or attach one you already validated.
                          </p>
                        </div>
                        <Button
                          className={`h-10 shrink-0 gap-1.5 rounded-none border border-slate-200 bg-white px-3 text-phx-sm font-bold text-slate-700 hover:bg-slate-50 sm:h-8 ${adminControlDepthClassName}`}
                          onClick={() =>
                            updateCustomer(customer.key, {
                              pharmacies: [...customer.pharmacies, newPharmacyLine(defaultDistributorId)],
                            })
                          }
                          type="button"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add Venue
                        </Button>
                      </div>
                    </div>

                    {/* `min-w-0` on each pharmacy card is load-bearing on mobile. A grid item's
                        automatic minimum size is its min-content width: when the reused-pharmacy
                        detail card was one `whitespace-nowrap` line, its widest line — "Validated by
                        <full name>" — sized the whole single-column track to ~618px on a 390px phone
                        and pushed the tab row off screen. That detail now WRAPS (text is never cut
                        off, and where that collides with the no-sideways-scroll rule, wrapping wins —
                        the old "never wrap" rule is superseded), and `min-w-0` stays so that no long
                        unbreakable value can ever size the track past the screen again. */}
                    {customer.pharmacies.map((pharmacy, index) => (
                      <div className="min-w-0 md:col-span-6" key={pharmacy.key}>
                        <div className={`rounded-none border border-slate-200 bg-slate-50/50 p-3 sm:p-4 ${adminPanelDepthClassName}`}>
                          <div className="mb-3 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2.5">
                              <div className="flex h-7 w-7 items-center justify-center rounded-none bg-white text-orange-600 ring-1 ring-orange-100">
                                <Store className="h-3.5 w-3.5" />
                              </div>
                              <p className="text-phx-md font-bold text-slate-800">Venue {index + 1}</p>
                            </div>
                            <button
                              aria-label="Remove venue"
                              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-none border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 sm:h-7 sm:w-7 ${adminControlDepthClassName}`}
                              disabled={customer.pharmacies.length === 1}
                              onClick={() =>
                                updateCustomer(customer.key, {
                                  pharmacies: customer.pharmacies.length === 1
                                    ? customer.pharmacies
                                    : customer.pharmacies.filter((item) => item.key !== pharmacy.key),
                                })
                              }
                              type="button"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>

                          {/* Two ways to give this customer a pharmacy. "Validate New Pharmacy" is
                              the original capture flow, unchanged. "My Pharmacies" attaches a shop
                              already validated — by this rep or by a colleague in his area — so one
                              physical pharmacy stays one record however many customers it serves. */}
                          <div className="mb-3 grid grid-cols-2 gap-2">
                            <PharmacySourceTab
                              active={pharmacy.source === "new"}
                              onClick={() => updatePharmacy(customer.key, pharmacy.key, { source: "new" })}
                            >
                              Validate New Venue
                            </PharmacySourceTab>
                            <PharmacySourceTab
                              active={pharmacy.source === "existing"}
                              disabled={workspace.reusablePharmacies.length === 0}
                              onClick={() => updatePharmacy(customer.key, pharmacy.key, { source: "existing" })}
                            >
                              My Venues ({workspace.reusablePharmacies.length})
                            </PharmacySourceTab>
                          </div>

                          {pharmacy.source === "existing" ? (
                          <div className="space-y-3">
                            <ReusablePharmacyPicker
                              onSelect={(pharmacyId) =>
                                updatePharmacy(customer.key, pharmacy.key, { existingPharmacyId: pharmacyId })
                              }
                              options={workspace.reusablePharmacies}
                              selectedId={pharmacy.existingPharmacyId}
                            />
                            {/* Offered, never demanded. The shop can be attached exactly as before
                                with this left untouched — the system flags what is missing, it does
                                not refuse (owner's standing rule). Taking it is what finally lets a
                                venue that has been short of proof since the day it was recorded
                                become complete, and with it every customer waiting on it. */}
                            {reusableNeedingEvidence(
                              workspace.reusablePharmacies,
                              pharmacy.existingPharmacyId,
                              isDeskMode,
                            ) ? (
                              <div className="space-y-2 rounded-none border border-amber-200 bg-amber-50/60 p-3">
                                <p className="text-phx-xs font-bold text-amber-800">
                                  This shop has no complete field proof on file. If you are standing in front of it,
                                  capture its GPS and live sign photo now and the record is completed for everyone.
                                  {customer.customerComplete
                                    ? " Required here — this customer is only waiting on this shop."
                                    : " Optional — you can attach it without this."}
                                </p>
                                <CapturePanel
                                  capture={pharmacy.capture}
                                  isCapturing={captureTarget === `${customer.key}::${pharmacy.key}`}
                                  label="Pharmacy GPS + live sign photo"
                                  onCaptureLocation={() =>
                                    captureLocation({ customerKey: customer.key, pharmacyKey: pharmacy.key })
                                  }
                                  onOpenCamera={() =>
                                    setCameraTarget({ customerKey: customer.key, pharmacyKey: pharmacy.key })
                                  }
                                />
                              </div>
                            ) : null}
                            {/* Also offered on the reuse path. A codeless shop already on record
                                is exactly the venue with no identity proof at all, and until this
                                existed nobody could supply one after the day it was created. The
                                code count and venue type come from the STORED record, not from
                                anything typed here — the reuse path never re-describes a shop. */}
                            {(() => {
                              const stored = workspace.reusablePharmacies.find(
                                (option) => option.id === pharmacy.existingPharmacyId,
                              );
                              if (!stored) return null;
                              return (
                                <PharmacyLicensePanel
                                  distributorCodeCount={stored.vendorCodes.length}
                                  license={pharmacy.license}
                                  onChange={(license) =>
                                    updatePharmacy(customer.key, pharmacy.key, { license })
                                  }
                                  venueType={stored.venueType}
                                />
                              );
                            })()}
                          </div>
                          ) : (
                          <div className="grid gap-3 md:grid-cols-6">
                            <div className="md:col-span-2">
                              <Field label="Pharmacy Name">
                                <Input
                                  className="text-phx-md"
                                  onChange={(event) => updatePharmacy(customer.key, pharmacy.key, { name: event.target.value })}
                                  placeholder="Name"
                                  value={pharmacy.name}
                                />
                              </Field>
                            </div>
                            <div className="md:col-span-2">
                              <Field label={isDeskMode ? "Area (Map)" : "Area (GPS)"}>
                                <ReadOnlyCaptureValue placeholder={isDeskMode ? "From map search" : "From GPS"} value={pharmacy.area} />
                              </Field>
                            </div>
                            <div className="md:col-span-2">
                              <Field label={isDeskMode ? "Governorate (Map)" : "Governorate (GPS)"}>
                                <ReadOnlyCaptureValue placeholder={isDeskMode ? "From map search" : "From GPS"} value={pharmacy.governorate} />
                              </Field>
                            </div>
                            <div className="md:col-span-6">
                              <Field label={isDeskMode ? "Address (Map)" : "Address (GPS)"}>
                                <ReadOnlyCaptureValue
                                  multiline
                                  placeholder={isDeskMode ? "Full address from the chosen map point" : "Full address from GPS"}
                                  value={pharmacy.capture.address}
                                />
                              </Field>
                            </div>
                            <div className="md:col-span-6">
                              {isDeskMode ? (
                                <PlaceSearchPanel
                                  capture={pharmacy.capture}
                                  label={`Pharmacy ${index + 1} location`}
                                  onResolved={(place) =>
                                    applyResolvedPlace({ customerKey: customer.key, pharmacyKey: pharmacy.key }, place)
                                  }
                                />
                              ) : (
                                <CapturePanel
                                  capture={pharmacy.capture}
                                  isCapturing={captureTarget === `${customer.key}::${pharmacy.key}`}
                                  label="Pharmacy GPS + live sign photo"
                                  onCaptureLocation={() =>
                                    captureLocation({ customerKey: customer.key, pharmacyKey: pharmacy.key })
                                  }
                                  onOpenCamera={() =>
                                    setCameraTarget({ customerKey: customer.key, pharmacyKey: pharmacy.key })
                                  }
                                />
                              )}
                            </div>
                            <div className="md:col-span-6">
                              <div className="space-y-2.5">
                                {/* Same box and same padding in both states — only the border and
                                    fill change, so answering the question does not shift the row
                                    under the rep's thumb. */}
                                <div
                                  className={
                                    venueTypeIsAnswered(pharmacy.venueType)
                                      ? "rounded-none border border-transparent p-2"
                                      : "rounded-none border border-orange-300 bg-orange-50/60 p-2"
                                  }
                                >
                                  <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
                                    What is this? *
                                  </p>
                                  <div className="mt-1.5 flex items-center gap-2">
                                    {/* A venue with no distributor account (a nursery) cannot be validated in
                                        Marketing (owner, 2026-10-21), so its answer is shown but disabled — the
                                        sentence below says where it goes instead. */}
                                    {VENUE_TYPES.map((venueType) => (
                                      <Button
                                        aria-pressed={pharmacy.venueType === venueType}
                                        className={
                                          pharmacy.venueType === venueType
                                            ? `${CAPTURE_BUTTON_SIZE} rounded-none border border-orange-300 bg-orange-50 px-2.5 text-phx-xs font-bold text-orange-700`
                                            : `${CAPTURE_BUTTON_SIZE} rounded-none border border-slate-200 bg-white px-2.5 text-phx-xs font-bold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none ${adminControlDepthClassName}`
                                        }
                                        disabled={!venueRequiresDistributorCode(venueType)}
                                        key={venueType}
                                        onClick={() => updatePharmacy(customer.key, pharmacy.key, { venueType })}
                                        type="button"
                                      >
                                        {venueTypeLabel(venueType)}
                                      </Button>
                                    ))}
                                  </div>
                                  {/* Unanswered says so; a nursery (only reachable from an old draft) is refused
                                      in the shared sentence; a pharmacy is told only where codeless venues go. */}
                                  {!venueTypeIsAnswered(pharmacy.venueType) ? (
                                    <p className="mt-1.5 text-phx-xs font-bold text-orange-700">
                                      {VENUE_TYPE_UNANSWERED_MESSAGE}
                                    </p>
                                  ) : venueRequiresDistributorCode(pharmacy.venueType) ? null : (
                                    <p className="mt-1.5 text-phx-xs font-bold text-orange-700">
                                      A {venueTypeLabel(pharmacy.venueType).toLowerCase()} has no distributor code, so it
                                      cannot be validated here.
                                    </p>
                                  )}
                                  <p className="mt-1.5 text-phx-xs text-slate-600">{CODELESS_VENUES_GO_TO_DIRECT_ORDERS}</p>
                                </div>
                                <div
                                  className={
                                    choiceRequiresDistributorCode(pharmacy.venueType)
                                      ? "flex items-center justify-between gap-3"
                                      : "hidden"
                                  }
                                >
                                  <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
                                    Vendor Codes
                                  </p>
                                  <Button
                                    className={`h-10 gap-1.5 rounded-none border border-slate-200 bg-white px-2.5 text-phx-xs font-bold text-slate-600 hover:bg-slate-50 sm:h-7 ${adminControlDepthClassName}`}
                                    onClick={() =>
                                      updatePharmacy(customer.key, pharmacy.key, {
                                        vendorCodes: [...pharmacy.vendorCodes, newVendorCodeLine(defaultDistributorId)],
                                      })
                                    }
                                    type="button"
                                  >
                                    <Plus className="h-3 w-3" />
                                    Add
                                  </Button>
                                </div>
                                {!choiceRequiresDistributorCode(pharmacy.venueType) ? null : pharmacy.vendorCodes.map((line) => {
                                  const codeCheck = codeChecks[line.key];
                                  return (
                                  <div key={line.key}>
                                    {/* Phone: distributor + remove on one row, the code on its own full-width
                                        row below (the old three-across row left ~54px of the distributor's
                                        name visible at 360px). From `sm` up: distributor · code · remove. */}
                                    <div className="grid grid-cols-[minmax(0,1fr)_40px] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_40px]">
                                      <SelectField
                                        disabled={workspace.distributors.length === 0}
                                        onChange={(value) => {
                                          updateVendorCode(customer.key, pharmacy.key, line.key, { distributorId: value });
                                          checkVendorCode(line.key, value, line.distributorCode);
                                        }}
                                        value={line.distributorId}
                                      >
                                        <option value="">Vendor</option>
                                        {workspace.distributors.map((distributor: MarketingDistributor) => (
                                          <option key={distributor.id} value={distributor.id}>
                                            {distributor.displayName}
                                          </option>
                                        ))}
                                      </SelectField>
                                      <Input
                                        className="order-last col-span-2 text-phx-md sm:order-none sm:col-span-1"
                                        onChange={(event) => {
                                          const nextCode = event.target.value;
                                          updateVendorCode(customer.key, pharmacy.key, line.key, { distributorCode: nextCode });
                                          checkVendorCode(line.key, line.distributorId, nextCode, {
                                            area: pharmacy.area,
                                            governorate: pharmacy.governorate,
                                          });
                                        }}
                                        placeholder="Code"
                                        value={line.distributorCode}
                                      />
                                      <button
                                        aria-label="Remove vendor"
                                        className={`flex h-10 w-full items-center justify-center rounded-none border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 ${adminControlDepthClassName}`}
                                        disabled={pharmacy.vendorCodes.length === 1}
                                        onClick={() =>
                                          updatePharmacy(customer.key, pharmacy.key, {
                                            vendorCodes: pharmacy.vendorCodes.length === 1
                                              ? pharmacy.vendorCodes
                                              : pharmacy.vendorCodes.filter((item) => item.key !== line.key),
                                          })
                                        }
                                        type="button"
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </button>
                                    </div>
                                    {/* THE CODE SUGGESTIONS — ranked by where he just stood, and
                                        NEVER narrowed by it (owner ruling, 2026-09-29). Every
                                        candidate the code he typed matches is here; the place only
                                        decides which comes first, because half the reference import
                                        carries no area and a filter would hide those shops for good.

                                        Tapping one fills the code. He can still type anything — this
                                        is a shortcut, not a gate, and nothing here tells him he is
                                        being checked: each row describes the CODE's registered
                                        place, never his. */}
                                    {(codeSuggestions[line.key] ?? []).length > 0 ? (
                                      <div className={`mt-1.5 max-h-48 overflow-y-auto rounded-none border border-slate-200 bg-white ${adminRecessedDepthClassName}`}>
                                        {(codeSuggestions[line.key] ?? []).map((suggestion) => (
                                          <button
                                            className="flex w-full items-start justify-between gap-2 border-b border-slate-100 px-2.5 py-2 text-left last:border-b-0 hover:bg-orange-50"
                                            key={suggestion.code}
                                            onClick={() => {
                                              updateVendorCode(customer.key, pharmacy.key, line.key, {
                                                distributorCode: suggestion.code,
                                              });
                                              checkVendorCode(line.key, line.distributorId, suggestion.code, {
                                                area: pharmacy.area,
                                                governorate: pharmacy.governorate,
                                              });
                                            }}
                                            type="button"
                                          >
                                            <span className="min-w-0">
                                              <span className="block text-phx-sm font-bold text-slate-900">
                                                {suggestion.code}
                                                {suggestion.name ? ` · ${suggestion.name}` : ""}
                                              </span>
                                              {suggestion.address ? (
                                                <span className="block text-phx-xs font-medium text-slate-500" dir="auto">
                                                  {suggestion.address}
                                                </span>
                                              ) : null}
                                            </span>
                                            <span
                                              className={`shrink-0 text-phx-2xs font-black uppercase tracking-[0.1em] ${
                                                suggestion.proximity === "same_area"
                                                  ? "text-emerald-700"
                                                  : suggestion.proximity === "same_governorate"
                                                    ? "text-slate-600"
                                                    : "text-slate-400"
                                              }`}
                                            >
                                              {proximityLabel(suggestion.proximity)}
                                            </span>
                                          </button>
                                        ))}
                                      </div>
                                    ) : null}
                                    {codeCheck ? (
                                      <p
                                        className={`mt-1.5 flex items-center gap-1.5 text-phx-xs font-bold ${
                                          codeCheck === "tracked"
                                            ? "text-emerald-700"
                                            : codeCheck === "untracked"
                                              ? "text-amber-700"
                                              : "text-slate-500"
                                        }`}
                                      >
                                        {codeCheck === "checking" ? (
                                          <>
                                            <LoadingSpinner />
                                            Checking Phoenix database…
                                          </>
                                        ) : null}
                                        {codeCheck === "tracked" ? (
                                          <>
                                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                            In Phoenix sales database — sales can be tracked.
                                          </>
                                        ) : null}
                                        {codeCheck === "untracked" ? (
                                          <>
                                            <ShieldX className="h-3.5 w-3.5 shrink-0" />
                                            Not in our database yet — sales won’t be auto-tracked.
                                          </>
                                        ) : null}
                                        {codeCheck === "unknown" ? (
                                          <>Could not check the database right now.</>
                                        ) : null}
                                      </p>
                                    ) : null}
                                  </div>
                                  );
                                })}
                                {/* The licence sits directly under the codes it stands in for.
                                    `vendorCodes` here are the rows ON SCREEN, so a rep who has not
                                    typed a code yet sees the prompt — which is the moment it is
                                    useful, not after the form is complete. */}
                                <PharmacyLicensePanel
                                  distributorCodeCount={
                                    pharmacy.vendorCodes.filter((line) => line.distributorCode.trim()).length
                                  }
                                  license={pharmacy.license}
                                  onChange={(license) =>
                                    updatePharmacy(customer.key, pharmacy.key, { license })
                                  }
                                  venueType={pharmacy.venueType}
                                />
                              </div>
                            </div>
                          </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <Button
                className="h-10 w-full gap-2 rounded-none border border-dashed border-orange-300 bg-orange-50/40 text-phx-md font-bold text-orange-700 hover:bg-orange-50"
                onClick={() => setCustomers((current) => [...current, newCustomerLine(defaultDistributorId, defaultCrmAreaSeatId)])}
                type="button"
              >
                <Plus className="h-4 w-4" />
                Add Another Customer
              </Button>

              {duplicateCustomerName ? (
                <div className="rounded-none border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-phx-sm font-semibold text-amber-800">
                  “{duplicateCustomerName}” is entered twice. Each customer must appear once per submission.
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-3 border-t border-slate-100 bg-slate-50/50 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="flex min-w-0 items-center gap-2 text-phx-md font-bold text-slate-700">
                <ShieldCheck className="h-4 w-4 shrink-0 text-orange-500" />
                {/* Wraps: one nowrap line (~290px) was cut off by the form card's edge at 360px. */}
                <span className="min-w-0 break-words">
                  {customers.length} customer{customers.length === 1 ? "" : "s"} · {totalPharmacyCount} venue{totalPharmacyCount === 1 ? "" : "s"} ready
                </span>
              </div>
              <div className="flex flex-col gap-1.5 sm:items-end">
                {!duplicateCustomerName && missingRequirement ? (
                  <p className="text-phx-sm font-semibold text-amber-700">{missingRequirement}</p>
                ) : null}
                <Button
                  className="h-10 w-full gap-2 rounded-none bg-orange-500 px-5 text-phx-md font-bold text-white shadow-sm hover:bg-orange-600 sm:w-auto"
                  disabled={!canSave}
                  type="submit"
                >
                  {isSaving ? <LoadingSpinner className="text-white" /> : <Save className="h-3.5 w-3.5" />}
                  Save Validation
                </Button>
              </div>
            </div>
          </form>
        </Card>
      ) : effectiveTab === "pending" ? (
        /* --------- Not Usable Yet Tab --------- */
        <Card className="rounded-none border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-amber-600">Not Usable Yet</p>
              <h2 className="mt-1 text-lg font-black tracking-tight text-slate-900">Captured but not in your request list</h2>
            </div>
            <span className="inline-flex items-center rounded-none border border-amber-200 bg-amber-50 px-2.5 py-1 text-phx-xs font-bold text-amber-700">
              {pendingGroups.length} customers
            </span>
          </div>

          <div className="mt-3 flex items-start gap-2 rounded-none border border-amber-200 bg-amber-50 px-3.5 py-2.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <p className="text-phx-sm font-semibold leading-relaxed text-amber-800">
              {/* The old wording said “add the missing photo and location” unconditionally. For a
                  governorate hold that is the WRONG advice and the wrong reason: the photo and the
                  pin are already there, retaking them lands on the identical hold, and the question
                  is about the CODE. Same split the save-path message already makes. */}
              {hasGovernorateHold(pendingGroups.flatMap((group) => group.rows))
                ? "Saved, but not yet usable in marketing requests. Check the distributor code is the right one for that shop, then ask a Super Admin or the CEO to release it."
                : "Saved, but not yet usable in marketing requests. Tap Capture Evidence to add the missing photo and location, or ask a Super Admin to release it."}
            </p>
          </div>

          {isLoading ? (
            <TableSkeleton />
          ) : (
            <>
              {/* Phone card view — below `md` (768px) */}
              <div className="mt-4 block md:hidden">
                <div className="space-y-2">
                  {pendingGroups.map((group) => {
                    const customer = group.rows[0]?.customer;
                    const pharmaciesForCustomer = buildValidatedPharmacyDetails(group.rows);
                    return (
                      <div className="rounded-none border border-amber-200 bg-white p-3" key={group.key}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="break-words text-phx-md font-bold text-slate-900">{group.customerName}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              <span className="text-phx-xs font-medium capitalize text-slate-500">{group.customerType}</span>
                              <StatusBadge status={group.status} />
                            </div>
                          </div>
                          <button
                            aria-label={`${pharmaciesForCustomer.length} venues linked to ${group.customerName}`}
                            className="flex h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-none border border-orange-200 bg-orange-50 px-2 text-phx-xs font-bold text-orange-700"
                            onClick={() => setSelectedValidatedCustomerKey(group.key)}
                            type="button"
                          >
                            <Store className="h-3 w-3" />
                            {pharmaciesForCustomer.length}
                          </button>
                        </div>
                        <div className="mt-2 space-y-1 text-phx-sm">
                          <div className="flex justify-between gap-2">
                            <span className="shrink-0 font-medium text-slate-500">Blocked by</span>
                            <span className="min-w-0 break-words text-right font-semibold text-amber-700">{pendingBlockLabel(group.rows)}</span>
                          </div>
                          <div className="flex justify-between gap-2">
                            <span className="shrink-0 font-medium text-slate-500">Area</span>
                            <span className="min-w-0 break-words text-right font-semibold text-slate-700">{customer?.extractedAreaName || customer?.regionName || "Not captured"}</span>
                          </div>
                        </div>
                        {pendingHasCapturableGap(group.rows) ? (
                          <button
                            className="mt-2.5 flex h-10 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-none border border-orange-300 bg-orange-600 px-2 text-phx-sm font-bold text-white transition hover:bg-orange-700"
                            onClick={() => startCompletingCustomer(group)}
                            type="button"
                          >
                            <Camera className="h-3.5 w-3.5" />
                            Capture Evidence
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Desktop and tablet table view — `md` (768px) and up */}
              <div className="mt-4 hidden md:block">
                <div className="overflow-hidden rounded-none border border-slate-200">
                  <table className="w-full border-collapse text-left">
                    <thead className="bg-slate-50 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                      <tr>
                        <th className="border-r border-slate-100 px-3 py-2.5">Customer</th>
                        <th className="border-r border-slate-100 px-3 py-2.5">Blocked By</th>
                        <th className="border-r border-slate-100 px-3 py-2.5">Area</th>
                        <th className="border-r border-slate-100 px-3 py-2.5 text-center">Venues</th>
                        <th className="px-3 py-2.5 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white text-phx-md">
                      {pendingGroups.map((group) => {
                        const customer = group.rows[0]?.customer;
                        const pharmaciesForCustomer = buildValidatedPharmacyDetails(group.rows);
                        return (
                          <tr className="border-t border-slate-100" key={group.key}>
                            <td className="border-r border-slate-100 px-3 py-2.5">
                              <div className="min-w-0">
                                <p className="font-bold text-slate-900">{group.customerName}</p>
                                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                  <span className="text-phx-xs font-medium capitalize text-slate-500">{group.customerType}</span>
                                  <StatusBadge status={group.status} />
                                </div>
                              </div>
                            </td>
                            <td className="border-r border-slate-100 px-3 py-2.5 font-semibold text-amber-700">
                              {pendingBlockLabel(group.rows)}
                            </td>
                            <td className="border-r border-slate-100 px-3 py-2.5 font-medium text-slate-700">
                              {customer?.extractedAreaName || customer?.regionName || "Not captured"}
                            </td>
                            <td className="border-r border-slate-100 px-3 py-2.5 text-center">
                              <button
                                className="inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-none border border-orange-200 bg-orange-50 px-2 text-phx-sm font-bold text-orange-700 transition hover:bg-orange-100"
                                onClick={() => setSelectedValidatedCustomerKey(group.key)}
                                type="button"
                              >
                                {pharmaciesForCustomer.length}
                              </button>
                            </td>
                            {/* Offered when EITHER half is short: the customer's own photo and location,
                                or its venue's. Only when neither is — a Super Admin / CEO release —
                                is there nothing a rep can capture. */}
                            <td className="px-3 py-2.5 text-center">
                              {pendingHasCapturableGap(group.rows) ? (
                                <button
                                  className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-none border border-orange-300 bg-orange-600 px-2.5 text-phx-sm font-bold text-white transition hover:bg-orange-700"
                                  onClick={() => startCompletingCustomer(group)}
                                  type="button"
                                >
                                  <Camera className="h-3.5 w-3.5" />
                                  Capture Evidence
                                </button>
                              ) : (
                                <span className="whitespace-nowrap text-phx-sm font-medium text-slate-400">Awaiting release</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </Card>
      ) : (
        /* --------- Validated Customers Tab --------- */
        <Card className="rounded-none border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-orange-600">Validated Customers</p>
              <h2 className="mt-1 text-lg font-black tracking-tight text-slate-900">Ready customer list</h2>
            </div>
            <span className="inline-flex items-center rounded-none border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-phx-xs font-bold text-emerald-700">
              {validatedGroups.length} customers
            </span>
          </div>

          {isLoading ? (
            <TableSkeleton />
          ) : (
            <>
              {/* Phone card view — below `md` (768px) */}
              <div className="mt-4 block md:hidden">
                {validatedGroups.length === 0 ? (
                  <p className="py-6 text-center text-phx-md font-medium text-slate-500">No validated customers yet.</p>
                ) : (
                  <div className="space-y-2">
                    {validatedGroups.map((group) => {
                      const customer = group.rows[0]?.customer;
                      const pharmaciesForCustomer = buildValidatedPharmacyDetails(group.rows);
                      return (
                        <div className={`rounded-none border border-slate-200 bg-white p-3 ${adminSoftDepthClassName}`} key={group.key}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="break-words text-phx-md font-bold text-slate-900">{group.customerName}</p>
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <span className="text-phx-xs font-medium capitalize text-slate-500">{group.customerType}</span>
                                <StatusBadge status={group.status} />
                                {group.fieldEvidenceGap ? <NotFieldValidatedBadge reason={group.fieldEvidenceGap} /> : null}
                                {group.isAdminValidated ? <AdminValidatedBadge /> : null}
                                {untrackedVendorCodes(group.rows).length > 0 ? <UntrackedCodeBadge /> : null}
                              </div>
                            </div>
                            <button
                              aria-label={`${pharmaciesForCustomer.length} venues linked to ${group.customerName}`}
                            className="flex h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-none border border-orange-200 bg-orange-50 px-2 text-phx-xs font-bold text-orange-700"
                              onClick={() => setSelectedValidatedCustomerKey(group.key)}
                              type="button"
                            >
                              <Store className="h-3 w-3" />
                              {pharmaciesForCustomer.length}
                            </button>
                          </div>
                          <div className="mt-2 space-y-1 text-phx-sm">
                            <div className="flex justify-between gap-2">
                              <span className="shrink-0 font-medium text-slate-500">Area</span>
                              <span className="min-w-0 break-words text-right font-semibold text-slate-700">{customer?.extractedAreaName || customer?.regionName || "Not captured"}</span>
                            </div>
                            <div className="flex justify-between gap-2">
                              <span className="shrink-0 font-medium text-slate-500">Governorate</span>
                              <span className="min-w-0 break-words text-right font-semibold text-slate-700">{customer?.extractedGovernorateName || "Not captured"}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Desktop and tablet table view — `md` (768px) and up */}
              <div className="mt-4 hidden md:block">
                <div className="overflow-hidden rounded-none border border-slate-200">
                  <table className="w-full border-collapse text-left">
                    <thead className="bg-slate-50 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                      <tr>
                        <th className="border-r border-slate-100 px-3 py-2.5">Customer</th>
                        <th className="border-r border-slate-100 px-3 py-2.5">Area</th>
                        <th className="border-r border-slate-100 px-3 py-2.5">Governorate</th>
                        <th className="px-3 py-2.5 text-center">Venues</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white text-phx-md">
                      {validatedGroups.map((group) => {
                        const customer = group.rows[0]?.customer;
                        const pharmaciesForCustomer = buildValidatedPharmacyDetails(group.rows);
                        return (
                          <tr className="border-t border-slate-100" key={group.key}>
                            <td className="border-r border-slate-100 px-3 py-2.5">
                              <div className="min-w-0">
                                <p className="font-bold text-slate-900">{group.customerName}</p>
                                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                  <span className="text-phx-xs font-medium capitalize text-slate-500">{group.customerType}</span>
                                  <StatusBadge status={group.status} />
                                  {group.fieldEvidenceGap ? <NotFieldValidatedBadge reason={group.fieldEvidenceGap} /> : null}
                                  {group.isAdminValidated ? <AdminValidatedBadge /> : null}
                                  {untrackedVendorCodes(group.rows).length > 0 ? <UntrackedCodeBadge /> : null}
                                </div>
                              </div>
                            </td>
                            <td className="border-r border-slate-100 px-3 py-2.5 font-medium text-slate-700">
                              {customer?.extractedAreaName || customer?.regionName || "Not captured"}
                            </td>
                            <td className="border-r border-slate-100 px-3 py-2.5 font-medium text-slate-700">
                              {customer?.extractedGovernorateName || "Not captured"}
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <button
                                className="inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-none border border-orange-200 bg-orange-50 px-2 text-phx-sm font-bold text-orange-700 transition hover:bg-orange-100"
                                onClick={() => setSelectedValidatedCustomerKey(group.key)}
                                type="button"
                              >
                                {pharmaciesForCustomer.length}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      {validatedGroups.length === 0 ? (
                        <tr>
                          <td className="px-4 py-6 text-center text-phx-md font-medium text-slate-500" colSpan={4}>
                            No validated customers yet.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </Card>
      )}

      {/* --------- Modals --------- */}
      {selectedValidatedGroup ? (
        <ValidatedPharmaciesModal
          group={selectedValidatedGroup}
          onClose={() => setSelectedValidatedCustomerKey(null)}
          pharmacies={selectedValidatedPharmacies}
        />
      ) : null}

      {cameraTarget && activeCameraCapture ? (
        <LiveCameraModal
          capture={activeCameraCapture}
          onCapture={applyLivePhoto}
          onClose={() => setCameraTarget(null)}
          targetLabel={activeCameraLabel}
        />
      ) : null}
    </div>
    </WorkspaceErrorBoundary>
  );
}
