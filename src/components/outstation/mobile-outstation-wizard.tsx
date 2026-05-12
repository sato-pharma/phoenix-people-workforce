"use client";

import { Car, CheckCircle2, MapPin, ReceiptText, Route, TrainFront } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { ApprovalRecommendationBadge } from "@/components/outstation/approval-recommendation-badge";
import { EligibilityResultCard } from "@/components/outstation/eligibility-result-card";
import { OfflineSyncBanner } from "@/components/outstation/offline-sync-banner";
import { OutstationCostBreakdown } from "@/components/outstation/outstation-cost-breakdown";
import { RouteMapPreview } from "@/components/outstation/route-map-preview";
import { TicketUploadCard } from "@/components/outstation/ticket-upload-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type {
  OutstationCalculationResult,
  OutstationCaptureResult,
  OutstationExpenseType,
  OutstationTransportationType,
} from "@/lib/outstation/types";
import { formatEmployeeDisplayName } from "@/lib/utils";

type MedicalTripOption = {
  hrId: string;
  name: string;
};

type LocalDraft = {
  captured: OutstationCaptureResult | null;
  expenseType: OutstationExpenseType;
  goTicketAmount: string;
  hasTicketAttachments: boolean;
  kilometerReading: string;
  medicalTripHrId: string;
  notes: string;
  returnTicketAmount: string;
  syncPending: boolean;
  transportationType: OutstationTransportationType;
  tripEndDate: string;
  tripStartDate: string;
};

const draftKey = "phoenix-outstation-draft";

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function parseDraft(raw: string | null): LocalDraft | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LocalDraft;
  } catch {
    return null;
  }
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

function buildTransportIcon(type: OutstationTransportationType) {
  return type === "car" ? Car : type === "train" || type === "bus" ? TrainFront : Route;
}

