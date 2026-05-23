"use client";

import { Calculator, Camera, Car, CheckCircle2, MapPin, ReceiptText, Route, TrainFront } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { ApprovalRecommendationBadge } from "@/components/outstation/approval-recommendation-badge";
import { OfflineSyncBanner } from "@/components/outstation/offline-sync-banner";
import { OutstationCostBreakdown } from "@/components/outstation/outstation-cost-breakdown";
import { RouteMapPreview } from "@/components/outstation/route-map-preview";
import { InfoStatusCard, StatusCard, type StatusSeverity } from "@/components/outstation/status-card";
import { TicketUploadCard } from "@/components/outstation/ticket-upload-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { useRouter } from "next/navigation";
import {
  isRestorableOutstationLocalDraft,
  outstationDraftStorageKey,
  parseOutstationLocalDraft,
  saveOutstationLocalDraft,
  outstationDraftStorageFullWarning,
  type OutstationLocalDraft,
} from "@/lib/outstation/local-draft";
import type {
  OutstationCalculationResult,
  OutstationCaptureResult,
  OutstationCarEvidenceMetadata,
  OutstationExpenseType,
  OutstationTicketAttachmentMetadata,
  OutstationTransportationType,
} from "@/lib/outstation/types";
import { cn, formatEmployeeDisplayName } from "@/lib/utils";

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
  imagePath: string | null;
  requestDraftId: string;
  requestId: string | null;
};

type CarEvidenceCaptureDetails = {
  capturedAt: string;
  capturedLatitude: number;
  capturedLocationLabel: string;
  capturedLongitude: number;
};

const draftKey = outstationDraftStorageKey;
const carEvidenceLogoSrc = "/brand/phoenix-camera-watermark.png";
const dataUrlBlobTypeFallback = "image/jpeg";
const wizardMessageClassName: Record<StatusSeverity, string> = {
  error: "text-red-800",
  info: "text-blue-800",
  warning: "text-amber-800",
  success: "text-green-800",
};
const wizardMessageRole: Record<StatusSeverity, "alert" | "status"> = {
  error: "alert",
  info: "status",
  warning: "status",
  success: "status",
};
const postSubmitRedirectPath = "/employee-portals";

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

function formatEvidenceDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "N/A" : date.toLocaleString();
}

async function resolveReadableLocation(latitude: number, longitude: number) {
  try {
    const response = await fetch("/api/outstation/reverse-geocode", {
      body: JSON.stringify({ latitude, longitude }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = await response.json();
    if (response.ok && typeof payload.label === "string" && payload.label.trim()) {
      return payload.label.trim();
    }
  } catch {
    // Human-readable location is best-effort; GPS metadata remains attached.
  }

  return "Location unavailable";
}

function loadWatermarkLogo() {
  return new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = carEvidenceLogoSrc;
  });
}

function drawWatermarkText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  const words = text.split(/\s+/g).filter(Boolean);
  let line = "";
  let currentY = y;

  for (const word of words) {
    const nextLine = line ? `${line} ${word}` : word;
    if (context.measureText(nextLine).width > maxWidth && line) {
      context.fillText(line, x, currentY);
      line = word;
      currentY += lineHeight;
    } else {
      line = nextLine;
    }
  }

  if (line) {
    context.fillText(line, x, currentY);
  }

  return currentY + lineHeight;
}

function getCompressedEvidenceCanvasSize(video: HTMLVideoElement) {
  const sourceWidth = video.videoWidth || 1280;
  const sourceHeight = video.videoHeight || 720;
  const maxDimension = 1280;
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));

  return {
    height: Math.max(1, Math.round(sourceHeight * scale)),
    width: Math.max(1, Math.round(sourceWidth * scale)),
  };
}

async function drawCarEvidenceWatermark(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  details: CarEvidenceCaptureDetails & { employeeHrId: string; requestDraftId: string },
) {
  const width = canvas.width;
  const height = canvas.height;
  const padding = Math.max(24, Math.round(width * 0.025));
  const panelHeight = Math.max(150, Math.round(height * 0.22));
  const logoSize = Math.max(112, Math.round(width * 0.13));
  const titleFont = Math.max(18, Math.round(width * 0.018));
  const bodyFont = Math.max(15, Math.round(width * 0.014));
  const lineHeight = Math.round(bodyFont * 1.45);

  const gradient = context.createLinearGradient(0, height - panelHeight, 0, height);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.35, "rgba(0,0,0,0.48)");
  gradient.addColorStop(1, "rgba(0,0,0,0.72)");
  context.fillStyle = gradient;
  context.fillRect(0, height - panelHeight, width, panelHeight);

  context.shadowColor = "rgba(0,0,0,0.65)";
  context.shadowBlur = 8;
  context.fillStyle = "#fff";
  context.font = `800 ${titleFont}px sans-serif`;
  context.fillText("Phoenix Workforce", padding, height - panelHeight + padding + titleFont);

  context.font = `700 ${bodyFont}px sans-serif`;
  context.shadowBlur = 6;
  let y = height - panelHeight + padding + titleFont + lineHeight;
  y = drawWatermarkText(
    context,
    `Time: ${formatEvidenceDateTime(details.capturedAt)}`,
    padding,
    y,
    width - logoSize - padding * 3,
    lineHeight,
  );
  y = drawWatermarkText(
    context,
    `Location: ${details.capturedLocationLabel}`,
    padding,
    y,
    width - logoSize - padding * 3,
    lineHeight,
  );
  drawWatermarkText(
    context,
    `HR ID: ${details.employeeHrId} | Draft: ${details.requestDraftId}`,
    padding,
    y,
    width - logoSize - padding * 3,
    lineHeight,
  );

  const logo = await loadWatermarkLogo();
  if (logo) {
    context.shadowBlur = 10;
    context.drawImage(logo, width - padding - logoSize, height - padding - logoSize, logoSize, logoSize);
  }
  context.shadowBlur = 0;
}

