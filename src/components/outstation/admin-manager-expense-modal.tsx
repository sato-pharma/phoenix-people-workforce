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
  ManagerExpenseAdminInput,
  ManagerExpenseDestination,
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
  routePolyline: string | null;
};

const SESSION_TOKEN = Math.random().toString(36).slice(2);

const panelClassName =
  "rounded-[28px] border border-[#D8E0EA] bg-white/94 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur";

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

  const [resolvingPlace, setResolvingPlace] = useState(false);
  const [calculatingDistance, setCalculatingDistance] = useState(false);
  const [distanceError, setDistanceError] = useState<string | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

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

      if (!placeResponse.ok || !placePayload.latitude || !placePayload.longitude) {
        setPlaceError(placePayload.message ?? "Could not resolve place details.");
        setResolvingPlace(false);
        return;
      }

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
        await calculateDistance(resolved, hrIdForDistance);
      }
    } catch {
      setPlaceError("Failed to resolve place details.");
      setResolvingPlace(false);
    }
  }

  async function calculateDistance(dest: ManagerExpenseDestination, hrId: string) {
    setCalculatingDistance(true);
    setDistanceError(null);
    try {
      const response = await fetch("/api/admin/outstation/calculate-manager-distance", {
        body: JSON.stringify({
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
      }
    } catch {
      setDistanceError("Could not reach the distance calculation service.");
    } finally {
      setCalculatingDistance(false);
    }
  }

  const hrIdRef = useRef(hrIdForDistance);
  hrIdRef.current = hrIdForDistance;

  useEffect(() => {
    if (destination && hrIdForDistance && !distanceResult) {
      void calculateDistance(destination, hrIdForDistance);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    Boolean(tripStartDate) &&
    Boolean(tripEndDate) &&
    (isEdit || Boolean(employeeHrId)) &&
    !submitting &&
    !resolvingPlace &&
    !calculatingDistance;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#020617]/65 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl overflow-hidden rounded-[24px] border border-[#D8E0EA] bg-white shadow-[0_28px_90px_rgba(15,23,42,0.3)]">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-[#E2E8F0] bg-white/98 px-6 py-5">
          <div>
            <span className="inline-flex rounded-full border border-[#FED7AA] bg-[#FFF7ED] px-3 py-1 text-xs font-black uppercase tracking-[0.14em] text-[#EA580C]">
              Manager expense · Admin
            </span>
            <h2 className="mt-2 text-xl font-black text-[#0F172A]">
              {isEdit ? "Edit manager expense" : "Create manager expense"}
            </h2>
            {(targetName ?? request?.employeeName) ? (
              <p className="mt-1 text-sm font-semibold text-[#64748B]">
                {targetName ?? request?.employeeName} · {employeeHrId}
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
              placeholder="Search city or location…"
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
                Resolving place details…
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
          </div>

          {/* Distance result */}
          {calculatingDistance ? (
            <div className={`${panelClassName} flex items-center gap-3 p-4`}>
              <Loader2 className="h-5 w-5 animate-spin text-[#F97316]" />
              <div>
                <p className="text-sm font-black text-[#0F172A]">Calculating road distance…</p>
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
                  Road distance · Google Maps
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
            <FieldLabel>Claimed amount (EGP) — optional</FieldLabel>
            <InputField
              min="0"
              onChange={(e) => setClaimedAmount(e.target.value)}
              placeholder="Leave blank to use calculated amount"
              step="0.01"
              type="number"
              value={claimedAmount}
            />
          </div>

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
              {isEdit ? "Save changes" : "Create expense"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
