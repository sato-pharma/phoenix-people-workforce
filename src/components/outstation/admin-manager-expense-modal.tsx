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

import { PlacesAutocompleteInput } from "@/components/outstation/places-autocomplete-input";
import { Button } from "@/components/ui/button";
import type {
  OutstationAllowanceBreakdown,
  ManagerExpenseAdminInput,
  ManagerExpenseDestination,
  OutstationEligibilityStatus,
  OutstationExpenseRequest,
  PlacesPrediction,
} from "@/lib/outstation/types";

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
  policyPreview: PolicyPreview | null;
  routePolyline: string | null;
};

type PolicyPreview = {
  allowanceAmount: number;
  allowanceBreakdown: OutstationAllowanceBreakdown;
  claimedTotalAmount: number;
  eligibilityReason: string;
  eligibilityStatus: OutstationEligibilityStatus;
  expectedTotalAmount: number;
  fuelAmount: number;
  fuelRatePerKm: number;
  minimumRequiredDistanceKm: number;
  overnightDays: number;
  policyRoleName: string;
  sameDayTrip: boolean;
  toleranceMinimumDistanceKm: number | null;
  varianceAmount: number;
  variancePercent: number;
};

const SESSION_TOKEN = Math.random().toString(36).slice(2);

const panelClassName =
  "rounded-[20px] border border-[#D8E0EA] bg-white shadow-[0_18px_44px_rgba(15,23,42,0.08)]";

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
      className={`h-11 w-full rounded-2xl border border-[#DDE6F1] bg-white/95 px-3 text-sm font-semibold text-[#0F172A] shadow-sm placeholder:font-normal placeholder:text-[#94A3B8] focus:border-[#F97316] focus:outline-none focus:ring-2 focus:ring-[#FED7AA] disabled:opacity-60 ${className ?? ""}`}
      {...props}
    />
  );
}

function SelectField({
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <select
      className="h-11 w-full rounded-2xl border border-[#DDE6F1] bg-white/95 px-3 text-sm font-semibold text-[#0F172A] shadow-sm focus:border-[#F97316] focus:outline-none focus:ring-2 focus:ring-[#FED7AA] disabled:opacity-60"
      {...props}
    >
      {children}
    </select>
  );
}

function egp(value: number | null | undefined) {
  return `${Number(value ?? 0).toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  })} EGP`;
}

