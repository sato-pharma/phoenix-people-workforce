"use client";

import { AlertTriangle, Car, CheckCircle2, MapPin, TrainFront, XCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type { OutstationCalculationResult } from "@/lib/outstation/types";
import { formatEmployeeDisplayName } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";


type CapturedLocation = {
  capturedAccuracyMeters: number;
  capturedLatitude: number;
  capturedLongitude: number;
  capturedAt?: string;
  distanceFromResidenceKm?: number | null;
  eligibilityReason?: string;
  eligibilityStatus?: string;
};

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  const normalized = String(status ?? "").toLowerCase();
  const tone = normalized === "eligible"
    ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
    : normalized === "not_eligible"
      ? "bg-red-50 text-red-700 ring-red-100"
      : "bg-amber-50 text-amber-700 ring-amber-100";
  const Icon = normalized === "eligible" ? CheckCircle2 : normalized === "not_eligible" ? XCircle : AlertTriangle;

  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold ring-1 ${tone}`}>
      <Icon className="h-3.5 w-3.5" />
      {status ? status.replace(/_/g, " ") : "not captured"}
    </span>
  );
}

export function OutstationRequestForm({
  employeeName,
  employeeRole,
  hasResidenceCoordinates,
  residenceSummary,
}: {
  employeeName: string;
  employeeRole: string;
  hasResidenceCoordinates: boolean;
  residenceSummary: string;
}) {
  const [transportationType, setTransportationType] = useState<"car" | "train">("car");
  const [tripStartDate, setTripStartDate] = useState("");
  const [tripEndDate, setTripEndDate] = useState("");
  const [claimedTotalAmount, setClaimedTotalAmount] = useState("");
  const [goTicketAmount, setGoTicketAmount] = useState("");
  const [returnTicketAmount, setReturnTicketAmount] = useState("");
  const [captured, setCaptured] = useState<CapturedLocation | null>(null);
  const [calculation, setCalculation] = useState<OutstationCalculationResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isCalculating, setIsCalculating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

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

      const response = await fetch("/api/outstation/capture-location", {
        body: JSON.stringify({
          capturedAccuracyMeters: position.coords.accuracy,
          capturedLatitude: position.coords.latitude,
          capturedLongitude: position.coords.longitude,
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
      const geoError = error as GeolocationPositionError | Error;
      if ("code" in geoError && typeof geoError.code === "number") {
        setMessage(
          geoError.code === 1
            ? "Location permission was denied. This report cannot proceed without GPS permission."
            : "Unable to capture your current location. Please try again.",
        );
      } else {
        setMessage(geoError instanceof Error ? geoError.message : "Unable to capture your current location.");
      }
    } finally {
      setIsCapturing(false);
    }
  }

  async function calculate() {
    if (!captured) {
      setMessage("Capture your current location first.");
      return;
    }

    setIsCalculating(true);
    setMessage(null);
    try {
      const response = await fetch("/api/outstation/calculate", {
        body: JSON.stringify({
          ...captured,
          claimedTotalAmount: Number(claimedTotalAmount || 0),
          goTicketAmount: Number(goTicketAmount || 0),
          returnTicketAmount: Number(returnTicketAmount || 0),
          transportationType,
          tripEndDate,
          tripStartDate,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message ?? payload.error ?? "Unable to calculate the request.");
        return;
      }

      setCalculation(payload);
    } catch {
      setMessage("Unable to calculate the request.");
    } finally {
      setIsCalculating(false);
    }
  }

  async function submitRequest() {
    if (!captured) {
      setMessage("Capture your current location first.");
      return;
    }

    setIsSubmitting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/outstation/submit", {
        body: JSON.stringify({
          ...captured,
          claimedTotalAmount: Number(claimedTotalAmount || 0),
          goTicketAmount: Number(goTicketAmount || 0),
          returnTicketAmount: Number(returnTicketAmount || 0),
          transportationType,
          tripEndDate,
          tripStartDate,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message ?? payload.error ?? "Unable to submit the request.");
        return;
      }

      setCalculation(null);
      setCaptured(null);
      setClaimedTotalAmount("");
      setGoTicketAmount("");
      setReturnTicketAmount("");
      setTripStartDate("");
      setTripEndDate("");
      setMessage("Outstation request submitted successfully.");
    } catch {
      setMessage("Unable to submit the request.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="rounded-lg border border-slate-200 bg-[linear-gradient(135deg,#fff7ed_0%,#ffffff_44%,#f8fafc_100%)] p-6 shadow-[0_18px_45px_rgba(15,23,42,0.06)]">
        <p className="text-xs font-black uppercase tracking-[0.2em] text-orange-500">
          Outstation Expense
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-[-0.05em] text-slate-950">
          New outstation request
        </h1>
        <p className="mt-3 text-sm leading-7 text-slate-600">
          The system validates your live browser GPS location against your registered residence. You do not enter the From location manually.
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <InfoCard label="Employee" value={formatEmployeeDisplayName(employeeName)} />
          <InfoCard label="Role" value={employeeRole} />
          <InfoCard label="Registered Residence" value={residenceSummary} />
          <InfoCard
            label="Residence Coordinates"
            value={<StatusBadge status={hasResidenceCoordinates ? "eligible" : "not_eligible"} />}
          />
        </div>
      </Card>

      <Card className="rounded-lg border border-slate-200 bg-white p-6 shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
              Capture Current Location
            </p>
            <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-slate-950">
              Validate destination against registered residence
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-600">
              Browser permission is required. Distances below 58 KM are not eligible. Distances from 58 KM to under 60 KM are accepted with warning.
            </p>
          </div>
          <Button
            className="rounded-xl bg-orange-500 text-white hover:bg-orange-600"
            disabled={isCapturing}
            onClick={captureLocation}
            type="button"
          >
            {isCapturing ? <LoadingSpinner className="text-white" /> : <MapPin className="h-4 w-4" />}
            {isCapturing ? "Capturing..." : "Capture My Location"}
          </Button>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-4">
          <InfoCard label="GPS Status" value={<StatusBadge status={captured?.eligibilityStatus} />} />
          <InfoCard label="Accuracy" value={captured ? `${Math.round(captured.capturedAccuracyMeters)} m` : "Not captured"} />
          <InfoCard label="Distance from residence" value={captured?.distanceFromResidenceKm != null ? `${captured.distanceFromResidenceKm.toFixed(2)} KM` : "Not calculated"} />
          <InfoCard label="Captured At" value={captured?.capturedAt ? new Date(captured.capturedAt).toLocaleString() : "Not captured"} />
        </div>
        {captured?.eligibilityReason ? (
          <p className="mt-4 text-sm font-medium text-slate-700">{captured.eligibilityReason}</p>
        ) : null}
      </Card>

      <Card className="rounded-lg border border-slate-200 bg-white p-6 shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SelectField
            label="Transportation Type"
            onChange={(value) => setTransportationType(value as "car" | "train")}
            options={[
              { label: "Car", value: "car" },
              { label: "Train", value: "train" },
            ]}
            value={transportationType}
          />
          <Field label="Trip Start Date">
            <Input onChange={(event) => setTripStartDate(event.target.value)} type="date" value={tripStartDate} />
          </Field>
          <Field label="Trip End Date">
            <Input onChange={(event) => setTripEndDate(event.target.value)} type="date" value={tripEndDate} />
          </Field>
          <Field label="Claimed Total Amount">
            <Input onChange={(event) => setClaimedTotalAmount(event.target.value)} type="number" value={claimedTotalAmount} />
          </Field>
          {transportationType === "train" ? (
            <>
              <Field label="Go Ticket Amount">
                <Input onChange={(event) => setGoTicketAmount(event.target.value)} type="number" value={goTicketAmount} />
              </Field>
              <Field label="Return Ticket Amount">
                <Input onChange={(event) => setReturnTicketAmount(event.target.value)} type="number" value={returnTicketAmount} />
              </Field>
              <div className="md:col-span-2 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                Train / Bus requests require go and return ticket evidence during review.
              </div>
            </>
          ) : (
            <div className="md:col-span-2 rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              Car payable fuel is calculated as distance Ã— 2 Ã— policy fuel rate. Round trip is enforced automatically.
            </div>
          )}
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <Button className="rounded-xl bg-slate-900 text-white hover:bg-slate-800" disabled={isCalculating} onClick={calculate} type="button">
            {isCalculating ? <LoadingSpinner className="text-white" /> : transportationType === "car" ? <Car className="h-4 w-4" /> : <TrainFront className="h-4 w-4" />}
            {isCalculating ? "Calculating..." : "Calculate Eligibility & Payable"}
          </Button>
          <Button className="rounded-xl bg-orange-500 text-white hover:bg-orange-600" disabled={isSubmitting || calculation?.eligibilityStatus === "not_eligible"} onClick={submitRequest} type="button">
            {isSubmitting ? <LoadingSpinner className="text-white" /> : null}
            {isSubmitting ? "Submitting..." : "Submit Request"}
          </Button>
        </div>
      </Card>

      {calculation ? (
        <Card className="rounded-lg border border-slate-200 bg-white p-6 shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
                Calculation Result
              </p>
              <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-slate-950">
                Server-side eligibility and payable summary
              </h2>
            </div>
            <StatusBadge status={calculation.eligibilityStatus} />
          </div>
          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <InfoCard label="Distance" value={calculation.distanceFromResidenceKm != null ? `${calculation.distanceFromResidenceKm.toFixed(2)} KM` : "N/A"} />
            <InfoCard label="Fuel Amount" value={egp(calculation.fuelAmount)} />
            <InfoCard label="Allowance" value={egp(calculation.allowanceAmount)} />
            <InfoCard label="Ticket Amount" value={egp(calculation.ticketAmount)} />
            <InfoCard label="Claimed Total" value={egp(Number(claimedTotalAmount || 0))} />
            <InfoCard label="Recommendation" value={calculation.approvalRecommendation.replace(/_/g, " ")} />
          </div>
          <p className="mt-4 text-sm font-medium text-slate-700">{calculation.eligibilityReason}</p>
        </Card>
      ) : null}

      {message ? (
        <Card className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700">
          {message}
        </Card>
      ) : null}
    </div>
  );
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function SelectField({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500">
        {label}
      </span>
      <SearchableSelect
        className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SearchableSelect>
    </label>
  );
}

function InfoCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
      <p className="text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <div className="mt-2 text-sm font-semibold text-slate-900">{value}</div>
    </div>
  );
}