function buildTransportIcon(type: OutstationTransportationType) {
  return type === "car" ? Car : type === "train" || type === "bus" ? TrainFront : Route;
}

function decodeDataUrlToBlob(imageDataUrl: string) {
  const commaIndex = imageDataUrl.indexOf(",");
  if (commaIndex === -1) {
    throw new Error("Invalid image data.");
  }

  const header = imageDataUrl.slice(0, commaIndex);
  const data = imageDataUrl.slice(commaIndex + 1);
  const mimeMatch = /^data:([^;,]+)(;[^;,]*)*/.exec(header);
  const mimeType = (mimeMatch?.[1] ?? dataUrlBlobTypeFallback).trim();
  const isBase64 = /;base64/i.test(header);

  if (!isBase64) {
    throw new Error("Unsupported image data format.");
  }

  const normalizedData = data.replace(/\s/g, "");
  const byteString = atob(normalizedData);
  const bytes = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i += 1) {
    bytes[i] = byteString.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
}

type TicketAttachmentUploadResult = {
  metadata: OutstationTicketAttachmentMetadata[];
  paths: string[];
};

export function MobileOutstationWizard({
  employeeHrId,
  employeeName,
  employeeRole,
  hasResidenceCoordinates,
  medicalTripOptions,
  residenceSummary,
  showIntro = true,
}: {
  employeeHrId: string;
  employeeName: string;
  employeeRole: string;
  hasResidenceCoordinates: boolean;
  medicalTripOptions: MedicalTripOption[];
  residenceSummary: string;
  showIntro?: boolean;
}) {
  const [step, setStep] = useState(1);
  const router = useRouter();
  const [expenseType, setExpenseType] = useState<OutstationExpenseType>("traveling");
  const [transportationType, setTransportationType] =
    useState<OutstationTransportationType>("car");
  const [tripStartDate, setTripStartDate] = useState("");
  const [tripEndDate, setTripEndDate] = useState("");
  const [goTicketAmount, setGoTicketAmount] = useState("");
  const [returnTicketAmount, setReturnTicketAmount] = useState("");
  const [kilometerReading, setKilometerReading] = useState("");
  const [notes, setNotes] = useState("");
  const [medicalTripHrId, setMedicalTripHrId] = useState("");
  const [captured, setCaptured] = useState<OutstationCaptureResult | null>(null);
  const [carEvidence, setCarEvidence] = useState<CarEvidenceState | null>(null);
  const [carEvidenceDraftId, setCarEvidenceDraftId] = useState(() => buildDraftId());
  const [isCarEvidenceCameraOpen, setIsCarEvidenceCameraOpen] = useState(false);
  const [calculation, setCalculation] = useState<OutstationCalculationResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageSeverity, setMessageSeverity] = useState<StatusSeverity>("info");
  const [draftStorageError, setDraftStorageError] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isCapturingCarEvidence, setIsCapturingCarEvidence] = useState(false);
  const [isCalculating, setIsCalculating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [ticketFiles, setTicketFiles] = useState<File[]>([]);
  const carEvidenceStreamRef = useRef<MediaStream | null>(null);
  const pendingOfflineDraftRef = useRef(false);
  const skipInitialDraftPersistRef = useRef(true);
  const syncAttemptedRef = useRef(false);
  const lastCalculationKeyRef = useRef("");
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const selectedMedicalTripName =
    medicalTripOptions.find((option) => option.hrId === medicalTripHrId)?.name ?? null;
  const transportIcon = buildTransportIcon(transportationType);
  const isTicketBased = transportationType === "train" || transportationType === "bus";
  const durationSummary = calculation
    ? calculation.sameDayTrip
      ? "Return the same day"
      : `Overnight stay - ${calculation.overnightDays} ${calculation.overnightDays === 1 ? "night" : "nights"}`
    : getDurationSummary(tripStartDate, tripEndDate);
  const parsedTripStartDate = useMemo(() => {
    return tripStartDate ? Date.parse(tripStartDate) : NaN;
  }, [tripStartDate]);
  const parsedTripEndDate = useMemo(() => {
    return tripEndDate ? Date.parse(tripEndDate) : NaN;
  }, [tripEndDate]);
  const tripDateRangeError = useMemo(() => {
    if (!Number.isFinite(parsedTripStartDate) || !Number.isFinite(parsedTripEndDate)) {
      return "";
    }
    return parsedTripEndDate < parsedTripStartDate ? "End date cannot be before start date" : "";
  }, [parsedTripStartDate, parsedTripEndDate]);
  const isTripDateRangeInvalid = tripDateRangeError.length > 0;

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
    setMedicalTripHrId("");
    setNotes("");
    setReturnTicketAmount("");
    setTripStartDate("");
    setTripEndDate("");
    setTicketFiles([]);
    setTransportationType("car");
    setStep(1);
  }, [stopCarEvidenceCamera]);

  useEffect(() => {
    const restore = parseOutstationLocalDraft(window.localStorage.getItem(draftKey));
    const isValidDraft = isRestorableOutstationLocalDraft(restore, employeeHrId);
    const shouldRestoreDraft = isValidDraft && !window.navigator.onLine;
    if (!isValidDraft) {
      window.localStorage.removeItem(draftKey);
      return;
    }

    if (!shouldRestoreDraft) {
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
        imagePath: restore.carEvidenceImagePath ?? null,
        requestDraftId: draftId,
        requestId: null,
      });
    }
    setExpenseType(restore.expenseType);
    setGoTicketAmount(restore.goTicketAmount);
    setKilometerReading(restore.kilometerReading);
    setMedicalTripHrId(restore.medicalTripHrId);
    setNotes(restore.notes);
    setReturnTicketAmount(restore.returnTicketAmount);
    setTransportationType(restore.transportationType);
    setTripEndDate(restore.tripEndDate);
    setTripStartDate(restore.tripStartDate);
  }, [employeeHrId]);

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
      queueMicrotask(() => setDraftStorageError(null));
      return;
    }

    pendingOfflineDraftRef.current = true;
    const draft: OutstationLocalDraft = {
      employeeHrId,
      captured,
      carEvidenceCapturedAt: carEvidence?.capturedAt ?? null,
      carEvidenceImageDataUrl: carEvidence?.imagePath ? null : carEvidence?.imageDataUrl ?? null,
      carEvidenceImagePath: carEvidence?.imagePath ?? null,
      carEvidenceLatitude: carEvidence?.capturedLatitude ?? null,
      carEvidenceLocationLabel: carEvidence?.capturedLocationLabel ?? null,
      carEvidenceLongitude: carEvidence?.capturedLongitude ?? null,
      carEvidenceRequestId: carEvidenceDraftId,
      expenseType,
      goTicketAmount,
      hasTicketAttachments: ticketFiles.length > 0,
      kilometerReading,
      medicalTripHrId,
      notes,
      returnTicketAmount,
      updatedAt: new Date().toISOString(),
      syncPending: true,
      transportationType,
      tripEndDate,
      tripStartDate,
    };
    const saveResult = saveOutstationLocalDraft(draftKey, draft);
    if (saveResult.success) {
      queueMicrotask(() => setDraftStorageError(null));
      return;
    }

    if (saveResult.quotaExceeded) {
      queueMicrotask(() => setDraftStorageError(outstationDraftStorageFullWarning));
    }
  }, [
    captured,
    carEvidence?.capturedAt,
    carEvidence?.imageDataUrl,
    carEvidence?.imagePath,
    carEvidence?.capturedLatitude,
    carEvidence?.capturedLocationLabel,
    carEvidence?.capturedLongitude,
    carEvidenceDraftId,
    expenseType,
    goTicketAmount,
    isOffline,
    kilometerReading,
    medicalTripHrId,
    notes,
    returnTicketAmount,
    ticketFiles.length,
    transportationType,
    tripEndDate,
    tripStartDate,
    employeeHrId,
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
        (draft.transportationType === "car" &&
            (!draft.carEvidenceRequestId ||
              !draft.carEvidenceCapturedAt ||
              (!draft.carEvidenceImagePath && !draft.carEvidenceImageDataUrl) ||
              draft.carEvidenceLatitude == null ||
              !draft.carEvidenceLocationLabel ||
              draft.carEvidenceLongitude == null)) ||
          syncAttemptedRef.current
        ) {
          return;
        }

        syncAttemptedRef.current = true;
        try {
          let carEvidenceImagePath = draft.carEvidenceImagePath ?? null;
          if (
            draft.transportationType === "car" &&
            !carEvidenceImagePath &&
            draft.carEvidenceImageDataUrl &&
            draft.carEvidenceRequestId &&
            draft.carEvidenceCapturedAt &&
            draft.carEvidenceLatitude != null &&
            draft.carEvidenceLocationLabel &&
            draft.carEvidenceLongitude != null
          ) {
            carEvidenceImagePath = await uploadCarEvidenceImage(draft.carEvidenceImageDataUrl, {
              capturedAt: draft.carEvidenceCapturedAt,
              capturedLatitude: draft.carEvidenceLatitude,
              capturedLocationLabel: draft.carEvidenceLocationLabel,
              capturedLongitude: draft.carEvidenceLongitude,
              requestDraftId: draft.carEvidenceRequestId,
            });
            saveOutstationLocalDraft(draftKey, {
              ...draft,
              carEvidenceImageDataUrl: null,
              carEvidenceImagePath,
            });
          }

          const response = await fetch("/api/outstation/sync-offline", {
            body: JSON.stringify({
              attachmentCount: draft.hasTicketAttachments ? 1 : 0,
              capturedAccuracyMeters: draft.captured.capturedAccuracyMeters,
              capturedAt: draft.captured.capturedAt,
              capturedLatitude: draft.captured.capturedLatitude,
              capturedLongitude: draft.captured.capturedLongitude,
              claimedTotalAmount: 0,
              expenseType: draft.expenseType,
              goTicketAmount: Number(draft.goTicketAmount || 0),
              carEvidenceMetadata:
                draft.transportationType === "car" && draft.carEvidenceRequestId
                  ? {
                      capturedAt: draft.carEvidenceCapturedAt ?? "",
                      capturedLatitude: Number(draft.carEvidenceLatitude),
                      capturedLocationLabel: draft.carEvidenceLocationLabel,
                      capturedLongitude: Number(draft.carEvidenceLongitude),
                      employeeHrId,
                      requestDraftId: draft.carEvidenceRequestId,
                      requestId: null,
                      source: "live_camera",
                  }
                  : undefined,
              carEvidenceImagePath:
                draft.transportationType === "car" ? carEvidenceImagePath : undefined,
              hasTicketAttachments: draft.hasTicketAttachments,
              kilometerReading: Number(draft.kilometerReading || 0),
              medicalTripHrId: draft.medicalTripHrId,
              medicalTripName:
                medicalTripOptions.find((option) => option.hrId === draft.medicalTripHrId)?.name ??
                "",
              notes: draft.notes,
              returnTicketAmount: Number(draft.returnTicketAmount || 0),
              transportationType: draft.transportationType,
              tripEndDate: draft.tripEndDate,
              tripStartDate: draft.tripStartDate,
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });
          if (response.ok) {
            resetFormState();
            setWizardMessage("Offline outstation draft synced successfully after reconnecting.", "success");
          } else {
            syncAttemptedRef.current = false;
          }
        } catch (error) {
          syncAttemptedRef.current = false;
          setWizardMessage(
            error instanceof Error ? error.message : "Unable to sync offline outstation draft.",
            "error",
          );
        }
      };
      void syncPending();
    } else {
      syncAttemptedRef.current = false;
    }
  }, [employeeHrId, isOffline, medicalTripOptions, resetFormState]);

  const hasTicketAttachments = ticketFiles.length > 0;
  const hasCarEvidence = Boolean(carEvidence?.imagePath || carEvidence?.imageDataUrl);

  const setWizardMessage = (nextMessage: string | null, severity: StatusSeverity = "info") => {
    setMessage(nextMessage);
    setMessageSeverity(nextMessage ? severity : "info");
  };

  async function uploadCarEvidenceImage(
    imageDataUrl: string,
    details: Omit<CarEvidenceState, "imageDataUrl" | "imagePath" | "requestId">,
  ) {
    const blob = imageDataUrl.startsWith("data:")
      ? decodeDataUrlToBlob(imageDataUrl)
      : await (await fetch(imageDataUrl)).blob();
    const requestBody = new FormData();
    const file = new File([blob], `car-evidence-${details.requestDraftId}.jpg`, {
      type: blob.type || "image/jpeg",
    });

    requestBody.set("carEvidenceImage", file);
    requestBody.set("requestDraftId", details.requestDraftId);
    requestBody.set("capturedAt", details.capturedAt);
    requestBody.set("capturedLatitude", String(details.capturedLatitude));
    requestBody.set("capturedLongitude", String(details.capturedLongitude));
    requestBody.set("capturedLocationLabel", details.capturedLocationLabel);

    const response = await fetch("/api/outstation/car-evidence", {
      body: requestBody,
      method: "POST",
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        (typeof payload.message === "string" ? payload.message : undefined) ??
          (typeof payload.error === "string" ? payload.error : undefined) ??
          "Unable to upload car evidence image.",
      );
    }

    const uploadedPath = typeof payload.carEvidenceImagePath === "string"
      ? payload.carEvidenceImagePath
      : "";
    const trimmedPath = uploadedPath.trim();
    if (!trimmedPath) {
      throw new Error("Car evidence upload did not return an image path.");
    }

    return trimmedPath;
  }

  async function uploadTicketAttachments() {
    if (!hasTicketAttachments) {
      return { metadata: [], paths: [] } satisfies TicketAttachmentUploadResult;
    }

    const formData = new FormData();
    const requestDraftId = `${carEvidenceDraftId}-${Date.now()}`;
    for (const file of ticketFiles) {
      formData.append("ticketFiles", file);
    }
    formData.set("requestDraftId", requestDraftId);

    const response = await fetch("/api/outstation/ticket-attachments", {
      body: formData,
      method: "POST",
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        (typeof payload.message === "string" ? payload.message : undefined) ??
          (typeof payload.error === "string" ? payload.error : undefined) ??
          "Unable to upload ticket attachments.",
      );
    }

    const metadata = Array.isArray(payload.ticketAttachmentMetadata)
      ? payload.ticketAttachmentMetadata
          .map((entry) => {
            if (!entry || typeof entry !== "object") return null;
            const contentType = typeof entry.contentType === "string" ? entry.contentType : "";
            const name = typeof entry.name === "string" ? entry.name : "";
            const path = typeof entry.path === "string" ? entry.path : "";
            const size = typeof entry.size === "number" ? entry.size : NaN;
            const uploadedAt =
              typeof entry.uploadedAt === "string" && entry.uploadedAt.trim().length > 0
                ? entry.uploadedAt
                : new Date().toISOString();

            if (!contentType || !name || !path || !Number.isFinite(size)) {
              return null;
            }

            return {
              contentType,
              name,
              path,
              size,
              uploadedAt,
            } satisfies OutstationTicketAttachmentMetadata;
          })
          .filter((item): item is OutstationTicketAttachmentMetadata => item != null)
      : [];

    const paths = Array.isArray(payload.ticketAttachmentPaths)
      ? payload.ticketAttachmentPaths
          .map((path) => (typeof path === "string" ? path.trim() : ""))
          .filter(Boolean)
      : [];

    return { metadata, paths } satisfies TicketAttachmentUploadResult;
  }

  function handleTransportationTypeChange(value: OutstationTransportationType) {
    setTransportationType(value);
    if (value === "car") {
      setTicketFiles([]);
    } else {
      setCarEvidence(null);
      setKilometerReading("");
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
      source: "live_camera",
    };
  }, [carEvidence, employeeHrId]);

  const requestPayload = useMemo(
    () => ({
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
      medicalTripHrId,
      medicalTripName: selectedMedicalTripName,
      notes,
      offlineCaptured: isOffline,
      returnTicketAmount: Number(returnTicketAmount || 0),
      transportationType,
      tripEndDate,
      tripStartDate,
    }),
    [
      captured,
      expenseType,
      goTicketAmount,
      hasTicketAttachments,
      isOffline,
      kilometerReading,
      medicalTripHrId,
      notes,
      returnTicketAmount,
      carEvidenceMetadata,
      selectedMedicalTripName,
      ticketFiles.length,
      transportationType,
      tripEndDate,
      tripStartDate,
    ],
  );

  const canAutoCalculate = Boolean(
    captured &&
    tripStartDate &&
    tripEndDate &&
    !isTripDateRangeInvalid
  );
  const summaryStatus = isCalculating
    ? "Calculating"
    : calculation
      ? "Ready to review"
      : canAutoCalculate
        ? "Preparing"
        : "Waiting for trip details";
  const calculationKey = useMemo(() => {
    if (!captured || !tripStartDate || !tripEndDate || isTripDateRangeInvalid) return "";

    return JSON.stringify({
      attachmentCount: ticketFiles.length,
      capturedAccuracyMeters: captured.capturedAccuracyMeters,
      capturedAt: captured.capturedAt,
      capturedLatitude: captured.capturedLatitude,
      capturedLongitude: captured.capturedLongitude,
      expenseType,
      goTicketAmount: isTicketBased ? Number(goTicketAmount || 0) : 0,
      hasTicketAttachments,
      returnTicketAmount: isTicketBased ? Number(returnTicketAmount || 0) : 0,
      transportationType,
      tripEndDate,
      tripStartDate,
    });
  }, [
    captured,
    expenseType,
    goTicketAmount,
    hasTicketAttachments,
    isTicketBased,
    isTripDateRangeInvalid,
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

    const shouldApplyResponse = (responseKey?: string) => {
      return !responseKey || responseKey === lastCalculationKeyRef.current;
    };

    if (submittedCalculationKey) {
      lastCalculationKeyRef.current = submittedCalculationKey;
    }
    setIsCalculating(true);
    setWizardMessage(null);
    try {
      const response = await fetch("/api/outstation/calculate", {
        body: JSON.stringify(requestPayload),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        if (!shouldApplyResponse(submittedCalculationKey)) {
          return;
        }
        if (submittedCalculationKey === lastCalculationKeyRef.current) {
          lastCalculationKeyRef.current = "";
        }
        setWizardMessage(payload.message ?? payload.error ?? "Unable to calculate the request.", "error");
        return;
      }

      if (!shouldApplyResponse(submittedCalculationKey)) {
        return;
      }
      setCalculation(payload);
    } catch {
      if (!shouldApplyResponse(submittedCalculationKey)) {
        return;
      }
      if (submittedCalculationKey === lastCalculationKeyRef.current) {
        lastCalculationKeyRef.current = "";
      }
      setWizardMessage("Unable to calculate the request.", "error");
    } finally {
      if (shouldApplyResponse(submittedCalculationKey)) {
        setIsCalculating(false);
      }
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

  async function captureLocation() {
    setWizardMessage(null);
    setCalculation(null);
    if (!navigator.geolocation) {
      setWizardMessage("Browser geolocation is not supported on this device.", "error");
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
          fraudFlags: [],
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
          suspiciousLocationScore: 0,
          territoryValidationReason: "Territory validation will run after the offline draft syncs.",
          territoryValidationStatus: "not_available",
          toArea: null,
          toCity: null,
          toLabel: "Offline capture pending server validation",
        };
        setCaptured(offlineCapture);
        setStep(2);
        setWizardMessage(
          "Destination captured offline. The draft will sync when internet returns.",
          "info",
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
        setWizardMessage(payload.message ?? payload.error ?? "Unable to capture your location.", "error");
        return;
      }

      setCaptured(payload);
      setStep(2);
    } catch (error) {
      const geoError = error as GeolocationPositionError | Error;
      if ("code" in geoError && typeof geoError.code === "number" && geoError.code === 1) {
        setWizardMessage(
          "Location permission was denied. This report cannot proceed without GPS permission.",
          "error",
        );
      } else {
        setWizardMessage(
          geoError instanceof Error
            ? geoError.message
            : "Unable to capture your current location.",
          "error",
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
      setWizardMessage("Unable to start camera preview.", "error");
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
    setWizardMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setWizardMessage("Camera capture is not available on this device.", "error");
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
      if (typedError instanceof DOMException && typedError.name === "NotAllowedError") {
        setWizardMessage(
          "Camera permission was denied. Enable camera permission to continue.",
          "error",
        );
        return;
      }
      setWizardMessage(
        typedError instanceof Error ? typedError.message : "Unable to open the camera.",
        "error",
      );
    } finally {
      setIsCapturingCarEvidence(false);
    }
  }

  async function captureCarEvidence() {
    setWizardMessage(null);
    if (!navigator.geolocation) {
      setWizardMessage("Browser geolocation is not supported on this device.", "error");
      return;
    }
    if (!videoRef.current || !carEvidenceStreamRef.current) {
      setWizardMessage("Open the camera before capturing evidence.", "warning");
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
      const capturedLocationLabel = await resolveReadableLocation(
        position.coords.latitude,
        position.coords.longitude,
      );

      await drawCarEvidenceWatermark(context, canvas, {
        capturedAt,
        capturedLatitude: position.coords.latitude,
        capturedLocationLabel,
        capturedLongitude: position.coords.longitude,
        employeeHrId,
        requestDraftId: carEvidenceDraftId,
      });

      const imageDataUrl = canvas.toDataURL("image/jpeg", 0.74);

      setCarEvidence({
        capturedAt,
        capturedLatitude: position.coords.latitude,
        capturedLocationLabel,
        capturedLongitude: position.coords.longitude,
        imageDataUrl,
        imagePath: null,
        requestDraftId: carEvidenceDraftId,
        requestId: carEvidence?.requestId ?? null,
      });

      const imagePath = isOffline
        ? null
        : await uploadCarEvidenceImage(imageDataUrl, {
            capturedAt,
            capturedLatitude: position.coords.latitude,
            capturedLocationLabel,
            capturedLongitude: position.coords.longitude,
            requestDraftId: carEvidenceDraftId,
          });

      if (imagePath) {
        setCarEvidence((current) =>
          current ? { ...current, imagePath, requestId: current.requestId } : current,
        );
      }

      setWizardMessage(
        isOffline
          ? "Live car evidence captured. This photo is attached locally and will upload when you sync."
          : imagePath
            ? "Live car evidence captured and uploaded."
            : "Live car evidence captured. This photo is attached to this request.",
        isOffline || !imagePath ? "info" : "success",
      );
      stopCarEvidenceCamera();
    } catch (error) {
      const typedError = error as GeolocationPositionError | DOMException | Error;
      if ("code" in typedError && typeof typedError.code === "number" && typedError.code === 1) {
        setWizardMessage(
          "Location permission was denied. Car evidence cannot be captured without GPS permission.",
          "error",
        );
        return;
      }
      setWizardMessage(
        typedError instanceof Error ? typedError.message : "Unable to capture live car evidence.",
        "error",
      );
    } finally {
      setIsCapturingCarEvidence(false);
    }
  }

  async function submit() {
    if (!captured) {
      setWizardMessage("Tap the To field to capture your current destination first.", "warning");
      return;
    }

    if (transportationType === "car" && !hasCarEvidence) {
      setWizardMessage("Capture live camera evidence before submitting this car request.", "warning");
      return;
    }

    setIsSubmitting(true);
    setWizardMessage(null);
    try {
      let carEvidenceImagePath = carEvidence?.imagePath ?? null;
      if (
        transportationType === "car" &&
        !carEvidenceImagePath &&
        carEvidence?.imageDataUrl
      ) {
        carEvidenceImagePath = await uploadCarEvidenceImage(carEvidence.imageDataUrl, {
          capturedAt: carEvidence.capturedAt,
          capturedLatitude: carEvidence.capturedLatitude,
          capturedLocationLabel: carEvidence.capturedLocationLabel,
          capturedLongitude: carEvidence.capturedLongitude,
          requestDraftId: carEvidence.requestDraftId,
        });

        setCarEvidence((current) =>
          current
            ? {
                ...current,
                imagePath: carEvidenceImagePath,
                requestId: current.requestId,
              }
            : current,
        );
      }

      const attachmentUpload = isOffline ? { metadata: [], paths: [] } : await uploadTicketAttachments();
      const endpoint = isOffline ? "/api/outstation/sync-offline" : "/api/outstation/submit";
      const response = await fetch(endpoint, {
        body: JSON.stringify({
          ...requestPayload,
          attachmentCount: attachmentUpload.paths.length,
          hasTicketAttachments: attachmentUpload.paths.length > 0,
          ticketAttachmentMetadata: attachmentUpload.metadata,
          ticketAttachmentPaths: attachmentUpload.paths,
          carEvidenceImagePath:
            transportationType === "car" ? carEvidenceImagePath ?? undefined : undefined,
          claimedTotalAmount: calculation?.expectedTotalAmount ?? 0,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setWizardMessage(payload.message ?? payload.error ?? "Unable to submit the request.", "error");
        return;
      }

      resetFormState();
      setWizardMessage(
        isOffline
          ? "Offline request synced successfully."
          : "Outstation request submitted successfully.",
        "success",
      );
      setTimeout(() => {
        router.replace(postSubmitRedirectPath);
      }, 900);
    } catch (error) {
      setWizardMessage(
        error instanceof Error ? error.message : "Unable to submit the request.",
        "error",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
      <div className="min-w-0 space-y-5">
      <OfflineSyncBanner draftStorageError={draftStorageError} visible={isOffline} />

      {showIntro ? (
      <section className="overflow-hidden rounded-[30px] border border-slate-200 bg-[linear-gradient(135deg,#fff7ed_0%,#ffffff_46%,#f8fafc_100%)] p-6 shadow-[0_18px_45px_rgba(15,23,42,0.06)]">
        <p className="text-xs font-black uppercase tracking-[0.2em] text-orange-500">
          Outstation Expense
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-[-0.05em] text-slate-950">
          Smart expense entry
        </h1>
        <p className="mt-3 text-sm leading-7 text-slate-600">
          From is locked to your registered residence. Tap To so Phoenix Workforce captures
          your live destination, validates distance, detects fraud signals, and calculates the
          request automatically on the server.
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Stat label="Employee" value={formatEmployeeDisplayName(employeeName)} />
          <Stat label="Role" value={employeeRole} />
          <Stat label="From" value={residenceSummary} />
          <Stat label="Residence Coordinates" value={hasResidenceCoordinates ? "Ready" : "Missing"} />
        </div>
      </section>
      ) : null}

      <div className="grid min-w-0 gap-3 md:grid-cols-3">
        <WizardStep active={step === 1} icon={ReceiptText} label="1. Trip details" />
        <WizardStep active={step === 2} icon={transportIcon} label="2. Validate route" />
        <WizardStep active={step === 3} icon={CheckCircle2} label="3. Review & submit" />
      </div>

      <Card className="min-w-0 rounded-3xl border border-slate-200 bg-white p-4 shadow-[0_18px_40px_rgba(15,23,42,0.06)] sm:p-5">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
          Request Details
        </p>
        <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-slate-950">
          Fill the trip and let the system calculate the rest
        </h2>

        <div className="mt-4 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Expense Type">
            <select
              className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800"
              onChange={(event) => setExpenseType(event.target.value as OutstationExpenseType)}
              value={expenseType}
            >
              <option value="traveling">Traveling</option>
              <option value="meeting">Meeting</option>
              <option value="other">Other</option>
            </select>
          </Field>

          <Field label="From Date">
            <Input onChange={(event) => setTripStartDate(event.target.value)} type="date" value={tripStartDate} />
          </Field>

          <Field label="To Date">
            <Input onChange={(event) => setTripEndDate(event.target.value)} type="date" value={tripEndDate} />
            {tripDateRangeError ? (
              <p className="mt-1 text-xs font-bold text-red-700">{tripDateRangeError}</p>
            ) : null}
          </Field>

          <Field label="Duration">
            <div className="flex min-h-11 min-w-0 items-center rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm font-semibold leading-6 text-slate-800">
              {durationSummary}
            </div>
          </Field>

          <Field className="md:col-span-2" label="From">
            <LocationValue value={residenceSummary} />
          </Field>

          <Field className="md:col-span-2" label="To">
            <LocationCaptureButton
              disabled={isCapturing}
              loading={isCapturing}
              onClick={() => void captureLocation()}
              value={
                isCapturing
                  ? "Capturing destination..."
                  : captured?.toLabel ?? "Tap here to capture current location"
              }
            />
          </Field>

          <Field label="Transportation Type">
            <select
              className="h-11 w-full min-w-0 rounded-2xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800"
              onChange={(event) =>
                handleTransportationTypeChange(event.target.value as OutstationTransportationType)
              }
              value={transportationType}
            >
              <option value="car">Car</option>
              <option value="train">Train</option>
              <option value="bus">Bus</option>
              <option value="other">Other</option>
            </select>
          </Field>

          <Field label="Medical Representative">
            <select
              className="h-11 w-full min-w-0 rounded-2xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 disabled:bg-slate-50 disabled:text-slate-400"
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
            </select>
          </Field>

          {isTicketBased ? (
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

          <Field className="md:col-span-2 xl:col-span-4" label="Notes">
            <textarea
              className="min-h-28 w-full min-w-0 resize-y rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm leading-6 text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-orange-300 focus:bg-orange-50"
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Add any trip note or explanation"
              value={notes}
            />
          </Field>
        </div>

        <div className="mt-6 overflow-hidden rounded-[24px] border border-orange-100 bg-[linear-gradient(135deg,#fff7ed_0%,#ffffff_58%,#f8fafc_100%)] p-4 shadow-[0_16px_36px_rgba(15,23,42,0.05)] sm:p-5">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-orange-500 text-white shadow-[0_10px_22px_rgba(249,115,22,0.22)]">
                <Calculator className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-black uppercase text-orange-600">
                  Auto Calculated Summary
                </p>
                <p className="mt-1 text-[13px] font-medium leading-6 text-slate-600">
                  Live totals update after the dates and destination are captured.
                </p>
              </div>
            </div>
            <span className="w-fit rounded-full border border-orange-200 bg-white px-3 py-1 text-[11px] font-black uppercase text-orange-700">
              {summaryStatus}
            </span>
          </div>

          <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <SummaryValue
              featured
              label="Total Cost"
              pending={!calculation}
              value={calculation ? egp(calculation.expectedTotalAmount) : "Will appear automatically"}
            />
            <SummaryValue
              label="Allowance"
              pending={!calculation}
              value={calculation ? egp(calculation.allowanceAmount) : "Will appear automatically"}
            />
            <SummaryValue
              label={transportationType === "car" ? "Travel Cost" : "Ticket Cost"}
              pending={!calculation}
              value={
                calculation
                  ? transportationType === "car"
                    ? egp(calculation.fuelAmount)
                    : egp(calculation.ticketAmount)
                  : "Will appear automatically"
              }
            />
            <SummaryValue
              label="Kilometer"
              pending={calculation?.distanceFromResidenceKm == null}
              value={
                calculation?.distanceFromResidenceKm != null
                  ? `${calculation.distanceFromResidenceKm.toFixed(2)} KM`
                  : "Will appear automatically"
              }
            />
            <SummaryValue
              label="Estimated Duration"
              pending={calculation?.durationMinutes == null}
              value={
                calculation?.durationMinutes != null
                  ? `${calculation.durationMinutes.toFixed(0)} mins`
                  : "Will appear automatically"
              }
            />
            <SummaryValue
              label="Eligibility"
              pending={!calculation}
              value={
                calculation
                  ? calculation.eligibilityStatus.replace(/_/g, " ")
                  : "Will appear automatically"
              }
            />
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
          {isCalculating ? (
            <span className="inline-flex min-w-0 items-center gap-2 font-medium text-slate-800">
              <LoadingSpinner />
              <span className="min-w-0 break-words">
                Phoenix is calculating kilometer, allowance, amount, and validation automatically...
              </span>
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

      </Card>

      {transportationType === "car" ? (
        <Card className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
            Car Live Evidence
          </p>
          <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-slate-950">
            Capture one live photo from device camera
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">
            Car requests require one in-app camera photo with GPS and app-generated timestamp.
          </p>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
                Live Camera Evidence
              </span>
              <button
                className="flex min-h-12 w-full items-center justify-center gap-3 rounded-2xl bg-orange-500 px-5 text-sm font-semibold text-white transition hover:bg-orange-600 disabled:bg-orange-300"
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
            </label>
          </div>
          {isCarEvidenceCameraOpen ? (
            <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-slate-950">
              <video
                ref={videoRef}
                autoPlay
                className="aspect-video w-full object-cover"
                muted
                playsInline
              />
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-slate-950 p-4">
                <p className="text-sm font-semibold text-white">
                  Frame the car clearly, then capture the evidence photo.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="rounded-2xl border border-white/20 bg-transparent px-4 text-white hover:bg-white/10"
                    onClick={stopCarEvidenceCamera}
                    type="button"
                  >
                    Cancel
                  </Button>
                  <Button
                    className="rounded-2xl bg-orange-500 px-5 text-white hover:bg-orange-600"
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
            <div className="relative mt-4 overflow-hidden rounded-2xl border border-slate-200">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt="Live car evidence preview"
                className="h-auto w-full object-cover"
                src={carEvidence.imageDataUrl}
              />
            </div>
          ) : carEvidence ? (
            <LiveEvidenceRestoreNotice />
          ) : null}
        </Card>
      ) : (
        <TicketUploadCard
          attachmentCount={ticketFiles.length}
          onFilesSelected={(files) => setTicketFiles(files ? Array.from(files) : [])}
          transportationType={transportationType}
          visible={transportationType === "train" || transportationType === "bus"}
        />
      )}

      <OutstationCostBreakdown result={calculation} />
      <RouteMapPreview request={calculation} />

      {calculation ? (
        <Card className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
                Step 3
              </p>
              <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-slate-950">
                Submit request
              </h2>
            </div>
            <ApprovalRecommendationBadge value={calculation.approvalRecommendation} />
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              className="min-h-12 rounded-2xl bg-orange-500 px-5 text-white hover:bg-orange-600"
              disabled={
                isSubmitting ||
                isTripDateRangeInvalid ||
                calculation.eligibilityStatus === "not_eligible" ||
                (transportationType === "car" && !hasCarEvidence)
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
        </Card>
      ) : null}

      {message ? (
        <StatusCard
          className={wizardMessageClassName[messageSeverity]}
          role={wizardMessageRole[messageSeverity]}
          severity={messageSeverity}
        >
          {message}
        </StatusCard>
      ) : null}
    </div>
  );
}

function WizardStep({
  active,
  icon: Icon,
  label,
}: {
  active: boolean;
  icon: typeof MapPin;
  label: string;
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-3 rounded-2xl border px-4 py-3 ${
        active ? "border-orange-200 bg-orange-50" : "border-slate-200 bg-white"
      }`}
    >
      <span
        className={`flex h-10 w-10 items-center justify-center rounded-2xl ${
          active ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-600"
        }`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 text-sm font-bold leading-5 text-slate-900">{label}</span>
    </div>
  );
}

function Field({
  children,
  className,
  label,
}: {
  children: React.ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <label className={cn("block min-w-0", className)}>
      <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function LiveEvidenceRestoreNotice() {
  return (
    <InfoStatusCard className="mt-4">
      Live evidence metadata is restored, but the image preview cannot be restored. Re-capture the photo before submitting if needed.
    </InfoStatusCard>
  );
}

function LocationValue({ value }: { value: string }) {
  return (
    <div className="flex min-h-12 w-full min-w-0 items-start gap-2.5 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold leading-6 text-slate-800">
      <MapPin className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
      <span className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere]">
        {value}
      </span>
    </div>
  );
}

function LocationCaptureButton({
  disabled,
  loading,
  onClick,
  value,
}: {
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
  value: string;
}) {
  return (
    <button
      className="flex min-h-12 w-full min-w-0 items-start gap-2.5 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-left text-sm font-semibold leading-6 text-slate-800 transition hover:border-orange-300 hover:bg-orange-50 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere]">
        {value}
      </span>
      {loading ? (
        <span className="mt-1 shrink-0">
          <LoadingSpinner />
        </span>
      ) : (
        <MapPin className="mt-1 h-4 w-4 shrink-0 text-orange-500" />
      )}
    </button>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-slate-200 bg-white/80 p-4">
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 break-words text-sm font-semibold leading-6 text-slate-900 [overflow-wrap:anywhere]">
        {value}
      </p>
    </div>
  );
}

function SummaryValue({
  featured = false,
  label,
  pending = false,
  value,
}: {
  featured?: boolean;
  label: string;
  pending?: boolean;
  value: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-[20px] border bg-white/90 p-4 shadow-[0_10px_22px_rgba(15,23,42,0.04)]",
        featured ? "border-orange-200" : "border-white/80",
      )}
    >
      <p className="text-[11px] font-black uppercase text-slate-500">{label}</p>
      <p
        className={cn(
          "mt-2 break-words leading-tight [overflow-wrap:anywhere]",
          pending
            ? "text-[13px] font-semibold text-slate-500"
            : featured
              ? "text-2xl font-black text-orange-600"
              : "text-lg font-black text-slate-950",
        )}
      >
        {value}
      </p>
    </div>
  );
}
