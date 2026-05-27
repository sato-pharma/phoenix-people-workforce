"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  ChevronLeft,
  ChevronRight,
  Download,
  RefreshCw,
  Search,
} from "lucide-react";

import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { normalizeHrId, normalizeHrIdForAccess } from "@/lib/auth/permissions";
import type { MedicalRepPortalData } from "@/lib/employee-portal/service";
import { extractKnownPlace } from "@/lib/utils/places";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type ExpenseRow = {
  hrId: string;
  tripId: string;
  date: string;
  toDate: string;
  requestType: string;
  from: string;
  fromCity: string;
  to: string;
  toCity: string;
  destinationCity: string;
  status: string;
  travelCost: number;
  meetingAmount: number;
  allowance: number;
  total: number;
  km: number;
  transportationType: string;
  amWorkload: number;
  pmWorkload: number;
  description: string;
  hrNotes: string;
};

export type WorkloadAdminKeyCards = {
  expenseClaimsAmount: number;
  expenseClaimsEntries: number;
  payrollBatchLabel: string;
  payrollEligibleCount: number;
  totalSalesTarget: number;
  totalSalesValue: number;
};

const statusOptions = [
  "All",
  "System Approval",
  "Pending",
  "Declined",
  "Confirmed by HR",
  "Other",
] as const;

type SortField =
  | "date"
  | "tripId"
  | "toDate"
  | "requestType"
  | "fromCity"
  | "toCity"
  | "total"
  | "travelCost"
  | "meetingAmount"
  | "allowance"
  | "km"
  | "status"
  | "transportationType";

type SortDirection = "asc" | "desc";

type PeriodPreset = "7d" | "30d" | "90d" | "ytd" | "custom";

/* ------------------------------------------------------------------ */
/*  Design tokens                                                     */
/* ------------------------------------------------------------------ */

const cardShadow = "shadow-[0_1px_3px_rgba(15,23,42,0.06)]";

const inputClass =
  "h-10 w-full rounded-md border border-gray-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-orange-300 focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)] disabled:bg-slate-50";

const labelClass =
  "text-[10px] font-semibold uppercase tracking-wider text-slate-500";

/* ------------------------------------------------------------------ */
/*  Color insight palette — degrading scale for chart bars            */
/* ------------------------------------------------------------------ */

const SPEND_COLORS = ["#10b981", "#22c55e", "#f59e0b", "#f97316", "#ef4444"];
const STATUS_COLORS = {
  "Confirmed by HR": "#10b981",
  "System Approval": "#f59e0b",
  Pending: "#fbbf24",
  Declined: "#ef4444",
  Other: "#94a3b8",
} as const;

function spendColorForValue(value: number, max: number) {
  if (max <= 0) return SPEND_COLORS[0];
  const ratio = Math.min(1, value / max);
  const idx = Math.min(SPEND_COLORS.length - 1, Math.floor(ratio * SPEND_COLORS.length));
  return SPEND_COLORS[idx];
}

/* ------------------------------------------------------------------ */
/*  Formatting helpers (UNCHANGED LOGIC)                              */
/* ------------------------------------------------------------------ */

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function formatKm(value: number) {
  return `${Math.max(0, Number.isFinite(value) ? value : 0).toLocaleString()} km`;
}

function formatDate(value: string) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function normalizeString(value: string | null | undefined) {
  return (value || "").trim();
}

