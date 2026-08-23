"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  History,
  MapPin,
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
  readEvidenceLocationStamp,
  resolveEvidenceLocationStamp,
} from "@/components/outstation/evidence-watermark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import {
  MARKETING_CUSTOMER_SPECIALITIES,
  MARKETING_GOVERNORATE_HOLD_PREFIX,
} from "@/lib/marketing-requests/types";
import type {
  MarketingCustomerType,
  MarketingDistributor,
  MarketingOnBehalfEmployee,
  MarketingReusablePharmacy,
  MarketingValidationReportRow,
  MarketingValidationStatus,
  MarketingValidationWorkspace as MarketingValidationWorkspacePayload,
} from "@/lib/marketing-requests/types";
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
  VENUE_TYPES,
  venueRequiresDistributorCode,
  venueTypeLabel,
  type VenueType,
} from "@/lib/venues/venue-type";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";


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
  payload: unknown;
  timestamp: number;
};

function useOfflineQueue(onReplay: (payload: unknown) => Promise<void>) {
  const [queue, setQueue] = useState<QueuedSubmission[]>([]);
  // Always start `true` to match SSR output --- sync real value in useEffect
  const [isOnline, setIsOnline] = useState(true);
  /** Offline submissions found on disk that were too old to send. Surfaced, never dropped quietly. */
  const [expiredCount, setExpiredCount] = useState(0);
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
        const usable = entries.filter((entry) => Number(entry.timestamp) >= cutoff);
        if (usable.length > 0) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setQueue(usable);
        }
        if (usable.length < entries.length) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setExpiredCount(entries.length - usable.length);
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

  // Replay queue when back online
  useEffect(() => {
    if (!isOnline || queue.length === 0 || replayingRef.current) return;
    replayingRef.current = true;

    (async () => {
      const pending = [...queue];
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
  }, [isOnline, queue, onReplay]);

  function enqueue(payload: unknown) {
    const submission: QueuedSubmission = {
      id: `q-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      payload,
      timestamp: Date.now(),
    };
    setQueue((current) => [...current, submission]);
  }

  return {
    dismissExpired: () => setExpiredCount(0),
    enqueue,
    expiredCount,
    isOnline,
    queueLength: queue.length,
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
  photoCapturedAt: string | null;
  photoDataUrl: string | null;
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
   * What kind of venue this is. A nursery has no distributor account, so it carries no vendor codes
   * at all — which is why the codes block below disappears when this is set. Before this existed
   * the form demanded a code from every venue, and reps supplied invented ones (`0000`,
   * `0001000000`, `0001511111` are all in production) because there was no other way to save.
   */
  venueType: VenueType;
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
   * Set only by "Capture evidence" on the Pending tab: the id of the customer already on record
   * that this capture completes. Empty on the ordinary path, which mints a new customer.
   */
  existingCustomerId: string;
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
  /** True when a Super Admin validated this at the desk rather than a rep capturing it in the field. */
  isAdminValidated: boolean;
  key: string;
  rows: MarketingValidationReportRow[];
  status: MarketingValidationStatus;
};

type ValidatedPharmacyDetail = {
  area: string;
  governorate: string;
  id: string;
  name: string;
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
    photoCapturedAt: null,
    photoDataUrl: null,
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
    venueType: "pharmacy",
  };
}

function newCustomerLine(distributorId = ""): CustomerLine {
  return {
    area: "",
    capture: emptyCapture(),
    existingCustomerId: "",
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

function emptyWorkspace(): MarketingValidationWorkspacePayload {
  return {
    canValidateOnBehalf: false,
    distributors: [],
    onBehalfEmployees: [],
    reusablePharmacies: [],
    rows: [],
    summary: {
      pending: 0,
      rejected: 0,
      sfe_validated: 0,
      system_validated: 0,
    },
    viewerHrId: "",
  };
}

function statusVariant(status: MarketingValidationStatus): "success" | "warning" | "danger" | "neutral" {
  if (status === "system_validated" || status === "sfe_validated") return "success";
  if (status === "rejected") return "danger";
  if (status === "pending") return "warning";
  return "neutral";
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
    return "The live photo and location are incomplete on both the customer and the pharmacy.";
  }
  if (customerShort) return "The customer's live photo and location are incomplete.";
  if (pharmacyShort) return "The pharmacy's live photo and location are incomplete.";
  return "Waiting for a Super Admin or the CEO to release it.";
}

/**
 * The same finding as `pendingBlockReason`, short enough to sit in a table cell on one line.
 *
 * The owner's standing rule is that nothing in the UI wraps or truncates, so the prose explanation
 * lives once in the tab's banner and each row carries only this chip.
 */
function pendingBlockLabel(rows: MarketingValidationReportRow[]): string {
  const customerShort = rows.some((row) => row.customer.evidenceStatus !== "complete");
  const pharmacyShort = rows.some((row) => row.pharmacy.evidenceStatus !== "complete");
  // 22 characters — deliberately shorter than the longest label already here ("Customer capture
  // incomplete", 26), so the chip cannot become the thing that makes a row wrap.
  if (hasGovernorateHold(rows) && !customerShort && !pharmacyShort) return "Code location mismatch";
  if (customerShort && pharmacyShort) return "Both captures incomplete";
  if (customerShort) return "Customer capture incomplete";
  if (pharmacyShort) return "Pharmacy capture incomplete";
  return "Awaiting release";
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
 * The exact reason Save is blocked, in the same order `canSave` checks them.
 *
 * The Save button is natively `disabled` while the form is incomplete, so a tap never reaches
 * `submitValidation` and its messages never show — a field rep got no feedback at all about which
 * customer, pharmacy, or code line still needed something, only a button that did nothing. This
 * walks the same checks `canSave` runs, in the same order, and names the first one that fails, so
 * the reason is visible without ever having to tap a dead button.
 */
function describeMissingRequirement(customers: CustomerLine[], isDeskMode: boolean): string | null {
  const hasPin = (capture: CaptureState) => capture.latitude !== null && capture.longitude !== null;

  for (const [customerIndex, customer] of customers.entries()) {
    const customerLabel = customer.name.trim() ? `"${customer.name.trim()}"` : `Customer ${customerIndex + 1}`;
    if (!customer.name.trim()) return `Enter a name for Customer ${customerIndex + 1}.`;
    if (isDeskMode && !hasPin(customer.capture)) return `Pin ${customerLabel}'s location on the map.`;
    if (customer.pharmacies.length === 0) return `${customerLabel} needs at least one pharmacy.`;

    for (const [pharmacyIndex, pharmacy] of customer.pharmacies.entries()) {
      const pharmacyLabel = pharmacy.name.trim() ? `"${pharmacy.name.trim()}"` : `Pharmacy ${pharmacyIndex + 1}`;
      // On the My Pharmacies tab there is exactly one thing to get right: which shop. Name, GPS,
      // live photo and distributor codes all come from the record already stored for it.
      if (pharmacy.source === "existing") {
        if (!pharmacy.existingPharmacyId) {
          return `Choose which pharmacy to attach for Pharmacy ${pharmacyIndex + 1} under ${customerLabel}.`;
        }
        continue;
      }
      if (!pharmacy.name.trim()) return `Enter a name for Pharmacy ${pharmacyIndex + 1} under ${customerLabel}.`;
      if (isDeskMode && !hasPin(pharmacy.capture)) return `Pin ${pharmacyLabel}'s location on the map.`;
      // A venue with no distributor account has nothing to check here, and the codes block is not
      // even rendered for it. Asking for a code would be asking the rep to make one up again.
      if (!venueRequiresDistributorCode(pharmacy.venueType)) continue;
      if (pharmacy.vendorCodes.length === 0) return `${pharmacyLabel} needs at least one distributor code.`;

      for (const [codeIndex, line] of pharmacy.vendorCodes.entries()) {
        const codeSuffix = pharmacy.vendorCodes.length > 1 ? ` (row ${codeIndex + 1})` : "";
        if (!line.distributorId) return `Pick a distributor for ${pharmacyLabel}${codeSuffix}.`;
        if (!line.distributorCode.trim()) return `Enter the distributor code for ${pharmacyLabel}${codeSuffix}.`;
      }
    }
  }
  return null;
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
      area: row.pharmacy.extractedAreaName ?? row.pharmacy.regionName ?? "",
      governorate: row.pharmacy.extractedGovernorateName ?? "",
      id: row.pharmacy.id,
      name: row.pharmacy.displayName,
      vendorCodes: vendorCode ? [vendorCode] : [],
    });
  }

  return Array.from(pharmacies.values());
}

