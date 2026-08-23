"use client";

import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  MapPin,
  Navigation,
  Route,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { PlacesAutocompleteInput } from "@/components/outstation/places-autocomplete-input";
import { Button } from "@/components/ui/button";
import type {
  ManagerExpenseAdminInput,
  ManagerExpenseDestination,
  OutstationExpenseRequest,
  PlacesPrediction,
} from "@/lib/outstation/types";
import { SearchableSelect } from "@/components/ui/searchable-select";


type Mode = "create" | "edit";

type Props = {
  mode: Mode;
  onClose: () => void;
  onSaved: (request: OutstationExpenseRequest) => void;
  request?: OutstationExpenseRequest;
  targetHrId?: string;
  targetName?: string;
};

type DistanceResult = {
  distanceKm: number;
  durationMinutes: number | null;
  fromLabel: string;
  routePolyline: string | null;
};

type EmployeeLookup =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "found"; name: string; jobTitle: string | null; isActive: boolean }
  | { status: "not_found" }
  | { status: "error"; message: string };

type CalcPreviewRow = { amount: number; label: string; type: string };

type CalcPreview = {
  allowanceAmount: number;
  allowanceBreakdown: {
    overnightDays: number;
    returnDayApplied: boolean;
    rows: CalcPreviewRow[];
    sameDayTrip: boolean;
  };
  claimedTotalAmount: number;
  eligibilityStatus: string;
  expectedTotalAmount: number;
  fuelAmount: number;
  fuelRatePerKm: number;
  meetingAmount: number;
  otherAmount: number;
  overnightDays: number;
  sameDayTrip: boolean;
  ticketAmount: number;
  travelCost: number;
};

function formatEgp(value: number) {
  return `EGP ${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

const SESSION_TOKEN = Math.random().toString(36).slice(2);

const panelClassName =
  "rounded-lg border border-[#D8E0EA] bg-white/94 shadow-[0_1px_3px_rgba(15,23,42,0.06)] backdrop-blur";

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">
      {children}
    </span>
  );
}

function InputField({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { className?: string }) {
  return (
    <input
      className={`h-11 w-full rounded-md border border-[#DDE6F1] bg-white/95 px-3 text-sm font-semibold text-[#0F172A] shadow-sm placeholder:font-normal placeholder:text-[#94A3B8] focus:border-[#F97316] focus:outline-none focus:ring-2 focus:ring-[#FED7AA] disabled:opacity-60 ${className ?? ""}`}
      {...props}
    />
  );
}

function SelectField({
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <SearchableSelect
      className="h-11 w-full rounded-md border border-[#DDE6F1] bg-white/95 px-3 text-sm font-semibold text-[#0F172A] shadow-sm focus:border-[#F97316] focus:outline-none focus:ring-2 focus:ring-[#FED7AA] disabled:opacity-60"
      {...props}
    >
      {children}
    </SearchableSelect>
  );
}

