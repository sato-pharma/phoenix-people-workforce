"use client";

import { Camera, MapPin, Upload } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { ApprovalRecommendationBadge } from "@/components/outstation/approval-recommendation-badge";
import { EligibilityResultCard } from "@/components/outstation/eligibility-result-card";
import { OfflineSyncBanner } from "@/components/outstation/offline-sync-banner";
import { OutstationCostBreakdown } from "@/components/outstation/outstation-cost-breakdown";
import { RouteMapPreview } from "@/components/outstation/route-map-preview";
import { TicketUploadCard } from "@/components/outstation/ticket-upload-card";
import {
  Field,
  FieldValue,
  Stat,
  SummaryValue,
  WizardStep,
} from "@/components/outstation/wizard-primitives";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { PremiumTooltip } from "@/components/ui/premium-tooltip";
import {
  isOutstationEvidenceWaivedRole,
  isOutstationTicketWaivedRole,
} from "@/lib/outstation/evidence-waiver";
import {
  isRestorableOutstationLocalDraft,
  outstationDraftStorageKey,
  parseOutstationLocalDraft,
  type OutstationLocalDraft,
} from "@/lib/outstation/local-draft";
import type {
  OutstationCalculationResult,
  OutstationCaptureResult,
  OutstationCarEvidenceMetadata,
  OutstationCarEvidenceSource,
  OutstationExpenseType,
  OutstationTransportationType,
} from "@/lib/outstation/types";
import { formatEmployeeDisplayName } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { ManagerAreaRepOption } from "@/lib/outstation/area-rep-options";
import {
  drawEvidenceWatermark,
  getCompressedEvidenceCanvasSize,
  resolveEvidenceLocationStamp,
} from "@/components/outstation/evidence-watermark";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";


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

const draftKey = outstationDraftStorageKey;