/* --------------------------------------------------------------------- Sub-components --------------------------------------------------------------------- */

function Field({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
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
  const captureClassName = "w-full rounded-sm border border-slate-200 bg-slate-50 px-3.5 text-[13px] font-semibold text-slate-700 outline-none";

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
      className="h-10 cursor-default rounded-sm border-slate-200 bg-slate-50 text-[13px] font-semibold text-slate-700"
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
  return (
    <SearchableSelect
      className="h-10 w-full rounded-sm border border-slate-200 bg-white px-3 text-[13px] font-semibold text-slate-800 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {children}
    </SearchableSelect>
  );
}

function MetricCard({
  accent,
  icon: Icon,
  label,
  value,
}: {
  accent: "green" | "amber" | "blue" | "red";
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
    <div className={`rounded-sm border border-slate-200 border-l-[3px] px-3.5 py-3 ${accentStyles[accent]}`}>
      <div className="flex items-center gap-2">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${iconStyles[accent]}`} />
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">
          {label}
        </p>
      </div>
      <p className="mt-1.5 text-[22px] font-black leading-none text-slate-900">{value}</p>
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
  return (
    <button
      className={`min-h-9 overflow-hidden whitespace-nowrap rounded-sm px-3 text-[12px] font-bold transition ${
        active
          ? "bg-orange-500 text-white shadow-[0_4px_12px_rgba(249,115,22,0.25)]"
          : disabled
            ? "cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400"
            : "border border-slate-200 bg-white text-slate-600 hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
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
      <div className="rounded-sm border border-slate-200 bg-white px-3.5 py-3 text-[12px] font-semibold text-slate-500">
        No validated pharmacies yet. Validate one on the other tab and it will be here next time —
        for you and for your colleagues in the same area.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Field label="Pharmacy Already Validated">
        <SearchableSelect
          className="h-10 w-full rounded-sm border-slate-200 bg-white text-[13px]"
          onValueChange={onSelect}
          placeholder="Search by pharmacy name, code, or area"
          value={selectedId}
        >
          <option value="">Choose a pharmacy</option>
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
        <div className="space-y-2.5 rounded-sm border border-orange-200 bg-orange-50/40 px-3.5 py-3">
          <div className="overflow-x-auto">
            <p className="whitespace-nowrap text-[13px] font-black text-slate-900">
              {selected.displayName || selected.pharmacyCode}
            </p>
            <p className="mt-0.5 whitespace-nowrap text-[11px] font-semibold text-slate-600">
              {[
                selected.pharmacyCode,
                [selected.areaName, selected.governorateName].filter(Boolean).join(", "),
                selected.isOwn ? "Validated by you" : `Validated by ${selected.ownerName ?? "a colleague"}`,
                selected.linkedCustomerCount === 1
                  ? "Serving 1 customer"
                  : `Serving ${selected.linkedCustomerCount} customers`,
              ].filter(Boolean).join(" · ")}
            </p>
          </div>

          <div className="space-y-1.5">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">
              Vendor codes that will be attached
            </p>
            {/*
              An empty list is the correct, complete answer for a venue with no distributor account.
              Said in words, because a heading with nothing under it reads as a loading failure.
            */}
            {selected.vendorCodes.length === 0 ? (
              <p className="text-[12px] font-semibold text-slate-600">
                None — a {venueTypeLabel(selected.venueType).toLowerCase()} has no distributor account, so sales
                cannot be attributed to it.
              </p>
            ) : null}
            {selected.vendorCodes.map((code) => (
              <div className="overflow-x-auto" key={code.distributorCodeId}>
                <p className="whitespace-nowrap text-[12px] font-semibold text-slate-700">
                  {code.distributorName} — {code.distributorPharmacyCode}
                  {code.referenceStatus === "matched" ? null : (
                    <span className="ml-2 font-bold text-amber-700">Sales not trackable</span>
                  )}
                </p>
              </div>
            ))}
          </div>

          {selected.evidenceStatus === "complete" ? (
            <p className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              Live photo and location already on file — no need to capture it again.
            </p>
          ) : (
            <p className="flex items-start gap-1.5 text-[11px] font-bold text-amber-700">
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
      className={`min-h-9 rounded-sm px-4 text-[13px] font-bold transition ${
        active
          ? "bg-orange-500 text-white shadow-[0_4px_12px_rgba(249,115,22,0.25)]"
          : "border border-slate-200 bg-white text-slate-600 hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
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
    <span className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${styles[variant]}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

/** Marks a customer a Super Admin validated at the desk, so it is never mistaken for a field capture. */
function AdminValidatedBadge() {
  return (
    <span className="inline-flex items-center rounded-sm border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-700">
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
    <span className="inline-flex items-center rounded-sm border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">
      Sales not trackable
    </span>
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
    <div className="rounded-sm border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[13px] font-bold text-slate-800">{label}</p>
          {/* Address and territory, one per line. The coordinate pair stays on the photo and in
              the record — on screen it only ever answered a question nobody asked. */}
          {hasLocation && capture.locationLines.length > 0 ? (
            <div className="mt-0.5 space-y-0.5 text-[12px] font-medium text-slate-500">
              {capture.locationLines.slice(0, 2).map((line, index) => (
                <p key={`${index}-${line}`}>{line}</p>
              ))}
            </div>
          ) : (
            <p className="mt-0.5 text-[12px] font-medium text-slate-500">
              {hasLocation ? "Resolving the address…" : "No GPS capture yet"}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            className="h-8 gap-1.5 rounded-sm border border-orange-200 bg-white px-3 text-[12px] font-bold text-orange-700 hover:bg-orange-50"
            disabled={isCapturing}
            onClick={onCaptureLocation}
            type="button"
          >
            {isCapturing ? <LoadingSpinner /> : <MapPin className="h-3.5 w-3.5" />}
            GPS
          </Button>
          <Button
            className="h-8 gap-1.5 rounded-sm border border-slate-200 bg-white px-3 text-[12px] font-bold text-slate-700 hover:bg-slate-50"
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
        <span className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${hasLocation ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
          {hasLocation ? "Location captured" : "Location required"}
        </span>
        <span className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${hasPhoto ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
          {hasPhoto ? "Live photo captured" : "Live photo required"}
        </span>
      </div>
      {capture.photoDataUrl ? (
        <div className="mt-2.5 overflow-hidden rounded-sm border border-slate-200 bg-slate-900">
          <ZoomablePhoto
            alt={`${label} captured evidence`}
            caption={`${label} · captured evidence`}
            className="h-36 w-full object-contain"
            src={capture.photoDataUrl}
          />
          <p className="bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-500">{capture.photoCapturedAt}</p>
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
    <div className="rounded-sm border border-sky-200 bg-sky-50/60 p-3">
      <div className="flex items-center gap-2">
        <MapPin className="h-3.5 w-3.5 shrink-0 text-sky-600" />
        <p className="text-[13px] font-bold text-slate-800">{label}</p>
      </div>
      {hasLocation && capture.locationLines.length > 0 ? (
        <div className="mt-0.5 space-y-0.5 text-[12px] font-medium text-slate-500">
          {capture.locationLines.slice(0, 2).map((line, index) => (
            <p key={`${index}-${line}`}>{line}</p>
          ))}
        </div>
      ) : (
        <p className="mt-0.5 text-[12px] font-medium text-slate-500">
          {hasLocation
            ? capture.address || "Resolving the address…"
            : "Search the address or place name, then pick the nearest point."}
        </p>
      )}

      <div className="relative mt-2.5">
        <Input
          className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
          onChange={(event) => runSearch(event.target.value)}
          placeholder="Search address or place"
          value={query}
        />
        {suggestions.length > 0 ? (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-auto rounded-sm border border-slate-200 bg-white shadow-[0_16px_36px_rgba(15,23,42,0.14)]">
            {suggestions.map((suggestion) => (
              <button
                className="flex w-full flex-col items-start gap-0.5 border-b border-slate-100 px-3 py-2 text-left transition last:border-b-0 hover:bg-orange-50"
                disabled={isResolving}
                key={suggestion.placeId}
                onClick={() => void choosePlace(suggestion)}
                type="button"
              >
                <span className="text-[13px] font-bold text-slate-800">{suggestion.primaryText}</span>
                {suggestion.secondaryText ? (
                  <span className="text-[11px] font-medium text-slate-500">{suggestion.secondaryText}</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span
          className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
            hasLocation
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-amber-200 bg-amber-50 text-amber-700"
          }`}
        >
          {hasLocation ? "Location pinned from map" : "Location required"}
        </span>
        {isSearching || isResolving ? <LoadingSpinner /> : null}
        {note ? <span className="text-[11px] font-semibold text-amber-700">{note}</span> : null}
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`Pharmacies linked to ${group.customerName}`}>
      <div className="max-h-[88vh] w-full max-w-3xl overflow-hidden rounded-sm border border-slate-200 bg-white shadow-2xl" ref={focusTrapRef}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-orange-600">Linked pharmacies</p>
            <h3 className="mt-1 text-lg font-black text-slate-900">{group.customerName}</h3>
          </div>
          <Button
            className="h-8 rounded-sm border border-slate-200 bg-white px-3 text-[12px] font-bold text-slate-700 hover:bg-slate-50"
            onClick={onClose}
            type="button"
          >
            Close
          </Button>
        </div>
        <div className="max-h-[65vh] overflow-auto p-4">
          {/* Mobile card view < 480px */}
          <div className="block md:hidden">
            <div className="space-y-3">
              {pharmacies.map((pharmacy) => (
                <div className="rounded-sm border border-slate-200 bg-white p-3" key={pharmacy.id}>
                  <p className="text-[13px] font-bold text-slate-900">{pharmacy.name}</p>
                  <div className="mt-2 space-y-1 text-[12px]">
                    <div className="flex justify-between">
                      <span className="font-medium text-slate-500">Area</span>
                      <span className="font-semibold text-slate-700">{pharmacy.area || "Not captured"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-medium text-slate-500">Governorate</span>
                      <span className="font-semibold text-slate-700">{pharmacy.governorate || "Not captured"}</span>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {pharmacy.vendorCodes.map((line) => (
                      <span
                        className="rounded-sm border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-700"
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
          {/* Desktop table view */}
          <div className="hidden md:block">
            <div className="overflow-hidden rounded-sm border border-slate-200">
              <table className="w-full border-collapse text-left">
                <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="border-r border-slate-100 px-3 py-2.5">Pharmacy</th>
                    <th className="border-r border-slate-100 px-3 py-2.5">Area</th>
                    <th className="border-r border-slate-100 px-3 py-2.5">Governorate</th>
                    <th className="px-3 py-2.5">Vendor Codes</th>
                  </tr>
                </thead>
                <tbody className="bg-white text-[13px]">
                  {pharmacies.map((pharmacy) => (
                    <tr className="border-t border-slate-100" key={pharmacy.id}>
                      <td className="border-r border-slate-100 px-3 py-2.5 font-bold text-slate-900">{pharmacy.name}</td>
                      <td className="border-r border-slate-100 px-3 py-2.5 font-medium text-slate-700">{pharmacy.area || "Not captured"}</td>
                      <td className="border-r border-slate-100 px-3 py-2.5 font-medium text-slate-700">{pharmacy.governorate || "Not captured"}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1.5">
                          {pharmacy.vendorCodes.map((line) => (
                            <span
                              className="rounded-sm border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-600"
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
    </div>
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
  onCapture: (dataUrl: string, capturedAt: string) => void;
  onClose: () => void;
  targetLabel: string;
}) {
  const focusTrapRef = useFocusTrap(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [message, setMessage] = useState("Camera permission is required.");
  const [pendingPhoto, setPendingPhoto] = useState<{ capturedAt: string; dataUrl: string } | null>(null);
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
    });
    setMessage("Review the stamped photo before confirming.");
  }

  function confirmPhoto() {
    if (!pendingPhoto) return;
    onCapture(pendingPhoto.dataUrl, pendingPhoto.capturedAt);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Live timestamped photo capture">
      <div className="w-full max-w-xl overflow-hidden rounded-sm border border-slate-200 bg-white shadow-2xl" ref={focusTrapRef}>
        <div className="border-b border-slate-100 px-5 py-3">
          <p className="text-[13px] font-bold text-slate-900">Live timestamped photo</p>
          <p className="mt-0.5 text-[12px] font-medium text-slate-500">{message}</p>
          {hasLocationStamp ? (
            <p className="mt-1.5 text-[11px] font-semibold text-slate-600 whitespace-nowrap">{capture.address}</p>
          ) : null}
        </div>
        <div className="bg-slate-900">
          {pendingPhoto ? (
            <ZoomablePhoto
              alt={`${targetLabel} stamped live evidence preview`}
              caption={`${targetLabel} · stamped live evidence`}
              className="max-h-[70vh] w-full object-contain"
              src={pendingPhoto.dataUrl}
            />
          ) : (
            <video className="aspect-video w-full object-cover" muted playsInline ref={videoRef} />
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 bg-slate-50 px-4 py-3">
          <Button
            className="h-8 rounded-sm border border-slate-200 bg-white px-3 text-[12px] font-bold text-slate-700 hover:bg-slate-50"
            onClick={onClose}
            type="button"
          >
            Cancel
          </Button>
          {pendingPhoto ? (
            <>
              <Button
                className="h-8 gap-1.5 rounded-sm border border-orange-200 bg-white px-3 text-[12px] font-bold text-orange-700 hover:bg-orange-50"
                onClick={() => {
                  setPendingPhoto(null);
                  setMessage("Camera ready");
                }}
                type="button"
              >
                Re-take
              </Button>
              <Button
                className="h-8 gap-1.5 rounded-sm bg-orange-500 px-3 text-[12px] font-bold text-white hover:bg-orange-600"
                onClick={confirmPhoto}
                type="button"
              >
                Confirm Photo
              </Button>
            </>
          ) : (
            <>
              <Button
                className="h-8 gap-1.5 rounded-sm border border-orange-200 bg-white px-3 text-[12px] font-bold text-orange-700 hover:bg-orange-50"
                disabled={isStarting}
                onClick={startCamera}
                type="button"
              >
                {isStarting ? <LoadingSpinner /> : <Camera className="h-3.5 w-3.5" />}
                {cameraReady ? "Restart" : "Start Camera"}
              </Button>
              <Button
                className="h-8 gap-1.5 rounded-sm bg-orange-500 px-3 text-[12px] font-bold text-white hover:bg-orange-600"
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
  );
}

/* --------------------------------------------------------------------- Skeleton Loader --------------------------------------------------------------------- */

function MetricSkeleton() {
  return (
    <div className="animate-pulse rounded-sm border border-slate-200 border-l-[3px] border-l-slate-300 px-3.5 py-3">
      <div className="h-3 w-24 rounded-sm bg-slate-200" />
      <div className="mt-3 h-6 w-12 rounded-sm bg-slate-200" />
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {[1, 2, 3].map((i) => (
        <div className="animate-pulse rounded-sm border border-slate-100 bg-slate-50 p-3" key={i}>
          <div className="h-4 w-3/4 rounded-sm bg-slate-200" />
          <div className="mt-2 h-3 w-1/2 rounded-sm bg-slate-200" />
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
  // Super Admin only. When set, the whole form switches to desk mode: the location comes from map
  // search instead of the phone's GPS, no live photo is required, and the saved customer is owned
  // by this employee so it lands in THEIR marketing request dropdown.
  const [onBehalfHrId, setOnBehalfHrId] = useState("");
  const [codeChecks, setCodeChecks] = useState<Record<string, CodeCheckStatus>>({});
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
  const { dismissExpired, enqueue, expiredCount, isOnline, queueLength } = useOfflineQueue(replaySubmission);

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

        setCustomers(restore.customers);
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
  const validatedGroups = useMemo(() => {
    const groups = new Map<string, ValidatedCustomerGroup>();
    for (const row of workspace.rows) {
      if (row.validationStatus !== "system_validated" && row.validationStatus !== "sfe_validated") continue;
      const key = row.customer.id;
      const current = groups.get(key);
      if (current) {
        current.rows.push(row);
        if (row.validationStatus === "sfe_validated") current.status = "sfe_validated";
      } else {
        groups.set(key, {
          customerName: row.customer.displayName,
          customerType: row.customer.customerType,
          // A desk entry is the only path that stamps validated_at, so it is the honest signal for
          // "an admin typed this" — never a field capture.
          isAdminValidated: Boolean(row.customer.validatedAt),
          key,
          rows: [row],
          status: row.validationStatus,
        });
      }
    }
    return Array.from(groups.values());
  }, [workspace.rows]);
  /**
   * The customers this rep captured that are NOT in her marketing request list.
   *
   * Before 2026-08-12 these appeared nowhere at all: the page had only Validate and Validated tabs,
   * `validatedGroups` skips anything not validated, and the save message said "Validation rows
   * saved." either way — so a customer that landed pending simply vanished, with the rep having no
   * way to know it had, why, or that only a Super Admin / CEO could release it.
   */
  const pendingGroups = useMemo(() => {
    const groups = new Map<string, ValidatedCustomerGroup>();
    for (const row of workspace.rows) {
      if (row.validationStatus !== "pending") continue;
      const key = row.customer.id;
      const current = groups.get(key);
      if (current) {
        current.rows.push(row);
        continue;
      }
      groups.set(key, {
        customerName: row.customer.displayName,
        customerType: row.customer.customerType,
        isAdminValidated: Boolean(row.customer.validatedAt),
        key,
        rows: [row],
        status: row.validationStatus,
      });
    }
    return Array.from(groups.values());
  }, [workspace.rows]);
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

  // Desk mode saves straight to validated, so a missing pin would mint a "validated" customer with
  // no coordinates at all — worse than the field path, where incomplete evidence simply parks the
  // row on pending. Require the pin here instead.
  const hasPin = (capture: CaptureState) => capture.latitude !== null && capture.longitude !== null;
  const canSave = Boolean(
    !isSaving &&
    customers.length > 0 &&
    customers.every((customer) =>
      customer.name.trim() &&
      (!isDeskMode || hasPin(customer.capture)) &&
      customer.pharmacies.length > 0 &&
      customer.pharmacies.every((pharmacy) =>
        pharmacy.source === "existing"
          // Everything else about an attached pharmacy is read from its stored record, so the pick
          // itself is the only requirement. Must stay in step with describeMissingRequirement.
          ? Boolean(pharmacy.existingPharmacyId)
          : pharmacy.name.trim() &&
            (!isDeskMode || hasPin(pharmacy.capture)) &&
            pharmacy.vendorCodes.length > 0 &&
            pharmacy.vendorCodes.every((line) => line.distributorId && line.distributorCode.trim()),
      ),
    ),
  );
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
  // Save is a native `disabled` submit button, so once the form is incomplete a tap fires no click
  // event and `submitValidation` never runs to explain why — the rep just sees a button that does
  // nothing. Compute the same reason here so it can be shown without requiring a tap at all.
  const missingRequirement = !isSaving ? describeMissingRequirement(customers, isDeskMode) : null;

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
  const checkVendorCode = useCallback((lineKey: string, distributorId: string, code: string) => {
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
      return;
    }

    setCodeChecks((current) => ({ ...current, [lineKey]: "checking" }));
    timers[lineKey] = setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({ code: trimmedCode, distributorId });
          const response = await fetch(`/api/marketing-requests/pharmacy-code-lookup?${params.toString()}`, {
            cache: "no-store",
          });
          if (!response.ok) {
            setCodeChecks((current) => ({ ...current, [lineKey]: "unknown" }));
            return;
          }
          const payload = (await response.json()) as { tracked?: boolean };
          setCodeChecks((current) => ({ ...current, [lineKey]: payload.tracked ? "tracked" : "untracked" }));
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

  function applyLivePhoto(dataUrl: string, photoCapturedAt: string) {
    if (cameraTarget) {
      patchLocation(cameraTarget, {
        photoCapturedAt,
        photoDataUrl: dataUrl,
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
      evidencePhotoCapturedAt: capture.photoCapturedAt,
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
          // An attached pharmacy sends its id and nothing else. Re-describing a shop the server
          // already has on file is how the stored name, address or photo would drift.
          pharmacy.source === "existing"
            ? { existingPharmacyId: pharmacy.existingPharmacyId }
            : {
              ...payloadCapture(pharmacy.capture),
              displayName: pharmacy.name,
              extractedAreaName: pharmacy.area,
              extractedGovernorateName: pharmacy.governorate,
              regionName: [pharmacy.area, pharmacy.governorate].filter(Boolean).join(", "),
              // Empty for a codeless venue — the server refuses a code on one, so sending the
              // half-typed rows that were on screen before the rep switched type would 400.
              vendorCodes: venueRequiresDistributorCode(pharmacy.venueType)
                ? pharmacy.vendorCodes.map((line) => ({
                  distributorId: Number(line.distributorId),
                  distributorPharmacyCode: line.distributorCode,
                }))
                : [],
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
    setCustomers([newCustomerLine(defaultDistributorId)]);
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
    setCustomers([{
      ...newCustomerLine(defaultDistributorId),
      area: customer?.extractedAreaName ?? "",
      existingCustomerId: group.key,
      governorate: customer?.extractedGovernorateName ?? "",
      name: group.customerName,
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
      setMessage(
        describeMissingRequirement(customers, isDeskMode)
          ?? (isDeskMode
            ? "Complete every customer, pharmacy, vendor, and code field, and pin a location on the map for each one, before saving."
            : "Complete every customer, pharmacy, vendor, and code field before saving."),
      );
      return;
    }

    const submissionPayload = buildSubmissionPayload();

    // Offline path --- queue and optimistically update UI
    if (!isOnline) {
      enqueue(submissionPayload);
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
      enqueue(submissionPayload);
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

  const totalValidated = workspace.summary.system_validated + workspace.summary.sfe_validated;

  return (
    <WorkspaceErrorBoundary fallbackTitle="Validation workspace error">
    <div className="space-y-4" dir="auto">
      {/* --------- Offline Indicator --------- */}
      {hasMounted && (!isOnline || queueLength > 0) && (
        <div className="flex items-center gap-2 rounded-sm border border-amber-200 bg-amber-50 px-3.5 py-2 text-[12px] font-semibold text-amber-800">
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          {!isOnline
            ? "You are offline. Submissions will be queued and synced automatically."
            : `Syncing ${queueLength} queued submission${queueLength > 1 ? "s" : ""}...`}
        </div>
      )}

      {/* --------- Recovered Draft --------- */}
      {hasMounted && draftNotice ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] font-semibold text-amber-800">
          <span className="flex min-w-0 items-start gap-2">
            <History className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {draftNotice}
          </span>
          <button
            className="shrink-0 rounded-sm border border-amber-300 bg-white px-2.5 py-1 text-[12px] font-semibold text-amber-800 hover:bg-amber-100"
            onClick={discardRecoveredDraft}
            type="button"
          >
            Discard
          </button>
        </div>
      ) : null}

      {/* --------- Offline Submissions That Aged Out --------- */}
      {hasMounted && expiredCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] font-semibold text-red-800">
          <span className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {`${expiredCount} offline submission${expiredCount > 1 ? "s were" : " was"} waiting to sync but the live photo and location on ${expiredCount > 1 ? "them are" : "it is"} now too old to count as evidence of the visit. Capture ${expiredCount > 1 ? "them" : "it"} again.`}
          </span>
          <button
            className="shrink-0 rounded-sm border border-red-300 bg-white px-2.5 py-1 text-[12px] font-semibold text-red-800 hover:bg-red-100"
            onClick={dismissExpired}
            type="button"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* --------- Summary Metrics --------- */}
      <div className="rounded-sm border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="grid flex-1 grid-cols-2 gap-2 xs:grid-cols-4">
            {isLoading ? (
              <>
                <MetricSkeleton />
                <MetricSkeleton />
                <MetricSkeleton />
                <MetricSkeleton />
              </>
            ) : (
              <>
                <MetricCard accent="green" icon={CheckCircle2} label="System Validated" value={workspace.summary.system_validated} />
                <MetricCard accent="blue" icon={UserCheck} label="SFE Validated" value={workspace.summary.sfe_validated} />
                <MetricCard accent="amber" icon={Clock} label="Pending" value={workspace.summary.pending} />
                <MetricCard accent="red" icon={ShieldX} label="Rejected" value={workspace.summary.rejected} />
              </>
            )}
          </div>
          <button
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-slate-200 bg-white text-slate-600 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600"
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
        {/* Mini summary bar */}
        {!isLoading && (totalValidated + workspace.summary.pending + workspace.summary.rejected) > 0 && (
          <div className="mt-3 flex h-2 w-full overflow-hidden rounded-sm bg-slate-100">
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
      <div className="flex gap-2 rounded-sm border border-slate-200 bg-white p-1.5">
        <TabButton active={activeTab === "validation"} onClick={() => setActiveTab("validation")}>
          Validate Customer
        </TabButton>
        <TabButton active={activeTab === "validated"} onClick={() => setActiveTab("validated")}>
          Validated ({validatedGroups.length})
        </TabButton>
        {pendingGroups.length > 0 ? (
          <TabButton active={activeTab === "pending"} onClick={() => setActiveTab("pending")}>
            Not Usable Yet ({pendingGroups.length})
          </TabButton>
        ) : null}
      </div>

      {/* --------- Alert Messages --------- */}
      {message ? (
        <div className={`rounded-sm border px-3.5 py-2.5 text-[13px] font-semibold ${messageState?.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          {message}
        </div>
      ) : null}

      {/* --------- Validation Form Tab --------- */}
      {activeTab === "validation" ? (
        <Card className="overflow-hidden rounded-sm border border-slate-200 bg-white p-0 shadow-sm">
          <form aria-busy={isSaving} onSubmit={submitValidation}>
            <div className="border-b border-slate-100 bg-gradient-to-r from-white via-orange-50/40 to-white px-4 py-4 sm:px-5">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-orange-50 text-orange-600 ring-1 ring-orange-100">
                  <ClipboardCheck className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.14em] text-orange-600">
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
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-white text-sky-600 ring-1 ring-sky-100">
                    <ShieldCheck className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-black uppercase tracking-[0.14em] text-sky-700">Super Admin</p>
                    <p className="text-[13px] font-bold text-slate-800">Validate on behalf of an employee</p>
                  </div>
                </div>
                <div className="mt-3 grid gap-3 lg:grid-cols-6">
                  <div className="lg:col-span-3">
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
                  <div className="lg:col-span-3">
                    <Field label="What this does">
                      <div className="flex h-10 items-center overflow-hidden rounded-sm border border-slate-200 bg-white px-3.5">
                        <p className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-semibold text-slate-600">
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
                    <span className="inline-flex items-center rounded-sm border border-sky-200 bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-700">
                      Desk mode — map search, no live photo
                    </span>
                    <span className="inline-flex items-center rounded-sm border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">
                      Saved as admin validated
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-4 p-4 sm:p-5">
              {customers.map((customer, customerIndex) => (
                <div
                  className="overflow-hidden rounded-sm border border-slate-200 bg-white"
                  key={customer.key}
                >
                  <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/70 px-3 py-2.5 sm:px-4">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-white text-orange-600 ring-1 ring-orange-100">
                        <UserCheck className="h-3.5 w-3.5" />
                      </div>
                      <p className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-bold text-slate-800">
                        Customer {customerIndex + 1}
                        {customer.name.trim() ? ` — ${customer.name.trim()}` : ""}
                      </p>
                    </div>
                    <button
                      aria-label="Remove customer"
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
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
                      <p className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-bold text-amber-800">
                        Completing a customer already on record — name and type are locked
                      </p>
                    </div>
                  ) : null}

                  <div className="grid gap-4 p-3 sm:p-4 lg:grid-cols-6">
                    <div className="lg:col-span-2">
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
                    <div className="lg:col-span-4">
                      <Field label="Customer Name">
                        <Input
                          className="h-10 rounded-sm border-slate-200 bg-white text-[13px] disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={Boolean(customer.existingCustomerId)}
                          onChange={(event) => updateCustomer(customer.key, { name: event.target.value })}
                          placeholder="Customer name"
                          value={customer.name}
                        />
                      </Field>
                    </div>
                    <div className={customer.type === "other" ? "lg:col-span-2" : "lg:col-span-3"}>
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
                      <div className="lg:col-span-2">
                        <Field label="Other Type">
                          <Input
                            className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
                            onChange={(event) => updateCustomer(customer.key, { otherType: event.target.value })}
                            placeholder="Describe customer type"
                            value={customer.otherType}
                          />
                        </Field>
                      </div>
                    ) : null}
                    <div className={customer.type === "other" ? "lg:col-span-2" : "lg:col-span-3"}>
                      <Field label="Phone">
                        <Input
                          className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
                          onChange={(event) => updateCustomer(customer.key, { mobile: event.target.value })}
                          placeholder="Mobile number"
                          type="tel"
                          value={customer.mobile}
                        />
                      </Field>
                    </div>
                    <div className="lg:col-span-3">
                      <Field label={isDeskMode ? "Area (Map)" : "Area (GPS)"}>
                        <ReadOnlyCaptureValue placeholder={isDeskMode ? "From map search" : "From GPS"} value={customer.area} />
                      </Field>
                    </div>
                    <div className="lg:col-span-3">
                      <Field label={isDeskMode ? "Governorate (Map)" : "Governorate (GPS)"}>
                        <ReadOnlyCaptureValue placeholder={isDeskMode ? "From map search" : "From GPS"} value={customer.governorate} />
                      </Field>
                    </div>
                    <div className="lg:col-span-6">
                      <Field label={isDeskMode ? "Address (Map)" : "Address (GPS)"}>
                        <ReadOnlyCaptureValue
                          multiline
                          placeholder={isDeskMode ? "Full address from the chosen map point" : "Full address from GPS capture"}
                          value={customer.capture.address}
                        />
                      </Field>
                    </div>
                    <div className="lg:col-span-6">
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

                    {/* Pharmacy section divider — scoped to THIS customer.
                        `min-w-0` here is the same load-bearing fix as on the pharmacy cards below:
                        without it this grid item sizes to its own min-content (the nowrap sentence,
                        ~335px) and overflows a 330px phone track, and the customer card's
                        `overflow-hidden` then clips the sentence mid-word. The sentence itself
                        scrolls inside `overflow-x-auto` rather than ellipsing — owner's rule:
                        never wrap, never truncate. */}
                    <div className="min-w-0 lg:col-span-6">
                      <div className="flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 overflow-x-auto">
                          <p className="whitespace-nowrap text-[10px] font-black uppercase tracking-[0.14em] text-orange-600">Pharmacy Validation</p>
                          <p className="mt-0.5 whitespace-nowrap text-[12px] font-medium text-slate-500">
                            Capture a new pharmacy, or attach one you already validated.
                          </p>
                        </div>
                        <Button
                          className="h-8 shrink-0 gap-1.5 rounded-sm border border-slate-200 bg-white px-3 text-[12px] font-bold text-slate-700 hover:bg-slate-50"
                          onClick={() =>
                            updateCustomer(customer.key, {
                              pharmacies: [...customer.pharmacies, newPharmacyLine(defaultDistributorId)],
                            })
                          }
                          type="button"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add Pharmacy
                        </Button>
                      </div>
                    </div>

                    {/* `min-w-0` on each pharmacy card is load-bearing on mobile. A grid item's
                        automatic minimum size is its min-content width, and the reused-pharmacy
                        detail card is deliberately `whitespace-nowrap` (owner's rule: never wrap,
                        never ellipsis). Without it the card's widest line — "Validated by <full
                        name>" — sized the whole single-column track to ~618px on a 390px phone and
                        pushed the tab row off screen. With it the track stays at the viewport width
                        and the card's own `overflow-x-auto` scrolls instead. */}
                    {customer.pharmacies.map((pharmacy, index) => (
                      <div className="min-w-0 lg:col-span-6" key={pharmacy.key}>
                        <div className="rounded-sm border border-slate-200 bg-slate-50/50 p-3 sm:p-4">
                          <div className="mb-3 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2.5">
                              <div className="flex h-7 w-7 items-center justify-center rounded-sm bg-white text-orange-600 ring-1 ring-orange-100">
                                <Store className="h-3.5 w-3.5" />
                              </div>
                              <p className="text-[13px] font-bold text-slate-800">Pharmacy {index + 1}</p>
                            </div>
                            <button
                              aria-label="Remove pharmacy"
                              className="flex h-7 w-7 items-center justify-center rounded-sm border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
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
                              Validate New Pharmacy
                            </PharmacySourceTab>
                            <PharmacySourceTab
                              active={pharmacy.source === "existing"}
                              disabled={workspace.reusablePharmacies.length === 0}
                              onClick={() => updatePharmacy(customer.key, pharmacy.key, { source: "existing" })}
                            >
                              My Pharmacies ({workspace.reusablePharmacies.length})
                            </PharmacySourceTab>
                          </div>

                          {pharmacy.source === "existing" ? (
                          <ReusablePharmacyPicker
                            onSelect={(pharmacyId) =>
                              updatePharmacy(customer.key, pharmacy.key, { existingPharmacyId: pharmacyId })
                            }
                            options={workspace.reusablePharmacies}
                            selectedId={pharmacy.existingPharmacyId}
                          />
                          ) : (
                          <div className="grid gap-3 lg:grid-cols-6">
                            <div className="lg:col-span-2">
                              <Field label="Pharmacy Name">
                                <Input
                                  className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
                                  onChange={(event) => updatePharmacy(customer.key, pharmacy.key, { name: event.target.value })}
                                  placeholder="Name"
                                  value={pharmacy.name}
                                />
                              </Field>
                            </div>
                            <div className="lg:col-span-2">
                              <Field label={isDeskMode ? "Area (Map)" : "Area (GPS)"}>
                                <ReadOnlyCaptureValue placeholder={isDeskMode ? "From map search" : "From GPS"} value={pharmacy.area} />
                              </Field>
                            </div>
                            <div className="lg:col-span-2">
                              <Field label={isDeskMode ? "Governorate (Map)" : "Governorate (GPS)"}>
                                <ReadOnlyCaptureValue placeholder={isDeskMode ? "From map search" : "From GPS"} value={pharmacy.governorate} />
                              </Field>
                            </div>
                            <div className="lg:col-span-6">
                              <Field label={isDeskMode ? "Address (Map)" : "Address (GPS)"}>
                                <ReadOnlyCaptureValue
                                  multiline
                                  placeholder={isDeskMode ? "Full address from the chosen map point" : "Full address from GPS"}
                                  value={pharmacy.capture.address}
                                />
                              </Field>
                            </div>
                            <div className="lg:col-span-6">
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
                            <div className="lg:col-span-6">
                              <div className="space-y-2.5">
                                <div className="flex items-center gap-2">
                                  {VENUE_TYPES.map((venueType) => (
                                    <Button
                                      className={
                                        pharmacy.venueType === venueType
                                          ? "h-7 rounded-sm border border-orange-300 bg-orange-50 px-2.5 text-[11px] font-bold text-orange-700"
                                          : "h-7 rounded-sm border border-slate-200 bg-white px-2.5 text-[11px] font-bold text-slate-600 hover:bg-slate-50"
                                      }
                                      key={venueType}
                                      onClick={() => updatePharmacy(customer.key, pharmacy.key, { venueType })}
                                      type="button"
                                    >
                                      {venueTypeLabel(venueType)}
                                    </Button>
                                  ))}
                                </div>
                                {venueRequiresDistributorCode(pharmacy.venueType) ? null : (
                                  <p className="text-[11px] text-slate-600">
                                    A {venueTypeLabel(pharmacy.venueType).toLowerCase()} has no distributor account, so it
                                    carries no code. Spend on it is allowed and can never be matched to a sale.
                                  </p>
                                )}
                                <div
                                  className={
                                    venueRequiresDistributorCode(pharmacy.venueType)
                                      ? "flex items-center justify-between gap-3"
                                      : "hidden"
                                  }
                                >
                                  <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">
                                    Vendor Codes
                                  </p>
                                  <Button
                                    className="h-7 gap-1.5 rounded-sm border border-slate-200 bg-white px-2.5 text-[11px] font-bold text-slate-600 hover:bg-slate-50"
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
                                {!venueRequiresDistributorCode(pharmacy.venueType) ? null : pharmacy.vendorCodes.map((line) => {
                                  const codeCheck = codeChecks[line.key];
                                  return (
                                  <div key={line.key}>
                                    <div className="grid grid-cols-[1fr_1fr_32px] gap-2">
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
                                        className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
                                        onChange={(event) => {
                                          const nextCode = event.target.value;
                                          updateVendorCode(customer.key, pharmacy.key, line.key, { distributorCode: nextCode });
                                          checkVendorCode(line.key, line.distributorId, nextCode);
                                        }}
                                        placeholder="Code"
                                        value={line.distributorCode}
                                      />
                                      <button
                                        aria-label="Remove vendor"
                                        className="flex h-10 w-full items-center justify-center rounded-sm border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
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
                                    {codeCheck ? (
                                      <p
                                        className={`mt-1.5 flex items-center gap-1.5 text-[11px] font-bold ${
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
                className="h-10 w-full gap-2 rounded-sm border border-dashed border-orange-300 bg-orange-50/40 text-[13px] font-bold text-orange-700 hover:bg-orange-50"
                onClick={() => setCustomers((current) => [...current, newCustomerLine(defaultDistributorId)])}
                type="button"
              >
                <Plus className="h-4 w-4" />
                Add Another Customer
              </Button>

              {duplicateCustomerName ? (
                <div className="rounded-sm border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12px] font-semibold text-amber-800">
                  “{duplicateCustomerName}” is entered twice. Each customer must appear once per submission.
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-3 border-t border-slate-100 bg-slate-50/50 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="flex items-center gap-2 text-[13px] font-bold text-slate-700">
                <ShieldCheck className="h-4 w-4 shrink-0 text-orange-500" />
                <span className="whitespace-nowrap">
                  {customers.length} customer{customers.length === 1 ? "" : "s"} · {totalPharmacyCount} pharmacy row{totalPharmacyCount === 1 ? "" : "s"} ready
                </span>
              </div>
              <div className="flex flex-col gap-1.5 sm:items-end">
                {!duplicateCustomerName && missingRequirement ? (
                  <p className="text-[12px] font-semibold text-amber-700">{missingRequirement}</p>
                ) : null}
                <Button
                  className="h-10 min-w-[180px] gap-2 rounded-sm bg-orange-500 px-5 text-[13px] font-bold text-white shadow-sm hover:bg-orange-600"
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
      ) : activeTab === "pending" ? (
        /* --------- Not Usable Yet Tab --------- */
        <Card className="rounded-sm border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-amber-600">Not Usable Yet</p>
              <h2 className="mt-1 text-lg font-black tracking-tight text-slate-900">Captured but not in your request list</h2>
            </div>
            <span className="inline-flex items-center rounded-sm border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-700">
              {pendingGroups.length} customers
            </span>
          </div>

          <div className="mt-3 flex items-start gap-2 rounded-sm border border-amber-200 bg-amber-50 px-3.5 py-2.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <p className="text-[12px] font-semibold leading-relaxed text-amber-800">
              These customers were saved, but they do not appear in the customer list when you create a marketing
              request. A customer only becomes usable once the live photo and location are complete on both the
              customer and the pharmacy. Capture the customer again with the missing photo, or ask a Super Admin or
              the CEO to release it from Customer Pharmacy Mapping.
            </p>
          </div>

          {isLoading ? (
            <TableSkeleton />
          ) : (
            <>
              {/* Mobile card view < 480px */}
              <div className="mt-4 block md:hidden">
                <div className="space-y-2">
                  {pendingGroups.map((group) => {
                    const customer = group.rows[0]?.customer;
                    const pharmaciesForCustomer = buildValidatedPharmacyDetails(group.rows);
                    return (
                      <div className="rounded-sm border border-amber-200 bg-white p-3" key={group.key}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-[13px] font-bold text-slate-900">{group.customerName}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              <span className="text-[11px] font-medium capitalize text-slate-500">{group.customerType}</span>
                              <StatusBadge status={group.status} />
                            </div>
                          </div>
                          <button
                            className="flex h-7 shrink-0 items-center gap-1 rounded-sm border border-orange-200 bg-orange-50 px-2 text-[11px] font-bold text-orange-700"
                            onClick={() => setSelectedValidatedCustomerKey(group.key)}
                            type="button"
                          >
                            <Store className="h-3 w-3" />
                            {pharmaciesForCustomer.length}
                          </button>
                        </div>
                        <div className="mt-2 space-y-1 text-[12px]">
                          <div className="flex justify-between gap-2">
                            <span className="font-medium text-slate-500">Blocked by</span>
                            <span className="font-semibold text-amber-700">{pendingBlockLabel(group.rows)}</span>
                          </div>
                          <div className="flex justify-between gap-2">
                            <span className="font-medium text-slate-500">Area</span>
                            <span className="font-semibold text-slate-700">{customer?.extractedAreaName || customer?.regionName || "Not captured"}</span>
                          </div>
                        </div>
                        {customer && customer.evidenceStatus !== "complete" ? (
                          <button
                            className="mt-2.5 flex h-8 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border border-orange-300 bg-orange-600 px-2 text-[12px] font-bold text-white transition hover:bg-orange-700"
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

              {/* Desktop table view >= 480px */}
              <div className="mt-4 hidden md:block">
                <div className="overflow-hidden rounded-sm border border-slate-200">
                  <table className="w-full border-collapse text-left">
                    <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
                      <tr>
                        <th className="border-r border-slate-100 px-3 py-2.5">Customer</th>
                        <th className="border-r border-slate-100 px-3 py-2.5">Blocked By</th>
                        <th className="border-r border-slate-100 px-3 py-2.5">Area</th>
                        <th className="border-r border-slate-100 px-3 py-2.5 text-center">Pharmacies</th>
                        <th className="px-3 py-2.5 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white text-[13px]">
                      {pendingGroups.map((group) => {
                        const customer = group.rows[0]?.customer;
                        const pharmaciesForCustomer = buildValidatedPharmacyDetails(group.rows);
                        return (
                          <tr className="border-t border-slate-100" key={group.key}>
                            <td className="border-r border-slate-100 px-3 py-2.5">
                              <div className="min-w-0">
                                <p className="font-bold text-slate-900">{group.customerName}</p>
                                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                  <span className="text-[11px] font-medium capitalize text-slate-500">{group.customerType}</span>
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
                                className="inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-sm border border-orange-200 bg-orange-50 px-2 text-[12px] font-bold text-orange-700 transition hover:bg-orange-100"
                                onClick={() => setSelectedValidatedCustomerKey(group.key)}
                                type="button"
                              >
                                {pharmaciesForCustomer.length}
                              </button>
                            </td>
                            {/* The customer's own evidence is the half a rep can actually fix in the
                                field. When it is already complete the block is on the pharmacy, and
                                offering "Capture Evidence" would only earn a server rejection. */}
                            <td className="px-3 py-2.5 text-center">
                              {customer && customer.evidenceStatus !== "complete" ? (
                                <button
                                  className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border border-orange-300 bg-orange-600 px-2.5 text-[12px] font-bold text-white transition hover:bg-orange-700"
                                  onClick={() => startCompletingCustomer(group)}
                                  type="button"
                                >
                                  <Camera className="h-3.5 w-3.5" />
                                  Capture Evidence
                                </button>
                              ) : (
                                <span className="whitespace-nowrap text-[12px] font-medium text-slate-400">Pharmacy side</span>
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
        <Card className="rounded-sm border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-orange-600">Validated Customers</p>
              <h2 className="mt-1 text-lg font-black tracking-tight text-slate-900">Ready customer list</h2>
            </div>
            <span className="inline-flex items-center rounded-sm border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700">
              {validatedGroups.length} customers
            </span>
          </div>

          {isLoading ? (
            <TableSkeleton />
          ) : (
            <>
              {/* Mobile card view < 480px */}
              <div className="mt-4 block md:hidden">
                {validatedGroups.length === 0 ? (
                  <p className="py-6 text-center text-[13px] font-medium text-slate-500">No validated customers yet.</p>
                ) : (
                  <div className="space-y-2">
                    {validatedGroups.map((group) => {
                      const customer = group.rows[0]?.customer;
                      const pharmaciesForCustomer = buildValidatedPharmacyDetails(group.rows);
                      return (
                        <div className="rounded-sm border border-slate-200 bg-white p-3" key={group.key}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-[13px] font-bold text-slate-900">{group.customerName}</p>
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <span className="text-[11px] font-medium capitalize text-slate-500">{group.customerType}</span>
                                <StatusBadge status={group.status} />
                                {group.isAdminValidated ? <AdminValidatedBadge /> : null}
                                {untrackedVendorCodes(group.rows).length > 0 ? <UntrackedCodeBadge /> : null}
                              </div>
                            </div>
                            <button
                              className="flex h-7 shrink-0 items-center gap-1 rounded-sm border border-orange-200 bg-orange-50 px-2 text-[11px] font-bold text-orange-700"
                              onClick={() => setSelectedValidatedCustomerKey(group.key)}
                              type="button"
                            >
                              <Store className="h-3 w-3" />
                              {pharmaciesForCustomer.length}
                            </button>
                          </div>
                          <div className="mt-2 space-y-1 text-[12px]">
                            <div className="flex justify-between">
                              <span className="font-medium text-slate-500">Area</span>
                              <span className="font-semibold text-slate-700">{customer?.extractedAreaName || customer?.regionName || "Not captured"}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="font-medium text-slate-500">Governorate</span>
                              <span className="font-semibold text-slate-700">{customer?.extractedGovernorateName || "Not captured"}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Desktop table view >= 480px */}
              <div className="mt-4 hidden md:block">
                <div className="overflow-hidden rounded-sm border border-slate-200">
                  <table className="w-full border-collapse text-left">
                    <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
                      <tr>
                        <th className="border-r border-slate-100 px-3 py-2.5">Customer</th>
                        <th className="border-r border-slate-100 px-3 py-2.5">Area</th>
                        <th className="border-r border-slate-100 px-3 py-2.5">Governorate</th>
                        <th className="px-3 py-2.5 text-center">Pharmacies</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white text-[13px]">
                      {validatedGroups.map((group) => {
                        const customer = group.rows[0]?.customer;
                        const pharmaciesForCustomer = buildValidatedPharmacyDetails(group.rows);
                        return (
                          <tr className="border-t border-slate-100" key={group.key}>
                            <td className="border-r border-slate-100 px-3 py-2.5">
                              <div className="min-w-0">
                                <p className="font-bold text-slate-900">{group.customerName}</p>
                                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                  <span className="text-[11px] font-medium capitalize text-slate-500">{group.customerType}</span>
                                  <StatusBadge status={group.status} />
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
                                className="inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-sm border border-orange-200 bg-orange-50 px-2 text-[12px] font-bold text-orange-700 transition hover:bg-orange-100"
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
                          <td className="px-4 py-6 text-center text-[13px] font-medium text-slate-500" colSpan={4}>
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
