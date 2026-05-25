"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Camera,
  CheckCircle2,
  MapPin,
  Plus,
  RefreshCcw,
  Save,
  ShieldCheck,
  Store,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type {
  MarketingCustomerType,
  MarketingDistributor,
  MarketingValidationReportRow,
  MarketingValidationStatus,
  MarketingValidationWorkspace as MarketingValidationWorkspacePayload,
} from "@/lib/marketing-requests/types";

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

const customerTypes: Array<{ label: string; value: MarketingCustomerType }> = [
  { label: "Clinic", value: "clinic" },
  { label: "Hospital", value: "hospital" },
  { label: "Account", value: "account" },
  { label: "Other", value: "other" },
];

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
    key: `vendor-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  };
}

function newPharmacyLine(distributorId = ""): PharmacyLine {
  return {
    capture: emptyCapture(),
    governorate: "",
    key: `pharmacy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

function Field({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-2 block text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
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
  const captureClassName = "w-full rounded border border-slate-200 bg-slate-100 px-4 text-sm font-bold text-slate-700 shadow-inner outline-none";

  if (multiline) {
    return (
      <textarea
        aria-readonly="true"
        className={`${captureClassName} min-h-20 resize-none py-3`}
        placeholder={placeholder}
        readOnly
        value={value}
      />
    );
  }

  return (
    <Input
      aria-readonly="true"
      className="h-12 cursor-default rounded border-slate-200 bg-slate-100 font-bold text-slate-700 shadow-inner"
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
      className="h-12 w-full rounded border border-slate-200 bg-white px-4 text-sm font-bold text-slate-800 outline-none transition focus:border-orange-300 focus:ring-4 focus:ring-orange-100 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {children}
    </select>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-2xl font-black text-slate-950">{value}</p>
    </div>
  );
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
      className={`min-h-11 rounded px-4 text-sm font-black transition ${
        active
          ? "bg-orange-500 text-white shadow-[0_12px_24px_rgba(249,115,22,0.22)]"
          : "border border-slate-200 bg-white text-slate-600 hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
      }`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="max-h-[88vh] w-full max-w-3xl overflow-hidden rounded border border-white/20 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Linked pharmacies</p>
            <h3 className="mt-1 whitespace-nowrap text-xl font-black text-slate-950">{group.customerName}</h3>
          </div>
          <Button
            className="rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            onClick={onClose}
            type="button"
          >
            Close
          </Button>
        </div>
        <div className="max-h-[65vh] overflow-auto p-5">
          <div className="overflow-hidden rounded border border-slate-200">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] border-collapse text-left">
                <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Pharmacy</th>
                    <th className="px-4 py-3">Area</th>
                    <th className="px-4 py-3">Governorate</th>
                    <th className="px-4 py-3">Vendor Codes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white text-sm">
                  {pharmacies.map((pharmacy) => (
                    <tr key={pharmacy.id}>
                      <td className="px-4 py-3 font-black text-slate-950">{pharmacy.name}</td>
                      <td className="px-4 py-3 font-semibold text-slate-700">{pharmacy.area || "Not captured"}</td>
                      <td className="px-4 py-3 font-semibold text-slate-700">{pharmacy.governorate || "Not captured"}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          {pharmacy.vendorCodes.map((line) => (
                            <span
                              className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700"
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
    <div className="rounded border border-slate-200 bg-slate-50 p-3">
      <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto]">
        <div className="min-w-0">
          <p className="text-sm font-black text-slate-950">{label}</p>
          <p className="mt-1 whitespace-nowrap text-xs font-semibold text-slate-500">
            {hasLocation ? capture.address || `${capture.latitude?.toFixed(5)}, ${capture.longitude?.toFixed(5)}` : "No GPS capture yet"}
          </p>
        </div>
        <Button
          className="gap-2 rounded border border-orange-200 bg-white text-orange-700 hover:bg-orange-50"
          disabled={isCapturing}
          onClick={onCaptureLocation}
          type="button"
        >
          {isCapturing ? <LoadingSpinner /> : <MapPin className="h-4 w-4" />}
          Capture Location
        </Button>
        <Button
          className="gap-2 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          disabled={!hasLocation}
          onClick={onOpenCamera}
          type="button"
        >
          <Camera className="h-4 w-4" />
          Live Photo
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Badge variant={hasLocation ? "success" : "warning"}>
          {hasLocation ? "Location captured" : "Location required"}
        </Badge>
        <Badge variant={hasPhoto ? "success" : "warning"}>
          {hasPhoto ? "Timestamped live photo" : "Live photo required"}
        </Badge>
      </div>
      {capture.photoDataUrl ? (
        <div className="mt-3 overflow-hidden rounded border border-slate-200 bg-slate-950">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt={`${label} captured evidence`} className="h-40 w-full object-contain" src={capture.photoDataUrl} />
          <p className="bg-white px-3 py-2 text-xs font-bold text-slate-500">{capture.photoCapturedAt}</p>
        </div>
      ) : null}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-hidden rounded border border-white/20 bg-white shadow-2xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-black text-slate-950">Live timestamped photo</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">{message}</p>
          {hasLocationStamp ? (
            <p className="mt-2 line-clamp-2 text-xs font-bold text-slate-600">{capture.address}</p>
          ) : null}
        </div>
        <div className="bg-slate-950">
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
        <div className="flex flex-wrap items-center justify-end gap-3 bg-slate-50 px-5 py-4">
          <Button
            className="rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            onClick={onClose}
            type="button"
          >
            Cancel
          </Button>
          {pendingPhoto ? (
            <>
              <Button
                className="gap-2 rounded border border-orange-200 bg-white text-orange-700 hover:bg-orange-50"
                onClick={() => {
                  setPendingPhoto(null);
                  setMessage("Camera ready");
                }}
                type="button"
              >
                Re-take
              </Button>
              <Button
                className="gap-2 rounded bg-orange-500 text-white hover:bg-orange-600"
                onClick={confirmPhoto}
                type="button"
              >
                Confirm Photo
              </Button>
            </>
          ) : (
            <>
              <Button
                className="gap-2 rounded border border-orange-200 bg-white text-orange-700 hover:bg-orange-50"
                disabled={isStarting}
                onClick={startCamera}
                type="button"
              >
                {isStarting ? <LoadingSpinner /> : <Camera className="h-4 w-4" />}
                {cameraReady ? "Restart Camera" : "Start Camera"}
              </Button>
              <Button
                className="gap-2 rounded bg-orange-500 text-white hover:bg-orange-600"
                disabled={!cameraReady || !hasLocationStamp}
                onClick={captureFrame}
                type="button"
              >
                <Camera className="h-4 w-4" />
                Capture Photo
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

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

  async function submitValidation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    if (!canSave) {
      setMessage("Complete the customer, pharmacy, vendor, and code fields before saving.");
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch("/api/marketing-requests/validation", {
        body: JSON.stringify({
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
        }),
        headers: {
          "Content-Type": "application/json",
        },
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
      setCustomerName("");
      setCustomerArea("");
      setCustomerGovernorate("");
      setCustomerMobile("");
      setCustomerOtherType("");
      setCustomerCapture(emptyCapture());
      setPharmacies([newPharmacyLine(defaultDistributorId)]);
      setMessage("Validation rows saved.");
    } catch {
      setMessage("Unable to save validation row.");
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

  return (
    <div className="space-y-6">
      <Card className="rounded border border-slate-200 bg-white p-4 shadow-[0_18px_44px_rgba(15,23,42,0.06)] sm:p-5">
        <div className="grid gap-3 md:grid-cols-5">
          <Metric label="System Validated" value={workspace.summary.system_validated} />
          <Metric label="Pending" value={workspace.summary.pending} />
          <Metric label="SFE Validated" value={workspace.summary.sfe_validated} />
          <Metric label="Rejected" value={workspace.summary.rejected} />
          <button
            className="flex min-h-[78px] items-center justify-center gap-2 rounded border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
            onClick={() => {
              setIsLoading(true);
              setMessage(null);
              void loadWorkspace();
            }}
            type="button"
          >
            {isLoading ? <LoadingSpinner /> : <RefreshCcw className="h-4 w-4" />}
            Refresh
          </button>
        </div>
      </Card>

      <div className="flex flex-wrap gap-2 rounded border border-slate-200 bg-white p-2 shadow-[0_18px_44px_rgba(15,23,42,0.06)]">
        <TabButton active={activeTab === "validation"} onClick={() => setActiveTab("validation")}>
          Customer + Pharmacy Validation
        </TabButton>
        <TabButton active={activeTab === "validated"} onClick={() => setActiveTab("validated")}>
          Validated Customers
        </TabButton>
      </div>

      {message ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
          {message}
        </div>
      ) : null}

      {activeTab === "validation" ? (
        <Card className="overflow-hidden rounded border border-slate-200 bg-white p-0 shadow-[0_24px_60px_rgba(15,23,42,0.08)]">
          <form onSubmit={submitValidation}>
            <div className="border-b border-slate-100 bg-gradient-to-r from-white via-orange-50/60 to-white p-5 sm:p-7">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">
                    HCP / PH Validation
                  </p>
                  <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">
                    Customer and pharmacy evidence
                  </h2>
                </div>
                <div className="flex h-12 w-12 items-center justify-center rounded bg-orange-50 text-orange-600 ring-1 ring-orange-100">
                  <ShieldCheck className="h-5 w-5" />
                </div>
              </div>
            </div>

            <div className="grid gap-5 p-5 sm:p-7 lg:grid-cols-6">
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
                    className="h-12 rounded border-slate-200 bg-white"
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
                      className="h-12 rounded border-slate-200 bg-white"
                      onChange={(event) => setCustomerOtherType(event.target.value)}
                      placeholder="Describe customer type"
                      value={customerOtherType}
                    />
                  </Field>
                </div>
              ) : null}
              <div className={customerType === "other" ? "lg:col-span-3" : "lg:col-span-2"}>
                <Field label="Extracted Customer Area">
                  <ReadOnlyCaptureValue
                    placeholder="Area from GPS"
                    value={customerArea}
                  />
                </Field>
              </div>
              <div className={customerType === "other" ? "lg:col-span-3" : "lg:col-span-2"}>
                <Field label="Extracted Customer Governorate">
                  <ReadOnlyCaptureValue
                    placeholder="Governorate from GPS"
                    value={customerGovernorate}
                  />
                </Field>
              </div>
              <div className="lg:col-span-2">
                <Field label="Customer Phone">
                  <Input
                    className="h-12 rounded border-slate-200 bg-white"
                    onChange={(event) => setCustomerMobile(event.target.value)}
                    placeholder="Mobile number"
                    type="tel"
                    value={customerMobile}
                  />
                </Field>
              </div>
              <div className="lg:col-span-6">
                <Field label="Captured Customer Address">
                  <ReadOnlyCaptureValue
                    multiline
                    placeholder="Full address from GPS capture"
                    value={customerCapture.address}
                  />
                </Field>
              </div>
              <div className="lg:col-span-6">
                <CapturePanel
                  capture={customerCapture}
                  isCapturing={captureTarget === "customer"}
                  label="Customer GPS and live sign photo"
                  onCaptureLocation={() => captureLocation("customer")}
                  onOpenCamera={() => setCameraTarget({ kind: "customer" })}
                />
              </div>

              <div className="lg:col-span-6">
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">Pharmacy Validation</p>
                    <p className="mt-1 text-sm font-semibold text-slate-500">Each customer can have multiple pharmacies, and each pharmacy can have multiple vendors.</p>
                  </div>
                  <Button
                    className="gap-2 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                    onClick={() => setPharmacies((current) => [...current, newPharmacyLine(defaultDistributorId)])}
                    type="button"
                  >
                    <Plus className="h-4 w-4" />
                    Add Pharmacy
                  </Button>
                </div>
              </div>

              {pharmacies.map((pharmacy, index) => (
                <div className="lg:col-span-6" key={pharmacy.key}>
                  <div className="rounded border border-slate-200 bg-slate-50 p-4">
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded bg-white text-orange-600 ring-1 ring-orange-100">
                          <Store className="h-4 w-4" />
                        </div>
                        <p className="text-sm font-black text-slate-950">Pharmacy {index + 1}</p>
                      </div>
                      <button
                        aria-label="Remove pharmacy"
                        className="flex h-10 w-10 items-center justify-center rounded border border-slate-200 bg-white text-slate-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
                        disabled={pharmacies.length === 1}
                        onClick={() => setPharmacies((current) => current.length === 1 ? current : current.filter((item) => item.key !== pharmacy.key))}
                        type="button"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="grid gap-4 lg:grid-cols-6">
                      <div className="lg:col-span-2">
                        <Field label="Pharmacy Name">
                          <Input
                            className="h-12 rounded border-slate-200 bg-white"
                            onChange={(event) => updatePharmacy(pharmacy.key, { name: event.target.value })}
                            placeholder="Pharmacy display name"
                            value={pharmacy.name}
                          />
                        </Field>
                      </div>
                      <div className="lg:col-span-2">
                        <Field label="Extracted Pharmacy Area">
                          <ReadOnlyCaptureValue
                            placeholder="Area from GPS"
                            value={pharmacy.area}
                          />
                        </Field>
                      </div>
                      <div className="lg:col-span-2">
                        <Field label="Extracted Pharmacy Governorate">
                          <ReadOnlyCaptureValue
                            placeholder="Governorate from GPS"
                            value={pharmacy.governorate}
                          />
                        </Field>
                      </div>
                      <div className="lg:col-span-6">
                        <Field label="Captured Pharmacy Address">
                          <ReadOnlyCaptureValue
                            multiline
                            placeholder="Full address from GPS capture"
                            value={pharmacy.capture.address}
                          />
                        </Field>
                      </div>
                      <div className="lg:col-span-6">
                        <CapturePanel
                          capture={pharmacy.capture}
                          isCapturing={captureTarget === pharmacy.key}
                          label="Pharmacy GPS and live sign photo"
                          onCaptureLocation={() => captureLocation(pharmacy.key)}
                          onOpenCamera={() => setCameraTarget({ kind: "pharmacy", pharmacyKey: pharmacy.key })}
                        />
                      </div>
                      <div className="lg:col-span-6">
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
                              Vendors
                            </p>
                            <Button
                              className="gap-2 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                              onClick={() => updatePharmacy(pharmacy.key, { vendorCodes: [...pharmacy.vendorCodes, newVendorCodeLine(defaultDistributorId)] })}
                              type="button"
                            >
                              <Plus className="h-4 w-4" />
                              Add Vendor
                            </Button>
                          </div>
                          {pharmacy.vendorCodes.map((line) => (
                            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_44px]" key={line.key}>
                              <SelectField
                                disabled={workspace.distributors.length === 0}
                                onChange={(value) => updateVendorCode(pharmacy.key, line.key, { distributorId: value })}
                                value={line.distributorId}
                              >
                                <option value="">Select vendor</option>
                                {workspace.distributors.map((distributor: MarketingDistributor) => (
                                  <option key={distributor.id} value={distributor.id}>
                                    {distributor.displayName}
                                  </option>
                                ))}
                              </SelectField>
                              <Input
                                className="h-12 rounded border-slate-200 bg-white"
                                onChange={(event) => updateVendorCode(pharmacy.key, line.key, { distributorCode: event.target.value })}
                                placeholder="Vendor pharmacy code"
                                value={line.distributorCode}
                              />
                              <button
                                aria-label="Remove vendor"
                                className="flex h-12 w-full items-center justify-center rounded border border-slate-200 bg-white text-slate-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
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
                                <Trash2 className="h-4 w-4" />
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

            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 bg-slate-50 px-5 py-5 sm:px-7">
              <div className="flex min-w-0 items-center gap-3 text-sm font-black text-slate-800">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-orange-500" />
                <span>{pharmacies.length} pharmacy row{pharmacies.length === 1 ? "" : "s"}</span>
              </div>
              <Button
                className="min-h-12 min-w-[210px] gap-2 rounded bg-orange-500 px-6 text-white hover:bg-orange-600"
                disabled={!canSave}
                type="submit"
              >
                {isSaving ? <LoadingSpinner className="text-white" /> : <Save className="h-4 w-4" />}
                Save Validation
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <Card className="rounded border border-slate-200 bg-white p-5 shadow-[0_20px_48px_rgba(15,23,42,0.07)]">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">Validated Customers</p>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950">Ready customer list</h2>
            </div>
            <Badge variant="success">{validatedGroups.length} customers</Badge>
          </div>
          <div className="mt-5 overflow-hidden rounded border border-slate-200">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left">
                <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Customer Area</th>
                    <th className="px-4 py-3">Customer Governorate</th>
                    <th className="px-4 py-3 text-center">Pharmacies</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white text-sm">
                  {validatedGroups.map((group) => {
                    const customer = group.rows[0]?.customer;
                    const pharmaciesForCustomer = buildValidatedPharmacyDetails(group.rows);
                    return (
                      <tr className="align-middle" key={group.key}>
                        <td className="px-4 py-3">
                          <div className="min-w-0">
                            <p className="whitespace-nowrap font-black text-slate-950">{group.customerName}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              <span className="text-xs font-semibold capitalize text-slate-500">{group.customerType}</span>
                              <Badge variant={statusVariant(group.status)}>{group.status.replace(/_/g, " ")}</Badge>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-semibold text-slate-700">
                          {customer?.extractedAreaName || customer?.regionName || "Not captured"}
                        </td>
                        <td className="px-4 py-3 font-semibold text-slate-700">
                          {customer?.extractedGovernorateName || "Not captured"}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button
                            className="inline-flex h-10 min-w-10 items-center justify-center rounded border border-orange-200 bg-orange-50 px-3 text-sm font-black text-orange-700 transition hover:bg-orange-100"
                            onClick={() => setSelectedValidatedCustomerKey(group.key)}
                            type="button"
                          >
                            {pharmaciesForCustomer.length}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {!isLoading && validatedGroups.length === 0 ? (
                    <tr>
                      <td className="px-4 py-8 text-center text-sm font-semibold text-slate-500" colSpan={4}>
                        No validated customers yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      )}

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
  );
}