function buildDraftId() {
  return typeof crypto === "undefined" || typeof crypto.randomUUID !== "function"
    ? `car-evidence-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    : crypto.randomUUID();
}

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read the selected file."));
    reader.readAsDataURL(file);
  });
}

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
  showIntro = true,
}: {
  areaRepOptions?: ManagerAreaRepOption[];
  employeeHrId: string;
  employeeName: string;
  employeeRole: string;
  hasResidenceCoordinates: boolean;
  medicalTripOptions: MedicalTripOption[];
  residenceShortSummary?: string;
  residenceSummary: string;
  showIntro?: boolean;
}) {
  const [step, setStep] = useState(1);
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
  const isTicketBased = transportationType === "train" || transportationType === "bus";
  // Owner request 2026-08-19: Product Manager, Group Product Manager and National Sales Manager
  // submit with no evidence photo at all, and their train/bus ticket is optional. The rule lives
  // in src/lib/outstation/evidence-waiver.ts and the SERVER applies the same predicate to the
  // same role string — this is the screen agreeing with the gate, not a second copy of the rule.
  //
  // `employeeRole` is the canonical job-function role the page was rendered with, so a waived
  // manager never sees the photo step. Hiding a step the server still demanded (or the reverse)
  // is exactly the dead-end this page had to be fixed for on 2026-08-04.
  const isEvidencePhotoWaived = isOutstationEvidenceWaivedRole(employeeRole);
  const isTicketRequired = isTicketBased && !isOutstationTicketWaivedRole(employeeRole);
  // The arrival photo is required for EVERY transportation type — validateLiveArrivalEvidence()
  // was widened past `car` on 2026-08-04. The capture card below must therefore render for every
  // type too. While it rendered on `car` only, a train or bus employee had no control anywhere on
  // the page that could satisfy a rule the server was already enforcing, so every train and bus
  // submission died on a 400 that the mobile layout pushed off-screen below the sticky footer.
  const arrivalPhotoBadge = transportationType === "car" ? "Car live photo" : "Arrival photo";
  // Owner request 2026-08-05: a non-car trip may satisfy the arrival photo by UPLOADING one
  // instead of capturing it live. Car is deliberately excluded — validateLiveArrivalEvidence
  // still refuses anything but a live capture there, and offering an upload button that the
  // server would then reject is exactly the dead-end this whole page just got fixed for.
  const canUploadArrivalPhoto = transportationType !== "car";
  const arrivalPhotoHeading = canUploadArrivalPhoto
    ? "Add one arrival photo — take it live or upload it"
    : "Capture one live photo from device camera";
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
        ? "Camera permission was declined. The car photo cannot be captured without camera access."
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
    window.localStorage.removeItem(draftKey);
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
  }, [stopCarEvidenceCamera]);

  useEffect(() => {
    const restore = parseOutstationLocalDraft(window.localStorage.getItem(draftKey));
    if (!isRestorableOutstationLocalDraft(restore)) {
      window.localStorage.removeItem(draftKey);
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
  }, []);

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
        window.localStorage.removeItem(draftKey);
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
      returnTicketAmount,
      syncPending: true,
      transportationType,
      travelCostAmount: "",
      tripType: durationSummary,
      tripEndDate,
      tripStartDate,
    };
    window.localStorage.setItem(draftKey, JSON.stringify(draft));
  }, [
    captured,
    carEvidence?.capturedAt,
    carEvidence?.source,
    carEvidence?.imageDataUrl,
    carEvidence?.capturedLatitude,
    carEvidence?.capturedLocationLabel,
    carEvidence?.capturedLongitude,
    carEvidenceDraftId,
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
        const draft = parseOutstationLocalDraft(window.localStorage.getItem(draftKey));
        if (
          !draft?.syncPending ||
          !draft.captured ||
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
            resetFormState();
            setMessage("Offline outstation draft synced successfully after reconnecting.");
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
  }, [employeeHrId, isOffline, medicalTripOptions, resetFormState]);

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
      capturedAccuracyMeters: captured?.capturedAccuracyMeters ?? 0,
      capturedAt: captured?.capturedAt,
      capturedLatitude: captured?.capturedLatitude ?? 0,
      capturedLongitude: captured?.capturedLongitude ?? 0,
      carEvidenceMetadata,
      claimedTotalAmount: 0,
      expenseType,
      goTicketAmount: Number(goTicketAmount || 0),
      hasTicketAttachments,
      kilometerReading: Number(kilometerReading || 0),
      meetingAmount: Number(meetingAmount || 0),
      medicalTripHrId,
      medicalTripName: selectedMedicalTripName,
      notes,
      offlineCaptured: isOffline,
      otherAmount: Number(otherAmount || 0),
      pmWorkload: Number(pmWorkload || 0),
      returnTicketAmount: Number(returnTicketAmount || 0),
      transportationType,
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

  const canAutoCalculate = Boolean(captured && tripStartDate && tripEndDate);
  const calculationKey = useMemo(() => {
    if (!captured || !tripStartDate || !tripEndDate) return "";

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
    if (!captured) {
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
        setCaptured(offlineCapture);
        setStep(2);
        setMessage("Destination captured offline. The draft will sync when internet returns.");
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
      setStep(2);
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
      setMessage("Live car photo captured. This photo is attached to this request.");
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
      setMessage("Arrival photo uploaded. It is marked as uploaded, not captured live.");
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
    if (!captured) {
      setMessage("Tap the To field to capture your current destination first.");
      return;
    }

    if (!hasCarEvidence && !isEvidencePhotoWaived) {
      setMessage(arrivalPhotoMissingMessage);
      return;
    }

    if (!isOffline && isTicketRequired && ticketFiles.length === 0) {
      setMessage("Upload the ticket before submitting this train or bus request.");
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
      // Ticket files are uploaded on the online path only; the offline path cannot carry them.
      const ticketAttachments =
        !isOffline && isTicketBased && ticketFiles.length > 0
          ? await Promise.all(
              ticketFiles.map(async (file) => ({
                dataUrl: await fileToDataUrl(file),
                name: file.name,
              })),
            )
          : undefined;
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
          carEvidenceImageDataUrl: carEvidence?.imageDataUrl,
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

      resetFormState();
      setMessage(
        isOffline
          ? "Offline request synced successfully."
          : "Outstation request submitted successfully.",
      );
    } catch {
      setMessage("Unable to submit the request.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <OfflineSyncBanner visible={isOffline} />
      {permissionPrompt ? (
        <PermissionPromptModal
          blocked={permissionPrompt.blocked}
          kind={permissionPrompt.kind}
          onAccept={() => void acceptPermissionPrompt()}
          onDecline={declinePermissionPrompt}
        />
      ) : null}

      {showIntro ? (
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-6">
          <p className="text-phx-2xs font-semibold uppercase tracking-wider text-orange-600">
            Outstation Expense
          </p>
          <h1 className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl">
            Smart expense entry
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-500">
            From is locked to your registered residence. Tap To so Phoenix Workforce captures
            your live destination, validates distance, detects fraud signals, and calculates
            the request automatically on the server.
          </p>
          <div className="mt-4 grid grid-cols-2 divide-x divide-y divide-gray-100 overflow-hidden rounded-md border border-gray-100 sm:grid-cols-4">
            <Stat label="Employee" value={formatEmployeeDisplayName(employeeName)} />
            <Stat label="Role" value={employeeRole} />
            <Stat label="From" value={fromShortLabel} />
            <Stat
              label="Residence GPS"
              value={hasResidenceCoordinates ? "Ready" : "Missing"}
            />
          </div>
        </section>
      ) : null}

      {/* Step indicator — flat thin pills, no oversized icon boxes */}
      <div
        aria-label="Submission progress"
        className="overflow-hidden rounded-md border border-gray-100 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)]"
        role="group"
      >
        <div className="grid grid-cols-3 divide-x divide-gray-100">
          <WizardStep active={step === 1} index={1} label="Trip details" />
          <WizardStep active={step === 2} index={2} label="Validate route" />
          <WizardStep active={step === 3} index={3} label="Review & submit" />
        </div>
      </div>

      <Card
        aria-busy={isCalculating}
        className="rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="rounded-md bg-orange-50 px-2 py-1 text-phx-2xs font-bold uppercase tracking-wider text-orange-600">
            Request details
          </span>
        </div>
        <h2 className="mt-2 text-base font-bold text-slate-800 sm:text-lg">
          Fill the trip and let the system calculate the rest
        </h2>

        {/* Conditional hint banner */}
        {(!hasResidenceCoordinates || isOffline) && (
          <div
            className={`mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-phx-sm ${
              !hasResidenceCoordinates
                ? "border-rose-200 bg-rose-50 text-rose-700"
                : "border-amber-200 bg-amber-50 text-amber-800"
            }`}
            role="status"
          >
            <span
              className={`mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-sm ${
                !hasResidenceCoordinates ? "bg-rose-500" : "bg-amber-500"
              }`}
            />
            <span>
              {!hasResidenceCoordinates
                ? "Residence GPS coordinates are missing. Ask HR to set your residence in your profile before submitting."
                : "You are offline. The request will be saved locally and synced automatically when you reconnect."}
            </span>
          </div>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <span className="mb-1 block text-phx-2xs font-semibold uppercase tracking-wider text-slate-500">
              Expense Type
            </span>
            <ChoiceGroup
              aria-label="Expense type"
              className="grid-cols-3 rounded-md"
              onChange={(value) => setExpenseType(value)}
              options={[
                { label: "Traveling", value: "traveling" },
                { label: "Meeting", value: "meeting" },
                { label: "Other", value: "other" },
              ]}
              optionClassName="min-h-11"
              value={expenseType}
            />
          </div>

          <Field label="From Date">
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

          <Field label="To Date">
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

          <Field label="Duration">
            <div className="flex min-h-11 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-800">
              {durationSummary}
            </div>
          </Field>

          <Field label="From">
            <PremiumTooltip
              className="w-80"
              content={<LocationTooltipContent label="Full residence address" value={residenceSummary} />}
              placement="top"
              triggerClassName="block"
            >
              <div
                aria-label={`From residence: ${residenceSummary}`}
                className="flex min-h-11 items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-800"
                title={residenceSummary}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-sm bg-orange-400" />
                <span className="truncate" dir="auto">{fromShortLabel}</span>
              </div>
            </PremiumTooltip>
          </Field>

          <Field label="To">
            <PremiumTooltip
              className="w-80"
              content={<LocationTooltipContent label="Full destination address" value={destinationLocation.fullAddress} />}
              placement="top"
              triggerClassName="block"
            >
              <button
                aria-label={
                  captured
                    ? `Destination location: ${destinationLocation.fullAddress}`
                    : "Capture current location for destination"
                }
                className="flex min-h-11 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-3 text-left text-sm font-semibold text-slate-800 transition hover:border-orange-300 hover:bg-orange-50"
                disabled={isCapturing}
                onClick={() => void captureLocation()}
                title={destinationLocation.fullAddress}
                type="button"
              >
                <span className="truncate" dir="auto">
                  {isCapturing ? "Capturing destination..." : destinationLocation.shortLabel}
                </span>
                {isCapturing ? (
                  <LoadingSpinner />
                ) : (
                  <MapPin className="h-4 w-4 shrink-0 text-orange-500" />
                )}
              </button>
            </PremiumTooltip>
          </Field>

          {captured ? (
            <>
              <Field label="Area / Brick">
                <LocationReadout value={destinationLocation.area} />
              </Field>

              <Field label="Governorate">
                <LocationReadout value={destinationLocation.governorate} />
              </Field>

              <div className="sm:col-span-2 xl:col-span-2">
                <Field label="Full Address">
                  <PremiumTooltip
                    className="w-80 max-w-[calc(100vw-2rem)]"
                    content={<LocationTooltipContent label="Captured full address" value={destinationLocation.fullAddress} />}
                    placement="top"
                    triggerClassName="block"
                  >
                    <LocationReadout value={destinationLocation.fullAddress} />
                  </PremiumTooltip>
                </Field>
              </div>
            </>
          ) : null}

          <Field label="Transportation Type">
            <SearchableSelect
              className="h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800"
              onChange={(event) =>
                handleTransportationTypeChange(event.target.value as OutstationTransportationType)
              }
              value={transportationType}
            >
              <option value="car">Car</option>
              <option value="train">Train</option>
              <option value="bus">Bus</option>
              <option value="other">Other</option>
            </SearchableSelect>
          </Field>

          {useAreaRepPicker ? (
            <Field label="Area">
              <SearchableSelect
                className="h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 disabled:bg-slate-50 disabled:text-slate-400"
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
            <Field label="Medical Representative">
              <SearchableSelect
                className="h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 disabled:bg-slate-50 disabled:text-slate-400"
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

          {transportationType === "car" ? (
            <Field label="Kilometer Reading">
              <Input
                onChange={(event) => setKilometerReading(event.target.value)}
                placeholder="Enter odometer reading"
                type="number"
                value={kilometerReading}
              />
            </Field>
          ) : isTicketBased ? (
            <>
              <Field label="Go Ticket Amount">
                <Input
                  onChange={(event) => setGoTicketAmount(event.target.value)}
                  placeholder="EGP"
                  type="number"
                  value={goTicketAmount}
                />
              </Field>
              <Field label="Return Ticket Amount">
                <Input
                  onChange={(event) => setReturnTicketAmount(event.target.value)}
                  placeholder="EGP"
                  type="number"
                  value={returnTicketAmount}
                />
              </Field>
            </>
          ) : null}

          <Field label="Meeting Amount">
            <Input
              onChange={(event) => setMeetingAmount(event.target.value)}
              placeholder="EGP"
              type="number"
              value={meetingAmount}
            />
          </Field>

          <Field label="Other">
            <Input
              onChange={(event) => setOtherAmount(event.target.value)}
              placeholder="EGP"
              type="number"
              value={otherAmount}
            />
          </Field>

          {/*
            The editable "AM Workload" / "PM Workload" inputs that used to sit here were removed.
            They contradicted the read-only "AM Visits" / "PM Visits" fields further down, which
            already say workload is resolved automatically: every write path runs
            resolveOutstationWorkloadPayload (src/lib/outstation/service.ts) and overwrites
            am_workload / pm_workload from the published Double Visit Analytics snapshot, so a
            typed value never survived there.

            It did still reach report_am_workload / report_pm_workload, which payroll-expense-
            mapping.ts prefers over am_workload. That preference is already effectively
            unconditional — those columns are NOT NULL DEFAULT 0, so its `!= null` fallback to the
            resolved value can never fire — meaning a rep who left these blank (which the adjacent
            "resolved automatically" note tells them to do) already sent 0. Removing the inputs
            makes that the uniform behaviour rather than introducing it.
          */}

          <Field label="Notes">
            <textarea
              className="min-h-28 w-full rounded-md border border-slate-200 bg-white px-3 py-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-orange-300 focus:bg-orange-50"
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Add any trip note or explanation"
              value={notes}
            />
          </Field>

          {expenseType === "meeting" ? (
            <Field label="Meeting Amount (EGP)">
              <Input
                min="0"
                onChange={(event) => setMeetingAmount(event.target.value)}
                placeholder="EGP"
                type="number"
                value={meetingAmount}
              />
            </Field>
          ) : expenseType === "other" ? (
            <Field label="Other Amount (EGP)">
              <Input
                min="0"
                onChange={(event) => setOtherAmount(event.target.value)}
                placeholder="EGP"
                type="number"
                value={otherAmount}
              />
            </Field>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <Field label="AM Visits">
              <Input
                disabled
                placeholder="Auto from Double Visit Analytics"
                readOnly
                value={amWorkload}
              />
            </Field>
            <Field label="PM Visits">
              <Input
                disabled
                placeholder="Auto from Double Visit Analytics"
                readOnly
                value={pmWorkload}
              />
            </Field>
            <p className="col-span-2 text-xs font-semibold text-slate-500">
              Workload is resolved automatically from the official published Double Visit Analytics snapshot after submission.
            </p>
          </div>
        </div>

        <div className="mt-5">
          <span className="rounded-md bg-orange-50 px-2 py-1 text-phx-2xs font-bold uppercase tracking-wider text-orange-600">
            Auto calculated summary
          </span>
          <div className="mt-3 grid grid-cols-1 divide-x divide-y divide-gray-100 overflow-hidden rounded-md border border-gray-100 sm:grid-cols-2 xl:grid-cols-3">
            <SummaryValue
              label="Allowance"
              value={calculation ? egp(calculation.allowanceAmount) : "Will appear automatically"}
            />
            <SummaryValue
              label={transportationType === "car" ? "Travel Cost" : "Ticket Cost"}
              value={
                calculation
                  ? transportationType === "car"
                    ? egp(calculation.fuelAmount)
                    : egp(calculation.ticketAmount)
                  : "Will appear automatically"
              }
            />
            <SummaryValue
              label="Total Cost"
              value={calculation ? egp(calculation.expectedTotalAmount) : "Will appear automatically"}
            />
            <SummaryValue
              label="Meeting"
              value={calculation ? egp(calculation.reportMeetingAmount) : "Will appear automatically"}
            />
            <SummaryValue
              label="Other"
              value={calculation ? egp(calculation.reportOtherAmount) : "Will appear automatically"}
            />
            <SummaryValue
              label="Kilometer"
              value={
                calculation?.distanceFromResidenceKm != null
                  ? `${calculation.distanceFromResidenceKm.toFixed(2)} KM`
                  : "Will appear automatically"
              }
            />
            <SummaryValue
              label="Estimated Duration"
              value={
                calculation?.durationMinutes != null
                  ? `${calculation.durationMinutes.toFixed(0)} mins`
                  : "Will appear automatically"
              }
            />
            <SummaryValue
              label="Eligibility"
              value={
                calculation
                  ? calculation.eligibilityStatus.replace(/_/g, " ")
                  : "Will appear automatically"
              }
            />
          </div>
        </div>

        <div className="mt-4 rounded-md border border-gray-100 bg-slate-50/60 px-3 py-2.5 text-phx-sm text-slate-600">
          {isCalculating ? (
            <span className="inline-flex items-center gap-2 font-medium text-slate-800">
              <LoadingSpinner />
              Phoenix is calculating kilometer, allowance, amount, and validation automatically...
            </span>
          ) : canAutoCalculate ? (
            <span>
              The system is calculating your trip automatically from your residence, live
              destination, dates, policy, and transport details.
            </span>
          ) : (
            <span>
              Select the date range and tap To so the system can capture destination and calculate
              the request.
            </span>
          )}
        </div>

        {calculation ? (
          <div className="mt-5 grid grid-cols-1 divide-x divide-y divide-gray-100 overflow-hidden rounded-md border border-gray-100 sm:grid-cols-2 xl:grid-cols-3">
            <FieldValue
              label="Kilometer"
              value={
                calculation?.distanceFromResidenceKm != null
                  ? `${calculation.distanceFromResidenceKm.toFixed(2)} KM`
                  : "N/A"
              }
            />
            <FieldValue
              label="Estimated Duration"
              value={
                calculation?.durationMinutes != null
                  ? `${calculation.durationMinutes.toFixed(0)} mins`
                  : "N/A"
              }
            />
            <FieldValue
              label={transportationType === "car" ? "Fuel Amount" : "Ticket Amount"}
              value={
                calculation
                  ? transportationType === "car"
                    ? egp(calculation.fuelAmount)
                    : egp(calculation.ticketAmount)
                  : "N/A"
              }
            />
            <FieldValue label="Amount" value={egp(calculation.expectedTotalAmount)} />
            <FieldValue
              label="Eligibility"
              value={calculation.eligibilityStatus.replace(/_/g, " ")}
            />
            <FieldValue label="Allowance" value={egp(calculation.allowanceAmount)} />
            {/* Meeting and other are inside Amount (reportExpectedTotal sums travel + meeting +
                allowance + other), so a review card that lists fuel and allowance beside the
                Amount has to list these two as well or the figures below it do not add up. */}
            {calculation.reportMeetingAmount > 0 ? (
              <FieldValue label="Meeting" value={egp(calculation.reportMeetingAmount)} />
            ) : null}
            {calculation.reportOtherAmount > 0 ? (
              <FieldValue label="Other" value={egp(calculation.reportOtherAmount)} />
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* Hidden outright for the waived roles (owner request 2026-08-19) rather than shown as
          "optional": these managers are not being asked to weigh a choice, the step is simply no
          longer part of their submission. A card that stays on screen saying "you may skip this"
          is the same requirement, only asked more quietly. */}
      {isEvidencePhotoWaived ? null : (
      <Card className="rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
          <span className="rounded-md bg-orange-50 px-2 py-1 text-phx-2xs font-bold uppercase tracking-wider text-orange-600">
            {arrivalPhotoBadge}
          </span>
          <h2 className="mt-2 text-base font-bold text-slate-800 sm:text-lg">
            {arrivalPhotoHeading}
          </h2>
          <p className="mt-2 max-w-2xl text-phx-md leading-relaxed text-slate-500">
            {arrivalPhotoHint}
          </p>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500">
                Live Camera Photo
              </span>
              <button
                className="flex min-h-12 w-full items-center justify-center gap-3 rounded-md bg-orange-500 px-5 text-sm font-semibold text-white transition hover:bg-orange-600 disabled:bg-orange-300"
                disabled={isCapturingCarEvidence || isCarEvidenceCameraOpen}
                onClick={() => void openCarEvidenceCamera()}
                type="button"
              >
                {isCapturingCarEvidence ? (
                  <>
                    <LoadingSpinner className="text-white" />
                    Opening...
                  </>
                ) : (
                  <>
                    <Camera className="h-4 w-4" />
                    {isCarEvidenceCameraOpen
                      ? "Camera Open"
                      : carEvidence
                        ? "Retake Camera Photo"
                        : "Open Camera"}
                  </>
                )}
              </button>
              {canUploadArrivalPhoto ? (
                <>
                  <span className="mt-3 mb-1 block text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500">
                    Or upload a photo
                  </span>
                  <label className="flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-orange-300 bg-orange-50/50 px-4 text-phx-md font-semibold text-orange-700 transition hover:bg-orange-50">
                    <Upload className="h-4 w-4" />
                    {carEvidence?.source === "upload" ? "Replace uploaded photo" : "Upload Photo"}
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
                </>
              ) : null}
            </label>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
              <p className="text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500">
                Photo status
              </p>
              <p className="mt-2 text-sm font-semibold text-slate-900">
                {arrivalPhotoStatusLabel}
              </p>
              {carEvidence ? (
                <p className="mt-2 text-sm text-slate-700">
                  {carEvidence.capturedLocationLabel}
                </p>
              ) : null}
            </div>
          </div>
          {isCarEvidenceCameraOpen ? (
            <div className="mt-5 overflow-hidden rounded-md border border-slate-200 bg-slate-950">
              <video
                ref={videoRef}
                autoPlay
                className="aspect-video w-full object-cover"
                muted
                playsInline
              />
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-slate-950 p-4">
                <p className="text-sm font-semibold text-white">
                  Frame the car clearly, then capture the photo.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="rounded-md border border-white/20 bg-transparent px-4 text-white hover:bg-white/10"
                    onClick={stopCarEvidenceCamera}
                    type="button"
                  >
                    Cancel
                  </Button>
                  <Button
                    className="rounded-md bg-orange-500 px-5 text-white hover:bg-orange-600"
                    disabled={isCapturingCarEvidence}
                    onClick={() => void captureCarEvidence()}
                    type="button"
                  >
                    {isCapturingCarEvidence ? <LoadingSpinner className="text-white" /> : <Camera className="h-4 w-4" />}
                    Capture
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          {carEvidence?.imageDataUrl ? (
            <div className="relative mt-4 overflow-hidden rounded-md border border-slate-200">
              <ZoomablePhoto
                alt="Live car photo preview"
                caption="Live car photo"
                className="h-auto w-full object-cover"
                src={carEvidence.imageDataUrl}
              />
            </div>
          ) : carEvidence ? (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              Live photo details are restored, but the image preview cannot be restored. Re-capture the photo before submitting if needed.
            </div>
          ) : null}
        </Card>
      )}

      {/* Rendered alongside the arrival photo, never instead of it — a train or bus
          request carries BOTH its ticket and its live arrival photo. The card hides
          itself for car and other via `visible`. For a waived role the photo card is gone
          and this is the trip's only evidence surface, which is why it stays on screen for
          them — optional, but offered. */}
      <TicketUploadCard
        attachmentCount={ticketFiles.length}
        onFilesSelected={(files) => setTicketFiles(files ? Array.from(files) : [])}
        required={isTicketRequired}
        transportationType={transportationType}
        visible={isTicketBased}
      />

      <EligibilityResultCard result={calculation} />
      <OutstationCostBreakdown result={calculation} />
      <RouteMapPreview request={calculation} />

      {calculation ? (
        <>
          {/* Desktop / tablet inline submit card */}
          <Card className="hidden rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:block sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <span className="rounded-md bg-orange-50 px-2 py-1 text-phx-2xs font-bold uppercase tracking-wider text-orange-600">
                  Step 3
                </span>
                <h2 className="mt-2 text-base font-bold text-slate-800 sm:text-lg">
                  Submit request
                </h2>
              </div>
              <ApprovalRecommendationBadge value={calculation.approvalRecommendation} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                className="min-h-11 rounded-md bg-orange-500 px-5 text-sm font-semibold text-white shadow-sm hover:bg-orange-600 disabled:opacity-60"
                disabled={
                  isSubmitting ||
                  calculation.eligibilityStatus === "not_eligible" ||
                  (!hasCarEvidence && !isEvidencePhotoWaived)
                }
                onClick={submit}
                type="button"
              >
                {isSubmitting ? <LoadingSpinner className="text-white" /> : null}
                {isSubmitting
                  ? "Submitting..."
                  : isOffline
                    ? "Save & Sync Offline Request"
                    : "Submit Request"}
              </Button>
            </div>
            {/* A disabled button that says nothing is what made this look broken: the
                employee pressed it and the page did not react. Always name the reason. */}
            {!hasCarEvidence && !isEvidencePhotoWaived ? (
              <p className="mt-2 text-phx-sm font-semibold text-amber-700">
                {arrivalPhotoMissingMessage}
              </p>
            ) : null}
          </Card>

          {/* Mobile sticky footer (< sm). Includes a spacer above the
              container so the last content row isn't hidden behind the
              footer when the form is fully scrolled. */}
          <div aria-hidden className="h-20 sm:hidden" />
          <div
            className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-100 bg-white/95 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.5rem)] pt-2.5 shadow-[0_-2px_8px_rgba(15,23,42,0.06)] backdrop-blur sm:hidden print:hidden"
            data-no-print
            role="region"
            aria-label="Submit expense action bar"
          >
            {!hasCarEvidence && !isEvidencePhotoWaived ? (
              <p className="mb-1.5 whitespace-nowrap text-phx-xs font-semibold text-amber-700">
                {arrivalPhotoMissingShort}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <ApprovalRecommendationBadge value={calculation.approvalRecommendation} />
              <Button
                className="ml-auto min-h-11 flex-1 rounded-md bg-orange-500 px-4 text-sm font-semibold text-white shadow-sm hover:bg-orange-600 disabled:opacity-60"
                disabled={
                  isSubmitting ||
                  calculation.eligibilityStatus === "not_eligible" ||
                  (!hasCarEvidence && !isEvidencePhotoWaived)
                }
                onClick={submit}
                type="button"
              >
                {isSubmitting ? <LoadingSpinner className="text-white" /> : null}
                {isSubmitting
                  ? "Submitting..."
                  : isOffline
                    ? "Save offline"
                    : "Submit Request"}
              </Button>
            </div>
          </div>
        </>
      ) : null}

      {message ? (
        <>
          <Card
            aria-live="polite"
            className="hidden rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-phx-sm font-medium text-amber-800 sm:block"
            role="status"
          >
            {message}
          </Card>
          {/* On a phone this card sat in normal flow BELOW the fixed submit bar, at the
              very end of the scroll area. Every refusal — including the server's — landed
              off-screen, so pressing Submit looked like it did nothing at all. Pinned above
              the action bar it is now the first thing the employee sees. */}
          <div
            className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+4.25rem)] z-50 sm:hidden print:hidden"
            data-no-print
          >
            <Card
              aria-live="polite"
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-phx-sm font-medium text-amber-800 shadow-lg"
              role="status"
            >
              {message}
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}

function LocationTooltipContent({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-phx-2xs font-bold uppercase tracking-[0.14em] text-slate-500">
        {label}
      </p>
      <p className="break-words text-sm font-semibold leading-5 text-slate-900" dir="auto">
        {value}
      </p>
    </div>
  );
}

function LocationReadout({ value }: { value: string }) {
  return (
    <div
      className="flex min-h-11 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-800"
      title={value}
    >
      <span className="truncate" dir="auto">{value}</span>
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
      <div className="w-full max-w-md rounded-lg border border-white/30 bg-white p-5 shadow-[0_20px_50px_rgba(15,23,42,0.24)]">
        <span className="inline-flex rounded-md bg-orange-50 px-2 py-1 text-phx-2xs font-bold uppercase tracking-[0.14em] text-orange-600">
          {copy.badge}
        </span>
        <h2 id="outstation-permission-title" className="mt-3 text-lg font-bold text-slate-900">
          {copy.title}
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">{copy.description}</p>
        {blocked ? (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium leading-5 text-amber-800">
            Browser security can prevent the native prompt from appearing again after a permanent block.
            The app can open settings as a shortcut, but you must switch this site&apos;s permission to Allow.
          </p>
        ) : null}
        {blocked ? (
          <Button
            className="mt-4 min-h-11 w-full rounded-md border border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100"
            onClick={handleOpenSettings}
            type="button"
            variant="secondary"
          >
            Open settings / show steps
          </Button>
        ) : null}
        {blocked && settingsAttempted ? (
          <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-700">
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
                <Button
                  className="min-h-10 rounded-md border border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-100"
                  onClick={() => void copyText(settingsUrl, "Settings shortcut")}
                  type="button"
                  variant="secondary"
                >
                  Copy settings shortcut
                </Button>
              ) : null}
              {siteUrl ? (
                <Button
                  className="min-h-10 rounded-md border border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-100"
                  onClick={() => void copyText(siteUrl, "Site URL")}
                  type="button"
                  variant="secondary"
                >
                  Copy site URL
                </Button>
              ) : null}
            </div>
            {copyMessage ? (
              <p className="mt-2 font-medium text-slate-600">{copyMessage}</p>
            ) : null}
          </div>
        ) : null}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button
            className="min-h-11 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            onClick={onDecline}
            type="button"
            variant="secondary"
          >
            Decline
          </Button>
          <Button
            className="min-h-11 rounded-md bg-orange-500 text-white hover:bg-orange-600"
            onClick={onAccept}
            type="button"
          >
            {blocked ? "Accept & retry" : "Accept"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// WizardStep / Field / Stat / FieldValue / SummaryValue moved to
// `src/components/outstation/wizard-primitives.tsx` so admin outstation
// pages can reuse them.
