"use client";

import {
  ArrowRight,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  MapPin,
  Upload,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";

import { ApprovalRecommendationBadge } from "@/components/outstation/approval-recommendation-badge";
import { JourneyStopRehearsal, type RehearsalTrip } from "@/components/outstation/journey-stop-rehearsal";
import { OfflineSyncBanner } from "@/components/outstation/offline-sync-banner";
import { prepareTicketAttachment } from "@/components/outstation/prepare-ticket-attachment";
import { RouteMapPreview } from "@/components/outstation/route-map-preview";
import { TicketUploadCard } from "@/components/outstation/ticket-upload-card";
import { isNonTravelExpenseType, nonTravelAmountRefusal } from "@/lib/outstation/non-travel-expense";
import { Field } from "@/components/outstation/wizard-primitives";
import { FormWizard } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import {
  isOutstationEvidenceWaivedRole,
  isOutstationTicketWaivedRole,
} from "@/lib/outstation/evidence-waiver";
import {
  isRestorableOutstationLocalDraft,
  outstationDraftStorageKeyBase,
  outstationDraftStorageKeyFor,
  parseOutstationLocalDraft,
  type OutstationLocalDraft,
} from "@/lib/outstation/local-draft";
import {
  afterSubmitGuidance,
  firstOpenSubmitExpenseStep,
  MY_CLAIMS_ANCHOR,
  submitExpenseStepInstruction,
  submitExpenseStepProblem,
  submitExpenseSteps,
  type AfterSubmitItem,
  type SubmitExpenseFacts,
} from "@/lib/outstation/submit-expense-steps";
import {
  checkSubmitBodySize,
  checkTicketAttachmentFile,
  TICKET_MAX_FILES,
} from "@/lib/outstation/ticket-attachment-limits";
import type {
  OutstationCalculationResult,
  OutstationCaptureResult,
  OutstationCarEvidenceMetadata,
  OutstationCarEvidenceSource,
  OutstationExpenseType,
  OutstationTransportationType,
} from "@/lib/outstation/types";
import { cn, formatEmployeeDisplayName } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { ManagerAreaRepOption } from "@/lib/outstation/area-rep-options";
import {
  drawEvidenceWatermark,
  getCompressedEvidenceCanvasSize,
  resolveEvidenceLocationStamp,
} from "@/components/outstation/evidence-watermark";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";


type MedicalTripOption = {
  hrId: string;
  name: string;
};

type CarEvidenceState = {
  capturedAt: string;
  capturedLatitude: number;
  capturedLocationLabel: string;
  capturedLongitude: number;
  imageDataUrl: string;
  requestDraftId: string;
  requestId: string | null;
  // Which of the two routes produced this photo. Carried through to the server verbatim —
  // never inferred there from the transport type, because that would let an upload on a
  // train trip be recorded as if it had been captured live.
  source: OutstationCarEvidenceSource;
};

type PermissionPromptKind =
  | "destination-location"
  | "car-evidence-location"
  | "camera";

type PermissionPromptState = {
  blocked?: boolean;
  kind: PermissionPromptKind;
};

/**
 * The draft lives under the signed-in person's own key (`outstationDraftStorageKeyFor`), and every
 * read and write goes through these three: a browser with site data blocked or a full quota (the
 * arrival photo is a data URL) must never take the claim screen down. A null key stores nothing.
 */
function readStoredDraft(key: string | null): OutstationLocalDraft | null {
  if (!key) return null;
  try {
    return parseOutstationLocalDraft(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeStoredDraft(key: string | null, draft: OutstationLocalDraft) {
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Not stored: the claim screen keeps working, it simply cannot recover after a reload.
  }
}

function removeStoredDraft(key: string | null) {
  if (!key) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to remove from a store that cannot be read.
  }
}

function buildDraftId() {
  return typeof crypto === "undefined" || typeof crypto.randomUUID !== "function"
    ? `car-evidence-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    : crypto.randomUUID();
}

function egp(value: number) {
  return stableCurrencyFormatter("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}


/** What a test account reads after Submit or an offline replay: the claim ran, and nothing was kept. */
const TEST_CLAIM_NOT_SAVED_TITLE = "Test claim — checked, not saved";
const TEST_CLAIM_NOT_SAVED_DETAIL =
  "Every check ran exactly as it does for the real claim. Nothing was saved: no claim, no photo, no ticket, no payroll line and no email.";

/**
 * What a test account's stop rehearsal needs from its checked, unsaved car trip: the arrival photo's
 * position and time (the phone's, exactly what a saved trip would store) and the distance from home.
 */
function rehearsalTripFrom(
  payload: Record<string, unknown> | null,
  carEvidence: { capturedAt: string; capturedLatitude: number; capturedLongitude: number } | null,
): RehearsalTrip | null {
  const tripStartDate = typeof payload?.tripStartDate === "string" ? payload.tripStartDate.slice(0, 10) : "";
  const tripEndDate = typeof payload?.tripEndDate === "string" ? payload.tripEndDate.slice(0, 10) : tripStartDate;
  if (!tripStartDate) return null;
  const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    arrival: {
      capturedAt: carEvidence?.capturedAt ?? (typeof payload?.capturedAt === "string" ? payload.capturedAt : null),
      distanceFromResidenceKm: finite(payload?.distanceFromResidenceKm),
      latitude: carEvidence?.capturedLatitude ?? finite(payload?.capturedLatitude),
      longitude: carEvidence?.capturedLongitude ?? finite(payload?.capturedLongitude),
    },
    tripEndDate: tripEndDate || tripStartDate,
    tripStartDate,
  };
}

/** What the screen after Submit names: the claim, and where the trip went. */
type SubmittedClaim = {
  arrivalPhotoOwed: boolean;
  destination: string | null;
  /**
   * A test account's claim: every check ran and NOTHING was saved (owner, 2026-10-28 — "Runs fully,
   * saves nothing"; the stop is in submitOutstationRequest). Carries the total Phoenix priced it at,
   * and for a car trip what its stop rehearsal needs (journey-stop-rehearsal.tsx, owner 2026-11-03).
   */
  dryRun: { expectedTotal: number | null; rehearsal: RehearsalTrip | null } | null;
  id: number | null;
  /** A car trip can add stops on the way (chained-journey.ts) — the screen after Submit says how. */
  isCarTrip: boolean;
  isNonTravel: boolean;
  isTicketBased: boolean;
  ticketsAttached: number;
};

function getDurationSummary(start: string, end: string) {
  if (!start || !end) {
    return "Select from date and to date";
  }

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return "Invalid date range";
  }

  const diffMs = endDate.getTime() - startDate.getTime();
  const days = Math.round(diffMs / 86_400_000);
  if (days < 0) {
    return "To date must be after from date";
  }
  if (days === 0) {
    return "Return the same day";
  }
  if (days === 1) {
    return "Overnight stay - 1 night";
  }
  return `Overnight stay - ${days} nights`;
}

function cleanLocationPart(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function withoutGovernorateSuffix(value: string | null | undefined) {
  return cleanLocationPart(value).replace(/\s+governorate$/i, "");
}

function uniqueLocationParts(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  return values
    .map(cleanLocationPart)
    .filter((value) => {
      if (!value) return false;
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function splitAddressLabel(label: string | null | undefined) {
  return cleanLocationPart(label)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function compactLocationLabel(area: string | null | undefined, city: string | null | undefined, fallback: string) {
  const parts = uniqueLocationParts([area, withoutGovernorateSuffix(city)]);
  return parts.length > 0 ? parts.join(", ") : fallback;
}

function capturedDestinationParts(captured: OutstationCaptureResult | null) {
  if (!captured) {
    return {
      area: "Not captured yet",
      fullAddress: "Destination location has not been captured yet",
      governorate: "Not captured yet",
      shortLabel: "Capture current location",
    };
  }

  const addressParts = splitAddressLabel(captured.toLabel);
  const area = cleanLocationPart(captured.toArea) || addressParts[0] || "Not detected";
  const governorate = withoutGovernorateSuffix(captured.toCity) || addressParts[1] || "Not detected";
  const fullAddress = cleanLocationPart(captured.toLabel) || compactLocationLabel(area, governorate, "Location captured");

  return {
    area,
    fullAddress,
    governorate,
    shortLabel: compactLocationLabel(area, governorate, fullAddress),
  };
}

function isDeniedPermissionError(error: unknown) {
  if (typeof error === "object" && error && "code" in error && Number(error.code) === 1) {
    return true;
  }
  return error instanceof DOMException && (
    error.name === "NotAllowedError" ||
    error.name === "PermissionDeniedError"
  );
}

function permissionDeniedMessage(kind: PermissionPromptKind) {
  if (kind === "camera") {
    return "Camera permission is blocked. Tap Open browser settings to unblock it for this website, then tap Accept & retry.";
  }

  return "Location permission is blocked. Tap Open browser settings to unblock it for this website, then tap Accept & retry.";
}

function getCurrentSiteUrl() {
  return typeof window === "undefined" ? "" : window.location.origin;
}

function getPermissionSettingsUrl(kind: PermissionPromptKind) {
  if (typeof navigator === "undefined") {
    return null;
  }

  const permissionPath = kind === "camera" ? "camera" : "location";
  const siteDetailsPath = getCurrentSiteUrl()
    ? `content/siteDetails?site=${encodeURIComponent(getCurrentSiteUrl())}`
    : `content/${permissionPath}`;
  const userAgent = navigator.userAgent.toLowerCase();

  if (userAgent.includes("edg/")) {
    return `edge://settings/${siteDetailsPath}`;
  }
  if (userAgent.includes("opr/") || userAgent.includes("opera/")) {
    return `opera://settings/content/${permissionPath}`;
  }
  if (userAgent.includes("firefox/")) {
    return "about:preferences#privacy";
  }
  if (userAgent.includes("chrome/") || userAgent.includes("crios/")) {
    return `chrome://settings/${siteDetailsPath}`;
  }

  return null;
}

function getPermissionSettingsSteps(kind: PermissionPromptKind) {
  if (typeof navigator === "undefined") {
    return [];
  }

  const permissionName = kind === "camera" ? "Camera" : "Location";
  const lowerPermissionName = permissionName.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();

  if (/iphone|ipad|ipod/.test(userAgent)) {
    if (userAgent.includes("crios/")) {
      return [
        `Open the iOS Settings app, then open Chrome.`,
        `Set ${permissionName} to Allow.`,
        "Return to this page, reload it, then tap Accept & retry.",
      ];
    }

    return [
      "Tap the AA/page settings icon in Safari's address bar, then open Website Settings.",
      `Set ${permissionName} to Allow for this website.`,
      `If it is still blocked, open the iOS Settings app, open Safari, and allow ${lowerPermissionName}.`,
      "Return to this page, reload it, then tap Accept & retry.",
    ];
  }

  if (userAgent.includes("android")) {
    return [
      "Tap the lock/tune icon beside the website address.",
      `Open Permissions and set ${permissionName} to Allow.`,
      "Return to this page, reload it, then tap Accept & retry.",
    ];
  }

  if (userAgent.includes("firefox/")) {
    return [
      "Click the lock icon beside the website address.",
      `Open Permissions and set ${permissionName} to Allow.`,
      "Reload this page, then tap Accept & retry.",
    ];
  }

  return [
    "Click the lock/tune icon beside the website address.",
    "Open Site settings.",
    `Set ${permissionName} to Allow for this website.`,
    "Return to this page, reload it, then tap Accept & retry.",
  ];
}

export function MobileOutstationWizard({
  areaRepOptions = [],
  employeeHrId,
  employeeName,
  employeeRole,
  hasResidenceCoordinates,
  medicalTripOptions,
  residenceShortSummary,
  residenceSummary,
}: {
  areaRepOptions?: ManagerAreaRepOption[];
  employeeHrId: string;
  employeeName: string;
  employeeRole: string;
  hasResidenceCoordinates: boolean;
  medicalTripOptions: MedicalTripOption[];
  residenceShortSummary?: string;
  residenceSummary: string;
}) {
  const router = useRouter();
  const draftKey = outstationDraftStorageKeyFor(employeeHrId);
  const [step, setStep] = useState(1);
  // He pressed Next (or Submit) on a step that still needs something: the bar then says
  // "Still needed" in rose instead of "Now" — the same two words Log a visit uses.
  const [tried, setTried] = useState(false);
  const [submitted, setSubmitted] = useState<SubmittedClaim | null>(null);
  const formTopRef = useRef<HTMLDivElement | null>(null);
  const [expenseType, setExpenseType] = useState<OutstationExpenseType>("traveling");
  const [transportationType, setTransportationType] =
    useState<OutstationTransportationType>("car");
  const [tripStartDate, setTripStartDate] = useState("");
  const [tripEndDate, setTripEndDate] = useState("");
  const [goTicketAmount, setGoTicketAmount] = useState("");
  const [returnTicketAmount, setReturnTicketAmount] = useState("");
  const [kilometerReading, setKilometerReading] = useState("");
  const [meetingAmount, setMeetingAmount] = useState("");
  const [otherAmount, setOtherAmount] = useState("");
  const [amWorkload, setAmWorkload] = useState("");
  const [pmWorkload, setPmWorkload] = useState("");
  const [notes, setNotes] = useState("");
  const [medicalTripHrId, setMedicalTripHrId] = useState("");
  const [selectedAreaCode, setSelectedAreaCode] = useState("");
  const [captured, setCaptured] = useState<OutstationCaptureResult | null>(null);
  const [carEvidence, setCarEvidence] = useState<CarEvidenceState | null>(null);
  const [carEvidenceDraftId, setCarEvidenceDraftId] = useState(() => buildDraftId());
  const [isCarEvidenceCameraOpen, setIsCarEvidenceCameraOpen] = useState(false);
  const [calculation, setCalculation] = useState<OutstationCalculationResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The bar's line is a warning or a refusal unless it is the confirmation set by confirmToHim — a
  // photo taken or uploaded. Read by text, so any later message (a refusal included) turns it back
  // into a warning with nothing to reset.
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const messageIsConfirmation = message !== null && message === confirmation;
  const [isCapturing, setIsCapturing] = useState(false);
  const [isCapturingCarEvidence, setIsCapturingCarEvidence] = useState(false);
  const [isCalculating, setIsCalculating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [permissionPrompt, setPermissionPrompt] = useState<PermissionPromptState | null>(null);
  const [ticketFiles, setTicketFiles] = useState<File[]>([]);
  const carEvidenceStreamRef = useRef<MediaStream | null>(null);
  const pendingOfflineDraftRef = useRef(false);
  const permissionActionRef = useRef<(() => Promise<void>) | null>(null);
  const skipInitialDraftPersistRef = useRef(true);
  const syncAttemptedRef = useRef(false);
  const lastCalculationKeyRef = useRef("");
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // When the manager's areas are known (sales seat model), they pick an AREA and
  // the occupying rep is resolved automatically. Otherwise (roles not modelled
  // in the seat tree) the wizard keeps its legacy free-text rep picker.
  const useAreaRepPicker = areaRepOptions.length > 0;
  const selectedAreaOption =
    areaRepOptions.find((option) => option.areaCode === selectedAreaCode) ?? null;
  const selectedMedicalTripName =
    medicalTripOptions.find((option) => option.hrId === medicalTripHrId)?.name ??
    selectedAreaOption?.repName ??
    null;

  function handleAreaSelection(areaCode: string) {
    setSelectedAreaCode(areaCode);
    const option = areaRepOptions.find((entry) => entry.areaCode === areaCode) ?? null;
    setMedicalTripHrId(option?.repHrId ?? "");
  }
  // transportIcon was removed when WizardStep migrated from icon containers
  // to numbered indices (visual polish — no logic change).
  // Meeting and Other are not trips (owner request 2026-09-19, src/lib/outstation/non-travel-expense.ts):
  // no destination capture, distance, fuel, ticket, allowance or arrival photo — the claim is
  // priced on the two typed amounts and carries an uploaded invoice or picture. The server applies
  // the same predicate, so this is the screen agreeing with it, not a second copy of the rule.
  const isNonTravel = isNonTravelExpenseType(expenseType);
  const isTicketBased =
    !isNonTravel && (transportationType === "train" || transportationType === "bus");
  // Owner request 2026-08-19: Product Manager, Group Product Manager and National Sales Manager
  // submit with no evidence photo at all, and their train/bus ticket is optional. The rule lives
  // in src/lib/outstation/evidence-waiver.ts and the SERVER applies the same predicate to the
  // same role string — this is the screen agreeing with the gate, not a second copy of the rule.
  //
  // `employeeRole` is the canonical job-function role the page was rendered with, so a waived
  // manager never sees the photo step. Hiding a step the server still demanded (or the reverse)
  // is exactly the dead-end this page had to be fixed for on 2026-08-04.
  const isEvidencePhotoWaived = isOutstationEvidenceWaivedRole(employeeRole);
  const arrivalPhotoOwed = !isNonTravel && !isEvidencePhotoWaived;
  const isTicketRequired = isTicketBased && !isOutstationTicketWaivedRole(employeeRole);
  // The arrival photo is required for EVERY transportation type — validateLiveArrivalEvidence()
  // was widened past `car` on 2026-08-04. The capture card below must therefore render for every
  // type too. While it rendered on `car` only, a train or bus employee had no control anywhere on
  // the page that could satisfy a rule the server was already enforcing, so every train and bus
  // submission died on a 400 that the mobile layout pushed off-screen below the sticky footer.
  const arrivalPhotoBadge = transportationType === "car" ? "Live car photo" : "Arrival photo";
  // Owner request 2026-08-05: a non-car trip may satisfy the arrival photo by UPLOADING one
  // instead of capturing it live. Car is deliberately excluded — validateLiveArrivalEvidence
  // still refuses anything but a live capture there, and offering an upload button that the
  // server would then reject is exactly the dead-end this whole page just got fixed for.
  const canUploadArrivalPhoto = transportationType !== "car";
  const arrivalPhotoHeading = canUploadArrivalPhoto
    ? "Add one arrival photo — take it live or upload it"
    : "Take one live photo of the car";
  const arrivalPhotoHint =
    transportationType === "car"
      ? "Car requests require one in-app camera photo with GPS and app-generated timestamp."
      : transportationType === "other"
        ? "This trip requires one arrival photo. Take it live, or upload one — an uploaded photo is stamped as uploaded."
        : `A ${transportationType} trip requires one arrival photo. Take it live, or upload one — an uploaded photo is stamped as uploaded.`;
  const arrivalPhotoMissingMessage =
    transportationType === "car"
      ? "Capture the live car photo before submitting this car request."
      : "Add the arrival photo before submitting — take it live or upload one.";
  // Kept deliberately short: this one renders inside the narrow mobile action bar and
  // must stay on a single line without wrapping.
  const arrivalPhotoMissingShort =
    transportationType === "car" ? "Capture the car photo first" : "Add the arrival photo first";
  // Derived from `carEvidence` directly rather than from `hasCarEvidence`, which is declared
  // further down the component — a const cannot be read above its own declaration.
  const arrivalPhotoStatusLabel = !carEvidence?.imageDataUrl
    ? "No arrival photo yet"
    : carEvidence.source === "upload"
      ? "One uploaded arrival photo"
      : "One live camera photo captured";
  const durationSummary = calculation
    ? calculation.sameDayTrip
      ? "Return the same day"
      : `Overnight stay - ${calculation.overnightDays} ${calculation.overnightDays === 1 ? "night" : "nights"}`
    : getDurationSummary(tripStartDate, tripEndDate);
  const fromShortLabel = cleanLocationPart(residenceShortSummary) || residenceSummary;
  const destinationLocation = capturedDestinationParts(captured);

  function openPermissionPrompt(kind: PermissionPromptKind, action: () => Promise<void>, blocked = false) {
    permissionActionRef.current = action;
    setPermissionPrompt({ blocked, kind });
  }

  function closePermissionPrompt() {
    permissionActionRef.current = null;
    setPermissionPrompt(null);
  }

  async function acceptPermissionPrompt() {
    const action = permissionActionRef.current;
    closePermissionPrompt();
    await action?.();
  }

  function declinePermissionPrompt() {
    const kind = permissionPrompt?.kind;
    closePermissionPrompt();
    setMessage(
      kind === "camera"
        ? transportationType === "car"
          ? "Camera permission was declined. The car photo cannot be taken without camera access."
          : "Camera permission was declined. Allow the camera, or upload the arrival photo instead."
        : "Location permission was declined. This expense cannot continue without GPS access.",
    );
  }

  const stopCarEvidenceCamera = useCallback(() => {
    if (carEvidenceStreamRef.current) {
      carEvidenceStreamRef.current.getTracks().forEach((track) => track.stop());
      carEvidenceStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsCarEvidenceCameraOpen(false);
    setIsCapturingCarEvidence(false);
  }, []);

  const resetFormState = useCallback(() => {
    pendingOfflineDraftRef.current = false;
    syncAttemptedRef.current = false;
    lastCalculationKeyRef.current = "";
    removeStoredDraft(draftKey);
    stopCarEvidenceCamera();
    setCalculation(null);
    setCaptured(null);
    setCarEvidence(null);
    setCarEvidenceDraftId(buildDraftId());
    setExpenseType("traveling");
    setGoTicketAmount("");
    setKilometerReading("");
    setMeetingAmount("");
    setOtherAmount("");
    setAmWorkload("");
    setPmWorkload("");
    setMedicalTripHrId("");
    setSelectedAreaCode("");
    setMeetingAmount("");
    setNotes("");
    setOtherAmount("");
    setReturnTicketAmount("");
    setTripStartDate("");
    setTripEndDate("");
    setTicketFiles([]);
    setTransportationType("car");
    setStep(1);
  }, [draftKey, stopCarEvidenceCamera]);

  useEffect(() => {
    // The browser-wide draft from before 2026-10-26 cannot say whose claim it is, so it is removed
    // rather than restored for whoever happens to be signed in (src/lib/browser-storage/owner-scoped.ts).
    removeStoredDraft(outstationDraftStorageKeyBase);
    const restore = readStoredDraft(draftKey);
    if (!isRestorableOutstationLocalDraft(restore, employeeHrId)) {
      removeStoredDraft(draftKey);
      return;
    }

    pendingOfflineDraftRef.current = true;
    const draftId = restore.carEvidenceRequestId?.trim() || buildDraftId();
    // Restore only offline sync drafts. Submitted or stale online drafts must not repopulate a new request.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCaptured(restore.captured);
    setCarEvidenceDraftId(draftId);
    if (
      restore.carEvidenceCapturedAt &&
      restore.carEvidenceLatitude != null &&
      restore.carEvidenceLongitude != null
    ) {
      setCarEvidence({
        capturedAt: restore.carEvidenceCapturedAt,
        capturedLatitude: restore.carEvidenceLatitude,
        capturedLocationLabel: restore.carEvidenceLocationLabel ?? "Location unavailable",
        capturedLongitude: restore.carEvidenceLongitude,
        imageDataUrl: restore.carEvidenceImageDataUrl ?? "",
        requestDraftId: draftId,
        requestId: null,
        // A restored draft with no stored source predates the upload route, so it can only
        // have been a live capture. Never guess this from the transport type.
        source: restore.carEvidenceSource ?? "live_camera",
      });
    }
    setExpenseType(restore.expenseType);
    setGoTicketAmount(restore.goTicketAmount);
    setKilometerReading(restore.kilometerReading);
    setMeetingAmount(restore.meetingAmount ?? "");
    setOtherAmount(restore.otherAmount ?? "");
    setAmWorkload(restore.amWorkload ?? "");
    setPmWorkload(restore.pmWorkload ?? "");
    setMedicalTripHrId(restore.medicalTripHrId);
    setNotes(restore.notes);
    setReturnTicketAmount(restore.returnTicketAmount);
    setTransportationType(restore.transportationType);
    setTripEndDate(restore.tripEndDate);
    setTripStartDate(restore.tripStartDate);
  }, [draftKey, employeeHrId]);

  useEffect(() => {
    const syncOnlineState = () => setIsOffline(!navigator.onLine);
    syncOnlineState();
    window.addEventListener("online", syncOnlineState);
    window.addEventListener("offline", syncOnlineState);
    return () => {
      window.removeEventListener("online", syncOnlineState);
      window.removeEventListener("offline", syncOnlineState);
    };
  }, []);

  useEffect(() => {
    if (skipInitialDraftPersistRef.current) {
      skipInitialDraftPersistRef.current = false;
      return;
    }

    if (!isOffline || !captured) {
      if (!pendingOfflineDraftRef.current) {
        removeStoredDraft(draftKey);
      }
      return;
    }

    pendingOfflineDraftRef.current = true;
    const draft: OutstationLocalDraft = {
      captured,
      carEvidenceCapturedAt: carEvidence?.capturedAt ?? null,
      carEvidenceImageDataUrl: carEvidence?.imageDataUrl ?? null,
      carEvidenceLatitude: carEvidence?.capturedLatitude ?? null,
      carEvidenceLocationLabel: carEvidence?.capturedLocationLabel ?? null,
      carEvidenceLongitude: carEvidence?.capturedLongitude ?? null,
      carEvidenceRequestId: carEvidenceDraftId,
      carEvidenceSource: carEvidence?.source,
      expenseType,
      goTicketAmount,
      hasTicketAttachments: ticketFiles.length > 0,
      kilometerReading,
      meetingAmount,
      otherAmount,
      amWorkload,
      pmWorkload,
      medicalTripHrId,
      notes,
      ownerHrId: employeeHrId,
      returnTicketAmount,
      syncPending: true,
      transportationType,
      travelCostAmount: "",
      tripType: durationSummary,
      tripEndDate,
      tripStartDate,
    };
    writeStoredDraft(draftKey, draft);
  }, [
    captured,
    carEvidence?.capturedAt,
    carEvidence?.source,
    carEvidence?.imageDataUrl,
    carEvidence?.capturedLatitude,
    carEvidence?.capturedLocationLabel,
    carEvidence?.capturedLongitude,
    carEvidenceDraftId,
    draftKey,
    employeeHrId,
    expenseType,
    goTicketAmount,
    meetingAmount,
    otherAmount,
    amWorkload,
    pmWorkload,
    isOffline,
    kilometerReading,
    medicalTripHrId,
    notes,
    returnTicketAmount,
    ticketFiles.length,
    transportationType,
    durationSummary,
    tripEndDate,
    tripStartDate,
  ]);

  useEffect(() => {
    if (!isOffline) {
      const syncPending = async () => {
        const draft = readStoredDraft(draftKey);
        if (
          // Only the signed-in person's own draft is ever sent: the server files it under THIS
          // session, so another person's draft replayed here became their claim under our name.
          !isRestorableOutstationLocalDraft(draft, employeeHrId) ||
          !draft.tripStartDate ||
          !draft.tripEndDate ||
          // Applies to EVERY transport type, not just car: the server refuses any request
          // without arrival evidence, so replaying an evidence-less train draft would burn the
          // one sync attempt (syncAttemptedRef) on a request that cannot succeed.
          !draft.carEvidenceRequestId ||
          !draft.carEvidenceCapturedAt ||
          !draft.carEvidenceImageDataUrl ||
          draft.carEvidenceLatitude == null ||
          !draft.carEvidenceLocationLabel ||
          draft.carEvidenceLongitude == null ||
          syncAttemptedRef.current
        ) {
          return;
        }

        syncAttemptedRef.current = true;
        try {
          const response = await fetch("/api/outstation/sync-offline", {
            body: JSON.stringify({
              attachmentCount: draft.hasTicketAttachments ? 1 : 0,
              capturedAccuracyMeters: draft.captured.capturedAccuracyMeters,
              capturedAt: draft.captured.capturedAt,
              capturedLatitude: draft.captured.capturedLatitude,
              capturedLongitude: draft.captured.capturedLongitude,
              // Deliberately 0, and it must stay 0. A draft saved with no signal was never
              // priced: pricing needs the route distance, the policy rates, the duplicate-day
              // guard and the Cairo no-allowance rule, every one of them server-side. There is
              // nothing meaningful the phone could put here, so it sends nothing and the server
              // recalculates the whole trip on sync. Do NOT "fix" this by inventing a
              // client-side estimate.
              //
              // This 0 used to be stored verbatim, which is how request 72 — the only offline
              // submission ever made — landed with claimed 0 against an expected 448.14 and
              // showed "EGP 0 / You claimed" on the employee's own portal card. The fix is in
              // submitOutstationRequest, which is the only place holding the real number.
              claimedTotalAmount: 0,
              expenseType: draft.expenseType,
              goTicketAmount: Number(draft.goTicketAmount || 0),
              amWorkload: Number(draft.amWorkload || 0),
              // NOT gated on car. The arrival photo is required for every transport type, so
              // stripping the evidence here for a train or bus draft guaranteed the sync would
              // be refused — the same defect that broke the online path, in its offline twin.
              carEvidenceMetadata: draft.carEvidenceRequestId
                ? {
                    capturedAt: draft.carEvidenceCapturedAt ?? "",
                    capturedLatitude: Number(draft.carEvidenceLatitude),
                    capturedLocationLabel: draft.carEvidenceLocationLabel,
                    capturedLongitude: Number(draft.carEvidenceLongitude),
                    employeeHrId,
                    requestDraftId: draft.carEvidenceRequestId,
                    requestId: null,
                    // Pre-2026-08-05 drafts carry no source; those are all live captures.
                    source: draft.carEvidenceSource ?? "live_camera",
                  }
                : undefined,
              carEvidenceImageDataUrl: draft.carEvidenceImageDataUrl ?? undefined,
              hasTicketAttachments: draft.hasTicketAttachments,
              kilometerReading: Number(draft.kilometerReading || 0),
              meetingAmount: Number(draft.meetingAmount || 0),
              medicalTripHrId: draft.medicalTripHrId,
              medicalTripName:
                medicalTripOptions.find((option) => option.hrId === draft.medicalTripHrId)?.name ??
                "",
              notes: draft.notes,
              otherAmount: Number(draft.otherAmount || 0),
              pmWorkload: Number(draft.pmWorkload || 0),
              returnTicketAmount: Number(draft.returnTicketAmount || 0),
              transportationType: draft.transportationType,
              tripType: draft.tripType,
              tripEndDate: draft.tripEndDate,
              tripStartDate: draft.tripStartDate,
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });
          if (response.ok) {
            const replayed = (await response.json().catch(() => null)) as { dryRun?: unknown } | null;
            resetFormState();
            // A replayed draft carries no ticket file (a file cannot live in localStorage), so a
            // train or bus claim lands without one — and the departure photo is still owed. Both
            // are said here, and the refresh puts both cards at the top of the page.
            // A test account's replay was checked and not saved, so nothing is owed on it.
            setMessage(
              replayed?.dryRun === true
                ? `${TEST_CLAIM_NOT_SAVED_TITLE}. ${TEST_CLAIM_NOT_SAVED_DETAIL}`
                : "Your saved claim was sent now that you are back online. Take the departure photo before you leave, and for a train or bus trip attach the ticket on the claim under My claims below.",
            );
            router.refresh();
          } else {
            syncAttemptedRef.current = false;
          }
        } catch {
          syncAttemptedRef.current = false;
        }
      };
      void syncPending();
    } else {
      syncAttemptedRef.current = false;
    }
  }, [draftKey, employeeHrId, isOffline, medicalTripOptions, resetFormState, router]);

  const hasTicketAttachments = ticketFiles.length > 0;
  const hasCarEvidence = Boolean(carEvidence?.imageDataUrl);

  function handleTransportationTypeChange(value: OutstationTransportationType) {
    setTransportationType(value);
    if (value === "car") {
      setTicketFiles([]);
    } else {
      setCarEvidence(null);
    }
  }

  const carEvidenceMetadata = useMemo<OutstationCarEvidenceMetadata | undefined>(() => {
    if (!carEvidence) return undefined;

    return {
      capturedAt: carEvidence.capturedAt,
      capturedLatitude: carEvidence.capturedLatitude,
      capturedLocationLabel: carEvidence.capturedLocationLabel,
      capturedLongitude: carEvidence.capturedLongitude,
      employeeHrId,
      requestDraftId: carEvidence.requestDraftId,
      requestId: carEvidence.requestId,
      source: carEvidence.source,
    };
  }, [carEvidence, employeeHrId]);

  const requestPayload = useMemo(
    () => ({
      amWorkload: Number(amWorkload || 0),
      attachmentCount: ticketFiles.length,
      // Never `?? 0`: 0 would reach the server as a perfect 0 m fix and pass the accuracy limit.
      // A Meeting or Other expense posts no position, photo, kilometre or ticket amount: whatever
      // is left in those boxes from an earlier Traveling entry must never reach the request.
      capturedAccuracyMeters: isNonTravel ? null : (captured?.capturedAccuracyMeters ?? null),
      capturedAt: isNonTravel ? undefined : captured?.capturedAt,
      capturedLatitude: isNonTravel ? 0 : (captured?.capturedLatitude ?? 0),
      capturedLongitude: isNonTravel ? 0 : (captured?.capturedLongitude ?? 0),
      carEvidenceMetadata: isNonTravel ? undefined : carEvidenceMetadata,
      claimedTotalAmount: 0,
      expenseType,
      goTicketAmount: isNonTravel ? 0 : Number(goTicketAmount || 0),
      hasTicketAttachments,
      kilometerReading: isNonTravel ? 0 : Number(kilometerReading || 0),
      meetingAmount: Number(meetingAmount || 0),
      medicalTripHrId,
      medicalTripName: selectedMedicalTripName,
      notes,
      offlineCaptured: isOffline,
      otherAmount: Number(otherAmount || 0),
      pmWorkload: Number(pmWorkload || 0),
      returnTicketAmount: isNonTravel ? 0 : Number(returnTicketAmount || 0),
      transportationType: isNonTravel ? ("other" as const) : transportationType,
      tripType: durationSummary,
      tripEndDate,
      tripStartDate,
    }),
    [
      amWorkload,
      captured,
      durationSummary,
      expenseType,
      goTicketAmount,
      hasTicketAttachments,
      isNonTravel,
      isOffline,
      kilometerReading,
      meetingAmount,
      medicalTripHrId,
      notes,
      otherAmount,
      pmWorkload,
      returnTicketAmount,
      carEvidenceMetadata,
      selectedMedicalTripName,
      ticketFiles.length,
      transportationType,
      tripEndDate,
      tripStartDate,
    ],
  );

  // A Meeting or Other claim with no amount typed yet cannot be priced — the server refuses it with
  // nonTravelAmountRefusal's message — so it is not asked. Asking anyway logged a failed calculation
  // for every rep who set the dates before the amount (System Audit, 31 Oct 2026).
  const canAutoCalculate = Boolean(
    (captured || isNonTravel) &&
      tripStartDate &&
      tripEndDate &&
      !(isNonTravel && nonTravelAmountRefusal({ meetingAmount, otherAmount })),
  );
  const calculationKey = useMemo(() => {
    if ((!captured && !isNonTravel) || !tripStartDate || !tripEndDate) return "";

    if (isNonTravel) {
      // Priced on the two amounts and the dates alone, so nothing else may re-trigger a price.
      return JSON.stringify({
        attachmentCount: ticketFiles.length,
        expenseType,
        meetingAmount: Number(meetingAmount || 0),
        otherAmount: Number(otherAmount || 0),
        tripEndDate,
        tripStartDate,
      });
    }

    if (!captured) return "";

    return JSON.stringify({
      attachmentCount: ticketFiles.length,
      capturedAccuracyMeters: captured.capturedAccuracyMeters,
      capturedAt: captured.capturedAt,
      capturedLatitude: captured.capturedLatitude,
      capturedLongitude: captured.capturedLongitude,
      expenseType,
      goTicketAmount: isTicketBased ? Number(goTicketAmount || 0) : 0,
      hasTicketAttachments,
      amWorkload: Number(amWorkload || 0),
      meetingAmount: Number(meetingAmount || 0),
      otherAmount: Number(otherAmount || 0),
      pmWorkload: Number(pmWorkload || 0),
      returnTicketAmount: isTicketBased ? Number(returnTicketAmount || 0) : 0,
      transportationType,
      tripEndDate,
      tripStartDate,
    });
  }, [
    captured,
    amWorkload,
    expenseType,
    goTicketAmount,
    hasTicketAttachments,
    isNonTravel,
    isTicketBased,
    meetingAmount,
    otherAmount,
    pmWorkload,
    returnTicketAmount,
    ticketFiles.length,
    transportationType,
    tripEndDate,
    tripStartDate,
  ]);

  const performCalculation = useEffectEvent(async (submittedCalculationKey?: string) => {
    if (!captured && !isNonTravel) {
      return;
    }

    if (submittedCalculationKey) {
      lastCalculationKeyRef.current = submittedCalculationKey;
    }
    setIsCalculating(true);
    setMessage(null);
    try {
      const response = await fetch("/api/outstation/calculate", {
        body: JSON.stringify(requestPayload),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        if (submittedCalculationKey === lastCalculationKeyRef.current) {
          lastCalculationKeyRef.current = "";
        }
        setMessage(payload.message ?? payload.error ?? "Unable to calculate the request.");
        return;
      }
      // A newer recalculation can start (and overwrite the ref) while this fetch is still in
      // flight. Applying this response anyway would land a late, superseded price right after
      // the effect below clears it for the newer inputs — the same staleness bug from the other
      // direction. Only the most recently started calculation is allowed to win.
      if (submittedCalculationKey && submittedCalculationKey !== lastCalculationKeyRef.current) {
        return;
      }
      setCalculation(payload);
    } catch {
      if (submittedCalculationKey === lastCalculationKeyRef.current) {
        lastCalculationKeyRef.current = "";
      }
      setMessage("Unable to calculate the request.");
    } finally {
      setIsCalculating(false);
    }
  });

  useEffect(() => {
    if (isOffline || !canAutoCalculate || !calculationKey) return;
    if (lastCalculationKeyRef.current === calculationKey) return;

    const timeout = window.setTimeout(() => {
      void performCalculation(calculationKey);
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [
    calculationKey,
    canAutoCalculate,
    isOffline,
  ]);

  // A change to any pricing input means the current `calculation` no longer matches the trip
  // being priced. Clearing it right away — rather than waiting out the 350ms debounce above, or
  // waiting for a recalculation that might fail — is what hides the submit action below (it only
  // renders once `calculation` is set again), so a stale total can never sit on screen ready to
  // be submitted. Skipped while offline: recalculation cannot run without a server round trip, and
  // the offline path never trusts this value for money anyway (see submit()).
  useEffect(() => {
    if (isOffline) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCalculation(null);
  }, [calculationKey, isOffline]);

  async function captureLocation() {
    setMessage(null);
    setCalculation(null);
    if (!navigator.geolocation) {
      setMessage("Browser geolocation is not supported on this device.");
      return;
    }

    setIsCapturing(true);
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 20000,
        });
      });

      const offlineCapturedAt = new Date().toISOString();
      if (isOffline) {
        const offlineCapture: OutstationCaptureResult = {
          capturedAccuracyMeters: position.coords.accuracy,
          capturedAt: offlineCapturedAt,
          capturedLatitude: position.coords.latitude,
          capturedLocationSource: "browser_gps",
          capturedLongitude: position.coords.longitude,
          distanceFromResidenceKm: null,
          durationMinutes: null,
          eligibilityReason:
            "Location was captured offline. Distance, fraud checks, and approval intelligence will run when the request syncs to the server.",
          eligibilityStatus: "needs_review",
          employeeArea: null,
          employeeHrId: "",
          employeeLine: null,
          employeeName,
          employeeRole,
          minimumRequiredDistanceKm: 60,
          residenceLatitude: null,
          residenceLongitude: null,
          routeAlternatives: [],
          routePolyline: null,
          routeError: "Offline capture pending route validation after sync.",
          routeProvider: "google_maps",
          selectedRouteIndex: null,
          selectedRouteReason: null,
          submittedAt: offlineCapturedAt,
          territoryValidationReason: "Territory validation will run after the offline draft syncs.",
          territoryValidationStatus: "not_available",
          toArea: null,
          toCity: null,
          toLabel: "Offline capture pending server validation",
        };
        // He stays on the Destination step to see the result; the bar names the next step.
        setCaptured(offlineCapture);
        setMessage(
          "Location captured with no connection. The distance and the total are worked out when the claim reaches the server.",
        );
        return;
      }

      const response = await fetch("/api/outstation/capture-location", {
        body: JSON.stringify({
          capturedAccuracyMeters: position.coords.accuracy,
          capturedAt: offlineCapturedAt,
          capturedLatitude: position.coords.latitude,
          capturedLongitude: position.coords.longitude,
          offlineCaptured: isOffline,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message ?? payload.error ?? "Unable to capture your location.");
        return;
      }

      setCaptured(payload);
    } catch (error) {
      if (isDeniedPermissionError(error)) {
        setMessage(permissionDeniedMessage("destination-location"));
        openPermissionPrompt("destination-location", captureLocation, true);
      } else {
        const geoError = error as Error;
        setMessage(
          geoError instanceof Error
            ? geoError.message
            : "Unable to capture your current location.",
        );
      }
    } finally {
      setIsCapturing(false);
    }
  }

  useEffect(() => {
    if (!isCarEvidenceCameraOpen || !videoRef.current || !carEvidenceStreamRef.current) {
      return;
    }

    const video = videoRef.current;
    video.srcObject = carEvidenceStreamRef.current;
    void video.play().catch(() => {
      setMessage("Unable to start camera preview.");
    });
  }, [isCarEvidenceCameraOpen]);

  useEffect(() => {
    return () => {
      if (carEvidenceStreamRef.current) {
        carEvidenceStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  async function openCarEvidenceCamera() {
    setMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage("Camera capture is not available on this device.");
      return;
    }

    setIsCapturingCarEvidence(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      carEvidenceStreamRef.current = stream;
      setIsCarEvidenceCameraOpen(true);
    } catch (error) {
      const typedError = error as GeolocationPositionError | DOMException | Error;
      if (isDeniedPermissionError(typedError)) {
        setMessage(permissionDeniedMessage("camera"));
        openPermissionPrompt("camera", openCarEvidenceCamera, true);
        return;
      }
      setMessage(
        typedError instanceof Error ? typedError.message : "Unable to open the camera.",
      );
    } finally {
      setIsCapturingCarEvidence(false);
    }
  }

  function confirmToHim(text: string) {
    setConfirmation(text);
    setMessage(text);
  }

  async function captureCarEvidence() {
    setMessage(null);
    if (!navigator.geolocation) {
      setMessage("Browser geolocation is not supported on this device.");
      return;
    }
    if (!videoRef.current || !carEvidenceStreamRef.current) {
      setMessage("Open the camera before capturing the photo.");
      return;
    }

    setIsCapturingCarEvidence(true);
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 20000,
        });
      });

      const video = videoRef.current;
      const canvas = document.createElement("canvas");
      const canvasSize = getCompressedEvidenceCanvasSize(video);
      canvas.width = canvasSize.width;
      canvas.height = canvasSize.height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Unable to initialize the camera preview.");
      }

      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const capturedAt = new Date().toISOString();
      // Resolved BEFORE the watermark is drawn, so the address and the Phoenix brick/area/region
      // are burned into the JPEG itself rather than only stored beside it.
      const location = await resolveEvidenceLocationStamp(
        "/api/outstation/reverse-geocode",
        position.coords.latitude,
        position.coords.longitude,
        position.coords.accuracy ?? null,
      );

      await drawEvidenceWatermark(context, canvas, {
        capturedAt,
        employeeHrId,
        // Named in the burned-in panel so the arrival and departure photos are tellable apart
        // from the image alone, without trusting the filename or the database row.
        label: "Arrival photo",
        locationLines: location.lines,
        reference: `Draft: ${carEvidenceDraftId}`,
      });

      const imageDataUrl = canvas.toDataURL("image/jpeg", 0.74);

      setCarEvidence({
        capturedAt,
        capturedLatitude: position.coords.latitude,
        capturedLocationLabel: location.label,
        capturedLongitude: position.coords.longitude,
        imageDataUrl,
        requestDraftId: carEvidenceDraftId,
        requestId: carEvidence?.requestId ?? null,
        source: "live_camera",
      });
      stopCarEvidenceCamera();
      confirmToHim(
        transportationType === "car"
          ? "Live car photo taken. It goes with this claim."
          : "Arrival photo taken. It goes with this claim.",
      );
    } catch (error) {
      const typedError = error as GeolocationPositionError | DOMException | Error;
      if (isDeniedPermissionError(typedError)) {
        setMessage(permissionDeniedMessage("car-evidence-location"));
        openPermissionPrompt("car-evidence-location", captureCarEvidence, true);
        return;
      }
      setMessage(
        typedError instanceof Error ? typedError.message : "Unable to capture the live car photo.",
      );
    } finally {
      setIsCapturingCarEvidence(false);
    }
  }

  /**
   * The upload route to the SAME arrival-photo slot, for non-car trips only.
   *
   * It deliberately re-encodes the chosen file through the identical canvas path the camera
   * uses, rather than shipping the raw file: the server accepts only a compressed JPEG under
   * 2MB, and a phone photo is neither. Re-encoding also lets the same watermark be burned in,
   * so an uploaded photo is self-describing in the image itself and an approver can see at a
   * glance that it was uploaded rather than captured.
   *
   * The GPS written here is the TRIP's destination capture, not the photo's own — an uploaded
   * file carries no trustworthy location. `source: "upload"` is what keeps that distinction
   * legible downstream; nothing here may claim the photo was taken live.
   */
  async function uploadArrivalEvidence(file: File) {
    setMessage(null);
    if (!captured) {
      setMessage("Tap the To field to capture your destination before adding the arrival photo.");
      return;
    }
    if (!file.type.startsWith("image/")) {
      setMessage("The arrival photo must be an image file.");
      return;
    }

    setIsCapturingCarEvidence(true);
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("Unable to read the selected image."));
        element.src = objectUrl;
      });

      const canvas = document.createElement("canvas");
      const canvasSize = getCompressedEvidenceCanvasSize(image);
      canvas.width = canvasSize.width;
      canvas.height = canvasSize.height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Unable to process the selected image.");
      }

      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const capturedAt = new Date().toISOString();
      // The TRIP's destination capture, not the file's own — an uploaded photo carries no
      // trustworthy position. Accuracy is deliberately null: this pin was not measured here.
      const location = await resolveEvidenceLocationStamp(
        "/api/outstation/reverse-geocode",
        captured.capturedLatitude,
        captured.capturedLongitude,
      );

      await drawEvidenceWatermark(context, canvas, {
        capturedAt,
        employeeHrId,
        // Says "uploaded" on the face of the image. An approver reading the photo alone must not
        // mistake it for a live capture, and the burned-in panel is the one part of the evidence
        // that survives being screenshotted out of the app.
        label: "Arrival photo (uploaded)",
        locationLines: location.lines,
        reference: `Draft: ${carEvidenceDraftId}`,
      });

      setCarEvidence({
        capturedAt,
        capturedLatitude: captured.capturedLatitude,
        capturedLocationLabel: location.label,
        capturedLongitude: captured.capturedLongitude,
        imageDataUrl: canvas.toDataURL("image/jpeg", 0.74),
        requestDraftId: carEvidenceDraftId,
        requestId: carEvidence?.requestId ?? null,
        source: "upload",
      });
      confirmToHim("Arrival photo uploaded. It is marked as uploaded, not captured live.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to upload the arrival photo.",
      );
    } finally {
      URL.revokeObjectURL(objectUrl);
      setIsCapturingCarEvidence(false);
    }
  }

  async function submit() {
    if (isNonTravel && isOffline) {
      setMessage(
        "A Meeting or Other expense needs an internet connection so its invoice can be uploaded. Reconnect and submit again.",
      );
      return;
    }

    if (!captured && !isNonTravel) {
      setMessage("Go back to Destination and tap Capture my location first.");
      return;
    }

    if (!hasCarEvidence && arrivalPhotoOwed) {
      setMessage(arrivalPhotoMissingMessage);
      return;
    }

    // The review screen's total is only trustworthy for the exact inputs it was priced from.
    // `lastCalculationKeyRef` is set the instant a calculation starts, so this also catches a
    // submit attempted while one is still in flight, not only one made after a change nulled
    // `calculation` or a recalculation failed outright.
    if (!isOffline && (isCalculating || !calculation || lastCalculationKeyRef.current !== calculationKey)) {
      setMessage("Phoenix is still pricing this request. Wait a moment for the total to update, then submit again.");
      return;
    }

    setIsSubmitting(true);
    setMessage(null);
    try {
      const endpoint = isOffline ? "/api/outstation/sync-offline" : "/api/outstation/submit";
      // Sent on BOTH routes (owner, 2026-10-22: "fix the offline ticket gap"). `navigator.onLine`
      // reporting false does not mean this request cannot land — Osama's 20 Oct train claim was
      // posted to sync-offline and arrived, but its ticket had been stripped here because the
      // phone said "offline", and the claim was held for a ticket he had attached. sync-offline
      // now carries ticketAttachments exactly like submit. Only a draft REPLAYED later from
      // localStorage has no file to send; that claim gets its ticket from My claims.
      let ticketAttachments: Array<{ dataUrl: string; name: string }> | undefined;
      if ((isTicketBased || isNonTravel) && ticketFiles.length > 0) {
        try {
          ticketAttachments = await Promise.all(ticketFiles.map(prepareTicketAttachment));
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Unable to read the attached ticket. Attach it again.",
          );
          return;
        }
        const bodyCheck = checkSubmitBodySize(
          ticketAttachments.reduce((sum, attachment) => sum + attachment.dataUrl.length, 0) +
            (isNonTravel ? 0 : (carEvidence?.imageDataUrl?.length ?? 0)),
        );
        if (!bodyCheck.ok) {
          setMessage(bodyCheck.message);
          return;
        }
      }
      // claimedTotalAmount is deliberately left at requestPayload's 0 here, for both the online
      // and offline paths. The server always recalculates the whole trip itself and only trusts a
      // posted claim when it is a real positive number (outstationClaimedTotal, in
      // src/lib/outstation/service.ts) — so posting 0 makes the server's own fresh total the one
      // that is ever paid, rather than this wizard's `calculation`, which the guard above narrows
      // but can never fully guarantee is current (a response can still land between the check and
      // the fetch below). That gap is exactly how request 99 (Dina Fadel, 2026-08-25) was paid 200
      // EGP short of its own expected total.
      const response = await fetch(endpoint, {
        body: JSON.stringify({
          ...requestPayload,
          carEvidenceImageDataUrl: isNonTravel ? undefined : carEvidence?.imageDataUrl,
          ticketAttachments,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message ?? payload.error ?? "Unable to submit the request.");
        return;
      }

      // The form no longer resets in silence: the screen after Submit says what is still owed,
      // in order — the departure photo first (owner, 2026-10-22: "show him what should he do in
      // this step and the next"). The refresh re-reads the page, so the departure-photo card
      // appears at its top straight away.
      const claimId = Number(payload?.id);
      const expectedTotal = Number(payload?.expectedTotalAmount);
      setSubmitted({
        arrivalPhotoOwed,
        dryRun:
          payload?.dryRun === true
            ? {
                expectedTotal: Number.isFinite(expectedTotal) ? expectedTotal : null,
                rehearsal: !isNonTravel && transportationType === "car" ? rehearsalTripFrom(payload, carEvidence) : null,
              }
            : null,
        destination:
          (typeof payload?.toLabel === "string" && payload.toLabel.trim()) ||
          (captured ? destinationLocation.shortLabel : null),
        id: Number.isFinite(claimId) && claimId > 0 ? claimId : null,
        isCarTrip: !isNonTravel && transportationType === "car",
        isNonTravel,
        isTicketBased,
        ticketsAttached: ticketAttachments?.length ?? 0,
      });
      resetFormState();
      setMessage(null);
      router.refresh();
    } catch {
      // A phone with no signal cannot post at all. Its draft is already kept on the phone by the
      // effect above and is sent by itself once the connection is back, so say exactly that.
      setMessage(
        isOffline
          ? "No connection. Your claim is kept on this phone and is sent by itself when you are back online — keep this page open."
          : "Unable to submit the request.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  // ── The step form ───────────────────────────────────────────────────────────────────────
  // Every rule of WHICH step needs WHAT lives in src/lib/outstation/submit-expense-steps.ts; this
  // only feeds it the screen's state.
  const steps = submitExpenseSteps(isNonTravel);
  const stepNumber = Math.min(Math.max(step, 1), steps.length);
  const currentStep = steps[stepNumber - 1];
  const nextStep = stepNumber < steps.length ? steps[stepNumber] : null;
  const isReviewStep = currentStep.key === "review";
  const facts: SubmitExpenseFacts = {
    arrivalPhotoOwed,
    captured: Boolean(captured),
    hasArrivalPhoto: hasCarEvidence,
    isNonTravel,
    isOffline,
    isTicketBased,
    isTicketRequired,
    meetingAmount,
    otherAmount,
    ticketCount: ticketFiles.length,
    transportationType,
    tripEndDate,
    tripStartDate,
  };
  const stepProblem = submitExpenseStepProblem(currentStep.key, facts);
  const firstOpen = firstOpenSubmitExpenseStep(steps, facts);
  const reviewHold = !isReviewStep
    ? null
    : firstOpen
      ? `${steps[firstOpen.index].label}: ${firstOpen.problem}`
      : isOffline
        ? null
        : isCalculating || !calculation
          ? "Phoenix is calculating the total. It appears here in a moment."
          : calculation.eligibilityStatus === "not_eligible"
            ? `This trip is not eligible: ${calculation.eligibilityReason}`
            : null;

  function showStep(target: number) {
    // A camera left open on a step he has walked away from keeps the phone's camera light on, so
    // leaving the evidence step closes it — here, on the move itself, never in an effect after it.
    if (steps[target - 1]?.key !== "evidence" && isCarEvidenceCameraOpen) stopCarEvidenceCamera();
    setTried(false);
    setMessage(null);
    setStep(target);
    formTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function goNext() {
    if (stepProblem) {
      // Next refused: the bar shows what is still missing, never the line before it. A train trip
      // stuck on "Arrival photo taken" while the ticket was what held it read as a dead button.
      setMessage(null);
      setTried(true);
      return;
    }
    showStep(stepNumber + 1);
  }

  // ── What each step draws ────────────────────────────────────────────────────────────────
  const expenseTypeOptions: ReadonlyArray<{ label: string; value: OutstationExpenseType }> = [
    { label: "Traveling", value: "traveling" },
    { label: "Meeting", value: "meeting" },
    { label: "Other", value: "other" },
  ];
  const transportOptions: ReadonlyArray<{ label: string; value: OutstationTransportationType }> = [
    { label: "Car", value: "car" },
    { label: "Train", value: "train" },
    { label: "Bus", value: "bus" },
    { label: "Other", value: "other" },
  ];

  const tripBody = (
    <div className="grid gap-5">
      <Field as="div" label="Expense type">
        <ChoiceTiles
          label="Expense type"
          onChange={(value) => setExpenseType(value)}
          options={expenseTypeOptions}
          value={expenseType}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="From date">
          <Input
            aria-label="Trip start date"
            lang="en-GB"
            max={tripEndDate || undefined}
            onChange={(event) => setTripStartDate(event.target.value)}
            placeholder="YYYY-MM-DD"
            type="date"
            value={tripStartDate}
          />
        </Field>
        <Field label="To date">
          <Input
            aria-label="Trip end date"
            lang="en-GB"
            min={tripStartDate || undefined}
            onChange={(event) => setTripEndDate(event.target.value)}
            placeholder="YYYY-MM-DD"
            type="date"
            value={tripEndDate}
          />
        </Field>
      </div>
      {tripStartDate && tripEndDate ? (
        <StepNote tone="neutral">
          <span className="font-black">{durationSummary}.</span>{" "}
          {/* Only an overnight stay joins two days (owner, 2026-09-18 — see overnight-evidence.ts). */}
          {tripStartDate < tripEndDate
            ? "Two dates mean you stayed away overnight. If you came home the same day, choose one date and file each day as its own trip."
            : null}
        </StepNote>
      ) : null}

      {isNonTravel ? null : (
        <Field as="div" label="How you travelled">
          <ChoiceTiles
            columns={4}
            label="Transportation type"
            onChange={(value) => handleTransportationTypeChange(value)}
            options={transportOptions}
            value={transportationType}
          />
        </Field>
      )}

      {useAreaRepPicker ? (
        <Field label="Area">
          <SearchableSelect
            className="w-full px-3 disabled:text-slate-400"
            onChange={(event) => handleAreaSelection(event.target.value)}
            value={selectedAreaCode}
          >
            <option value="">Select area</option>
            {areaRepOptions.map((option) => (
              <option key={option.areaCode} value={option.areaCode}>
                {option.areaName}
                {option.isVacant ? " (vacant)" : ""}
              </option>
            ))}
          </SearchableSelect>
          {selectedAreaOption ? (
            <p className="mt-2 text-xs font-semibold text-slate-500">
              {selectedAreaOption.repHrId
                ? `Medical rep: ${formatEmployeeDisplayName(selectedAreaOption.repName)}`
                : "No medical rep is currently assigned to this area."}
            </p>
          ) : null}
        </Field>
      ) : (
        <Field label="Medical representative">
          <SearchableSelect
            className="w-full px-3 disabled:text-slate-400"
            disabled={medicalTripOptions.length === 0}
            onChange={(event) => setMedicalTripHrId(event.target.value)}
            value={medicalTripHrId}
          >
            <option value="">
              {medicalTripOptions.length === 0
                ? "No medical representatives in team"
                : "Select medical representative"}
            </option>
            {medicalTripOptions.map((option) => (
              <option key={option.hrId} value={option.hrId}>
                {formatEmployeeDisplayName(option.name)}
              </option>
            ))}
          </SearchableSelect>
        </Field>
      )}
    </div>
  );

  const destinationBody = (
    <div className="grid gap-5">
      {/* From is not a choice: it is the registered home the distance is measured from. Said here,
          on the step it belongs to, together with whether that home has a GPS point at all. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="From — your registered home">
          <LocationReadout value={residenceSummary || fromShortLabel} />
        </Field>
        <Field label="Home GPS">
          <LocationReadout value={hasResidenceCoordinates ? "Ready" : "Missing"} />
        </Field>
      </div>
      {!hasResidenceCoordinates ? (
        <StepNote tone="bad">
          Your home GPS is missing, so the distance cannot be measured. Ask HR to set your residence in
          your profile before you submit.
        </StepNote>
      ) : null}

      <button
        aria-label={
          captured
            ? `Capture the destination again. Now: ${destinationLocation.fullAddress}`
            : "Capture current location for destination"
        }
        className={cn(phxButtonPrimaryClassName, "min-h-12 w-full justify-center text-base sm:w-auto")}
        disabled={isCapturing}
        onClick={() => void captureLocation()}
        type="button"
      >
        {isCapturing ? <LoadingSpinner className="text-white" /> : <MapPin aria-hidden className="h-4 w-4" />}
        {isCapturing ? "Capturing your location…" : captured ? "Capture again" : "Capture my location"}
      </button>

      {captured ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Area / Brick">
            <LocationReadout value={destinationLocation.area} />
          </Field>
          <Field label="Governorate">
            <LocationReadout value={destinationLocation.governorate} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="To — the address captured">
              <LocationReadout value={destinationLocation.fullAddress} />
            </Field>
          </div>
        </div>
      ) : (
        <StepNote tone="neutral">
          Phoenix reads your phone&apos;s GPS once, here, and measures the trip from your home to this point.
        </StepNote>
      )}
    </div>
  );

  const evidenceBody = (
    <div className="grid gap-5">
      {/* Hidden outright for the waived roles (owner request 2026-08-19) rather than shown as
          "optional": these managers are not being asked to weigh a choice, the step is simply no
          longer part of their submission. A block that stays on screen saying "you may skip this"
          is the same requirement, only asked more quietly. */}
      {!arrivalPhotoOwed ? null : (
        <section aria-label={arrivalPhotoBadge} className="grid gap-3 border border-slate-200 bg-white p-4">
          <div>
            <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-orange-600">{arrivalPhotoBadge}</p>
            <h3 className="mt-1 text-base font-black text-slate-900">{arrivalPhotoHeading}</h3>
            <p className="mt-1 text-sm leading-6 text-slate-600">{arrivalPhotoHint}</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              className={cn(phxButtonAccentClassName, "min-h-12 w-full justify-center")}
              disabled={isCapturingCarEvidence || isCarEvidenceCameraOpen}
              onClick={() => void openCarEvidenceCamera()}
              type="button"
            >
              {isCapturingCarEvidence ? (
                <>
                  <LoadingSpinner className="text-white" />
                  Opening…
                </>
              ) : (
                <>
                  <Camera aria-hidden className="h-4 w-4" />
                  {isCarEvidenceCameraOpen ? "Camera open" : carEvidence ? "Take it again" : "Open camera"}
                </>
              )}
            </button>
            {canUploadArrivalPhoto ? (
              <label className="flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 border border-dashed border-orange-400 bg-orange-50 px-4 text-sm font-bold text-orange-800 transition hover:bg-orange-100">
                <Upload aria-hidden className="h-4 w-4" />
                {carEvidence?.source === "upload" ? "Replace the uploaded photo" : "Or upload a photo"}
                <input
                  accept="image/*"
                  className="hidden"
                  disabled={isCapturingCarEvidence}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    // Cleared so re-picking the SAME file fires change again; without this a
                    // failed upload cannot be retried with the identical photo.
                    event.target.value = "";
                    if (file) void uploadArrivalEvidence(file);
                  }}
                  type="file"
                />
              </label>
            ) : null}
          </div>

          {isCarEvidenceCameraOpen ? (
            <div className="overflow-hidden border border-slate-200 bg-slate-950">
              <video ref={videoRef} autoPlay className="aspect-video w-full object-cover" muted playsInline />
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-slate-950 p-3">
                <p className="min-w-0 flex-1 basis-48 text-sm font-semibold text-white">
                  {transportationType === "car"
                    ? "Frame the car clearly, then take the photo."
                    : "Frame where you arrived — the station or the place — then take the photo."}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="inline-flex min-h-11 items-center border border-white/30 px-4 text-sm font-bold text-white hover:bg-white/10"
                    onClick={stopCarEvidenceCamera}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    className={cn(phxButtonAccentClassName, "min-h-11")}
                    disabled={isCapturingCarEvidence}
                    onClick={() => void captureCarEvidence()}
                    type="button"
                  >
                    {isCapturingCarEvidence ? <LoadingSpinner className="text-white" /> : <Camera aria-hidden className="h-4 w-4" />}
                    Take the photo
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="border border-slate-200 bg-slate-50 p-3">
            <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">Photo</p>
            <p className="mt-1 text-sm font-bold text-slate-900">{arrivalPhotoStatusLabel}</p>
            {carEvidence ? (
              <p className="mt-1 break-words text-sm text-slate-700" dir="auto">{carEvidence.capturedLocationLabel}</p>
            ) : (
              <p className="mt-1 text-sm font-semibold text-amber-800">{arrivalPhotoMissingMessage}</p>
            )}
          </div>

          {carEvidence?.imageDataUrl ? (
            <div className="relative overflow-hidden border border-slate-200">
              <ZoomablePhoto
                alt={`${arrivalPhotoBadge} preview`}
                caption={arrivalPhotoBadge}
                className="h-auto w-full object-cover"
                src={carEvidence.imageDataUrl}
              />
            </div>
          ) : carEvidence ? (
            <StepNote tone="warn">
              The photo details were kept, but the picture itself could not be restored on this phone. Take the
              photo again before you submit.
            </StepNote>
          ) : null}
        </section>
      )}

      {/* Rendered alongside the arrival photo, never instead of it — a train or bus claim carries
          BOTH its ticket and its live arrival photo. The card hides itself for car and other via
          `visible`. For a waived role the photo block is gone and this is the trip's only evidence
          surface, which is why it stays on screen for them — optional, but offered. */}
      <TicketUploadCard
        attachmentCount={ticketFiles.length}
        onFilesSelected={(files) => {
          // Judged when picked, so a PDF that is too big or a file that is not a ticket is named
          // here and never survives to a submit that could only refuse it.
          const picked = files ? Array.from(files) : [];
          const accepted: File[] = [];
          let refusal: string | null = null;
          for (const file of picked) {
            const verdict = checkTicketAttachmentFile(file);
            if (!verdict.ok) {
              refusal ??= verdict.message;
              continue;
            }
            if (accepted.length >= TICKET_MAX_FILES) {
              refusal ??= `Attach at most ${TICKET_MAX_FILES} files. The first ${TICKET_MAX_FILES} were kept.`;
              continue;
            }
            accepted.push(file);
          }
          setTicketFiles(accepted);
          setMessage(refusal);
        }}
        required={isTicketRequired}
        transportationType={transportationType}
        visible={isTicketBased || isNonTravel}
        {...(isNonTravel
          ? {
              badge: "Invoice or picture",
              description:
                "Attach the invoice or a picture of this expense — JPG, PNG or PDF, up to 3 files. You can submit without one, but the claim is then held for review before it moves to payroll.",
            }
          : {})}
      />

      {isTicketRequired && ticketFiles.length === 0 ? (
        <StepNote tone="warn">
          {isOffline ? "No connection: you" : "No ticket yet? You"} can submit without it now — the claim is held for review until you attach the ticket from My claims, below this form.
        </StepNote>
      ) : null}
      {!arrivalPhotoOwed && !(isTicketBased || isNonTravel) ? (
        <StepNote tone="neutral">Nothing to add on this step for your role. Press Next.</StepNote>
      ) : null}
    </div>
  );

  const amountsBody = (
    <div className="grid gap-5">
      {isNonTravel ? null : transportationType === "car" ? (
        <Field label="Kilometer reading">
          <Input
            inputMode="numeric"
            onChange={(event) => setKilometerReading(event.target.value)}
            placeholder="Odometer reading"
            type="number"
            value={kilometerReading}
          />
        </Field>
      ) : isTicketBased ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Go ticket amount (EGP)">
            <Input
              inputMode="decimal"
              onChange={(event) => setGoTicketAmount(event.target.value)}
              placeholder="EGP"
              type="number"
              value={goTicketAmount}
            />
          </Field>
          <Field label="Return ticket amount (EGP)">
            <Input
              inputMode="decimal"
              onChange={(event) => setReturnTicketAmount(event.target.value)}
              placeholder="EGP"
              type="number"
              value={returnTicketAmount}
            />
          </Field>
        </div>
      ) : null}

      {/*
        Meeting and Other are ALWAYS both shown, never gated on the expense type.

        They are additive line items on top of travel + allowance — reportExpectedTotal
        (src/lib/outstation/service.ts) adds travelCost + meetingAmount + allowanceAmount +
        otherAmount unconditionally — and the expense type only labels the trip. Production
        agrees: live rep-submitted requests are typed "traveling" while carrying a real
        meeting or parking cost (#45 "BRM for delta 1 team7" meeting 627.20, #114 parking
        20.00), which is the shape reps use most, so gating either box by type would make
        that trip unable to record its own cost.

        A SECOND, expenseType-gated pair of these same two inputs used to sit below Notes.
        It came first (1a9d4b482, 2026-06-11); this always-visible pair landed four days
        later in ec2a5dded ("expense report fields, rescued from #129") without removing it,
        so both were on screen at once, bound to the same meetingAmount / otherAmount state.
        The gated pair is the one that went, which also settles this screen on the same rule
        as the admin modal: see src/components/outstation/admin-manager-expense-modal.tsx and
        tests/outstation-admin-manual-expense-amount-visibility.test.ts (production request
        77, B-122: 550.00 typed under "meeting", saved under "other" with the visible box
        reading empty, because handleSubmit sends both amounts whatever is on screen).

        Do NOT reintroduce the conditional, and do NOT "fix" the submit payload by zeroing
        the amount that does not match the type — that would silently drop real money from
        every traveling trip that also had a meeting or a parking cost.
      */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Meeting Amount (EGP)">
          <Input
            min="0"
            onChange={(event) => setMeetingAmount(event.target.value)}
            placeholder="EGP"
            type="number"
            value={meetingAmount}
          />
        </Field>
        <Field label="Other Amount (EGP)">
          <Input
            min="0"
            onChange={(event) => setOtherAmount(event.target.value)}
            placeholder="EGP"
            type="number"
            value={otherAmount}
          />
        </Field>
      </div>
      <StepNote tone="neutral">
        {isNonTravel
          ? "A Meeting or Other expense is paid on these amounts alone. No distance, travel cost or allowance is calculated."
          : "Both are paid on top of the travel cost and the allowance, whatever the expense type is. Leave a box empty if that cost was not incurred."}
      </StepNote>

      {/*
        No AM / PM / Pharmacy boxes on this form, editable or disabled. The workload is read from
        Phoenix CRM after submission, as three figures (THE AM · PM · PHARMACIES GOLDEN RULE), and a
        trip stamped before the evening's visits were saved is re-read the next morning
        (runOutstationWorkloadRestamp). Three greyed-out boxes that could never hold anything were
        what this step showed until 2026-10-22; the Review step says what happens instead.
      */}
      <Field label="Notes">
        <textarea
          className={cn(phxTextareaClassName, "min-h-28")}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Anything your approver should know about this trip"
          value={notes}
        />
      </Field>
    </div>
  );

  const preview = afterSubmitGuidance({
    arrivalPhotoOwed,
    destination: captured ? destinationLocation.shortLabel : null,
    isCarTrip: !isNonTravel && transportationType === "car",
    isNonTravel,
    isTicketBased,
    ticketsAttached: ticketFiles.length,
  });

  const reviewBody = (
    <div className="grid gap-5">
      {isOffline ? (
        <StepNote tone="warn">
          No connection: the total is calculated when the claim reaches the server. Press Save offline — it is
          sent by itself when you are back online.
        </StepNote>
      ) : isCalculating || !calculation ? (
        <StepNote tone="neutral">
          <span className="inline-flex items-center gap-2 font-bold">
            <LoadingSpinner />
            {isNonTravel
              ? "Phoenix is totalling your amounts…"
              : "Phoenix is calculating the distance, the allowance and the total…"}
          </span>
        </StepNote>
      ) : null}

      {/* ONE review, never two. This step used to show the same figures three times — an "auto
          calculated summary", a second grid of the same values, and an eligibility card repeating
          distance and duration — so the employee read every number twice before finding the one
          that mattered. */}
      <dl className="grid border border-slate-200 bg-white sm:grid-cols-2" aria-label="Claim review">
        <ReviewRow label="Expense" value={`${expenseTypeOptions.find((option) => option.value === expenseType)?.label ?? expenseType}${isNonTravel ? "" : ` · ${transportOptions.find((option) => option.value === transportationType)?.label ?? transportationType}`}`} />
        <ReviewRow label="Dates" value={tripStartDate && tripEndDate ? `${tripStartDate === tripEndDate ? tripStartDate : `${tripStartDate} to ${tripEndDate}`} · ${durationSummary}` : "Not chosen yet"} />
        {isNonTravel ? null : <ReviewRow label="From" value={fromShortLabel} />}
        {isNonTravel ? null : <ReviewRow label="To" value={captured ? destinationLocation.fullAddress : "Not captured yet"} />}
        {selectedMedicalTripName ? <ReviewRow label="Medical rep" value={formatEmployeeDisplayName(selectedMedicalTripName)} /> : null}
        {arrivalPhotoOwed ? (
          <ReviewRow label="Arrival photo" tone={hasCarEvidence ? "good" : "bad"} value={hasCarEvidence ? arrivalPhotoStatusLabel : arrivalPhotoMissingShort} />
        ) : null}
        {isTicketBased || isNonTravel ? (
          <ReviewRow
            label={isNonTravel ? "Invoice" : "Ticket"}
            tone={ticketFiles.length > 0 ? "good" : isTicketRequired ? "bad" : "neutral"}
            value={
              ticketFiles.length > 0
                ? `${ticketFiles.length} file${ticketFiles.length === 1 ? "" : "s"} attached`
                : isTicketRequired
                  ? "None attached — held for review until you attach it"
                  : "None attached"
            }
          />
        ) : null}
        {calculation && !isNonTravel ? (
          <>
            <ReviewRow
              label="Distance"
              value={
                calculation.distanceFromResidenceKm != null
                  ? `${calculation.distanceFromResidenceKm.toFixed(2)} km${calculation.durationMinutes != null ? ` · about ${calculation.durationMinutes.toFixed(0)} minutes` : ""}`
                  : "Not available"
              }
            />
            <ReviewRow label={transportationType === "car" ? "Travel cost" : "Ticket cost"} value={egp(transportationType === "car" ? calculation.fuelAmount : calculation.ticketAmount)} />
            <ReviewRow label="Allowance" value={egp(calculation.allowanceAmount)} />
          </>
        ) : null}
        {calculation && calculation.reportMeetingAmount > 0 ? <ReviewRow label="Meeting" value={egp(calculation.reportMeetingAmount)} /> : null}
        {calculation && calculation.reportOtherAmount > 0 ? <ReviewRow label="Other" value={egp(calculation.reportOtherAmount)} /> : null}
        {calculation ? (
          <ReviewRow
            label="Total"
            strong
            tone={calculation.eligibilityStatus === "not_eligible" ? "bad" : "neutral"}
            value={egp(calculation.expectedTotalAmount)}
          />
        ) : null}
        {calculation ? (
          <ReviewRow
            label="Eligibility"
            tone={calculation.eligibilityStatus === "not_eligible" ? "bad" : calculation.eligibilityStatus === "eligible" ? "good" : "warn"}
            value={`${calculation.eligibilityStatus.replace(/_/g, " ")} — ${calculation.eligibilityReason}`}
          />
        ) : null}
      </dl>

      {calculation ? (
        <div className="flex flex-wrap items-start gap-3 border border-slate-200 bg-slate-50 p-3">
          <ApprovalRecommendationBadge value={calculation.approvalRecommendation} />
          <p className="min-w-0 flex-1 basis-56 break-words text-sm leading-6 text-slate-700">{calculation.approvalReason}</p>
        </div>
      ) : null}
      {calculation?.routeError ? (
        <StepNote tone="warn">
          <span className="font-black">Route:</span> {calculation.routeError}
        </StepNote>
      ) : null}
      {isNonTravel ? null : <RouteMapPreview request={calculation} />}

      <section aria-label="After you submit" className="border border-slate-200 bg-white p-4">
        <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-orange-600">After you submit</p>
        <NextSteps items={preview.slice(1, 3)} />
      </section>
    </div>
  );

  const bodies: Record<(typeof steps)[number]["key"], ReactNode> = {
    amounts: amountsBody,
    destination: destinationBody,
    evidence: evidenceBody,
    review: reviewBody,
    trip: tripBody,
  };

  // The bar under his thumb, read the way Log a visit's is: what this step still needs ("Now", or
  // "Still needed" once he pressed on without it), and when it needs nothing, the step after it.
  const barProblem = isReviewStep ? reviewHold : stepProblem;
  const barStatus: ReactNode = message ? (
    messageIsConfirmation ? (
      <p className="flex min-w-0 items-start gap-2 text-sm font-black text-emerald-800">
        <CircleCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        <span className="min-w-0 break-words">{message}</span>
      </p>
    ) : (
      <p className="flex min-w-0 items-start gap-2 text-sm font-black text-amber-800">
        <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="min-w-0 break-words">{message}</span>
      </p>
    )
  ) : barProblem ? (
    <button
      className="flex min-h-11 w-full min-w-0 items-start gap-2 text-left disabled:cursor-default"
      disabled={!isReviewStep || !firstOpen}
      onClick={() => {
        if (isReviewStep && firstOpen) showStep(firstOpen.index + 1);
      }}
      type="button"
    >
      <ArrowRight aria-hidden className={cn("mt-0.5 h-4 w-4 shrink-0", tried ? "text-rose-600" : "text-orange-600")} />
      <span className="min-w-0">
        <span className={cn("block text-phx-2xs font-black uppercase tracking-[0.16em]", tried ? "text-rose-600" : "text-orange-600")}>
          {tried ? "Still needed" : "Now"}
        </span>
        <span className={cn("block break-words text-sm font-black", tried ? "text-rose-700" : "text-slate-950")}>{barProblem}</span>
      </span>
    </button>
  ) : isReviewStep ? (
    <p className="flex min-w-0 items-start gap-2">
      <CircleCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
      <span className="min-w-0">
        <span className="block break-words text-sm font-black text-slate-950">
          {isOffline ? "Ready to save on this phone" : `Ready to submit${calculation ? ` · ${egp(calculation.expectedTotalAmount)}` : ""}`}
        </span>
        <span className="block break-words text-xs font-semibold leading-5 text-slate-500">
          {arrivalPhotoOwed ? "Next: the departure photo, before you leave." : "Next: validation, then payroll."}
        </span>
      </span>
    </p>
  ) : nextStep ? (
    <p className="flex min-w-0 items-start gap-2">
      <CircleCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
      <span className="min-w-0">
        <span className="block text-phx-2xs font-black uppercase tracking-[0.16em] text-emerald-700">Done · Next</span>
        <span className="block break-words text-sm font-black text-slate-950">
          {nextStep.label} — {nextStep.description}
        </span>
      </span>
    </p>
  ) : null;

  return (
    <div className="min-w-0 space-y-4" ref={formTopRef}>
      <OfflineSyncBanner visible={isOffline} />
      {permissionPrompt ? (
        <PermissionPromptModal
          blocked={permissionPrompt.blocked}
          kind={permissionPrompt.kind}
          onAccept={() => void acceptPermissionPrompt()}
          onDecline={declinePermissionPrompt}
        />
      ) : null}

      {/* 🔴 NO PAGE TITLE HERE. The portal shell already prints "Submit Expense", and the admin shell
          prints its own; a second heading was removed on 2026-09-30 (tests/portal-single-header). */}
      {submitted ? (
        <SubmittedClaimPanel
          claim={submitted}
          employeeHrId={employeeHrId}
          onAnother={() => {
            setSubmitted(null);
            showStep(1);
          }}
        />
      ) : (
        <FormWizard
          badge={
            <span className="inline-flex max-w-full items-center gap-1.5 break-words border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">
              {expenseTypeOptions.find((option) => option.value === expenseType)?.label ?? "Expense"}
              {isNonTravel ? "" : ` · ${transportOptions.find((option) => option.value === transportationType)?.label ?? ""}`}
            </span>
          }
          bleed
          // Back to any step; forward only as far as the first step that still needs something.
          canJump={(target) => target < stepNumber || target <= (firstOpen ? firstOpen.index + 1 : steps.length)}
          footer={<></>}
          footnote="Nothing is sent until you press Submit. Phoenix measures the distance and calculates the allowance and the travel cost on the server."
          footnoteIcon={false}
          header="strip"
          onStepChange={showStep}
          step={stepNumber}
          steps={steps}
        >
          <div aria-busy={isCalculating} className="min-w-0 px-4 pb-5 sm:px-5">
            {/* What to do in THIS step, in one sentence, before anything else on it. */}
            <p className="mb-5 flex items-start gap-2 border-l-[3px] border-orange-500 bg-orange-50 px-3 py-2.5 text-sm font-bold leading-6 text-slate-900">
              {submitExpenseStepInstruction(currentStep.key, facts)}
            </p>
            {bodies[currentStep.key]}
          </div>

          {/* Held above the portal's bottom bar on phones (--phx-portal-bottom-nav-reserve is its
              height there and 0 elsewhere), under his thumb wherever he has scrolled to — the same
              bar Log a visit and the weekly plan carry. Every message lands here, in view, never in
              a card below a fixed footer where a refusal used to fall off-screen. */}
          <div
            aria-label="Submit expense action bar"
            data-portal-action-bar=""
            className="sticky bottom-[var(--phx-portal-bottom-nav-reserve,0px)] z-20 border-t border-orange-300 bg-white px-4 py-3 shadow-[0_-10px_30px_rgba(15,23,42,0.12)] sm:px-5 print:hidden"
            data-no-print
            role="region"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              <div aria-live="polite" className="min-w-0 flex-1 basis-56" data-action-bar-status="">
                {barStatus}
              </div>
              <div className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-2 sm:flex sm:w-auto sm:flex-row-reverse">
                {isReviewStep ? (
                  <button
                    className={cn(phxButtonAccentClassName, "min-h-12 justify-center text-base sm:min-w-40")}
                    disabled={
                      isSubmitting ||
                      (!isOffline && (isCalculating || !calculation)) ||
                      calculation?.eligibilityStatus === "not_eligible" ||
                      (!hasCarEvidence && arrivalPhotoOwed)
                    }
                    onClick={() => {
                      if (firstOpen) {
                        setTried(true);
                        return;
                      }
                      void submit();
                    }}
                    type="button"
                  >
                    {isSubmitting ? <LoadingSpinner className="text-white" /> : null}
                    {isSubmitting ? "Submitting…" : isOffline ? "Save offline" : "Submit"}
                  </button>
                ) : (
                  <button
                    className={cn(phxButtonPrimaryClassName, "min-h-12 justify-center text-base sm:min-w-40")}
                    onClick={goNext}
                    type="button"
                  >
                    Next
                    <ChevronRight aria-hidden className="h-4 w-4" />
                  </button>
                )}
                <button
                  className={cn(phxButtonGhostClassName, "order-first min-h-12 justify-center sm:order-none")}
                  disabled={stepNumber === 1 || isSubmitting}
                  onClick={() => showStep(stepNumber - 1)}
                  type="button"
                >
                  <ChevronLeft aria-hidden className="h-4 w-4" />
                  Back
                </button>
              </div>
            </div>
          </div>
        </FormWizard>
      )}
    </div>
  );
}

/** A tap is the step's answer, as on Log a visit's choice steps. Square, like every CRM tile. */
function ChoiceTiles<T extends string>({
  columns = 3,
  label,
  onChange,
  options,
  value,
}: {
  columns?: 3 | 4;
  label: string;
  onChange: (next: T) => void;
  options: ReadonlyArray<{ label: string; value: T }>;
  value: T;
}) {
  return (
    <div
      aria-label={label}
      className={cn("grid gap-1.5", columns === 4 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3")}
      role="radiogroup"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            aria-checked={selected}
            className={cn(
              "min-h-11 min-w-0 border px-3 py-2 text-sm font-black transition",
              selected ? "border-orange-500 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
            )}
            key={option.value}
            onClick={() => onChange(option.value)}
            role="radio"
            type="button"
          >
            <span className="block break-words">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const NOTE_TONES = {
  bad: "border-rose-200 bg-rose-50 text-rose-800",
  neutral: "border-slate-200 bg-slate-50 text-slate-700",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
} as const;

function StepNote({ children, tone }: { children: ReactNode; tone: keyof typeof NOTE_TONES }) {
  return (
    <div className={cn("border px-3.5 py-3 text-sm leading-6", NOTE_TONES[tone])} role={tone === "bad" ? "alert" : undefined}>
      <div className="break-words font-medium">{children}</div>
    </div>
  );
}

const REVIEW_TONES = {
  bad: "text-rose-700",
  good: "text-emerald-700",
  neutral: "text-slate-900",
  warn: "text-amber-800",
} as const;

function ReviewRow({
  label,
  strong = false,
  tone = "neutral",
  value,
}: {
  label: string;
  strong?: boolean;
  tone?: keyof typeof REVIEW_TONES;
  value: string;
}) {
  return (
    <div className="min-w-0 border-b border-slate-100 px-3 py-2.5 sm:odd:border-r">
      <dt className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">{label}</dt>
      <dd className={cn("mt-0.5 break-words", strong ? "text-lg font-black" : "text-sm font-bold", REVIEW_TONES[tone])} dir="auto">
        {value}
      </dd>
    </div>
  );
}

/** The rail of what is still owed — done, now, next — shared by the Review step and the screen after Submit. */
function NextSteps({ items }: { items: ReadonlyArray<AfterSubmitItem> }) {
  return (
    <ol className="mt-3 grid gap-3">
      {items.map((item, index) => (
        <li className="flex items-start gap-3" key={item.key}>
          <span
            aria-hidden
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center text-xs font-black",
              item.state === "done"
                ? "bg-orange-100 text-orange-700"
                : item.state === "now"
                  ? "bg-orange-600 text-white"
                  : item.state === "if-needed"
                    ? "border border-dashed border-orange-400 bg-white text-orange-700"
                    : "border border-slate-300 bg-white text-slate-400",
            )}
          >
            {item.state === "done" ? <Check className="h-4 w-4" /> : index + 1}
          </span>
          <div className="min-w-0">
            <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">
              {item.state === "done"
                ? "Done"
                : item.state === "now"
                  ? "Now"
                  : item.state === "if-needed"
                    ? "If you drive on"
                    : "Next"}
            </p>
            <p className={cn("break-words text-sm font-black", item.state === "next" ? "text-slate-500" : "text-slate-950")} dir="auto">
              {item.title}
            </p>
            <p className="mt-0.5 break-words text-xs leading-5 text-slate-500">{item.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * The screen after Submit (owner, 2026-10-22). It replaces a form that reset in silence: the claim's
 * number, and what is still owed on it, in order — the departure photo first when the trip owes one.
 */
function SubmittedClaimPanel({
  claim,
  employeeHrId,
  onAnother,
}: {
  claim: SubmittedClaim;
  employeeHrId: string;
  onAnother: () => void;
}) {
  if (claim.dryRun) {
    return (
      <TestClaimPanel
        employeeHrId={employeeHrId}
        expectedTotal={claim.dryRun.expectedTotal}
        onAnother={onAnother}
        rehearsal={claim.dryRun.rehearsal}
      />
    );
  }
  const items = afterSubmitGuidance(claim);
  return (
    <section aria-label="Claim submitted" className="border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-4 sm:px-8">
        <p className="flex items-center gap-2 text-phx-2xs font-black uppercase tracking-[0.18em] text-emerald-700">
          <CircleCheck aria-hidden className="h-4 w-4" />
          Submitted
        </p>
        <h2 className="mt-1 text-lg font-black text-slate-900">
          {claim.id ? `Claim OUTSTATION-${claim.id} is in` : "Your claim is in"}
        </h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">Here is what happens now, step by step.</p>
      </div>
      <div className="px-5 pb-5 sm:px-8">
        <NextSteps items={items} />
        <div className="mt-6 flex flex-wrap gap-2 border-t border-slate-200 pt-5">
          <a className={cn(phxButtonPrimaryClassName, "min-h-12 justify-center")} href={`#${MY_CLAIMS_ANCHOR}`}>
            See it under My claims
            <ChevronRight aria-hidden className="h-4 w-4" />
          </a>
          <button className={cn(phxButtonGhostClassName, "min-h-12 justify-center")} onClick={onAnother} type="button">
            Submit another expense
          </button>
        </div>
      </div>
    </section>
  );
}

/** A test account's Submit: the same panel, saying the claim was checked and nothing was kept. */
function TestClaimPanel({
  employeeHrId,
  expectedTotal,
  onAnother,
  rehearsal,
}: {
  employeeHrId: string;
  expectedTotal: number | null;
  onAnother: () => void;
  rehearsal: RehearsalTrip | null;
}) {
  return (
    <section aria-label="Test claim checked" className="border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-4 sm:px-8">
        <p className="flex items-center gap-2 text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">
          <CircleCheck aria-hidden className="h-4 w-4" />
          Test account
        </p>
        <h2 className="mt-1 text-lg font-black text-slate-900">{TEST_CLAIM_NOT_SAVED_TITLE}</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">{TEST_CLAIM_NOT_SAVED_DETAIL}</p>
        {expectedTotal != null ? (
          <p className="mt-2 text-sm font-black text-slate-900">Phoenix priced it at {egp(expectedTotal)}.</p>
        ) : null}
      </div>
      <div className="px-5 pb-5 sm:px-8">
        {rehearsal ? <JourneyStopRehearsal employeeHrId={employeeHrId} trip={rehearsal} /> : null}
        <div className="mt-5 flex flex-wrap gap-2">
          <button className={cn(phxButtonGhostClassName, "min-h-12 justify-center")} onClick={onAnother} type="button">
            Submit another expense
          </button>
        </div>
      </div>
    </section>
  );
}

/** A read-only value, wrapped rather than cut: an address is read in full (the no-ellipsis rule). */
function LocationReadout({ value }: { value: string }) {
  return (
    <div className="flex min-h-11 items-center border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-800">
      <span className="min-w-0 break-words" dir="auto">
        {value}
      </span>
    </div>
  );
}

function permissionPromptCopy(kind: PermissionPromptKind, blocked?: boolean) {
  if (kind === "camera") {
    return {
      badge: blocked ? "Camera blocked" : "Camera permission",
      description: blocked
        ? "Camera is blocked by the browser for this website. Open browser settings, change camera to Allow for this site, return here, then retry. If the permission is still set to Ask, the browser will show its real camera prompt."
        : "Phoenix will request the real browser camera permission now. If you approve it, the camera opens immediately.",
      title: blocked ? "Camera permission blocked" : "Camera permission required",
    };
  }

  if (kind === "car-evidence-location") {
    return {
      badge: blocked ? "Location blocked" : "Location permission",
      description: blocked
        ? "Location is blocked by the browser for this website. Open browser settings, change location to Allow for this site, return here, then retry."
        : "Phoenix will request the real browser location permission now and attach the GPS position to this car photo.",
      title: blocked ? "Location permission blocked" : "Location permission required",
    };
  }

  return {
    badge: blocked ? "Location blocked" : "Location permission",
    description: blocked
      ? "Location is blocked by the browser for this website. Open browser settings, change location to Allow for this site, return here, then retry."
      : "Phoenix will request the real browser location permission now and use it to capture your destination.",
    title: blocked ? "Location permission blocked" : "Location permission required",
  };
}

function PermissionPromptModal({
  blocked = false,
  kind,
  onAccept,
  onDecline,
}: {
  blocked?: boolean;
  kind: PermissionPromptKind;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const copy = permissionPromptCopy(kind, blocked);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [settingsAttempted, setSettingsAttempted] = useState(false);
  const settingsUrl = getPermissionSettingsUrl(kind);
  const siteUrl = getCurrentSiteUrl();
  const steps = getPermissionSettingsSteps(kind);

  function handleOpenSettings() {
    setSettingsAttempted(true);
    if (!settingsUrl) {
      return;
    }

    try {
      window.open(settingsUrl, "_blank", "noopener,noreferrer");
    } catch {
      // Browser security commonly blocks internal settings URLs from webpages.
    }
  }

  async function copyText(value: string, label: string) {
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage(`${label} copied.`);
    } catch {
      setCopyMessage(`Could not copy ${label.toLowerCase()}. Select and copy it manually.`);
    }
  }

  return (
    <div
      aria-labelledby="outstation-permission-title"
      aria-modal="true"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/45 px-4 py-6 backdrop-blur-sm"
      role="dialog"
    >
      <div className="w-full max-w-md border border-slate-200 bg-white p-5">
        <span className="inline-flex bg-orange-50 px-2 py-1 text-phx-2xs font-bold uppercase tracking-[0.14em] text-orange-600">
          {copy.badge}
        </span>
        <h2 id="outstation-permission-title" className="mt-3 text-lg font-bold text-slate-900">
          {copy.title}
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">{copy.description}</p>
        {blocked ? (
          <p className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium leading-5 text-amber-800">
            Browser security can prevent the native prompt from appearing again after a permanent block.
            The app can open settings as a shortcut, but you must switch this site&apos;s permission to Allow.
          </p>
        ) : null}
        {blocked ? (
          <button
            className={cn(phxButtonGhostClassName, "mt-4 min-h-11 w-full justify-center")}
            onClick={handleOpenSettings}
            type="button"
          >
            Open settings / show steps
          </button>
        ) : null}
        {blocked && settingsAttempted ? (
          <div className="mt-4 border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-700">
            <p className="font-semibold text-slate-900">
              If no settings page opened, your browser blocked the shortcut.
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-4">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {settingsUrl ? (
                <button
                  className={cn(phxButtonGhostClassName, "min-h-10 justify-center text-xs")}
                  onClick={() => void copyText(settingsUrl, "Settings shortcut")}
                  type="button"
                >
                  Copy settings shortcut
                </button>
              ) : null}
              {siteUrl ? (
                <button
                  className={cn(phxButtonGhostClassName, "min-h-10 justify-center text-xs")}
                  onClick={() => void copyText(siteUrl, "Site URL")}
                  type="button"
                >
                  Copy site URL
                </button>
              ) : null}
            </div>
            {copyMessage ? (
              <p className="mt-2 font-medium text-slate-600">{copyMessage}</p>
            ) : null}
          </div>
        ) : null}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button className={cn(phxButtonGhostClassName, "min-h-11 justify-center")} onClick={onDecline} type="button">
            Decline
          </button>
          <button className={cn(phxButtonAccentClassName, "min-h-11 justify-center")} onClick={onAccept} type="button">
            {blocked ? "Accept & retry" : "Accept"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Field lives in `src/components/outstation/wizard-primitives.tsx`.
