"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Clock,
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

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import type {
  MarketingCustomerType,
  MarketingDistributor,
  MarketingValidationReportRow,
  MarketingValidationStatus,
  MarketingValidationWorkspace as MarketingValidationWorkspacePayload,
} from "@/lib/marketing-requests/types";

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Focus Trap Hook â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

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

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Offline Queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

type QueuedSubmission = {
  id: string;
  payload: unknown;
  timestamp: number;
};

function useOfflineQueue(onReplay: (payload: unknown) => Promise<void>) {
  const [queue, setQueue] = useState<QueuedSubmission[]>([]);
  // Always start `true` to match SSR output â€” sync real value in useEffect
  const [isOnline, setIsOnline] = useState(true);
  const replayingRef = useRef(false);

  useEffect(() => {
    // Sync real browser state after hydration â€” must live in useEffect to avoid SSR mismatch
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
          // Stop replaying on first failure â€” will retry next time online
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

  return { enqueue, isOnline, queueLength: queue.length };
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

type CaptureState = {
  accuracy: number | null;
  address: string;
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  photoCapturedAt: string | null;
  photoDataUrl: string | null;
  photoName: string;
};

type VendorCodeLine = {
  distributorCode: string;
  distributorId: string;
  key: string;
};

type PharmacyLine = {
  capture: CaptureState;
  governorate: string;
  key: string;
  name: string;
  area: string;
  vendorCodes: VendorCodeLine[];
};

type CameraTarget =
  | { kind: "customer" }
  | { kind: "pharmacy"; pharmacyKey: string };

type ValidatedCustomerGroup = {
  customerName: string;
  customerType: string;
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

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const customerTypes: Array<{ label: string; value: MarketingCustomerType }> = [
  { label: "Clinic", value: "clinic" },
  { label: "Hospital", value: "hospital" },
  { label: "Account", value: "account" },
  { label: "Other", value: "other" },
];

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Utility Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

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
    governorate: "",
    key: stableKey("pharmacy"),
    name: "",
    area: "",
    vendorCodes: [newVendorCodeLine(distributorId)],
  };
}

function emptyWorkspace(): MarketingValidationWorkspacePayload {
  return {
    distributors: [],
    rows: [],
    summary: {
      pending: 0,
      rejected: 0,
      sfe_validated: 0,
      system_validated: 0,
    },
  };
}

function statusVariant(status: MarketingValidationStatus): "success" | "warning" | "danger" | "neutral" {
  if (status === "system_validated" || status === "sfe_validated") return "success";
  if (status === "rejected") return "danger";
  if (status === "pending") return "warning";
  return "neutral";
}

function buildValidatedPharmacyDetails(rows: MarketingValidationReportRow[]) {
  const pharmacies = new Map<string, ValidatedPharmacyDetail>();
  for (const row of rows) {
    const current = pharmacies.get(row.pharmacy.id);
    const vendorCode = {
      code: row.distributorCode.distributorPharmacyCode,
      distributorName: row.distributorName,
      id: row.distributorCode.id,
      status: row.distributorCode.referenceStatus.replace(/_/g, " "),
    };

    if (current) {
      if (!current.vendorCodes.some((line) => line.id === vendorCode.id)) {
        current.vendorCodes.push(vendorCode);
      }
      continue;
    }

    pharmacies.set(row.pharmacy.id, {
      area: row.pharmacy.extractedAreaName ?? row.pharmacy.regionName ?? "",
      governorate: row.pharmacy.extractedGovernorateName ?? "",
      id: row.pharmacy.id,
      name: row.pharmacy.displayName,
      vendorCodes: [vendorCode],
    });
  }

  return Array.from(pharmacies.values());
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Sub-components â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

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
    <select
      className="h-10 w-full rounded-sm border border-slate-200 bg-white px-3 text-[13px] font-semibold text-slate-800 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {children}
    </select>
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
          <p className="mt-0.5 text-[12px] font-medium text-slate-500">
            {hasLocation ? capture.address || `${capture.latitude?.toFixed(5)}, ${capture.longitude?.toFixed(5)}` : "No GPS capture yet"}
          </p>
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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt={`${label} captured evidence`} className="h-36 w-full object-contain" src={capture.photoDataUrl} />
          <p className="bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-500">{capture.photoCapturedAt}</p>
        </div>
      ) : null}
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
          <div className="block xs:hidden">
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
          <div className="hidden xs:block">
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
  const hasLocationStamp = capture.latitude !== null &&
    capture.longitude !== null &&
    Boolean(capture.capturedAt) &&
    Boolean(capture.address);

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
    const stampLines = [
      `${targetLabel} live evidence`,
      `Photo date/time: ${photoCapturedAtIso}`,
      `GPS: ${capture.latitude?.toFixed(6)}, ${capture.longitude?.toFixed(6)}${capture.accuracy ? ` (accuracy ${Math.round(capture.accuracy)}m)` : ""}`,
      `GPS captured at: ${capture.capturedAt}`,
      `Address: ${capture.address}`,
    ];

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
            <p className="mt-1.5 text-[11px] font-semibold text-slate-600 line-clamp-2">{capture.address}</p>
          ) : null}
        </div>
        <div className="bg-slate-900">
          {pendingPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt={`${targetLabel} stamped live evidence preview`}
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

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Skeleton Loader â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

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

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Main Exported Component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export function MarketingValidationWorkspace() {
  const [workspace, setWorkspace] = useState<MarketingValidationWorkspacePayload>(emptyWorkspace);
  const [activeTab, setActiveTab] = useState<"validation" | "validated">("validation");
  const [selectedValidatedCustomerKey, setSelectedValidatedCustomerKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [captureTarget, setCaptureTarget] = useState<"customer" | string | null>(null);
  const [cameraTarget, setCameraTarget] = useState<CameraTarget | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [customerType, setCustomerType] = useState<MarketingCustomerType>("clinic");
  const [customerName, setCustomerName] = useState("");
  const [customerArea, setCustomerArea] = useState("");
  const [customerGovernorate, setCustomerGovernorate] = useState("");
  const [customerMobile, setCustomerMobile] = useState("");
  const [customerOtherType, setCustomerOtherType] = useState("");
  const [customerCapture, setCustomerCapture] = useState<CaptureState>(emptyCapture);
  const [pharmacies, setPharmacies] = useState<PharmacyLine[]>([newPharmacyLine()]);
  const [hasMounted, setHasMounted] = useState(false);
  // Hydration flag — mount-only setState is the canonical React pattern.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setHasMounted(true); }, []);

  // Offline queue â€” replay pending submissions when connectivity returns
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
  const { enqueue, isOnline, queueLength } = useOfflineQueue(replaySubmission);

  async function loadWorkspace() {
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
        distributors: payload.distributors ?? [],
        rows: payload.rows ?? [],
        summary: payload.summary ?? emptyWorkspace().summary,
      });
      setPharmacies((current) =>
        current.map((pharmacy) => ({
          ...pharmacy,
          vendorCodes: pharmacy.vendorCodes.map((line) => ({
            ...line,
            distributorId: line.distributorId || String(payload.distributors?.[0]?.id ?? ""),
          })),
        })),
      );
    } catch {
      setWorkspace(emptyWorkspace());
      setMessage("Unable to load validation workspace.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadWorkspace();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const defaultDistributorId = String(workspace.distributors[0]?.id ?? "");
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
          key,
          rows: [row],
          status: row.validationStatus,
        });
      }
    }
    return Array.from(groups.values());
  }, [workspace.rows]);
  const selectedValidatedGroup = useMemo(
    () => validatedGroups.find((group) => group.key === selectedValidatedCustomerKey) ?? null,
    [selectedValidatedCustomerKey, validatedGroups],
  );
  const selectedValidatedPharmacies = useMemo(
    () => (selectedValidatedGroup ? buildValidatedPharmacyDetails(selectedValidatedGroup.rows) : []),
    [selectedValidatedGroup],
  );

  const canSave = Boolean(
    !isSaving &&
    customerName.trim() &&
    pharmacies.every((pharmacy) =>
      pharmacy.name.trim() &&
      pharmacy.vendorCodes.length > 0 &&
      pharmacy.vendorCodes.every((line) => line.distributorId && line.distributorCode.trim()),
    ),
  );

  async function reverseGeocode(latitude: number, longitude: number) {
    const response = await fetch("/api/marketing-requests/reverse-geocode", {
      body: JSON.stringify({ latitude, longitude }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) return null;
    return await response.json() as { area?: string | null; city?: string | null; governorate?: string | null; label?: string | null };
  }

  function updatePharmacy(key: string, patch: Partial<PharmacyLine>) {
    setPharmacies((current) =>
      current.map((pharmacy) => (pharmacy.key === key ? { ...pharmacy, ...patch } : pharmacy)),
    );
  }

  function updateVendorCode(pharmacyKey: string, vendorKey: string, patch: Partial<VendorCodeLine>) {
    setPharmacies((current) =>
      current.map((pharmacy) =>
        pharmacy.key === pharmacyKey
          ? {
              ...pharmacy,
              vendorCodes: pharmacy.vendorCodes.map((line) =>
                line.key === vendorKey ? { ...line, ...patch } : line,
              ),
            }
          : pharmacy,
      ),
    );
  }

  async function captureLocation(target: "customer" | string) {
    setMessage(null);
    if (!navigator.geolocation) {
      setMessage("GPS capture is not supported in this browser.");
      return;
    }

    setCaptureTarget(target);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const capturedAt = new Date(position.timestamp || Date.now()).toISOString();
        const basePatch = {
          accuracy: position.coords.accuracy,
          address: `${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)}`,
          capturedAt,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };

        if (target === "customer") {
          setCustomerCapture((current) => ({ ...current, ...basePatch }));
        } else {
          setPharmacies((current) =>
            current.map((pharmacy) =>
              pharmacy.key === target ? { ...pharmacy, capture: { ...pharmacy.capture, ...basePatch } } : pharmacy,
            ),
          );
        }
        void reverseGeocode(position.coords.latitude, position.coords.longitude).then((result) => {
          const area = result?.area ?? "";
          const governorate = result?.governorate ?? result?.city ?? "";
          const label = result?.label || [area, governorate].filter(Boolean).join(", ");
          if (!label) return;
          if (target === "customer") {
            setCustomerArea(area);
            setCustomerGovernorate(governorate);
            setCustomerCapture((current) => ({ ...current, address: label }));
          } else {
            setPharmacies((current) =>
              current.map((pharmacy) =>
                pharmacy.key === target
                  ? {
                      ...pharmacy,
                      capture: { ...pharmacy.capture, address: label },
                      area,
                      governorate,
                    }
                  : pharmacy,
              ),
            );
          }
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

  function applyLivePhoto(dataUrl: string, photoCapturedAt: string) {
    if (cameraTarget?.kind === "customer") {
      setCustomerCapture((current) => ({
        ...current,
        photoCapturedAt,
        photoDataUrl: dataUrl,
        photoName: `customer-live-${photoCapturedAt}.jpg`,
      }));
    } else if (cameraTarget?.kind === "pharmacy") {
      setPharmacies((current) =>
        current.map((pharmacy) =>
          pharmacy.key === cameraTarget.pharmacyKey
            ? {
                ...pharmacy,
                capture: {
                  ...pharmacy.capture,
                  photoCapturedAt,
                  photoDataUrl: dataUrl,
                  photoName: `pharmacy-live-${photoCapturedAt}.jpg`,
                },
              }
            : pharmacy,
        ),
      );
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
      evidencePhotoName: capture.photoName || null,
    };
  }

  function buildSubmissionPayload() {
    return {
      customer: {
        ...payloadCapture(customerCapture),
        customerType,
        displayName: customerName,
        mobileNumber: customerMobile,
        otherTypeDescription: customerOtherType,
        extractedAreaName: customerArea,
        extractedGovernorateName: customerGovernorate,
        regionName: [customerArea, customerGovernorate].filter(Boolean).join(", "),
      },
      pharmacies: pharmacies.map((pharmacy) => ({
        ...payloadCapture(pharmacy.capture),
        displayName: pharmacy.name,
        extractedAreaName: pharmacy.area,
        extractedGovernorateName: pharmacy.governorate,
        regionName: [pharmacy.area, pharmacy.governorate].filter(Boolean).join(", "),
        vendorCodes: pharmacy.vendorCodes.map((line) => ({
          distributorId: Number(line.distributorId),
          distributorPharmacyCode: line.distributorCode,
        })),
      })),
    };
  }

  function resetForm() {
    setCustomerName("");
    setCustomerArea("");
    setCustomerGovernorate("");
    setCustomerMobile("");
    setCustomerOtherType("");
    setCustomerCapture(emptyCapture());
    setPharmacies([newPharmacyLine(defaultDistributorId)]);
  }

  async function submitValidation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    if (!canSave) {
      setMessage("Complete the customer, pharmacy, vendor, and code fields before saving.");
      return;
    }

    const submissionPayload = buildSubmissionPayload();

    // Offline path â€” queue and optimistically update UI
    if (!isOnline) {
      enqueue(submissionPayload);
      // Optimistic: increment pending count
      setWorkspace((current) => ({
        ...current,
        summary: { ...current.summary, pending: current.summary.pending + pharmacies.length },
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
      setMessage("Validation rows saved.");
      // Optimistic: switch to validated tab so user immediately sees new entry
      if (rows.some((r) => r.validationStatus === "system_validated" || r.validationStatus === "sfe_validated")) {
        setActiveTab("validated");
      }
    } catch {
      // Network failure mid-request â€” queue for retry
      enqueue(submissionPayload);
      resetForm();
      setMessage("Network error. Submission queued for automatic retry.");
    } finally {
      setIsSaving(false);
    }
  }

  const activeCameraCapture = cameraTarget?.kind === "customer"
    ? customerCapture
    : cameraTarget
      ? pharmacies.find((pharmacy) => pharmacy.key === cameraTarget.pharmacyKey)?.capture ?? null
      : null;
  const activeCameraLabel = cameraTarget?.kind === "customer" ? "Customer" : "Pharmacy";

  const totalValidated = workspace.summary.system_validated + workspace.summary.sfe_validated;

  return (
    <WorkspaceErrorBoundary fallbackTitle="Validation workspace error">
    <div className="space-y-4" dir="auto">
      {/* â”€â”€â”€ Offline Indicator â”€â”€â”€ */}
      {hasMounted && (!isOnline || queueLength > 0) && (
        <div className="flex items-center gap-2 rounded-sm border border-amber-200 bg-amber-50 px-3.5 py-2 text-[12px] font-semibold text-amber-800">
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          {!isOnline
            ? "You are offline. Submissions will be queued and synced automatically."
            : `Syncing ${queueLength} queued submission${queueLength > 1 ? "s" : ""}...`}
        </div>
      )}

      {/* â”€â”€â”€ Summary Metrics â”€â”€â”€ */}
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

      {/* â”€â”€â”€ Tab Buttons â”€â”€â”€ */}
      <div className="flex gap-2 rounded-sm border border-slate-200 bg-white p-1.5">
        <TabButton active={activeTab === "validation"} onClick={() => setActiveTab("validation")}>
          Validate Customer
        </TabButton>
        <TabButton active={activeTab === "validated"} onClick={() => setActiveTab("validated")}>
          Validated ({validatedGroups.length})
        </TabButton>
      </div>

      {/* â”€â”€â”€ Alert Messages â”€â”€â”€ */}
      {message ? (
        <div className={`rounded-sm border px-3.5 py-2.5 text-[13px] font-semibold ${message.includes("saved") || message.includes("success") ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          {message}
        </div>
      ) : null}

      {/* â”€â”€â”€ Validation Form Tab â”€â”€â”€ */}
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
                    HCP / PH Validation
                  </p>
                  <h2 className="text-lg font-black tracking-tight text-slate-900">
                    Customer and pharmacy evidence
                  </h2>
                </div>
              </div>
            </div>

            <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-6">
              <div className="lg:col-span-2">
                <Field label="Customer Type">
                  <SelectField onChange={(value) => setCustomerType(value as MarketingCustomerType)} value={customerType}>
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
                    className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
                    onChange={(event) => setCustomerName(event.target.value)}
                    placeholder="Customer name"
                    value={customerName}
                  />
                </Field>
              </div>
              {customerType === "other" ? (
                <div className="lg:col-span-3">
                  <Field label="Other Type">
                    <Input
                      className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
                      onChange={(event) => setCustomerOtherType(event.target.value)}
                      placeholder="Describe customer type"
                      value={customerOtherType}
                    />
                  </Field>
                </div>
              ) : null}
              <div className={customerType === "other" ? "lg:col-span-3" : "lg:col-span-2"}>
                <Field label="Area (GPS)">
                  <ReadOnlyCaptureValue placeholder="From GPS" value={customerArea} />
                </Field>
              </div>
              <div className={customerType === "other" ? "lg:col-span-3" : "lg:col-span-2"}>
                <Field label="Governorate (GPS)">
                  <ReadOnlyCaptureValue placeholder="From GPS" value={customerGovernorate} />
                </Field>
              </div>
              <div className="lg:col-span-2">
                <Field label="Phone">
                  <Input
                    className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
                    onChange={(event) => setCustomerMobile(event.target.value)}
                    placeholder="Mobile number"
                    type="tel"
                    value={customerMobile}
                  />
                </Field>
              </div>
              <div className="lg:col-span-6">
                <Field label="Address (GPS)">
                  <ReadOnlyCaptureValue multiline placeholder="Full address from GPS capture" value={customerCapture.address} />
                </Field>
              </div>
              <div className="lg:col-span-6">
                <CapturePanel
                  capture={customerCapture}
                  isCapturing={captureTarget === "customer"}
                  label="Customer GPS + live sign photo"
                  onCaptureLocation={() => captureLocation("customer")}
                  onOpenCamera={() => setCameraTarget({ kind: "customer" })}
                />
              </div>

              {/* Pharmacy section divider */}
              <div className="lg:col-span-6">
                <div className="flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.14em] text-orange-600">Pharmacy Validation</p>
                    <p className="mt-0.5 text-[12px] font-medium text-slate-500">Multiple pharmacies per customer, multiple vendors per pharmacy.</p>
                  </div>
                  <Button
                    className="h-8 shrink-0 gap-1.5 rounded-sm border border-slate-200 bg-white px-3 text-[12px] font-bold text-slate-700 hover:bg-slate-50"
                    onClick={() => setPharmacies((current) => [...current, newPharmacyLine(defaultDistributorId)])}
                    type="button"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Pharmacy
                  </Button>
                </div>
              </div>

              {pharmacies.map((pharmacy, index) => (
                <div className="lg:col-span-6" key={pharmacy.key}>
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
                        disabled={pharmacies.length === 1}
                        onClick={() => setPharmacies((current) => current.length === 1 ? current : current.filter((item) => item.key !== pharmacy.key))}
                        type="button"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="grid gap-3 lg:grid-cols-6">
                      <div className="lg:col-span-2">
                        <Field label="Pharmacy Name">
                          <Input
                            className="h-10 rounded-sm border-slate-200 bg-white text-[13px]"
                            onChange={(event) => updatePharmacy(pharmacy.key, { name: event.target.value })}
                            placeholder="Name"
                            value={pharmacy.name}
                          />
                        </Field>
                      </div>
                      <div className="lg:col-span-2">
                        <Field label="Area (GPS)">
                          <ReadOnlyCaptureValue placeholder="From GPS" value={pharmacy.area} />
                        </Field>
                      </div>
                      <div className="lg:col-span-2">
                        <Field label="Governorate (GPS)">
                          <ReadOnlyCaptureValue placeholder="From GPS" value={pharmacy.governorate} />
                        </Field>
                      </div>
                      <div className="lg:col-span-6">
                        <Field label="Address (GPS)">
                          <ReadOnlyCaptureValue multiline placeholder="Full address from GPS" value={pharmacy.capture.address} />
                        </Field>
                      </div>
                      <div className="lg:col-span-6">
                        <CapturePanel
                          capture={pharmacy.capture}
                          isCapturing={captureTarget === pharmacy.key}
                          label="Pharmacy GPS + live sign photo"
                          onCaptureLocation={() => captureLocation(pharmacy.key)}
                          onOpenCamera={() => setCameraTarget({ kind: "pharmacy", pharmacyKey: pharmacy.key })}
                        />
                      </div>
                      <div className="lg:col-span-6">
                        <div className="space-y-2.5">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">
                              Vendor Codes
                            </p>
                            <Button
                              className="h-7 gap-1.5 rounded-sm border border-slate-200 bg-white px-2.5 text-[11px] font-bold text-slate-600 hover:bg-slate-50"
                              onClick={() => updatePharmacy(pharmacy.key, { vendorCodes: [...pharmacy.vendorCodes, newVendorCodeLine(defaultDistributorId)] })}
                              type="button"
                            >
                              <Plus className="h-3 w-3" />
                              Add
                            </Button>
                          </div>
                          {pharmacy.vendorCodes.map((line) => (
                            <div className="grid grid-cols-[1fr_1fr_32px] gap-2" key={line.key}>
                              <SelectField
                                disabled={workspace.distributors.length === 0}
                                onChange={(value) => updateVendorCode(pharmacy.key, line.key, { distributorId: value })}
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
                                onChange={(event) => updateVendorCode(pharmacy.key, line.key, { distributorCode: event.target.value })}
                                placeholder="Code"
                                value={line.distributorCode}
                              />
                              <button
                                aria-label="Remove vendor"
                                className="flex h-10 w-full items-center justify-center rounded-sm border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
                                disabled={pharmacy.vendorCodes.length === 1}
                                onClick={() =>
                                  updatePharmacy(pharmacy.key, {
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
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-3 border-t border-slate-100 bg-slate-50/50 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="flex items-center gap-2 text-[13px] font-bold text-slate-700">
                <ShieldCheck className="h-4 w-4 shrink-0 text-orange-500" />
                <span>{pharmacies.length} pharmacy row{pharmacies.length === 1 ? "" : "s"} ready</span>
              </div>
              <Button
                className="h-10 min-w-[180px] gap-2 rounded-sm bg-orange-500 px-5 text-[13px] font-bold text-white shadow-sm hover:bg-orange-600"
                disabled={!canSave}
                type="submit"
              >
                {isSaving ? <LoadingSpinner className="text-white" /> : <Save className="h-3.5 w-3.5" />}
                Save Validation
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        /* â”€â”€â”€ Validated Customers Tab â”€â”€â”€ */
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
              <div className="mt-4 block xs:hidden">
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
                              <div className="mt-1 flex items-center gap-2">
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
              <div className="mt-4 hidden xs:block">
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

      {/* â”€â”€â”€ Modals â”€â”€â”€ */}
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