export function MobileOutstationWizard({
  employeeName,
  employeeRole,
  hasResidenceCoordinates,
  medicalTripOptions,
  residenceSummary,
}: {
  employeeName: string;
  employeeRole: string;
  hasResidenceCoordinates: boolean;
  medicalTripOptions: MedicalTripOption[];
  residenceSummary: string;
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
  const [notes, setNotes] = useState("");
  const [medicalTripHrId, setMedicalTripHrId] = useState("");
  const [captured, setCaptured] = useState<OutstationCaptureResult | null>(null);
  const [calculation, setCalculation] = useState<OutstationCalculationResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isCalculating, setIsCalculating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [ticketFiles, setTicketFiles] = useState<File[]>([]);
  const syncAttemptedRef = useRef(false);
  const lastCalculationKeyRef = useRef("");

  const selectedMedicalTripName =
    medicalTripOptions.find((option) => option.hrId === medicalTripHrId)?.name ?? null;
  const transportIcon = buildTransportIcon(transportationType);
  const isTicketBased = transportationType !== "car";
  const durationSummary = calculation
    ? calculation.sameDayTrip
      ? "Return the same day"
      : `Overnight stay - ${calculation.overnightDays} ${calculation.overnightDays === 1 ? "night" : "nights"}`
    : getDurationSummary(tripStartDate, tripEndDate);

  useEffect(() => {
    const restore = parseDraft(window.localStorage.getItem(draftKey));
    if (!restore) return;
    // Restore the offline draft once after hydration; this intentionally syncs React state with localStorage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCaptured(restore.captured);
    setExpenseType(restore.expenseType);
    setGoTicketAmount(restore.goTicketAmount);
    setKilometerReading(restore.kilometerReading);
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
    const draft: LocalDraft = {
      captured,
      expenseType,
      goTicketAmount,
      hasTicketAttachments: ticketFiles.length > 0,
      kilometerReading,
      medicalTripHrId,
      notes,
      returnTicketAmount,
      syncPending: isOffline && Boolean(captured),
      transportationType,
      tripEndDate,
      tripStartDate,
    };
    window.localStorage.setItem(draftKey, JSON.stringify(draft));
  }, [
    captured,
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
  ]);

  useEffect(() => {
    if (!isOffline) {
      const syncPending = async () => {
        const draft = parseDraft(window.localStorage.getItem(draftKey));
        if (
          !draft?.syncPending ||
          !draft.captured ||
          !draft.tripStartDate ||
          !draft.tripEndDate ||
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
              claimedTotalAmount: 0,
              expenseType: draft.expenseType,
              goTicketAmount: Number(draft.goTicketAmount || 0),
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
            window.localStorage.removeItem(draftKey);
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
  }, [isOffline, medicalTripOptions]);

  const hasTicketAttachments = ticketFiles.length > 0;

  const requestPayload = useMemo(
    () => ({
      attachmentCount: ticketFiles.length,
      capturedAccuracyMeters: captured?.capturedAccuracyMeters ?? 0,
      capturedAt: captured?.capturedAt,
      capturedLatitude: captured?.capturedLatitude ?? 0,
      capturedLongitude: captured?.capturedLongitude ?? 0,
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
          fraudFlags: [],
          minimumRequiredDistanceKm: 60,
          residenceLatitude: null,
          residenceLongitude: null,
          routePolyline: null,
          routeError: "Offline capture pending route validation after sync.",
          routeProvider: "google_maps",
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
      const geoError = error as GeolocationPositionError | Error;
      if ("code" in geoError && typeof geoError.code === "number" && geoError.code === 1) {
        setMessage(
          "Location permission was denied. This report cannot proceed without GPS permission.",
        );
      } else {
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

  async function submit() {
    if (!captured) {
      setMessage("Tap the To field to capture your current destination first.");
      return;
    }

    setIsSubmitting(true);
    setMessage(null);
    try {
      const endpoint = isOffline ? "/api/outstation/sync-offline" : "/api/outstation/submit";
      const response = await fetch(endpoint, {
        body: JSON.stringify({
          ...requestPayload,
          claimedTotalAmount: calculation?.expectedTotalAmount ?? 0,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message ?? payload.error ?? "Unable to submit the request.");
        return;
      }

      window.localStorage.removeItem(draftKey);
      setCalculation(null);
      setCaptured(null);
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

      <div className="grid gap-3 md:grid-cols-3">
        <WizardStep active={step === 1} icon={ReceiptText} label="1. Trip details" />
        <WizardStep active={step === 2} icon={transportIcon} label="2. Validate route" />
        <WizardStep active={step === 3} icon={CheckCircle2} label="3. Review & submit" />
      </div>

      <Card className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
          Request Details
        </p>
        <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-slate-950">
          Fill the trip and let the system calculate the rest
        </h2>

        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
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
          </Field>

          <Field label="Duration">
            <div className="flex min-h-11 items-center rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-800">
              {durationSummary}
            </div>
          </Field>

          <Field label="From">
            <div className="flex min-h-11 items-center rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-800">
              {residenceSummary}
            </div>
          </Field>

          <Field label="To">
            <button
              className="flex min-h-11 w-full items-center justify-between rounded-2xl border border-slate-200 bg-white px-3 text-left text-sm font-semibold text-slate-800 transition hover:border-orange-300 hover:bg-orange-50"
              disabled={isCapturing}
              onClick={() => void captureLocation()}
              type="button"
            >
              <span className="truncate">
                {isCapturing
                  ? "Capturing destination..."
                  : captured?.toLabel ?? "Tap here to capture current location"}
              </span>
              {isCapturing ? (
                <LoadingSpinner />
              ) : (
                <MapPin className="h-4 w-4 shrink-0 text-orange-500" />
              )}
            </button>
          </Field>

          <Field label="Transportation Type">
            <select
              className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800"
              onChange={(event) =>
                setTransportationType(event.target.value as OutstationTransportationType)
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
              className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 disabled:bg-slate-50 disabled:text-slate-400"
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

          {transportationType === "car" ? (
            <Field label="Kilometer Reading">
              <Input
                onChange={(event) => setKilometerReading(event.target.value)}
                placeholder="Enter odometer reading"
                type="number"
                value={kilometerReading}
              />
            </Field>
          ) : (
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
          )}

          <Field label="Notes">
            <textarea
              className="min-h-28 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-orange-300 focus:bg-orange-50"
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Add any trip note or explanation"
              value={notes}
            />
          </Field>
        </div>

        <div className="mt-5">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
            Auto Calculated Summary
          </p>
          <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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

        <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
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
          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
            <FieldValue
              label="Amount"
              value={egp(calculation.expectedTotalAmount)}
            />
            <FieldValue
              label="Eligibility"
              value={calculation.eligibilityStatus.replace(/_/g, " ")}
            />
            <FieldValue
              label="Allowance"
              value={egp(calculation.allowanceAmount)}
            />
          </div>
        ) : null}
      </Card>

      <TicketUploadCard
        attachmentCount={ticketFiles.length}
        onFilesSelected={(files) => setTicketFiles(files ? Array.from(files) : [])}
        transportationType={transportationType}
        visible
      />

      <EligibilityResultCard result={calculation} />
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
              disabled={isSubmitting || calculation.eligibilityStatus === "not_eligible"}
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
        <Card className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700">
          {message}
        </Card>
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
      className={`flex items-center gap-3 rounded-2xl border px-4 py-3 ${
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
      <span className="text-sm font-bold text-slate-900">{label}</span>
    </div>
  );
}

function Field({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
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
    <div className="rounded-2xl border border-slate-200 bg-white/80 p-4">
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function FieldValue({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold capitalize text-slate-900">{value}</p>
    </div>
  );
}

function SummaryValue({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-white/70 bg-white/90 p-4">
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 text-xl font-black tracking-[-0.03em] text-slate-950">{value}</p>
    </div>
  );
}