function monthLabel(period: string) {
  const [yearText, monthText] = period.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!year || !month) return period;
  return new Intl.DateTimeFormat("en", { month: "short", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function mapStatusCategory(value: string) {
  const normalized = (value || "").toLowerCase();
  if (normalized.includes("system") && normalized.includes("approval")) return "System Approval";
  if (normalized.includes("declined") || normalized.includes("rejected")) return "Declined";
  if (normalized.includes("confirmed") && normalized.includes("hr")) return "Confirmed by HR";
  if (normalized.includes("pending")) return "Pending";
  if (normalized.includes("approved")) return "Confirmed by HR";
  return "Other";
}

function statusVariant(statusCategory: string) {
  if (statusCategory === "Confirmed by HR") return "success";
  if (statusCategory === "System Approval" || statusCategory === "Pending") return "warning";
  if (statusCategory === "Declined") return "danger";
  return "neutral";
}

function normalizeCityName(value: string) {
  const normalized = normalizeString(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\bEgypt\b/gi, " ")
    .replace(/\bGovernorate\b/gi, " ")
    .replace(/\bGov\.?\b/gi, " ")
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  const knownPlace = extractKnownPlace(normalized);
  if (knownPlace) return knownPlace;

  const routeBaseText = normalized
    .split("|")[0]
    .split("→")[0]
    .split(" to ")[0]
    .split(" To ")[0]
    .split(" - ")[0]
    .split(" – ")[0]
    .split(" — ")[0]
    .split("/")[0];
  const routeBaseParts = routeBaseText.split(",").map((part) => part.trim()).filter(Boolean);
  const base = (routeBaseParts[routeBaseParts.length - 1] || "")
    .replace(/^[,.\-\s]+|[,.\-\s]+$/g, "")
    .trim();

  if (!base) return "";

  const canonicalMap: Record<string, string> = {
    "kafr el sheykh": "Kafr El Sheykh",
    "kafr el sheikh": "Kafr El Sheikh",
    "kafr elsheikh": "Kafr El Sheikh",
    "al kahraba": "Al Kahraba",
    "6 oct": "6th Of October",
  };

  const lowered = base.toLowerCase().replace(/\s+/g, " ").trim();
  if (Object.prototype.hasOwnProperty.call(canonicalMap, lowered)) return canonicalMap[lowered];
  if (/[؀-ۿ]/.test(base)) return base;

  return base
    .toLowerCase()
    .split(" ")
    .slice(0, 4)
    .map((part) => {
      if (!part) return part;
      if (part.length <= 1) return part;
      return `${part[0].toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function extractDestination(to: string, fallback: string) {
  const fromTo = normalizeCityName(extractRoutePart(to || "", "to") || to || "");
  const fromFallback = normalizeCityName(fallback || "");
  return fromTo || fromFallback || "Unknown";
}

function extractRoutePart(value: string, endpoint: "from" | "to") {
  const text = normalizeString(value);
  if (!text) return "";

  const arrowParts = text.split(/\s*(?:→|->|-->)\s*/).map((part) => part.trim()).filter(Boolean);
  if (arrowParts.length >= 2) return endpoint === "from" ? arrowParts[0] : arrowParts[arrowParts.length - 1];

  const fromToMatch = text.match(/\bfrom\s+(.+?)\s+to\s+(.+)$/i);
  if (fromToMatch) return endpoint === "from" ? fromToMatch[1] : fromToMatch[2];

  return "";
}

function compactTripPlace(primary: string, routeFallback: string, endpoint: "from" | "to", fallbackPlace = "") {
  const routePart = extractRoutePart(primary, endpoint) || extractRoutePart(routeFallback, endpoint);
  return normalizeCityName(routePart || primary || fallbackPlace) || "Unknown";
}

/* ------------------------------------------------------------------ */
/*  Chart tooltip style                                               */
/* ------------------------------------------------------------------ */

function chartTooltipStyle() {
  return {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: 6,
    boxShadow: "0 4px 12px rgba(15,23,42,0.08)",
    fontSize: 12,
  };
}

/* ------------------------------------------------------------------ */
/*  Empty state                                                       */
/* ------------------------------------------------------------------ */

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-12 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-orange-600">
        {title}
      </p>
      <p className="text-sm text-slate-500">{message}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Smart Period Filter — segmented + collapsible custom range        */
/* ------------------------------------------------------------------ */

function SmartPeriodFilter({
  dateFrom,
  dateTo,
  onChange,
  preset,
  setPreset,
}: {
  dateFrom: string;
  dateTo: string;
  onChange: (from: string, to: string) => void;
  preset: PeriodPreset;
  setPreset: (preset: PeriodPreset) => void;
}) {
  const customRef = useRef<HTMLDivElement | null>(null);

  // Focus trap: when custom panel opens, focus first input + cycle on Tab
  useEffect(() => {
    if (preset !== "custom" || !customRef.current) return;
    const node = customRef.current;
    const inputs = Array.from(
      node.querySelectorAll<HTMLInputElement>("input[type='date']"),
    );
    if (inputs.length === 0) return;
    inputs[0].focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusables = inputs;
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    node.addEventListener("keydown", handler);
    return () => node.removeEventListener("keydown", handler);
  }, [preset]);

  const applyPreset = (next: PeriodPreset) => {
    setPreset(next);
    const today = new Date();
    const toIso = (date: Date) => date.toISOString().slice(0, 10);
    if (next === "7d") {
      const from = new Date(today);
      from.setDate(from.getDate() - 7);
      onChange(toIso(from), toIso(today));
    } else if (next === "30d") {
      const from = new Date(today);
      from.setDate(from.getDate() - 30);
      onChange(toIso(from), toIso(today));
    } else if (next === "90d") {
      const from = new Date(today);
      from.setDate(from.getDate() - 90);
      onChange(toIso(from), toIso(today));
    } else if (next === "ytd") {
      const from = new Date(today.getFullYear(), 0, 1);
      onChange(toIso(from), toIso(today));
    } else if (next === "custom") {
      // leave existing values
    }
  };

  const segmentBtn = (key: PeriodPreset, label: string) => {
    const active = preset === key;
    return (
      <button
        aria-pressed={active}
        className={`flex-1 whitespace-nowrap rounded-sm px-2.5 py-1.5 text-[12px] font-semibold transition sm:flex-initial ${
          active
            ? "bg-orange-500 text-white shadow-sm"
            : "text-slate-600 hover:bg-slate-100"
        }`}
        key={key}
        onClick={() => applyPreset(key)}
        type="button"
      >
        {label}
      </button>
    );
  };

  return (
    <div className="space-y-3">
      <div>
        <p className={labelClass}>Period</p>
        <div
          className="mt-1.5 inline-flex w-full items-center gap-0.5 rounded-md border border-gray-200 bg-slate-50 p-0.5 sm:w-auto"
          role="group"
        >
          {segmentBtn("7d", "7 days")}
          {segmentBtn("30d", "30 days")}
          {segmentBtn("90d", "90 days")}
          {segmentBtn("ytd", "YTD")}
          {segmentBtn("custom", "Custom")}
        </div>
      </div>
      {preset === "custom" && (
        <div
          className="grid gap-3 rounded-md border border-orange-100 bg-orange-50/30 p-3 sm:grid-cols-2"
          ref={customRef}
        >
          <label className="min-w-0">
            <span className={labelClass}>From</span>
            <input
              aria-label="Custom date from"
              className={`${inputClass} mt-1.5`}
              onChange={(event) => onChange(event.target.value, dateTo)}
              type="date"
              value={dateFrom}
            />
          </label>
          <label className="min-w-0">
            <span className={labelClass}>To</span>
            <input
              aria-label="Custom date to"
              className={`${inputClass} mt-1.5`}
              onChange={(event) => onChange(dateFrom, event.target.value)}
              type="date"
              value={dateTo}
            />
          </label>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  KPI Stat Card — thin, gridline-friendly                           */
/* ------------------------------------------------------------------ */

function StatCard({
  accent,
  delta,
  helper,
  label,
  value,
}: {
  accent: string;
  delta?: number | null;
  helper?: string;
  label: string;
  value: string;
}) {
  const showDelta = delta !== undefined && delta !== null;
  const isPositive = showDelta && (delta as number) >= 0;
  return (
    <div className={`border-l-2 ${accent} px-4 py-4`}>
      <p className={labelClass}>{label}</p>
      <p className="mt-1 text-xl font-bold text-slate-800">{value}</p>
      {helper && (
        <p className="mt-1 text-[11px] leading-snug text-slate-500">{helper}</p>
      )}
      {showDelta && (
        <span
          className={`mt-1.5 inline-block rounded-sm px-1.5 py-0.5 text-[10px] font-bold ${
            isPositive ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
          }`}
        >
          {isPositive ? "+" : ""}
          {(delta as number).toFixed(1)}%
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Admin Key Card — flat, no decorative icon                         */
/* ------------------------------------------------------------------ */

function AdminKeyCard({
  accent,
  helper,
  label,
  value,
}: {
  accent: string;
  helper: string;
  label: string;
  value: string;
}) {
  return (
    <div className={`border-l-2 ${accent} px-4 py-4`}>
      <p className={labelClass}>{label}</p>
      <p className="mt-1 text-xl font-bold text-slate-800">{value}</p>
      <p className="mt-1 text-[11px] leading-snug text-slate-500">{helper}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Chart Card wrapper                                                */
/* ------------------------------------------------------------------ */

function ChartCard({
  action,
  children,
  description,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <Card
      className={`overflow-hidden rounded-lg border border-gray-100 p-4 sm:p-5 ${cardShadow}`}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-semibold text-slate-800">{title}</h3>
          {description && (
            <p className="mt-0.5 text-[11px] text-slate-500">{description}</p>
          )}
        </div>
        {action}
      </div>
      <WorkspaceErrorBoundary fallbackTitle="Chart unavailable">
        {children}
      </WorkspaceErrorBoundary>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Print styles                                                      */
/* ------------------------------------------------------------------ */

const printStyles = `
@media print {
  body { background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  nav, header, footer, button, [data-no-print] { display: none !important; }
  .print\\:break-inside-avoid { break-inside: avoid; }
  .print\\:shadow-none { box-shadow: none !important; }
  * { border-color: #e2e8f0 !important; }
}
`;

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

export function PersonalExpenseWorkloadDashboard({
  adminKeyCards,
  data,
  showHero = true,
}: {
  adminKeyCards?: WorkloadAdminKeyCards | null;
  data: MedicalRepPortalData;
  showHero?: boolean;
}) {
  /* -------- data normalization (UNCHANGED LOGIC) -------- */
  const currentEmployeeHrId = normalizeHrId(data.employee?.hrId);
  const currentEmployeeCanonicalHrId = currentEmployeeHrId
    ? normalizeHrIdForAccess(currentEmployeeHrId)
    : null;

  const rows: ExpenseRow[] = useMemo(() => {
    const source = (data.workload?.expenseRows ?? []).filter((expense) => {
      if (!currentEmployeeHrId) return true;
      const expenseHrId = normalizeHrId(expense.hrId);
      if (!expenseHrId) return false;
      if (expenseHrId === currentEmployeeHrId) return true;
      const expenseCanonical = normalizeHrIdForAccess(expenseHrId);
      return Boolean(
        currentEmployeeCanonicalHrId &&
          expenseCanonical &&
          expenseCanonical === currentEmployeeCanonicalHrId,
      );
    });

    return source.map((expense) => ({
      hrId: normalizeString(expense.hrId),
      tripId: normalizeString(expense.tripId),
      date: normalizeString(expense.date),
      toDate: normalizeString(expense.toDate),
      requestType: normalizeString(expense.requestType),
      from: normalizeString(expense.from),
      fromCity: compactTripPlace(expense.from || "", expense.to || "", "from"),
      to: normalizeString(expense.to),
      toCity: compactTripPlace(expense.to || "", expense.from || "", "to", expense.location),
      destinationCity: extractDestination(expense.to || "", expense.location),
      status: normalizeString(expense.status),
      travelCost: Number(expense.travelCost ?? 0),
      meetingAmount: Number(expense.meetingAmount ?? 0),
      allowance: Number(expense.allowance ?? 0),
      total: Number(expense.total ?? 0),
      km: Number(expense.km ?? 0),
      transportationType: normalizeString(expense.transportationType || expense.requestType),
      amWorkload: Number(expense.amWorkload ?? 0),
      pmWorkload: Number(expense.pmWorkload ?? 0),
      description: normalizeString(expense.description),
      hrNotes: normalizeString(expense.hrNotes || expense.description),
    }));
  }, [data.workload?.expenseRows, currentEmployeeCanonicalHrId, currentEmployeeHrId]);

  /* -------- filter state -------- */
  // Initialize from URL search params (if any) so deep links + refresh
  // restore the previous view. Falls back to sensible defaults.
  const initialUrl = typeof window !== "undefined" ? new URL(window.location.href) : null;
  const initialPreset = ((initialUrl?.searchParams.get("period") as PeriodPreset) ||
    "custom") as PeriodPreset;
  const initialFrom = initialUrl?.searchParams.get("from") ?? "";
  const initialTo = initialUrl?.searchParams.get("to") ?? "";
  const initialStatus = (initialUrl?.searchParams.get("status") ?? "All") as (typeof statusOptions)[number];
  const initialQ = initialUrl?.searchParams.get("q") ?? "";

  const [searchTerm, setSearchTerm] = useState(initialQ);
  const [dateFrom, setDateFrom] = useState(initialFrom);
  const [dateTo, setDateTo] = useState(initialTo);
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>(initialPreset);
  const [statusFilter, setStatusFilter] = useState<(typeof statusOptions)[number]>(initialStatus);
  const [requestTypeFilter, setRequestTypeFilter] = useState("All");
  const [transportationFilter, setTransportationFilter] = useState("All");
  const [destinationFilter, setDestinationFilter] = useState("All");
  const [showCostByTransportation, setShowCostByTransportation] = useState(false);
  const [page, setPage] = useState(1);
  const [searchSortField, setSearchSortField] = useState<SortField>("date");
  const [searchSortDirection, setSearchSortDirection] = useState<SortDirection>("desc");
  const [density, setDensity] = useState<"compact" | "comfortable">("comfortable");
  // Page size — bumps to 25 automatically once dataset crosses 200 rows
  // so big histories paginate less without exploding DOM size on mobile.
  const [pageSize, setPageSize] = useState<10 | 25 | 50 | 100>(() =>
    rows.length > 200 ? 25 : 10,
  );

  /* -------- URL sync (filter state <-> ?period=...&from=...&to=...) -------- */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const set = (key: string, value: string | null | undefined) => {
      if (value && value !== "All") url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    };
    set("period", periodPreset === "custom" ? null : periodPreset);
    set("from", dateFrom);
    set("to", dateTo);
    set("status", statusFilter === "All" ? null : statusFilter);
    set("q", searchTerm);
    window.history.replaceState(null, "", url.toString());
  }, [periodPreset, dateFrom, dateTo, statusFilter, searchTerm]);

  /* -------- derived lists (UNCHANGED LOGIC) -------- */
  const uniqueRequestTypes = useMemo(
    () => [
      "All",
      ...Array.from(
        new Set(rows.map((row) => normalizeString(row.requestType)).filter(Boolean)).values(),
      ).sort(),
    ],
    [rows],
  );

  const uniqueTransportationTypes = useMemo(
    () => [
      "All",
      ...Array.from(
        new Set(rows.map((row) => normalizeString(row.transportationType)).filter(Boolean)).values(),
      ).sort(),
    ],
    [rows],
  );

  const uniqueDestinations = useMemo(
    () =>
      ["All", ...Array.from(new Set(rows.map((row) => row.destinationCity)).values())]
        .filter(Boolean)
        .sort(),
    [rows],
  );

  const statusFilterOptions = useMemo(
    () => ["All", ...statusOptions.filter((status) => status !== "All")],
    [],
  );

  const filteredTrips = useMemo(() => {
    const lowerSearch = searchTerm.trim().toLowerCase();
    return rows.filter((trip) => {
      const category = mapStatusCategory(trip.status);
      const tripDate = trip.date ? new Date(trip.date) : null;
      if (dateFrom) {
        const from = new Date(`${dateFrom}T00:00:00.000`);
        if (tripDate && tripDate < from) return false;
      }
      if (dateTo) {
        const to = new Date(`${dateTo}T23:59:59.999`);
        if (tripDate && tripDate > to) return false;
      }
      if (statusFilter !== "All" && category !== statusFilter) return false;
      if (requestTypeFilter !== "All" && normalizeString(trip.requestType) !== requestTypeFilter) return false;
      if (transportationFilter !== "All" && normalizeString(trip.transportationType) !== transportationFilter) return false;
      if (destinationFilter !== "All" && trip.destinationCity !== destinationFilter) return false;
      if (lowerSearch) {
        const searchable =
          `${trip.tripId} ${trip.requestType} ${trip.from} ${trip.fromCity} ${trip.to} ${trip.toCity} ${trip.status} ${trip.transportationType} ${trip.description} ${trip.hrNotes} ${trip.destinationCity}`.toLowerCase();
        if (!searchable.includes(lowerSearch)) return false;
      }
      return true;
    });
  }, [
    rows,
    dateFrom,
    dateTo,
    statusFilter,
    requestTypeFilter,
    transportationFilter,
    destinationFilter,
    searchTerm,
  ]);

  const sortedTrips = useMemo(() => {
    const mutableTrips = [...filteredTrips];
    mutableTrips.sort((left, right) => {
      const factor = searchSortDirection === "asc" ? 1 : -1;
      if (searchSortField === "date") {
        const leftDate = left.date ? new Date(left.date).getTime() : 0;
        const rightDate = right.date ? new Date(right.date).getTime() : 0;
        return (leftDate - rightDate) * factor;
      }
      if (searchSortField === "toDate") {
        const leftDate = left.toDate ? new Date(left.toDate).getTime() : 0;
        const rightDate = right.toDate ? new Date(right.toDate).getTime() : 0;
        return (leftDate - rightDate) * factor;
      }
      if (
        searchSortField === "total" ||
        searchSortField === "travelCost" ||
        searchSortField === "meetingAmount" ||
        searchSortField === "allowance" ||
        searchSortField === "km"
      ) {
        const numericField = searchSortField as
          | "total"
          | "travelCost"
          | "meetingAmount"
          | "allowance"
          | "km";
        return (left[numericField] - right[numericField]) * factor;
      }
      const leftValue = normalizeString(
        left[
          searchSortField as
            | "tripId"
            | "requestType"
            | "fromCity"
            | "toCity"
            | "status"
            | "transportationType"
        ],
      ).toLowerCase();
      const rightValue = normalizeString(
        right[
          searchSortField as
            | "tripId"
            | "requestType"
            | "fromCity"
            | "toCity"
            | "status"
            | "transportationType"
        ],
      ).toLowerCase();
      return leftValue.localeCompare(rightValue) * factor;
    });
    return mutableTrips;
  }, [filteredTrips, searchSortField, searchSortDirection]);

  /* -------- KPI computations (UNCHANGED LOGIC) -------- */
  const totalTrips = filteredTrips.length;
  const totalExpenses = filteredTrips.reduce((total, item) => total + item.total, 0);
  const totalKm = filteredTrips.reduce((total, item) => total + item.km, 0);
  const averageCostPerTrip = totalTrips > 0 ? totalExpenses / totalTrips : 0;

  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const previousMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const previousMonth = `${previousMonthDate.getUTCFullYear()}-${String(previousMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
  const tripsThisMonth = filteredTrips.filter((trip) => trip.date.startsWith(currentMonth)).length;
  const tripsLastMonth = filteredTrips.filter((trip) => trip.date.startsWith(previousMonth)).length;
  const tripsDeltaPercent = tripsLastMonth > 0 ? ((tripsThisMonth - tripsLastMonth) / tripsLastMonth) * 100 : null;

  /* -------- chart data (UNCHANGED LOGIC) -------- */
  const monthlyTrend = useMemo(() => {
    const totals = new Map<string, { expense: number; trips: number }>();
    filteredTrips.forEach((trip) => {
      if (!trip.date || Number.isNaN(new Date(trip.date).getTime())) return;
      const period = `${new Date(trip.date).getUTCFullYear()}-${String(new Date(trip.date).getUTCMonth() + 1).padStart(2, "0")}`;
      const existing = totals.get(period) ?? { expense: 0, trips: 0 };
      totals.set(period, {
        expense: existing.expense + trip.total,
        trips: existing.trips + 1,
      });
    });
    return Array.from(totals.entries())
      .map(([period, item]) => ({
        period,
        month: monthLabel(period),
        expense: item.expense,
        trips: item.trips,
      }))
      .sort((left, right) => left.period.localeCompare(right.period));
  }, [filteredTrips]);

  const categoryBreakdown = useMemo(() => {
    const travel = filteredTrips.reduce((sum, item) => sum + item.travelCost, 0);
    const meeting = filteredTrips.reduce((sum, item) => sum + item.meetingAmount, 0);
    const allowance = filteredTrips.reduce((sum, item) => sum + item.allowance, 0);
    const total = travel + meeting + allowance;
    return {
      total,
      data: [
        { name: "Travel Cost", value: travel, color: "#f97316" },
        { name: "Meeting Amount", value: meeting, color: "#f59e0b" },
        { name: "Allowance", value: allowance, color: "#94a3b8" },
      ],
    };
  }, [filteredTrips]);

  const statusDistribution = useMemo(() => {
    const grouped = new Map<string, number>();
    filteredTrips.forEach((trip) => {
      const status = mapStatusCategory(trip.status);
      grouped.set(status, (grouped.get(status) ?? 0) + 1);
    });
    return statusOptions
      .filter((status) => status !== "All")
      .map((status) => ({
        name: status,
        value: grouped.get(status) ?? 0,
        color: STATUS_COLORS[status as keyof typeof STATUS_COLORS] ?? "#94a3b8",
      }))
      .filter((item) => item.value > 0);
  }, [filteredTrips]);

  const transportationSummary = useMemo(() => {
    const grouped = new Map<string, { trips: number; total: number }>();
    filteredTrips.forEach((trip) => {
      const key = normalizeString(trip.transportationType) || "Other";
      const existing = grouped.get(key) ?? { trips: 0, total: 0 };
      grouped.set(key, { trips: existing.trips + 1, total: existing.total + trip.total });
    });
    return Array.from(grouped.entries())
      .map(([name, summary]) => ({ name, trips: summary.trips, total: summary.total }))
      .sort((left, right) => right.trips - left.trips);
  }, [filteredTrips]);

  const destinationSummary = useMemo(() => {
    const grouped = new Map<string, { trips: number; total: number }>();
    filteredTrips.forEach((trip) => {
      const city = trip.destinationCity || "Unknown";
      const existing = grouped.get(city) ?? { trips: 0, total: 0 };
      grouped.set(city, { trips: existing.trips + 1, total: existing.total + trip.total });
    });
    return Array.from(grouped.entries())
      .map(([name, summary]) => ({ city: name, trips: summary.trips, total: summary.total }))
      .sort((left, right) => right.total - left.total)
      .slice(0, 8);
  }, [filteredTrips]);

  /* -------- memoized max values for chart Cell colors -------- */
  const monthlyTrendMax = useMemo(
    () => monthlyTrend.reduce((max, r) => (r.expense > max ? r.expense : max), 0),
    [monthlyTrend],
  );
  const transportationTripsMax = useMemo(
    () => transportationSummary.reduce((max, r) => (r.trips > max ? r.trips : max), 0),
    [transportationSummary],
  );
  const transportationTotalMax = useMemo(
    () => transportationSummary.reduce((max, r) => (r.total > max ? r.total : max), 0),
    [transportationSummary],
  );
  const destinationTripsMax = useMemo(
    () => destinationSummary.reduce((max, r) => (r.trips > max ? r.trips : max), 0),
    [destinationSummary],
  );

  const hasWorkloadData = data.workload?.hasWorkloadFields ?? false;
  const totalAmWorkload = filteredTrips.reduce((sum, row) => sum + row.amWorkload, 0);
  const totalPmWorkload = filteredTrips.reduce((sum, row) => sum + row.pmWorkload, 0);
  const workloadTripCount = filteredTrips.length;
  const averageWorkloadPerTrip =
    workloadTripCount > 0 ? (totalAmWorkload + totalPmWorkload) / workloadTripCount : 0;

  const workloadChartData = [
    { name: "AM", value: totalAmWorkload, color: "#10b981" },
    { name: "PM", value: totalPmWorkload, color: "#f97316" },
  ];

  /* -------- NEW INSIGHTS (smart suggestions) -------- */
  const insights = useMemo(() => {
    // Top destination by total spend
    const top = destinationSummary[0];
    // Cost outlier: any trip > avg + 1.5x stdev
    const totals = filteredTrips.map((t) => t.total).filter((v) => v > 0);
    let outlier: ExpenseRow | null = null;
    if (totals.length >= 3) {
      const mean = totals.reduce((s, v) => s + v, 0) / totals.length;
      const variance = totals.reduce((s, v) => s + (v - mean) ** 2, 0) / totals.length;
      const stdev = Math.sqrt(variance);
      const threshold = mean + stdev * 1.5;
      outlier = filteredTrips.reduce<ExpenseRow | null>((best, current) => {
        if (current.total > threshold && (!best || current.total > best.total)) return current;
        return best;
      }, null);
    }
    // Cost per KM
    const costPerKm = totalKm > 0 ? totalExpenses / totalKm : 0;
    return { top, outlier, costPerKm };
  }, [destinationSummary, filteredTrips, totalKm, totalExpenses]);

  /* -------- pagination -------- */
  const totalPages = Math.max(1, Math.ceil(sortedTrips.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedTrips = sortedTrips.slice((safePage - 1) * pageSize, safePage * pageSize);
  const pageSummary = `${(safePage - 1) * pageSize + 1}-${Math.min(safePage * pageSize, sortedTrips.length)} of ${sortedTrips.length}`;

  /* -------- handlers -------- */
  const onSort = (field: SortField) => {
    if (searchSortField === field) {
      setSearchSortDirection(searchSortDirection === "asc" ? "desc" : "asc");
    } else {
      setSearchSortField(field);
      setSearchSortDirection("desc");
    }
  };

  const resetFilters = () => {
    setDateFrom("");
    setDateTo("");
    setSearchTerm("");
    setStatusFilter("All");
    setRequestTypeFilter("All");
    setTransportationFilter("All");
    setDestinationFilter("All");
    setPage(1);
    setSearchSortField("date");
    setSearchSortDirection("desc");
    setShowCostByTransportation(false);
    setPeriodPreset("custom");
  };

  const handlePeriodChange = (from: string, to: string) => {
    setDateFrom(from);
    setDateTo(to);
    setPage(1);
  };

  const header = (field: SortField, title: string) => (
    <button
      className="inline-flex items-center gap-1 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500 transition hover:text-orange-600"
      onClick={() => onSort(field)}
      type="button"
    >
      <span>{title}</span>
      <span className="text-[9px] opacity-60">
        {searchSortField === field ? (searchSortDirection === "desc" ? "▼" : "▲") : "↕"}
      </span>
    </button>
  );

  /* -------- CSV export -------- */
  const exportCsv = () => {
    if (typeof window === "undefined" || sortedTrips.length === 0) return;
    const escape = (raw: string | number) => {
      const value = String(raw ?? "");
      if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
      return value;
    };
    const headers = [
      "TripID",
      "Date",
      "ToDate",
      "RequestType",
      "From",
      "To",
      "Total (EGP)",
      "Travel Cost",
      "Meeting Amount",
      "Allowance",
      "KM",
      "Status",
      "Transport",
      "Description",
      "HR Notes",
    ];
    const lines = [headers.join(",")];
    for (const trip of sortedTrips) {
      lines.push(
        [
          escape(trip.tripId),
          escape(trip.date),
          escape(trip.toDate),
          escape(trip.requestType),
          escape(trip.fromCity),
          escape(trip.toCity),
          escape(trip.total),
          escape(trip.travelCost),
          escape(trip.meetingAmount),
          escape(trip.allowance),
          escape(trip.km),
          escape(mapStatusCategory(trip.status)),
          escape(trip.transportationType),
          escape(trip.description),
          escape(trip.hrNotes),
        ].join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `expense-trips-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  /* -------- table density classes -------- */
  const cellPaddingClass = density === "compact" ? "px-2 py-1.5" : "px-3 py-2.5";

  if (!rows.length) {
    return (
      <Card className={`overflow-hidden rounded-lg border border-gray-100 ${cardShadow}`}>
        <EmptyState title="No expense records" message="No expense records are linked to your profile yet." />
      </Card>
    );
  }

  /* -------- render -------- */
  return (
    <div className="space-y-5" dir="auto">
      <style dangerouslySetInnerHTML={{ __html: printStyles }} />

      {showHero && (
        <section className="relative overflow-hidden rounded border border-slate-800 bg-[linear-gradient(135deg,#070707_0%,#111827_52%,#2C1605_100%)] p-5 sm:p-6 lg:p-8">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-orange-300">
            EXPENSES
          </p>
          <h1 className="mt-2 text-2xl font-bold text-white sm:text-3xl">Expense Dashboard</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-slate-300">
            Track your personal trips, expenses, approvals, and workload from one clean view.
          </p>
        </section>
      )}

      {/* ---- KPI Stat Cards ---- */}
      <Card className={`overflow-hidden rounded-lg border border-gray-100 p-0 print:break-inside-avoid ${cardShadow}`}>
        <div className="grid grid-cols-2 divide-x divide-y divide-gray-100 sm:grid-cols-3 xl:grid-cols-5">
          <StatCard
            accent="border-l-emerald-400"
            helper="Sum of Total for this period"
            label="Total Expenses"
            value={formatMoney(totalExpenses)}
          />
          <StatCard
            accent="border-l-sky-400"
            helper={`${filteredTrips.length} filtered records`}
            label="Total Trips"
            value={totalTrips.toLocaleString()}
          />
          <StatCard
            accent="border-l-orange-400"
            helper="Total expenses / total trips"
            label="Avg Cost per Trip"
            value={formatMoney(averageCostPerTrip)}
          />
          <StatCard
            accent="border-l-amber-400"
            helper="Sum of KM travelled"
            label="Total KM"
            value={formatKm(totalKm)}
          />
          <StatCard
            accent="border-l-slate-400"
            delta={tripsDeltaPercent ?? undefined}
            helper={`${tripsThisMonth} this month vs ${tripsLastMonth} last month`}
            label="Month over Month"
            value={tripsThisMonth.toLocaleString()}
          />
        </div>
      </Card>

      {/* ---- Admin Key Cards (NSM/DSM scope) ---- */}
      {adminKeyCards && (
        <Card className={`overflow-hidden rounded-lg border border-gray-100 p-0 print:break-inside-avoid ${cardShadow}`}>
          <div className="grid grid-cols-1 divide-x divide-y divide-gray-100 sm:grid-cols-3">
            <AdminKeyCard
              accent="border-l-orange-400"
              helper={adminKeyCards.payrollBatchLabel || "Latest batch"}
              label="Payroll Eligible"
              value={adminKeyCards.payrollEligibleCount.toLocaleString("en-US")}
            />
            <AdminKeyCard
              accent="border-l-sky-400"
              helper={`vs ${formatMoney(adminKeyCards.totalSalesTarget)} target`}
              label="Total Sales"
              value={formatMoney(adminKeyCards.totalSalesValue)}
            />
            <AdminKeyCard
              accent="border-l-amber-400"
              helper={`${adminKeyCards.expenseClaimsEntries.toLocaleString("en-US")} entries`}
              label="Expense Claims"
              value={formatMoney(adminKeyCards.expenseClaimsAmount)}
            />
          </div>
        </Card>
      )}

      {/* ---- Insights Strip (NEW) ---- */}
      {(insights.top || insights.outlier || insights.costPerKm > 0) && (
        <Card className={`overflow-hidden rounded-lg border border-gray-100 p-0 print:break-inside-avoid ${cardShadow}`}>
          <div className="grid grid-cols-1 divide-x divide-y divide-gray-100 sm:grid-cols-3">
            <div className="px-4 py-3">
              <p className={labelClass}>Top destination</p>
              <p className="mt-1 truncate text-sm font-bold text-slate-800">
                {insights.top?.city ?? "—"}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {insights.top
                  ? `${insights.top.trips} trips · ${formatMoney(insights.top.total)}`
                  : "No data"}
              </p>
            </div>
            <div className="px-4 py-3">
              <p className={labelClass}>Cost outlier</p>
              <p className="mt-1 truncate text-sm font-bold text-slate-800">
                {insights.outlier
                  ? `${insights.outlier.tripId || "Trip"} → ${insights.outlier.toCity}`
                  : "—"}
              </p>
              <p className="mt-0.5 text-[11px] text-rose-600">
                {insights.outlier ? formatMoney(insights.outlier.total) : "No outliers detected"}
              </p>
            </div>
            <div className="px-4 py-3">
              <p className={labelClass}>Cost efficiency</p>
              <p className="mt-1 text-sm font-bold text-slate-800">
                {insights.costPerKm > 0 ? `${formatMoney(insights.costPerKm)}/km` : "—"}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                Average spend per kilometer
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* ---- Filters Card with Smart Period ---- */}
      <Card className={`overflow-hidden rounded-lg border border-gray-100 p-4 sm:p-5 print:hidden ${cardShadow}`}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <span className="rounded-md bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-600">
            Filters
          </span>
          <button
            aria-label="Reset all expense filters"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 text-[12px] font-semibold text-slate-600 shadow-sm transition hover:border-orange-200 hover:text-orange-600"
            onClick={resetFilters}
            type="button"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reset
          </button>
        </div>

        <SmartPeriodFilter
          dateFrom={dateFrom}
          dateTo={dateTo}
          onChange={handlePeriodChange}
          preset={periodPreset}
          setPreset={setPeriodPreset}
        />

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="min-w-0">
            <span className={labelClass}>Status</span>
            <select
              aria-label="Filter by status"
              className={`${inputClass} mt-1.5`}
              onChange={(event) => setStatusFilter(event.target.value as (typeof statusOptions)[number])}
              value={statusFilter}
            >
              {statusFilterOptions.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className={labelClass}>Request type</span>
            <select
              aria-label="Filter by request type"
              className={`${inputClass} mt-1.5`}
              onChange={(event) => setRequestTypeFilter(event.target.value)}
              value={requestTypeFilter}
            >
              {uniqueRequestTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className={labelClass}>Transportation</span>
            <select
              aria-label="Filter by transportation type"
              className={`${inputClass} mt-1.5`}
              onChange={(event) => setTransportationFilter(event.target.value)}
              value={transportationFilter}
            >
              {uniqueTransportationTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className={labelClass}>Destination</span>
            <select
              aria-label="Filter by destination city"
              className={`${inputClass} mt-1.5`}
              onChange={(event) => setDestinationFilter(event.target.value)}
              value={destinationFilter}
            >
              {uniqueDestinations.map((destination) => (
                <option key={destination} value={destination}>
                  {destination}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      {/* ---- Charts Row 1: Monthly trend + Category ---- */}
      <section className="grid gap-4 print:break-inside-avoid xl:grid-cols-2">
        <ChartCard
          description="Expense flow with trip volume overlay"
          title="Monthly Expense Trend"
        >
          <div className="h-64">
            {monthlyTrend.length === 0 ? (
              <EmptyState title="No trend data" message="No monthly data available for selected filters." />
            ) : (
              <SafeResponsiveContainer className="h-full">
                <ComposedChart data={monthlyTrend} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="month" stroke="#94a3b8" style={{ fontSize: 11 }} />
                  <YAxis
                    style={{ fontSize: 11 }}
                    stroke="#94a3b8"
                    tickFormatter={(value) => formatMoney(Number(value))}
                    width={70}
                    yAxisId="expense"
                  />
                  <YAxis
                    orientation="right"
                    stroke="#94a3b8"
                    style={{ fontSize: 11 }}
                    width={30}
                    yAxisId="trips"
                  />
                  <Tooltip
                    contentStyle={chartTooltipStyle()}
                    formatter={(value, name) => {
                      if (name === "expense") return [formatMoney(Number(value)), "Spend"];
                      if (name === "trips") return [Number(value).toLocaleString(), "Trips"];
                      return [String(value), String(name)];
                    }}
                    labelFormatter={(label) => `${label}`}
                  />
                  <ReferenceLine y={0} stroke="#e2e8f0" yAxisId="expense" />
                  <Bar dataKey="expense" radius={[2, 2, 0, 0]} yAxisId="expense">
                    {monthlyTrend.map((row) => (
                      <Cell key={row.period} fill={spendColorForValue(row.expense, monthlyTrendMax)} />
                    ))}
                  </Bar>
                  <Line
                    dataKey="trips"
                    dot={{ fill: "#0f172a", r: 3 }}
                    name="trips"
                    stroke="#0f172a"
                    strokeWidth={2}
                    yAxisId="trips"
                  />
                </ComposedChart>
              </SafeResponsiveContainer>
            )}
          </div>
        </ChartCard>

        <ChartCard
          description="Travel cost, meeting amount, and allowance"
          title="Expense Breakdown by Category"
        >
          <div className="h-64">
            {categoryBreakdown.total <= 0 ? (
              <EmptyState title="No category data" message="No expense category amounts available." />
            ) : (
              <div className="relative h-full">
                <SafeResponsiveContainer className="h-full">
                  <PieChart>
                    <Pie
                      cx="50%"
                      cy="50%"
                      data={categoryBreakdown.data}
                      dataKey="value"
                      innerRadius={60}
                      outerRadius={90}
                      paddingAngle={2}
                    >
                      {categoryBreakdown.data.map((entry) => (
                        <Cell fill={entry.color} key={entry.name} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={chartTooltipStyle()}
                      formatter={(value: unknown) => formatMoney(Number(value))}
                    />
                  </PieChart>
                </SafeResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="text-center">
                    <p className={labelClass}>Total</p>
                    <p className="text-sm font-bold text-slate-900">
                      {formatMoney(categoryBreakdown.total)}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px]">
            {categoryBreakdown.data.map((entry) => (
              <span className="inline-flex items-center gap-1.5 text-slate-600" key={entry.name}>
                <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: entry.color }} />
                {entry.name}: <strong className="text-slate-800">{formatMoney(entry.value)}</strong>
              </span>
            ))}
          </div>
        </ChartCard>
      </section>

      {/* ---- Charts Row 2: Status + Transportation ---- */}
      <section className="grid gap-4 print:break-inside-avoid xl:grid-cols-2">
        <ChartCard
          description="Approval pipeline at a glance"
          title="Trip Status Distribution"
        >
          {statusDistribution.length === 0 ? (
            <EmptyState title="No trips" message="No trip status records available." />
          ) : (
            <div className="space-y-2">
              {statusDistribution.map((status) => {
                const total = statusDistribution.reduce((s, x) => s + x.value, 0);
                const pct = total > 0 ? Math.round((status.value / total) * 100) : 0;
                return (
                  <div key={status.name}>
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="inline-flex items-center gap-2 font-medium text-slate-700">
                        <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: status.color }} />
                        {status.name}
                      </span>
                      <span className="font-bold text-slate-800">
                        {status.value} · {pct}%
                      </span>
                    </div>
                    <div
                      aria-label={`${status.name}: ${pct}%`}
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={pct}
                      className="mt-1 h-1.5 overflow-hidden rounded-sm bg-slate-100"
                      role="progressbar"
                    >
                      <div className="h-full rounded-sm" style={{ width: `${pct}%`, backgroundColor: status.color }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ChartCard>

        <ChartCard
          action={
            <button
              className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:border-orange-200 hover:text-orange-600"
              onClick={() => setShowCostByTransportation((prev) => !prev)}
              type="button"
            >
              {showCostByTransportation ? "Show trip count" : "Show total cost"}
            </button>
          }
          description={
            showCostByTransportation
              ? "Total cost per transportation type"
              : "Trip count by transportation type"
          }
          title="Trips by Transportation"
        >
          <div className="h-64">
            {transportationSummary.length === 0 ? (
              <EmptyState title="No transport data" message="No transportation records available." />
            ) : (
              <SafeResponsiveContainer className="h-full">
                <BarChart data={transportationSummary} layout="vertical" margin={{ top: 8, right: 8, left: 4, bottom: 8 }}>
                  <CartesianGrid horizontal={false} stroke="#f1f5f9" />
                  <XAxis
                    stroke="#94a3b8"
                    style={{ fontSize: 11 }}
                    tickFormatter={(value) =>
                      showCostByTransportation ? formatMoney(Number(value)) : String(value)
                    }
                    type="number"
                  />
                  <YAxis
                    dataKey="name"
                    stroke="#94a3b8"
                    style={{ fontSize: 11 }}
                    type="category"
                    width={100}
                  />
                  <Tooltip
                    contentStyle={chartTooltipStyle()}
                    formatter={(value: unknown, key) => {
                      if (key === "total") return [formatMoney(Number(value)), "Spend"];
                      return [String(value), "Trips"];
                    }}
                  />
                  <Bar
                    dataKey={showCostByTransportation ? "total" : "trips"}
                    radius={[0, 2, 2, 0]}
                  >
                    {transportationSummary.map((row) => {
                      const value = showCostByTransportation ? row.total : row.trips;
                      const max = showCostByTransportation ? transportationTotalMax : transportationTripsMax;
                      return <Cell key={row.name} fill={spendColorForValue(value, max)} />;
                    })}
                  </Bar>
                </BarChart>
              </SafeResponsiveContainer>
            )}
          </div>
        </ChartCard>
      </section>

      {/* ---- Charts Row 3: Destinations + Workload ---- */}
      <section className="grid gap-4 print:break-inside-avoid xl:grid-cols-2">
        <ChartCard
          description="Top 8 destinations by spend (degrading insight color)"
          title="Trips by Destination City"
        >
          <div className="h-64">
            {destinationSummary.length === 0 ? (
              <EmptyState title="No destination data" message="No destination records available." />
            ) : (
              <SafeResponsiveContainer className="h-full">
                <BarChart data={destinationSummary} layout="vertical" margin={{ top: 8, right: 8, left: 4, bottom: 8 }}>
                  <CartesianGrid horizontal={false} stroke="#f1f5f9" />
                  <XAxis
                    stroke="#94a3b8"
                    style={{ fontSize: 11 }}
                    tickFormatter={(value) => new Intl.NumberFormat("en-US").format(Number(value))}
                    type="number"
                  />
                  <YAxis
                    dataKey="city"
                    interval={0}
                    minTickGap={16}
                    stroke="#94a3b8"
                    style={{ fontSize: 11 }}
                    type="category"
                    width={130}
                  />
                  <Tooltip
                    contentStyle={chartTooltipStyle()}
                    formatter={(value, name) =>
                      name === "total"
                        ? [formatMoney(Number(value)), "Spend"]
                        : [Number(value).toLocaleString(), "Trips"]
                    }
                  />
                  <Bar dataKey="trips" radius={[0, 2, 2, 0]}>
                    {destinationSummary.map((row) => (
                      <Cell key={row.city} fill={spendColorForValue(row.trips, destinationTripsMax)} />
                    ))}
                  </Bar>
                </BarChart>
              </SafeResponsiveContainer>
            )}
          </div>
        </ChartCard>

        <ChartCard description="AM / PM visit balance and totals" title="Workload Summary">
          {!hasWorkloadData ? (
            <EmptyState
              title="No workload data"
              message="Workload data is not available for this period."
            />
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 divide-x divide-gray-100 border-y border-gray-100 sm:grid-cols-4">
                <div className="px-3 py-3">
                  <p className={labelClass}>AM visits</p>
                  <p className="mt-1 text-base font-bold text-slate-800">
                    {Math.round(totalAmWorkload).toLocaleString()}
                  </p>
                </div>
                <div className="px-3 py-3">
                  <p className={labelClass}>PM visits</p>
                  <p className="mt-1 text-base font-bold text-slate-800">
                    {Math.round(totalPmWorkload).toLocaleString()}
                  </p>
                </div>
                <div className="px-3 py-3">
                  <p className={labelClass}>Total visits</p>
                  <p className="mt-1 text-base font-bold text-slate-800">
                    {(totalAmWorkload + totalPmWorkload).toLocaleString()}
                  </p>
                </div>
                <div className="px-3 py-3">
                  <p className={labelClass}>Avg / trip</p>
                  <p className="mt-1 text-base font-bold text-slate-800">
                    {averageWorkloadPerTrip.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                  </p>
                </div>
              </div>
              <div className="h-44">
                <SafeResponsiveContainer className="h-full">
                  <BarChart data={workloadChartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="name" stroke="#94a3b8" style={{ fontSize: 11 }} />
                    <YAxis stroke="#94a3b8" style={{ fontSize: 11 }} width={40} />
                    <Tooltip
                      contentStyle={chartTooltipStyle()}
                      formatter={(value) => Number(value).toLocaleString()}
                    />
                    <Bar dataKey="value" radius={[2, 2, 0, 0]}>
                      {workloadChartData.map((row) => (
                        <Cell fill={row.color} key={row.name} />
                      ))}
                    </Bar>
                  </BarChart>
                </SafeResponsiveContainer>
              </div>
            </div>
          )}
        </ChartCard>
      </section>

      {/* ---- Trip Ledger ---- */}
      <section className="space-y-3 print:break-inside-avoid">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <span className="rounded-md bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-600">
              Trip ledger
            </span>
            <h2 className="mt-1.5 text-sm font-bold text-slate-800">Detailed Trip Table</h2>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {/* Density toggle */}
            <div
              aria-label="Table density"
              className="inline-flex items-center gap-0.5 rounded-md border border-gray-200 bg-slate-50 p-0.5 print:hidden"
              role="group"
            >
              <button
                aria-pressed={density === "comfortable"}
                className={`rounded-sm px-2 py-1 text-[11px] font-semibold transition ${
                  density === "comfortable"
                    ? "bg-white text-slate-800 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
                onClick={() => setDensity("comfortable")}
                type="button"
              >
                Comfortable
              </button>
              <button
                aria-pressed={density === "compact"}
                className={`rounded-sm px-2 py-1 text-[11px] font-semibold transition ${
                  density === "compact"
                    ? "bg-white text-slate-800 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
                onClick={() => setDensity("compact")}
                type="button"
              >
                Compact
              </button>
            </div>
            {/* CSV export */}
            <button
              aria-label="Export trips to CSV"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 text-[12px] font-semibold text-slate-600 shadow-sm transition hover:border-orange-200 hover:text-orange-600 disabled:opacity-40 print:hidden"
              disabled={sortedTrips.length === 0}
              onClick={exportCsv}
              type="button"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
            <label className="relative w-full sm:w-64">
              <span className="sr-only">Search trips</span>
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                aria-label="Search trips"
                className={`${inputClass} pl-9`}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search trips..."
                value={searchTerm}
              />
            </label>
          </div>
        </div>

        <Card className={`overflow-hidden rounded-lg border border-gray-100 ${cardShadow}`}>
          {/* Desktop / wide tablet table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-[1100px] w-full text-left text-sm">
              <thead className="border-b border-gray-100 bg-slate-50/60">
                <tr>
                  <th className={cellPaddingClass}>{header("tripId", "TripID")}</th>
                  <th className={cellPaddingClass}>{header("date", "Date")}</th>
                  <th className={cellPaddingClass}>{header("requestType", "Type")}</th>
                  <th className={cellPaddingClass}>{header("fromCity", "From")}</th>
                  <th className={cellPaddingClass}>{header("toCity", "To")}</th>
                  <th className={`${cellPaddingClass} text-right`}>{header("total", "Total")}</th>
                  <th className={`${cellPaddingClass} text-right`}>{header("km", "KM")}</th>
                  <th className={cellPaddingClass}>{header("status", "Status")}</th>
                  <th className={cellPaddingClass}>{header("transportationType", "Transport")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {pagedTrips.length === 0 ? (
                  <tr>
                    <td className="px-3 py-8 text-center text-sm text-slate-400" colSpan={9}>
                      No trips match your filters.
                    </td>
                  </tr>
                ) : (
                  pagedTrips.map((trip) => {
                    const category = mapStatusCategory(trip.status);
                    return (
                      <tr
                        className="transition hover:bg-orange-50/40"
                        key={`${trip.tripId}-${trip.date}-${trip.requestType}`}
                      >
                        <td className={`whitespace-nowrap font-mono text-[11px] font-semibold text-slate-600 ${cellPaddingClass}`}>
                          {trip.tripId || "N/A"}
                        </td>
                        <td className={`whitespace-nowrap text-[12px] text-slate-700 ${cellPaddingClass}`}>
                          {formatDate(trip.date)}
                        </td>
                        <td className={`whitespace-nowrap text-[12px] text-slate-700 ${cellPaddingClass}`}>
                          {trip.requestType || "N/A"}
                        </td>
                        <td className={`whitespace-nowrap text-[12px] font-semibold text-slate-800 ${cellPaddingClass}`}>
                          {trip.fromCity || "Unknown"}
                        </td>
                        <td className={`whitespace-nowrap text-[12px] font-semibold text-slate-800 ${cellPaddingClass}`}>
                          {trip.toCity || "Unknown"}
                        </td>
                        <td className={`whitespace-nowrap text-right text-[12px] font-bold text-slate-900 ${cellPaddingClass}`}>
                          {formatMoney(trip.total)}
                        </td>
                        <td className={`whitespace-nowrap text-right text-[12px] text-slate-700 ${cellPaddingClass}`}>
                          {formatKm(trip.km)}
                        </td>
                        <td className={cellPaddingClass}>
                          <Badge variant={statusVariant(category)}>{category}</Badge>
                        </td>
                        <td className={`whitespace-nowrap text-[12px] text-slate-700 ${cellPaddingClass}`}>
                          {trip.transportationType || "N/A"}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile / narrow tablet stacked cards (< md ~ < 768px) */}
          <div className="space-y-2 p-3 md:hidden">
            {pagedTrips.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-slate-500">
                No trips match your filters.
              </p>
            ) : (
              pagedTrips.map((trip) => {
                const category = mapStatusCategory(trip.status);
                return (
                  <div
                    className="relative overflow-hidden rounded-md border border-gray-100 bg-white"
                    key={`${trip.tripId}-${trip.date}-mobile`}
                  >
                    <div className="absolute inset-y-0 left-0 w-[3px] bg-orange-400" />
                    <div className="px-3 py-3 pl-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-mono text-[11px] font-bold text-slate-600">
                            {trip.tripId || "N/A"}
                          </p>
                          <p className="mt-0.5 text-[11px] text-slate-500">
                            {formatDate(trip.date)}
                            {trip.toDate ? ` → ${formatDate(trip.toDate)}` : ""}
                          </p>
                        </div>
                        <Badge variant={statusVariant(category)}>{category}</Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-600">
                        <span className="rounded-sm bg-slate-100 px-1.5 py-0.5 font-semibold">
                          {trip.fromCity || "?"} → {trip.toCity || "?"}
                        </span>
                        {trip.requestType && (
                          <span className="rounded-sm bg-slate-100 px-1.5 py-0.5">
                            {trip.requestType}
                          </span>
                        )}
                        {trip.transportationType && (
                          <span className="rounded-sm bg-slate-100 px-1.5 py-0.5">
                            {trip.transportationType}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2 border-t border-gray-100 pt-2 text-[11px]">
                        <div>
                          <p className="text-slate-500">Total</p>
                          <p className="font-bold text-slate-900">{formatMoney(trip.total)}</p>
                        </div>
                        <div>
                          <p className="text-slate-500">KM</p>
                          <p className="font-semibold text-slate-800">{formatKm(trip.km)}</p>
                        </div>
                        <div>
                          <p className="text-slate-500">Travel</p>
                          <p className="font-semibold text-slate-800">
                            {formatMoney(trip.travelCost)}
                          </p>
                        </div>
                        <div>
                          <p className="text-slate-500">Meeting</p>
                          <p className="font-semibold text-slate-800">
                            {formatMoney(trip.meetingAmount)}
                          </p>
                        </div>
                        <div>
                          <p className="text-slate-500">Allowance</p>
                          <p className="font-semibold text-slate-800">
                            {formatMoney(trip.allowance)}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Pagination footer */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 bg-slate-50/60 px-3 py-2">
            <p className="text-[11px] font-semibold text-slate-500">
              {sortedTrips.length === 0 ? "No records" : `Showing ${pageSummary}`}
            </p>
            <div className="flex items-center gap-3">
              {/* Page size selector — useful past ~200 records */}
              <label className="flex items-center gap-1.5 text-[11px] text-slate-500 print:hidden">
                <span>Rows</span>
                <select
                  aria-label="Rows per page"
                  className="h-7 rounded-md border border-gray-200 bg-white px-1.5 text-[11px] font-semibold text-slate-700 outline-none focus:border-orange-300"
                  onChange={(event) => {
                    setPageSize(Number(event.target.value) as 10 | 25 | 50 | 100);
                    setPage(1);
                  }}
                  value={pageSize}
                >
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </label>
              <div className="flex items-center gap-2">
                <button
                  aria-label="Previous page"
                  className="rounded-md border border-gray-200 bg-white p-1.5 text-slate-600 transition hover:border-orange-200 hover:text-orange-600 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={safePage <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  type="button"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="text-[11px] font-bold text-slate-700">
                  {safePage} / {totalPages}
                </span>
                <button
                  aria-label="Next page"
                  className="rounded-md border border-gray-200 bg-white p-1.5 text-slate-600 transition hover:border-orange-200 hover:text-orange-600 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                  type="button"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}