function policyPreviewFromRequest(request: OutstationExpenseRequest | undefined): PolicyPreview | null {
  if (!request?.allowanceBreakdown) return null;

  return {
    allowanceAmount: request.allowanceAmount,
    allowanceBreakdown: request.allowanceBreakdown,
    claimedTotalAmount: request.claimedTotalAmount,
    eligibilityReason: request.eligibilityReason,
    eligibilityStatus: request.eligibilityStatus,
    expectedTotalAmount: request.expectedTotalAmount,
    fuelAmount: request.fuelAmount,
    fuelRatePerKm: 0,
    minimumRequiredDistanceKm: request.minimumRequiredDistanceKm,
    overnightDays: request.overnightDays,
    policyRoleName: request.employeeRole,
    sameDayTrip: request.sameDayTrip,
    toleranceMinimumDistanceKm: null,
    varianceAmount: request.varianceAmount,
    variancePercent: request.variancePercent,
  };
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
  const [claimedAmount, setClaimedAmount] = useState(
    request?.claimedTotalAmount ? String(request.claimedTotalAmount) : "",
  );

  const [destination, setDestination] = useState<ManagerExpenseDestination | null>(
    request
      ? {
          area: request.toArea,
          city: request.toCity,
          country: request.toCountry,
          placeId: request.toPlaceId ?? "",
          label: request.toLabel ?? request.toCity ?? "",
          latitude: request.capturedLatitude,
          longitude: request.capturedLongitude,
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
          policyPreview: policyPreviewFromRequest(request),
          routePolyline: request.routePolyline,
        }
      : null,
  );

  const [resolvingPlace, setResolvingPlace] = useState(false);
  const [calculatingDistance, setCalculatingDistance] = useState(false);
  const [distanceError, setDistanceError] = useState<string | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [sourceLocationLabel, setSourceLocationLabel] = useState(
    request
      ? [request.residenceAddress, request.residenceCity, request.residenceArea]
          .filter(Boolean)
          .join(", ")
      : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const calculationRequestRef = useRef(0);

  const hrIdForDistance = employeeHrId || request?.employeeHrId;

  async function resolveAndCalculate(prediction: PlacesPrediction) {
    setResolvingPlace(true);
    setPlaceError(null);
    setDistanceResult(null);
    setDistanceError(null);
    setDestination(null);

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
        label?: string;
        latitude?: number;
        longitude?: number;
        message?: string;
        placeId?: string;
      };

      const latitude = Number(placePayload.latitude);
      const longitude = Number(placePayload.longitude);

      if (!placeResponse.ok || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        setPlaceError(placePayload.message ?? "Could not resolve place details.");
        setResolvingPlace(false);
        return;
      }

      const resolved: ManagerExpenseDestination = {
        area: placePayload.area ?? null,
        city: placePayload.city ?? null,
        country: placePayload.country ?? null,
        label: placePayload.label ?? prediction.description,
        latitude,
        longitude,
        placeId: prediction.placeId,
      };
      setSourceLocationLabel(
        distanceResult?.fromLabel ??
          [request?.residenceAddress, request?.residenceCity, request?.residenceArea]
            .filter(Boolean)
            .join(", "),
      );
      setDestination(resolved);
      setResolvingPlace(false);
    } catch {
      setPlaceError("Failed to resolve place details.");
      setResolvingPlace(false);
    }
  }

  async function calculateDistance(dest: ManagerExpenseDestination, hrId: string) {
    const requestId = calculationRequestRef.current + 1;
    calculationRequestRef.current = requestId;
    setCalculatingDistance(true);
    setDistanceError(null);
    setDistanceResult(null);
    try {
      const response = await fetch("/api/admin/outstation/calculate-manager-distance", {
        body: JSON.stringify({
          claimedTotalAmount: claimedAmount ? Number(claimedAmount) : 0,
          destinationLat: dest.latitude,
          destinationLng: dest.longitude,
          managerHrId: hrId,
          transportationType,
          tripEndDate,
          tripStartDate,
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
        policyPreview?: PolicyPreview | null;
        routePolyline?: string | null;
      };

      if (calculationRequestRef.current !== requestId) return;

      if (!response.ok || payload.distanceKm == null) {
        setDistanceError(payload.message ?? "Distance calculation failed.");
      } else {
        setDistanceResult({
          distanceKm: payload.distanceKm,
          durationMinutes: payload.durationMinutes ?? null,
          fromLabel: payload.fromLabel ?? "",
          policyPreview: payload.policyPreview ?? null,
          routePolyline: payload.routePolyline ?? null,
        });
        setSourceLocationLabel(payload.fromLabel ?? "");
      }
    } catch {
      if (calculationRequestRef.current !== requestId) return;
      setDistanceError("Could not reach the distance calculation service.");
    } finally {
      if (calculationRequestRef.current === requestId) {
        setCalculatingDistance(false);
      }
    }
  }

  useEffect(() => {
    if (!destination || !hrIdForDistance) return;
    void calculateDistance(destination, hrIdForDistance);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    claimedAmount,
    destination?.latitude,
    destination?.longitude,
    hrIdForDistance,
    transportationType,
    tripEndDate,
    tripStartDate,
  ]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!destination || !distanceResult) return;

    setSubmitting(true);
    setSubmitError(null);

    const input: ManagerExpenseAdminInput = {
      claimedTotalAmount: claimedAmount ? Number(claimedAmount) : 0,
      destination,
      distanceKm: distanceResult.distanceKm,
      durationMinutes: distanceResult.durationMinutes,
      employeeHrId,
      expenseType,
      notes: notes.trim() || null,
      routePolyline: distanceResult.routePolyline,
      transportationType,
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
        setSubmitError(payload.message ?? "Failed to save manager expense.");
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
    Boolean(distanceResult) &&
    Boolean(distanceResult?.policyPreview) &&
    Boolean(tripStartDate) &&
    Boolean(tripEndDate) &&
    (isEdit || Boolean(employeeHrId)) &&
    !distanceError &&
    !submitting &&
    !resolvingPlace &&
    !calculatingDistance;
  const policyPreview = distanceResult?.policyPreview ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#020617]/72 p-3 backdrop-blur-md sm:p-6">
      <div className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-5xl flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#F8FAFC] shadow-[0_36px_120px_rgba(2,6,23,0.45)] sm:max-h-[calc(100vh-3rem)]">
        {/* Header */}
        <div className="shrink-0 border-b border-[#172033] bg-[linear-gradient(135deg,#050505_0%,#111827_58%,#3A1D08_100%)] px-6 py-5 text-white">
          <div className="flex items-start justify-between gap-4">
          <div>
            <span className="inline-flex rounded-full border border-[#FDBA74]/30 bg-[#FDBA74]/12 px-3 py-1 text-xs font-black uppercase tracking-[0.14em] text-[#FDBA74]">
              Manager expense (Admin)
            </span>
            <h2 className="mt-3 text-2xl font-black text-white">
              {isEdit ? "Edit manager expense" : "Create manager expense"}
            </h2>
            {(targetName ?? request?.employeeName) ? (
              <p className="mt-1 text-sm font-semibold text-[#CBD5E1]">
                {targetName ?? request?.employeeName} - {employeeHrId}
              </p>
            ) : null}
          </div>
          <button
            className="shrink-0 rounded-2xl border border-white/10 bg-white/8 p-2 text-[#CBD5E1] transition hover:bg-white/14 hover:text-white"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
          </div>
        </div>

        <form className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 sm:p-6" onSubmit={(e) => void handleSubmit(e)}>
          {/* Employee HR ID (create mode only) */}
          {!isEdit && !targetHrId ? (
            <div>
              <FieldLabel>Employee HR ID</FieldLabel>
              <InputField
                onChange={(e) => setEmployeeHrId(e.target.value.trim())}
                placeholder="e.g. EMP-001"
                required
                value={employeeHrId}
              />
              <p className="mt-1 text-xs text-[#64748B]">
                Enter the HR ID of the manager for whom you are creating this expense.
              </p>
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
                {(sourceLocationLabel || destination.city || destination.area) ? (
                  <div className="text-xs font-semibold text-[#64748B]">
                    {sourceLocationLabel ? <p>Source: {sourceLocationLabel}</p> : null}
                    {(destination.city ?? destination.area) ? (
                      <p>Destination: {[destination.city, destination.area].filter(Boolean).join(" / ")}</p>
                    ) : null}
                  </div>
                ) : null}

                {(destination.city ?? destination.area) ? (
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#047857]">
                    <MapPin className="h-3.5 w-3.5" />
                    {[destination.city, destination.area].filter(Boolean).join(" / ")}
                    {destination.country ? ` / ${destination.country}` : ""}
                  </div>
                ) : null}
                <p className="text-[11px] text-[#94A3B8]">
                  {destination.latitude.toFixed(5)}, {destination.longitude.toFixed(5)}
                </p>
              </div>
            ) : null}
          </div>

          {/* Distance result */}
          {calculatingDistance ? (
            <div className={`${panelClassName} flex items-center gap-3 p-4`}>
              <Loader2 className="h-5 w-5 animate-spin text-[#F97316]" />
              <div>
                <p className="text-sm font-black text-[#0F172A]">Calculating road distance...</p>
                <p className="text-xs text-[#64748B]">Using Google Maps Routes API</p>
              </div>
            </div>
          ) : distanceError ? (
            <div className="flex items-start gap-2 rounded-2xl border border-[#FECACA] bg-[#FEF2F2] p-4 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#B91C1C]" />
              <div>
                <p className="font-black text-[#B91C1C]">Distance calculation failed</p>
                <p className="mt-0.5 text-xs font-semibold text-[#B91C1C]">{distanceError}</p>
              </div>
            </div>
          ) : distanceResult ? (
            <div className={`${panelClassName} p-4`}>
              <div className="mb-3 flex items-center gap-2">
                <Route className="h-4 w-4 text-[#F97316]" />
                <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">
                  Road distance via Google Maps
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-[#FED7AA] bg-[#FFF7ED] px-4 py-3 text-center">
                  <p className="text-2xl font-black text-[#EA580C]">
                    {distanceResult.distanceKm.toFixed(1)} km
                  </p>
                  <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[#EA580C]/70">
                    Distance
                  </p>
                </div>
                {distanceResult.durationMinutes != null ? (
                  <div className="rounded-2xl border border-[#BBF7D0] bg-[#F0FDF4] px-4 py-3 text-center">
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

          {/* Claimed amount */}
          <div>
            <FieldLabel>Claimed amount (EGP) - optional</FieldLabel>
            <InputField
              min="0"
              onChange={(e) => setClaimedAmount(e.target.value)}
              placeholder="Leave blank to use calculated amount"
              step="0.01"
              type="number"
              value={claimedAmount}
            />
          </div>

          {distanceResult ? (
            <div className={`${panelClassName} overflow-hidden p-0`}>
              <div className="flex items-center justify-between gap-3 border-b border-[#E2E8F0] bg-[linear-gradient(90deg,#FFFFFF_0%,#F8FAFC_100%)] px-5 py-4">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-[#047857]" />
                  <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">
                    Expense policy calculation
                  </p>
                </div>
                {policyPreview ? (
                  <span className="rounded-full border border-[#DDE6F1] bg-[#F8FAFC] px-2.5 py-1 text-[10px] font-black uppercase text-[#475569]">
                    {policyPreview.policyRoleName}
                  </span>
                ) : null}
              </div>

              {!policyPreview ? (
                <div className="m-5 rounded-2xl border border-[#FED7AA] bg-[#FFF7ED] px-4 py-3 text-xs font-semibold text-[#9A3412]">
                  Select trip start and end dates to calculate allowance and expected total.
                </div>
              ) : (
                <div className="space-y-4 p-5">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="rounded-2xl border border-[#BFDBFE] bg-[#EFF6FF] px-4 py-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[#2563EB]">
                        Allowance
                      </p>
                      <p className="mt-1 text-lg font-black text-[#0F172A]">
                        {egp(policyPreview.allowanceAmount)}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[#BBF7D0] bg-[#F0FDF4] px-4 py-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[#047857]">
                        Fuel
                      </p>
                      <p className="mt-1 text-lg font-black text-[#0F172A]">
                        {egp(policyPreview.fuelAmount)}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[#FED7AA] bg-[#FFF7ED] px-4 py-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[#EA580C]">
                        Expected total
                      </p>
                      <p className="mt-1 text-lg font-black text-[#0F172A]">
                        {egp(policyPreview.expectedTotalAmount)}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-[#E2E8F0] bg-white px-4 py-3">
                      <p className="text-xs font-black text-[#0F172A]">Policy details</p>
                      <div className="mt-2 space-y-1 text-xs font-semibold text-[#64748B]">
                        <p>Minimum distance: {policyPreview.minimumRequiredDistanceKm.toFixed(1)} km</p>
                        {policyPreview.toleranceMinimumDistanceKm != null ? (
                          <p>Tolerance distance: {policyPreview.toleranceMinimumDistanceKm.toFixed(1)} km</p>
                        ) : null}
                        <p>Fuel rate: {egp(policyPreview.fuelRatePerKm)} / km</p>
                        <p>
                          Trip type: {policyPreview.sameDayTrip ? "Same day" : `${policyPreview.overnightDays} overnight day(s)`}
                        </p>
                        <p>Status: {policyPreview.eligibilityStatus.replace(/_/g, " ")}</p>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-[#E2E8F0] bg-white px-4 py-3">
                      <p className="text-xs font-black text-[#0F172A]">Amount summary</p>
                      <div className="mt-2 space-y-1 text-xs font-semibold text-[#64748B]">
                        <p>Claimed amount: {egp(policyPreview.claimedTotalAmount)}</p>
                        <p>Variance: {egp(policyPreview.varianceAmount)}</p>
                        <p>Variance percent: {policyPreview.variancePercent.toFixed(1)}%</p>
                        <p>Drive duration: {distanceResult.durationMinutes != null ? `${Math.round(distanceResult.durationMinutes)} min` : "Not available"}</p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3">
                    <p className="text-xs font-black text-[#0F172A]">Allowance breakdown</p>
                    <div className="mt-2 divide-y divide-[#E2E8F0]">
                      {policyPreview.allowanceBreakdown.rows.map((row, index) => (
                        <div className="flex items-center justify-between gap-3 py-2 text-xs" key={`${row.type}-${index}`}>
                          <span className="font-semibold text-[#64748B]">{row.label}</span>
                          <span className="font-black text-[#0F172A]">{egp(row.amount)}</span>
                        </div>
                      ))}
                    </div>
                    <p className="mt-2 text-xs font-semibold text-[#64748B]">
                      {policyPreview.eligibilityReason}
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {/* Notes */}
          <div>
            <FieldLabel>Notes</FieldLabel>
            <textarea
              className="w-full rounded-2xl border border-[#DDE6F1] bg-white/95 px-3 py-2.5 text-sm font-semibold text-[#0F172A] shadow-sm placeholder:font-normal placeholder:text-[#94A3B8] focus:border-[#F97316] focus:outline-none focus:ring-2 focus:ring-[#FED7AA]"
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes for this expense"
              rows={3}
              value={notes}
            />
          </div>

          {/* Submit error */}
          {submitError ? (
            <div className="flex items-start gap-2 rounded-2xl border border-[#FECACA] bg-[#FEF2F2] p-4 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#B91C1C]" />
              <p className="font-semibold text-[#B91C1C]">{submitError}</p>
            </div>
          ) : null}

          {/* Actions */}
          <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-col-reverse gap-3 border-t border-[#E2E8F0] bg-white/96 px-4 pb-4 pt-4 shadow-[0_-18px_36px_rgba(15,23,42,0.08)] backdrop-blur sm:-mx-6 sm:-mb-6 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:pb-6">
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
              {isEdit ? "Save changes" : "Create expense"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