export function AdminManagerExpenseModal({
  mode,
  onClose,
  onSaved,
  request,
  targetHrId,
  targetName,
}: Props) {
  const isEdit = mode === "edit";

  const [employeeHrId, setEmployeeHrId] = useState(
    targetHrId ?? request?.employeeHrId ?? "",
  );
  const [tripStartDate, setTripStartDate] = useState(
    request?.tripStartDate?.slice(0, 10) ?? "",
  );
  const [tripEndDate, setTripEndDate] = useState(
    request?.tripEndDate?.slice(0, 10) ?? "",
  );
  const [expenseType, setExpenseType] = useState<"traveling" | "meeting" | "other">(
    request?.expenseType ?? "traveling",
  );
  const [transportationType, setTransportationType] = useState<
    "car" | "train" | "bus" | "other"
  >(request?.transportationType ?? "car");
  const [notes, setNotes] = useState(request?.notes ?? "");
  // Records created before the ticket field existed carry the price only in
  // reportTravelCost, so fall back to it rather than showing an empty box.
  const [ticketCost, setTicketCost] = useState(() => {
    if (!request || request.transportationType === "car") return "";
    const existing = request.ticketAmount || request.reportTravelCost || 0;
    return existing > 0 ? String(existing) : "";
  });
  const [claimedAmount, setClaimedAmount] = useState(
    request?.claimedTotalAmount ? String(request.claimedTotalAmount) : "",
  );
  const [meetingAmount, setMeetingAmount] = useState(
    request?.meetingAmount ? String(request.meetingAmount) : "",
  );
  const [otherAmount, setOtherAmount] = useState(
    request?.otherAmount ? String(request.otherAmount) : "",
  );
  const [amWorkload] = useState(
    request?.amWorkload ? String(request.amWorkload) : "",
  );
  const [pmWorkload] = useState(
    request?.pmWorkload ? String(request.pmWorkload) : "",
  );

  const [destination, setDestination] = useState<ManagerExpenseDestination | null>(
    request
      ? {
          area: request.toArea,
          city: request.toCity,
          country: ((request as OutstationExpenseRequest & { toCountry?: string | null }).toCountry ?? null),
          label: request.toLabel ?? request.toCity ?? "",
          latitude: request.capturedLatitude,
          longitude: request.capturedLongitude,
          placeId: "",
        }
      : null,
  );

  const [distanceResult, setDistanceResult] = useState<DistanceResult | null>(
    request?.distanceFromResidenceKm != null
      ? {
          distanceKm: request.distanceFromResidenceKm,
          durationMinutes: request.durationMinutes,
          fromLabel: [request.residenceAddress, request.residenceCity, request.residenceArea]
            .filter(Boolean)
            .join(", "),
          routePolyline: request.routePolyline,
        }
      : null,
  );

  // manualDistanceKm is always the editable distance value.
  // Maps auto-fills it on success; admin can type it when Maps fails.
  const [manualDistanceKm, setManualDistanceKm] = useState(
    request?.distanceFromResidenceKm != null
      ? String(request.distanceFromResidenceKm)
      : "",
  );

  const [resolvingPlace, setResolvingPlace] = useState(false);
  const [calculatingDistance, setCalculatingDistance] = useState(false);
  const [distanceError, setDistanceError] = useState<string | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [destinationIsRegion, setDestinationIsRegion] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [calcPreview, setCalcPreview] = useState<CalcPreview | null>(null);
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const initialName = targetName ?? request?.employeeName ?? null;
  const [employeeLookup, setEmployeeLookup] = useState<EmployeeLookup>(
    initialName ? { status: "found", name: initialName, jobTitle: null, isActive: true } : { status: "idle" },
  );
  const lookupDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hrIdForDistance = employeeHrId || request?.employeeHrId;

  // Car trips are paid from the fuel formula (km x 2 x rate); every other mode is
  // paid from the ticket the admin types in. Either way it is ADDED to the allowance.
  const isTicketBased = transportationType !== "car";
  const travelCostForSubmit = isTicketBased && ticketCost ? Number(ticketCost) : null;

  async function lookupEmployee(hrId: string) {
    if (!hrId.trim()) {
      setEmployeeLookup({ status: "idle" });
      return;
    }
    setEmployeeLookup({ status: "loading" });
    try {
      const url = new URL("/api/admin/outstation/employee-lookup", window.location.origin);
      url.searchParams.set("hrId", hrId.trim());
      const response = await fetch(url.toString());
      const payload = (await response.json()) as {
        hrId?: string;
        isActive?: boolean;
        jobTitle?: string | null;
        message?: string;
        name?: string;
      };
      if (!response.ok || !payload.name) {
        setEmployeeLookup(
          response.status === 404
            ? { status: "not_found" }
            : { status: "error", message: payload.message ?? "Lookup failed." },
        );
      } else {
        setEmployeeLookup({
          isActive: payload.isActive !== false,
          jobTitle: payload.jobTitle ?? null,
          name: payload.name,
          status: "found",
        });
      }
    } catch {
      setEmployeeLookup({ status: "error", message: "Could not reach the server." });
    }
  }

  async function calculateDistance(
    dest: ManagerExpenseDestination,
    hrId: string,
    isRegion: boolean,
  ) {
    setCalculatingDistance(true);
    setDistanceError(null);
    try {
      const response = await fetch("/api/admin/outstation/calculate-manager-distance", {
        body: JSON.stringify({
          destinationIsRegion: isRegion,
          destinationLabel: dest.label,
          destinationLat: dest.latitude,
          destinationLng: dest.longitude,
          managerHrId: hrId,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as {
        distanceKm?: number;
        durationMinutes?: number | null;
        error?: string;
        fromLabel?: string;
        message?: string;
        routePolyline?: string | null;
      };

      if (!response.ok || payload.distanceKm == null) {
        setDistanceError(payload.message ?? "Distance calculation failed.");
      } else {
        setDistanceResult({
          distanceKm: payload.distanceKm,
          durationMinutes: payload.durationMinutes ?? null,
          fromLabel: payload.fromLabel ?? "",
          routePolyline: payload.routePolyline ?? null,
        });
        setManualDistanceKm(String(payload.distanceKm));
      }
    } catch {
      setDistanceError("Could not reach the distance calculation service.");
    } finally {
      setCalculatingDistance(false);
    }
  }

  async function resolveAndCalculate(prediction: PlacesPrediction) {
    setResolvingPlace(true);
    setPlaceError(null);
    setDistanceResult(null);
    setDistanceError(null);
    setDestination(null);
    setManualDistanceKm("");
    setDestinationIsRegion(false);

    try {
      const url = new URL("/api/admin/outstation/place-details", window.location.origin);
      url.searchParams.set("placeId", prediction.placeId);
      url.searchParams.set("sessiontoken", SESSION_TOKEN);

      const placeResponse = await fetch(url.toString());
      const placePayload = (await placeResponse.json()) as {
        area?: string | null;
        city?: string | null;
        country?: string | null;
        error?: string;
        formattedAddress?: string;
        isAdministrativeArea?: boolean;
        label?: string;
        latitude?: number;
        longitude?: number;
        message?: string;
        placeId?: string;
        types?: string[];
      };

      if (!placeResponse.ok || !placePayload.latitude || !placePayload.longitude) {
        setPlaceError(placePayload.message ?? "Could not resolve place details.");
        setResolvingPlace(false);
        return;
      }

      const isRegion = Boolean(placePayload.isAdministrativeArea);
      setDestinationIsRegion(isRegion);

      const resolved: ManagerExpenseDestination = {
        area: placePayload.area ?? null,
        city: placePayload.city ?? null,
        country: placePayload.country ?? null,
        label: placePayload.label ?? prediction.description,
        latitude: placePayload.latitude,
        longitude: placePayload.longitude,
        placeId: prediction.placeId,
      };
      setDestination(resolved);
      setResolvingPlace(false);

      if (hrIdForDistance) {
        await calculateDistance(resolved, hrIdForDistance, isRegion);
      }
    } catch {
      setPlaceError("Failed to resolve place details.");
      setResolvingPlace(false);
    }
  }

  // Mount-time lookup if we already have an HR ID but no name yet
  useEffect(() => {
    if (employeeHrId && !initialName) {
      // Async fetch on mount; the loading setState is intentional, not a render loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void lookupEmployee(employeeHrId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When HR ID changes after a destination is already selected, re-trigger distance calc
  const destinationRef = useRef(destination);
  useEffect(() => {
    destinationRef.current = destination;
  }, [destination]);
  const destinationIsRegionRef = useRef(destinationIsRegion);
  useEffect(() => {
    destinationIsRegionRef.current = destinationIsRegion;
  }, [destinationIsRegion]);
  const prevHrIdRef = useRef(hrIdForDistance);

  useEffect(() => {
    const prevHrId = prevHrIdRef.current;
    prevHrIdRef.current = hrIdForDistance;
    const dest = destinationRef.current;
    if (hrIdForDistance && hrIdForDistance !== prevHrId && dest && !calculatingDistance) {
      setDistanceResult(null);
      setDistanceError(null);
      setManualDistanceKm("");
      void calculateDistance(dest, hrIdForDistance, destinationIsRegionRef.current);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeHrId]);

  async function fetchCalcPreview(hrId: string, distance: number) {
    try {
      const response = await fetch("/api/admin/outstation/preview-expense-calculation", {
        body: JSON.stringify({
          claimedTotalAmount: claimedAmount ? Number(claimedAmount) : 0,
          // Destination drives the Cairo no-allowance rule, so the live preview zeroes the
          // allowance exactly as the save will — the admin never sees a phantom allowance line.
          destinationArea: destination?.area ?? null,
          destinationCity: destination?.city ?? null,
          destinationCountry: destination?.country ?? null,
          destinationLabel: destination?.label ?? null,
          distanceKm: distance,
          employeeHrId: hrId,
          meetingAmount: meetingAmount ? Number(meetingAmount) : 0,
          otherAmount: otherAmount ? Number(otherAmount) : 0,
          transportationType,
          travelCostAmount: travelCostForSubmit,
          tripEndDate,
          tripStartDate,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as { message?: string; preview?: CalcPreview };
      setCalcPreview(response.ok && payload.preview ? payload.preview : null);
    } catch {
      setCalcPreview(null);
    }
  }

  // Live calculation preview: recompute the fuel + allowance breakdown whenever
  // the inputs that drive the payout change.
  useEffect(() => {
    const distance = Number(manualDistanceKm);
    const hrId = hrIdForDistance;
    if (!hrId || !Number.isFinite(distance) || distance <= 0 || !tripStartDate || !tripEndDate) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCalcPreview(null);
      return;
    }
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    previewDebounceRef.current = setTimeout(() => void fetchCalcPreview(hrId, distance), 450);
    return () => {
      if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hrIdForDistance,
    manualDistanceKm,
    tripStartDate,
    tripEndDate,
    transportationType,
    claimedAmount,
    ticketCost,
    meetingAmount,
    otherAmount,
    destination,
  ]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const distanceKm = Number(manualDistanceKm);
    if (!destination || distanceKm <= 0) return;

    setSubmitting(true);
    setSubmitError(null);

    const input: ManagerExpenseAdminInput = {
      amWorkload: amWorkload ? Number(amWorkload) : 0,
      claimedTotalAmount: claimedAmount ? Number(claimedAmount) : 0,
      destination,
      distanceKm,
      durationMinutes: distanceResult?.durationMinutes ?? null,
      employeeHrId,
      expenseType,
      meetingAmount: meetingAmount ? Number(meetingAmount) : 0,
      notes: notes.trim() || null,
      otherAmount: otherAmount ? Number(otherAmount) : 0,
      pmWorkload: pmWorkload ? Number(pmWorkload) : 0,
      routePolyline: distanceResult?.routePolyline ?? null,
      transportationType,
      travelCostAmount: travelCostForSubmit,
      tripEndDate,
      tripStartDate,
    };

    try {
      let response: Response;
      if (isEdit && request) {
        response = await fetch(`/api/admin/outstation/manager-expenses/${request.id}`, {
          body: JSON.stringify(input),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
      } else {
        response = await fetch("/api/admin/outstation/manager-expenses", {
          body: JSON.stringify(input),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
      }

      const payload = (await response.json()) as {
        message?: string;
        request?: OutstationExpenseRequest;
        success?: boolean;
      };

      if (!response.ok || !payload.request) {
        setSubmitError(payload.message ?? "Failed to save outstation expense.");
      } else {
        onSaved(payload.request);
      }
    } catch {
      setSubmitError("Could not reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    Boolean(destination) &&
    Number(manualDistanceKm) > 0 &&
    Boolean(tripStartDate) &&
    Boolean(tripEndDate) &&
    (isEdit || Boolean(employeeHrId)) &&
    !submitting &&
    !resolvingPlace &&
    !calculatingDistance;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-[#020617]/65 p-4 backdrop-blur-sm">
      <div className="w-full max-w-3xl rounded-lg border border-[#D8E0EA] bg-white shadow-[0_28px_90px_rgba(15,23,42,0.3)]">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-[#E2E8F0] bg-white/98 px-6 py-5">
          <div>
            <span className="inline-flex rounded-full border border-[#FED7AA] bg-[#FFF7ED] px-3 py-1 text-xs font-black uppercase tracking-[0.14em] text-[#EA580C]">
              Manual outstation expense - Admin
            </span>
            <h2 className="mt-2 text-xl font-black text-[#0F172A]">
              {isEdit ? "Edit outstation expense" : "Add manual outstation expense"}
            </h2>
            {(targetName ?? request?.employeeName) ? (
              <p className="mt-1 text-sm font-semibold text-[#64748B]">
                {targetName ?? request?.employeeName} &mdash; {employeeHrId}
              </p>
            ) : null}
          </div>
          <button
            className="shrink-0 rounded-xl border border-[#E2E8F0] bg-white p-2 text-[#64748B] hover:bg-[#F8FAFC]"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form className="space-y-6 p-6" onSubmit={(e) => void handleSubmit(e)}>
          {/* Employee HR ID (create mode only) */}
          {!isEdit && !targetHrId ? (
            <div>
              <FieldLabel>Employee HR ID</FieldLabel>
              <InputField
                onChange={(e) => {
                  const value = e.target.value.trim();
                  setEmployeeHrId(value);
                  if (lookupDebounceRef.current) clearTimeout(lookupDebounceRef.current);
                  lookupDebounceRef.current = setTimeout(
                    () => void lookupEmployee(value),
                    500,
                  );
                }}
                placeholder="e.g. A-12"
                required
                value={employeeHrId}
              />
              {employeeLookup.status === "loading" ? (
                <div className="mt-2 flex items-center gap-2 text-xs font-semibold text-[#64748B]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#F97316]" />
                  Looking up employee...
                </div>
              ) : employeeLookup.status === "found" && employeeLookup.isActive ? (
                <div className="mt-2 flex items-center gap-2 rounded-md bg-[#F0FDF4] px-3 py-2 text-xs font-black text-[#047857]">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  {employeeLookup.name}
                  {employeeLookup.jobTitle ? (
                    <span className="font-semibold text-[#047857]/70">
                      {" — "}{employeeLookup.jobTitle}
                    </span>
                  ) : null}
                </div>
              ) : employeeLookup.status === "found" && !employeeLookup.isActive ? (
                <div className="mt-2 flex items-center gap-2 rounded-md border border-[#FED7AA] bg-[#FFF7ED] px-3 py-2 text-xs font-black text-[#9A3412]">
                  <AlertCircle className="h-4 w-4 shrink-0 text-[#EA580C]" />
                  Found — but not currently active: {employeeLookup.name}
                  {employeeLookup.jobTitle ? (
                    <span className="font-semibold text-[#9A3412]/70">
                      {" — "}{employeeLookup.jobTitle}
                    </span>
                  ) : null}
                </div>
              ) : employeeLookup.status === "not_found" ? (
                <div className="mt-2 flex items-center gap-2 rounded-md bg-[#FEF2F2] px-3 py-2 text-xs font-black text-[#B91C1C]">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  No employee found with this HR ID.
                </div>
              ) : employeeLookup.status === "error" ? (
                <div className="mt-2 flex items-center gap-2 rounded-md bg-[#FEF2F2] px-3 py-2 text-xs font-semibold text-[#B91C1C]">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  {employeeLookup.message}
                </div>
              ) : (
                <p className="mt-1 text-xs text-[#64748B]">
                  Enter the HR ID of the employee — their name will appear automatically.
                </p>
              )}
            </div>
          ) : null}

          {/* Destination */}
          <div>
            <FieldLabel>Destination</FieldLabel>
            <PlacesAutocompleteInput
              disabled={resolvingPlace || calculatingDistance}
              onSelect={(prediction) => void resolveAndCalculate(prediction)}
              placeholder="Search city or location..."
              value={destination?.label}
            />

            {placeError ? (
              <div className="mt-2 flex items-center gap-2 rounded-xl bg-[#FEF2F2] px-3 py-2 text-xs font-semibold text-[#B91C1C]">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {placeError}
              </div>
            ) : null}

            {resolvingPlace ? (
              <div className="mt-2 flex items-center gap-2 text-xs font-semibold text-[#64748B]">
                <Loader2 className="h-4 w-4 animate-spin text-[#F97316]" />
                Resolving place details...
              </div>
            ) : destination ? (
              <div className="mt-2 space-y-1">
                {(destination.city ?? destination.area) ? (
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#047857]">
                    <MapPin className="h-3.5 w-3.5" />
                    {[destination.city, destination.area].filter(Boolean).join(" · ")}
                    {destination.country ? ` · ${destination.country}` : ""}
                  </div>
                ) : null}
                <p className="text-[11px] text-[#94A3B8]">
                  {destination.latitude.toFixed(5)}, {destination.longitude.toFixed(5)}
                </p>
              </div>
            ) : null}

            {destinationIsRegion && destination && !resolvingPlace ? (
              <div className="mt-2 flex items-start gap-2 rounded-md border border-[#FED7AA] bg-[#FFF7ED] px-3 py-2 text-xs text-[#9A3412]">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#EA580C]" />
                <span>
                  <span className="font-black">This is a governorate, not a specific place.</span>{" "}
                  Distance is measured to its map centre, which can be far from the town you mean.
                  Pick a city or an exact location for an accurate distance.
                </span>
              </div>
            ) : null}
          </div>

          {/* Distance — Maps result panel (informational) + always-editable input */}
          {calculatingDistance ? (
            <div className={`${panelClassName} flex items-center gap-3 p-4`}>
              <Loader2 className="h-5 w-5 animate-spin text-[#F97316]" />
              <div>
                <p className="text-sm font-black text-[#0F172A]">Calculating road distance...</p>
                <p className="text-xs text-[#64748B]">Using Google Maps Routes API</p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {distanceError ? (
                <div className="flex items-start gap-2 rounded-md border border-[#FECACA] bg-[#FEF2F2] p-3 text-sm">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#B91C1C]" />
                  <div>
                    <p className="font-black text-[#B91C1C]">Distance could not be measured</p>
                    <p className="mt-0.5 text-xs font-semibold text-[#B91C1C]">{distanceError}</p>
                  </div>
                </div>
              ) : distanceResult ? (
                <div className={`${panelClassName} p-4`}>
                  <div className="mb-3 flex items-center gap-2">
                    <Route className="h-4 w-4 text-[#F97316]" />
                    <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">
                      Road distance &middot; Google Maps
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl bg-[#FFF7ED] px-4 py-3 text-center">
                      <p className="text-2xl font-black text-[#EA580C]">
                        {distanceResult.distanceKm.toFixed(1)} km
                      </p>
                      <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[#EA580C]/70">
                        Distance
                      </p>
                    </div>
                    {distanceResult.durationMinutes != null ? (
                      <div className="rounded-xl bg-[#F0FDF4] px-4 py-3 text-center">
                        <p className="text-2xl font-black text-[#047857]">
                          {Math.round(distanceResult.durationMinutes)} min
                        </p>
                        <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[#047857]/70">
                          Drive time
                        </p>
                      </div>
                    ) : null}
                  </div>
                  {distanceResult.fromLabel ? (
                    <div className="mt-3 flex items-start gap-2 text-xs text-[#64748B]">
                      <Navigation className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <p>
                        <span className="font-black">From:</span>{" "}
                        <span className="font-semibold">{distanceResult.fromLabel}</span>
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* Distance input — always visible so the form is never stuck */}
              <div>
                <FieldLabel>
                  {distanceResult ? "Distance (km) — override if needed" : "Distance (km)"}
                </FieldLabel>
                <InputField
                  min="0"
                  onChange={(e) => setManualDistanceKm(e.target.value)}
                  placeholder="e.g. 45"
                  step="0.1"
                  type="number"
                  value={manualDistanceKm}
                />
                {!distanceResult && !distanceError && !destination ? (
                  <p className="mt-1 text-xs text-[#64748B]">
                    Select a destination and Google Maps will fill this automatically.
                  </p>
                ) : null}
              </div>
            </div>
          )}

          {/* Trip dates */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel>Trip start date</FieldLabel>
              <InputField
                onChange={(e) => setTripStartDate(e.target.value)}
                required
                type="date"
                value={tripStartDate}
              />
            </div>
            <div>
              <FieldLabel>Trip end date</FieldLabel>
              <InputField
                min={tripStartDate}
                onChange={(e) => setTripEndDate(e.target.value)}
                required
                type="date"
                value={tripEndDate}
              />
            </div>
          </div>

          {/* Expense type + transportation */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel>Expense type</FieldLabel>
              <SelectField
                onChange={(e) =>
                  setExpenseType(e.target.value as "traveling" | "meeting" | "other")
                }
                value={expenseType}
              >
                <option value="traveling">Traveling</option>
                <option value="meeting">Meeting</option>
                <option value="other">Other</option>
              </SelectField>
            </div>
            <div>
              <FieldLabel>Transportation</FieldLabel>
              <SelectField
                onChange={(e) =>
                  setTransportationType(
                    e.target.value as "car" | "train" | "bus" | "other",
                  )
                }
                value={transportationType}
              >
                <option value="car">Car</option>
                <option value="train">Train</option>
                <option value="bus">Bus</option>
                <option value="other">Other</option>
              </SelectField>
            </div>
          </div>

          {/* Ticket cost — non-car transport is paid from the ticket, not the fuel formula */}
          {isTicketBased ? (
            <div>
              <FieldLabel>Ticket cost (EGP) &mdash; go + return</FieldLabel>
              <InputField
                min="0"
                onChange={(e) => setTicketCost(e.target.value)}
                placeholder="e.g. 450"
                step="0.01"
                type="number"
                value={ticketCost}
              />
              <p className="mt-1 text-xs text-[#64748B]">
                The allowance is added on top of this ticket cost.
              </p>
            </div>
          ) : null}

          {/* Meeting / Other amount — conditional on expense type */}
          {expenseType === "meeting" ? (
            <div>
              <FieldLabel>Meeting amount (EGP)</FieldLabel>
              <InputField
                min="0"
                onChange={(e) => setMeetingAmount(e.target.value)}
                placeholder="e.g. 250"
                step="0.01"
                type="number"
                value={meetingAmount}
              />
            </div>
          ) : expenseType === "other" ? (
            <div>
              <FieldLabel>Other amount (EGP)</FieldLabel>
              <InputField
                min="0"
                onChange={(e) => setOtherAmount(e.target.value)}
                placeholder="e.g. 150"
                step="0.01"
                type="number"
                value={otherAmount}
              />
            </div>
          ) : null}

          {/* AM / PM workload */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel>AM visits</FieldLabel>
              <InputField
                disabled
                placeholder="Auto from Double Visit Analytics"
                readOnly
                value={amWorkload}
              />
            </div>
            <div>
              <FieldLabel>PM visits</FieldLabel>
              <InputField
                disabled
                placeholder="Auto from Double Visit Analytics"
                readOnly
                value={pmWorkload}
              />
            </div>
            <p className="sm:col-span-2 text-xs font-semibold text-[#64748B]">
              AM/PM workload is resolved automatically from the official published Double Visit Analytics snapshot after saving.
            </p>
          </div>

          {/* Claimed amount */}
          <div>
            <FieldLabel>Claimed amount (EGP) &mdash; optional override</FieldLabel>
            <InputField
              min="0"
              onChange={(e) => setClaimedAmount(e.target.value)}
              placeholder="Leave blank to use calculated amount"
              step="0.01"
              type="number"
              value={claimedAmount}
            />
            <p className="mt-1 text-xs text-[#64748B]">
              Leave this blank unless you are overriding the payout. Anything typed here{" "}
              <span className="font-black text-[#9A3412]">replaces</span> the calculated total &mdash;
              it is not added to it.
            </p>
          </div>

          {/* Calculation preview — fuel + allowance breakdown */}
          {calcPreview ? (
            <div className={`${panelClassName} p-4`}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">
                  Calculation preview
                </p>
                {calcPreview.eligibilityStatus === "not_eligible" ? (
                  <span className="rounded-full bg-[#FEF2F2] px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-[#B91C1C]">
                    Not eligible
                  </span>
                ) : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md bg-[#F8FAFC] px-3 py-2.5">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[#64748B]">
                    {isTicketBased ? "Ticket cost" : "Fuel (round trip)"}
                  </p>
                  <p className="mt-0.5 text-sm font-black text-[#0F172A]">
                    {formatEgp(isTicketBased ? calcPreview.ticketAmount : calcPreview.fuelAmount)}
                  </p>
                </div>
                <div className="rounded-md bg-[#F8FAFC] px-3 py-2.5">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[#64748B]">
                    Allowance
                  </p>
                  <p className="mt-0.5 text-sm font-black text-[#0F172A]">
                    {formatEgp(calcPreview.allowanceAmount)}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between rounded-md bg-[#FFF7ED] px-3 py-2.5">
                <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[#EA580C]">
                  {isTicketBased ? "Ticket + allowance" : "Fuel + allowance"} = total
                </p>
                <p className="text-sm font-black text-[#EA580C]">
                  {formatEgp(calcPreview.expectedTotalAmount)}
                </p>
              </div>
              {calcPreview.allowanceBreakdown.rows.length > 0 ? (
                <ul className="mt-3 space-y-1 border-t border-[#E2E8F0] pt-3">
                  {calcPreview.allowanceBreakdown.rows.map((row, index) => (
                    <li
                      className="flex items-center justify-between text-xs text-[#475569]"
                      key={`${row.type}-${index}`}
                    >
                      <span className="font-semibold">{row.label}</span>
                      <span className="font-black text-[#0F172A]">{formatEgp(row.amount)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {calcPreview.eligibilityStatus === "not_eligible" ? (
                <p className="mt-3 text-xs font-semibold text-[#B91C1C]">
                  Distance is below the policy minimum, so the policy payout is EGP 0. The
                  claim can still be filed for manual review.
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Notes */}
          <div>
            <FieldLabel>Notes</FieldLabel>
            <textarea
              className="w-full rounded-md border border-[#DDE6F1] bg-white/95 px-3 py-2.5 text-sm font-semibold text-[#0F172A] shadow-sm placeholder:font-normal placeholder:text-[#94A3B8] focus:border-[#F97316] focus:outline-none focus:ring-2 focus:ring-[#FED7AA]"
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes for this expense"
              rows={3}
              value={notes}
            />
          </div>

          {/* Submit error */}
          {submitError ? (
            <div className="flex items-start gap-2 rounded-md border border-[#FECACA] bg-[#FEF2F2] p-4 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#B91C1C]" />
              <p className="font-semibold text-[#B91C1C]">{submitError}</p>
            </div>
          ) : null}

          {/* Actions */}
          <div className="flex flex-col-reverse gap-3 border-t border-[#E2E8F0] pt-4 sm:flex-row sm:items-center sm:justify-between">
            <button
              className="rounded-xl border border-[#E2E8F0] bg-white px-4 py-2.5 text-sm font-black text-[#64748B] hover:bg-[#F8FAFC]"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <Button
              className="gap-2 rounded-xl bg-[#EA580C] px-6 py-2.5 text-sm font-black text-white hover:bg-[#C2410C] disabled:opacity-60"
              disabled={!canSubmit}
              type="submit"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              {isEdit ? "Save changes" : "Add expense"}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
