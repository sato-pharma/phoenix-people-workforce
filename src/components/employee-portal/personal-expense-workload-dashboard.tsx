"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Cell,
  ReferenceLine,
} from "recharts";

import { ChevronLeft, ChevronRight, Filter, Search, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { normalizeHrId, normalizeHrIdForAccess } from "@/lib/auth/permissions";
import type { MedicalRepPortalData } from "@/lib/employee-portal/service";

type ExpenseRow = {
  hrId: string;
  tripId: string;
  date: string;
  toDate: string;
  requestType: string;
  from: string;
  to: string;
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

const BRAND = {
  bg: "#FFF7ED",
  card: "#FFFFFF",
  border: "#FED7AA",
  textPrimary: "#0F172A",
  textMuted: "#64748B",
  primary: "#F97316",
  success: "#22C55E",
  warning: "#F59E0B",
  error: "#EF4444",
};

const premiumCardClass =
  "rounded-[28px] border border-orange-100/80 bg-white/94 shadow-[0_22px_58px_rgba(15,23,42,0.08)] ring-1 ring-slate-950/[0.03] backdrop-blur";

const premiumControlClass =
  "h-11 w-full rounded-2xl border border-orange-100 bg-white/95 px-3 text-sm text-slate-800 shadow-[0_12px_30px_rgba(15,23,42,0.05)] outline-none transition focus:border-orange-300 focus:ring-4 focus:ring-orange-100";

const chartPanelClass =
  "rounded-[28px] border border-orange-100/80 bg-white/96 p-5 shadow-[0_22px_60px_rgba(15,23,42,0.08)] ring-1 ring-slate-950/[0.03]";

const statusOptions = ["All", "System Approval", "Pending", "Declined", "Confirmed by HR", "Other"] as const;
type SortField =
  | "date"
  | "tripId"
  | "toDate"
  | "requestType"
  | "total"
  | "travelCost"
  | "meetingAmount"
  | "allowance"
  | "km"
  | "status"
  | "transportationType";

type SortDirection = "asc" | "desc";

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
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function normalizeString(value: string | null | undefined) {
  return (value || "").trim();
}

function monthLabel(period: string) {
  const [yearText, monthText] = period.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!year || !month) return period;
  return new Intl.DateTimeFormat("en", { month: "short", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, 1)));
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
  const normalized = normalizeString(value).replace(/\s+/g, " ");
  if (!normalized) return "";

  const text = normalized
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const base = text
    .split("|")[0]
    .split(",")[0]
    .split("→")[0]
    .split(" to ")[0]
    .split(" To ")[0]
    .split(" - ")[0]
    .split(" – ")[0]
    .split(" — ")[0]
    .split("/")[0]
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
  if (/[\\u0600-\\u06FF]/.test(base)) return base;

  return base
    .toLowerCase()
    .split(" ")
    .map((part) => {
      if (!part) return part;
      if (part.length <= 1) return part;
      return `${part[0].toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function extractDestination(to: string, fallback: string) {
  const fromTo = normalizeCityName(to || "");
  const fromFallback = normalizeCityName(fallback || "");
  return fromTo || fromFallback || "Unknown";
}

function chartTooltipStyle() {
  return {
    background: "rgba(255,255,255,0.98)",
    border: "1px solid #fed7aa",
    borderRadius: 16,
    boxShadow: "0 18px 44px rgba(15,23,42,0.12)",
  };
}

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <Card className={`${premiumCardClass} p-8 text-center`}>
      <p className="text-sm font-black uppercase tracking-[0.18em] text-orange-600">{title}</p>
      <p className="mt-2 text-sm font-medium text-slate-600">{message}</p>
    </Card>
  );
}

function DashboardCard({
  delta,
  helper,
  label,
  value,
}: {
  delta?: number;
  helper?: string;
  label: string;
  value: string;
}) {
  const showDelta = delta === undefined ? "" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
  const isPositive = delta === undefined ? false : delta >= 0;
  return (
    <Card className="group relative overflow-hidden rounded-[26px] border border-orange-100/80 bg-white/95 p-5 shadow-[0_18px_45px_rgba(15,23,42,0.07)] ring-1 ring-slate-950/[0.03] transition hover:-translate-y-1 hover:shadow-[0_24px_60px_rgba(249,115,22,0.13)]">
      <div className="absolute -right-8 -top-10 h-24 w-24 rounded-full bg-orange-100/70 blur-2xl transition group-hover:bg-orange-200/80" />
      <p className="relative text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="relative mt-3 text-2xl font-black text-slate-950" style={{ color: BRAND.textPrimary }}>
        {value}
      </p>
      {helper ? <p className="relative mt-1 text-xs font-medium text-slate-500">{helper}</p> : null}
      {delta === undefined ? null : (
        <span className={`relative mt-3 inline-block rounded-full px-2.5 py-1 text-xs font-bold ${isPositive ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
          {showDelta}
        </span>
      )}
    </Card>
  );
}

export function PersonalExpenseWorkloadDashboard({ data }: { data: MedicalRepPortalData }) {
  const currentEmployeeHrId = normalizeHrId(data.employee?.hrId);
  const currentEmployeeCanonicalHrId = currentEmployeeHrId ? normalizeHrIdForAccess(currentEmployeeHrId) : null;

  const rows: ExpenseRow[] = useMemo(() => {
    const source = (data.workload?.expenseRows ?? []).filter((expense) => {
      if (!currentEmployeeHrId) return true;
      const expenseHrId = normalizeHrId(expense.hrId);
      if (!expenseHrId) return false;
      if (expenseHrId === currentEmployeeHrId) return true;
      const expenseCanonical = normalizeHrIdForAccess(expenseHrId);
      return Boolean(currentEmployeeCanonicalHrId && expenseCanonical && expenseCanonical === currentEmployeeCanonicalHrId);
    });

    return source.map((expense) => ({
      hrId: normalizeString(expense.hrId),
      tripId: normalizeString(expense.tripId),
      date: normalizeString(expense.date),
      toDate: normalizeString(expense.toDate),
      requestType: normalizeString(expense.requestType),
      from: normalizeString(expense.from),
      to: normalizeString(expense.to),
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

  const [searchTerm, setSearchTerm] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [statusFilter, setStatusFilter] = useState<(typeof statusOptions)[number]>("All");
  const [requestTypeFilter, setRequestTypeFilter] = useState("All");
  const [transportationFilter, setTransportationFilter] = useState("All");
  const [destinationFilter, setDestinationFilter] = useState("All");
  const [showCostByTransportation, setShowCostByTransportation] = useState(false);
  const [page, setPage] = useState(1);
  const [searchSortField, setSearchSortField] = useState<SortField>("date");
  const [searchSortDirection, setSearchSortDirection] = useState<SortDirection>("desc");

  const uniqueRequestTypes = useMemo(
    () => ["All", ...Array.from(new Set(rows.map((row) => normalizeString(row.requestType)).filter(Boolean)).values()).sort()],
    [rows],
  );

  const uniqueTransportationTypes = useMemo(
    () => [
      "All",
      ...Array.from(new Set(rows.map((row) => normalizeString(row.transportationType)).filter(Boolean)).values()).sort(),
    ],
    [rows],
  );

  const uniqueDestinations = useMemo(
    () => ["All", ...Array.from(new Set(rows.map((row) => row.destinationCity)).values())].filter(Boolean).sort(),
    [rows],
  );

  const statusFilterOptions = useMemo(() => ["All", ...statusOptions.filter((status) => status !== "All")], []);

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
        const searchable = `${trip.tripId} ${trip.requestType} ${trip.from} ${trip.to} ${trip.status} ${trip.transportationType} ${trip.description} ${trip.hrNotes} ${trip.destinationCity}`.toLowerCase();
        if (!searchable.includes(lowerSearch)) return false;
      }
      return true;
    });
  }, [rows, dateFrom, dateTo, statusFilter, requestTypeFilter, transportationFilter, destinationFilter, searchTerm]);

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
      if (searchSortField === "total" || searchSortField === "travelCost" || searchSortField === "meetingAmount" || searchSortField === "allowance" || searchSortField === "km") {
        const numericField = searchSortField as "total" | "travelCost" | "meetingAmount" | "allowance" | "km";
        return (left[numericField] - right[numericField]) * factor;
      }

      const leftValue = normalizeString(left[searchSortField as "tripId" | "requestType" | "status" | "transportationType"]).toLowerCase();
      const rightValue = normalizeString(right[searchSortField as "tripId" | "requestType" | "status" | "transportationType"]).toLowerCase();
      return leftValue.localeCompare(rightValue) * factor;
    });
    return mutableTrips;
  }, [filteredTrips, searchSortField, searchSortDirection]);

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
        { name: "Travel Cost", value: travel },
        { name: "Meeting Amount", value: meeting },
        { name: "Allowance", value: allowance },
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
        color:
          status === "Confirmed by HR"
            ? BRAND.success
            : status === "Pending" || status === "System Approval"
              ? BRAND.warning
              : status === "Declined"
                ? BRAND.error
                : "#64748B",
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

  const hasWorkloadData = data.workload?.hasWorkloadFields ?? false;
  const totalAmWorkload = filteredTrips.reduce((sum, row) => sum + row.amWorkload, 0);
  const totalPmWorkload = filteredTrips.reduce((sum, row) => sum + row.pmWorkload, 0);
  const workloadTripCount = filteredTrips.length;
  const averageWorkloadPerTrip = workloadTripCount > 0 ? (totalAmWorkload + totalPmWorkload) / workloadTripCount : 0;

  const workloadChartData = [
    { name: "AM", value: totalAmWorkload },
    { name: "PM", value: totalPmWorkload },
  ];

  const destinationAxisWidth = useMemo(() => {
    const maxNameLength = destinationSummary.reduce((max, item) => Math.max(max, item.city.length), 0);
    const approximateWidth = Math.min(190, Math.max(120, Math.min(240, maxNameLength * 8 + 10)));
    return approximateWidth;
  }, [destinationSummary]);

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(sortedTrips.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedTrips = sortedTrips.slice((safePage - 1) * pageSize, safePage * pageSize);

  const pageSummary = `${(safePage - 1) * pageSize + 1}-${Math.min(safePage * pageSize, sortedTrips.length)} of ${sortedTrips.length}`;

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
  };

  const header = (field: SortField, title: string) => (
    <button className="inline-flex items-center gap-1 text-left text-[11px] font-black uppercase tracking-[0.14em] text-slate-500 transition hover:text-orange-600" type="button" onClick={() => onSort(field)}>
      <span>{title}</span>
      {searchSortField === field ? (searchSortDirection === "desc" ? "▼" : "▲") : "↕"}
    </button>
  );

  if (!rows.length) {
    return <EmptyState title="No expense records" message="No expense records are linked to your profile yet." />;
  }

  return (
    <div className="space-y-6 text-slate-950">
      <section className="relative overflow-hidden rounded-[30px] border border-orange-100 bg-[linear-gradient(135deg,#fff7ed_0%,#ffffff_46%,#fff1e6_100%)] p-6 shadow-[0_24px_70px_rgba(15,23,42,0.08)]">
        <div className="absolute -right-16 -top-20 h-48 w-48 rounded-full bg-orange-200/45 blur-3xl" />
        <div className="absolute -bottom-20 left-10 h-40 w-40 rounded-full bg-amber-100/60 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="inline-flex rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-[11px] font-black uppercase tracking-[0.18em] text-orange-600">
              Personal expense command
            </span>
            <h1 className="mt-4 text-3xl font-black tracking-tight text-slate-950 md:text-4xl">Expense Dashboard</h1>
            <p className="mt-2 max-w-2xl text-sm font-medium text-slate-600">
              Track your personal trips, expenses, approvals, and workload from one clean view.
            </p>
          </div>
          <div className="rounded-2xl border border-white/80 bg-white/80 px-4 py-3 text-right shadow-[0_14px_35px_rgba(15,23,42,0.07)]">
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">Filtered spend</p>
            <p className="mt-1 text-2xl font-black text-orange-600">{formatMoney(totalExpenses)}</p>
          </div>
        </div>
      </section>

      <Card className={`${premiumCardClass} p-4 md:p-5`}>
        <div className="mb-1 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Filter by date</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-[11px] font-bold text-slate-500">Date From</span>
                <input
                  className={premiumControlClass}
                  onChange={(event) => setDateFrom(event.target.value)}
                  type="date"
                  value={dateFrom}
                />
              </label>
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-[11px] font-bold text-slate-500">Date To</span>
                <input
                  className={premiumControlClass}
                  onChange={(event) => setDateTo(event.target.value)}
                  type="date"
                  value={dateTo}
                />
              </label>
            </div>
          </div>
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-[11px] font-bold text-slate-500">Status</span>
            <select
              className={premiumControlClass}
              onChange={(event) => setStatusFilter(event.target.value as (typeof statusOptions)[number])}
              value={statusFilter}
            >
              {statusFilterOptions.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </label>
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-[11px] font-bold text-slate-500">Request Type</span>
            <select
              className={premiumControlClass}
              onChange={(event) => setRequestTypeFilter(event.target.value)}
              value={requestTypeFilter}
            >
              {uniqueRequestTypes.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </label>
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-[11px] font-bold text-slate-500">Transportation Type</span>
            <select
              className={premiumControlClass}
              onChange={(event) => setTransportationFilter(event.target.value)}
              value={transportationFilter}
            >
              {uniqueTransportationTypes.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </label>
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-[11px] font-bold text-slate-500">Destination City</span>
            <select
              className={premiumControlClass}
              onChange={(event) => setDestinationFilter(event.target.value)}
              value={destinationFilter}
            >
              {uniqueDestinations.map((destination) => (
                <option key={destination} value={destination}>{destination}</option>
              ))}
            </select>
          </label>
          <button
            className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-orange-200 bg-orange-500 px-4 text-sm font-black text-white shadow-[0_14px_34px_rgba(249,115,22,0.25)] transition hover:-translate-y-0.5 hover:bg-orange-600"
            onClick={resetFilters}
            type="button"
          >
            <RefreshCw className="h-4 w-4" />
            Reset Filters
          </button>
        </div>
      </Card>

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <DashboardCard
          delta={undefined}
          helper="Sum of Total for this period"
          label="Total Expenses"
          value={formatMoney(totalExpenses)}
        />
        <DashboardCard
          delta={undefined}
          helper={`Filtered records: ${filteredTrips.length}`}
          label="Total Trips"
          value={totalTrips.toLocaleString()}
        />
        <DashboardCard
          delta={undefined}
          helper="Total Expenses / Total Trips"
          label="Average Cost per Trip"
          value={formatMoney(averageCostPerTrip)}
        />
        <DashboardCard
          delta={undefined}
          helper="Sum of KM (where available)"
          label="Total KM Travelled"
          value={formatKm(totalKm)}
        />
        <DashboardCard
          delta={tripsDeltaPercent ?? undefined}
          helper={`${tripsThisMonth.toLocaleString()} this month vs ${tripsLastMonth.toLocaleString()} last month`}
          label="Trips This Month vs Last Month"
          value={totalTrips.toLocaleString()}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card className={chartPanelClass}>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Monthly Expense Trend</p>
              <p className="text-sm font-medium text-slate-500">Spend rhythm and unusual spikes</p>
            </div>
            <span className="rounded-2xl border border-orange-100 bg-orange-50 p-2 text-orange-600">
              <Filter className="h-4 w-4" />
            </span>
          </div>
          <div className="h-72">
            {monthlyTrend.length === 0 ? (
              <EmptyState title="No trend data" message="No monthly data available for selected filters." />
            ) : (
              <ResponsiveContainer height="100%" width="100%">
                <ComposedChart data={monthlyTrend}>
                  <CartesianGrid strokeDasharray="4 4" stroke="#e2e8f0" />
                  <XAxis dataKey="month" stroke="#64748b" style={{ fontSize: 12 }} />
                  <YAxis yAxisId="expense" stroke="#64748b" style={{ fontSize: 12 }} tickFormatter={(value) => formatMoney(Number(value))} />
                  <YAxis yAxisId="trips" orientation="right" stroke="#64748b" style={{ fontSize: 12 }} />
                  <Tooltip
                    contentStyle={chartTooltipStyle()}
                    formatter={(value, name) => {
                      if (name === "expense") return formatMoney(Number(value));
                      if (name === "trips") return Number(value).toLocaleString();
                      return String(value);
                    }}
                    labelFormatter={(label) => `Month: ${label}`}
                  />
                  <ReferenceLine yAxisId="expense" y={0} stroke="#cbd5e1" />
                  <Bar dataKey="expense" fill={BRAND.primary} yAxisId="expense" />
                  <Line dataKey="trips" name="Trips" stroke={BRAND.primary} dot={{ fill: BRAND.primary }} yAxisId="trips" />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card className={chartPanelClass}>
          <div className="mb-3">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Expense Breakdown by Category</p>
            <p className="text-sm font-medium text-slate-500">Travel Cost, Meeting Amount, Allowance</p>
          </div>
          <div className="h-72">
            {categoryBreakdown.total <= 0 ? (
              <EmptyState title="No category data" message="No expense category amounts available for this period." />
            ) : (
              <div className="relative h-full">
                <ResponsiveContainer height="100%" width="100%">
                  <PieChart>
                    <Pie
                      cx="50%"
                      cy="50%"
                      data={categoryBreakdown.data}
                      dataKey="value"
                      innerRadius={65}
                      outerRadius={95}
                      paddingAngle={4}
                    >
                      <Cell fill={BRAND.primary} />
                      <Cell fill={BRAND.warning} />
                      <Cell fill="#94a3b8" />
                    </Pie>
                    <Tooltip formatter={(value: unknown) => formatMoney(Number(value))} contentStyle={chartTooltipStyle()} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="rounded-full border border-orange-100 bg-white/95 px-4 py-2 text-center shadow-[0_12px_32px_rgba(15,23,42,0.08)]">
                    <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">Total</p>
                    <p className="text-lg font-black text-slate-950">{formatMoney(categoryBreakdown.total)}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card className={chartPanelClass}>
          <div className="mb-3">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Trip Status Distribution</p>
            <p className="text-sm font-medium text-slate-500">System Approval, Pending, Declined, Confirmed by HR</p>
          </div>
          <div className="h-72">
            {statusDistribution.length === 0 ? (
              <EmptyState title="No trips" message="No trip status records available." />
            ) : (
              <ResponsiveContainer height="100%" width="100%">
                <PieChart>
                  <Pie
                    data={statusDistribution}
                    dataKey="value"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={4}
                  >
                    {statusDistribution.map((status) => (
                      <Cell key={status.name} fill={status.color} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: unknown) => `${value}`} contentStyle={chartTooltipStyle()} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="mt-2 space-y-1 text-xs font-semibold text-slate-600">
            {statusDistribution.map((status) => (
              <div key={status.name} className="flex items-center justify-between border-t border-orange-50 py-1.5">
                <span className="inline-flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: status.color }} />
                  {status.name}
                </span>
                <span>{status.value}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className={chartPanelClass}>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Trips by Transportation Type</p>
              <p className="text-sm font-medium text-slate-500">
                {showCostByTransportation ? "Total cost per transportation type" : "Trip count by transportation type"}
              </p>
            </div>
            <button
              className="rounded-2xl border border-orange-100 bg-orange-50 px-3 py-2 text-xs font-black text-orange-700 transition hover:bg-orange-100"
              onClick={() => setShowCostByTransportation((prev) => !prev)}
              type="button"
            >
              {showCostByTransportation ? "Show Trip Count" : "Show Total Cost"}
            </button>
          </div>
          <div className="h-72">
            {transportationSummary.length === 0 ? (
              <EmptyState title="No transport data" message="No transportation records available." />
            ) : (
              <ResponsiveContainer height="100%" width="100%">
                <BarChart data={transportationSummary} layout="vertical">
                  <CartesianGrid strokeDasharray="4 4" stroke="#e2e8f0" />
                  <XAxis type="number" />
                  <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 12 }} />
                  <Tooltip
                    formatter={(value: unknown, key) => {
                      if (key === "total") return formatMoney(Number(value));
                      return `${Number(value)}`;
                    }}
                    contentStyle={chartTooltipStyle()}
                  />
                  <Bar dataKey={showCostByTransportation ? "total" : "trips"} fill={BRAND.primary} radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card className={chartPanelClass}>
          <div className="mb-3">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Trips by Destination City</p>
            <p className="text-sm font-medium text-slate-500">Top destination cities visited</p>
          </div>
          <div className="h-72">
                {destinationSummary.length === 0 ? (
                  <EmptyState title="No destination data" message="No destination records available." />
                ) : (
                  <ResponsiveContainer height="100%" width="100%">
                <BarChart data={destinationSummary} layout="vertical" margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="4 4" stroke="#e2e8f0" />
                  <XAxis type="number" tickFormatter={(value) => new Intl.NumberFormat("en-US").format(Number(value))} />
                  <YAxis
                    type="category"
                    dataKey="city"
                    width={destinationAxisWidth}
                    interval={0}
                    minTickGap={16}
                    tick={{ fontSize: 12 }}
                  />
                  <Tooltip
                    formatter={(value, name) => (name === "total" ? formatMoney(Number(value)) : Number(value).toLocaleString())}
                    contentStyle={chartTooltipStyle()}
                  />
                  <Bar dataKey="trips" fill={BRAND.warning} radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card className={chartPanelClass}>
          <div className="mb-3">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Workload Summary</p>
          </div>
          {!hasWorkloadData ? (
            <p className="text-sm text-slate-600">Workload data is not available for this period.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              <DashboardCard label="Total AM workload visits" value={Math.round(totalAmWorkload).toLocaleString()} />
              <DashboardCard label="Total PM workload visits" value={Math.round(totalPmWorkload).toLocaleString()} />
              <DashboardCard
                label="Total workload visits per trip"
                value={`${(totalAmWorkload + totalPmWorkload).toLocaleString()}`}
              />
              <DashboardCard
                label="Average workload per trip"
                value={averageWorkloadPerTrip.toLocaleString(undefined, { maximumFractionDigits: 1 })}
              />

              <div className="md:col-span-2">
                <div className="h-52">
                  <ResponsiveContainer height="100%" width="100%">
                    <BarChart data={workloadChartData}>
                      <CartesianGrid strokeDasharray="4 4" stroke="#e2e8f0" />
                      <XAxis dataKey="name" />
                      <YAxis />
                      <Tooltip formatter={(value) => Number(value).toLocaleString()} contentStyle={chartTooltipStyle()} />
                      <Bar dataKey="value" fill={BRAND.success} radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}
        </Card>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Trip ledger</p>
            <h2 className="mt-1 text-xl font-black text-slate-950">Detailed Trip Table</h2>
          </div>
          <label className="relative min-w-0 flex-1 sm:max-w-sm">
            <span className="sr-only">Search trips</span>
            <Search className="absolute left-3 top-3.5 h-4 w-4 text-orange-500" />
            <input
              className="h-11 w-full rounded-2xl border border-orange-100 bg-white/95 py-2 pl-9 pr-3 text-sm font-medium text-slate-800 shadow-[0_12px_30px_rgba(15,23,42,0.05)] outline-none transition placeholder:text-slate-400 focus:border-orange-300 focus:ring-4 focus:ring-orange-100"
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search trips..."
              value={searchTerm}
            />
          </label>
        </div>

        <Card className="overflow-hidden rounded-[28px] border border-orange-100/80 bg-white/95 shadow-[0_24px_65px_rgba(15,23,42,0.08)] ring-1 ring-slate-950/[0.03]">
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-full divide-y divide-orange-50 text-left text-sm">
              <thead className="bg-orange-50/70">
                <tr>
                  <th className="px-4 py-3">{header("tripId", "TripID")}</th>
                  <th className="px-4 py-3">{header("date", "Date")}</th>
                  <th className="px-4 py-3">{header("toDate", "To Date")}</th>
                  <th className="px-4 py-3">{header("requestType", "Request Type")}</th>
                  <th className="px-4 py-3">From → To</th>
                  <th className="px-4 py-3 text-right">{header("total", "Total")}</th>
                  <th className="px-4 py-3 text-right">{header("travelCost", "Travel Cost")}</th>
                  <th className="px-4 py-3 text-right">{header("meetingAmount", "Meeting Amount")}</th>
                  <th className="px-4 py-3 text-right">{header("allowance", "Allowance")}</th>
                  <th className="px-4 py-3 text-right">{header("km", "KM")}</th>
                  <th className="px-4 py-3">{header("status", "Status")}</th>
                  <th className="px-4 py-3">{header("transportationType", "Transportation Type")}</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">HR Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-50 bg-white">
                {pagedTrips.map((trip) => {
                  const category = mapStatusCategory(trip.status);
                  return (
                    <tr className="transition hover:bg-orange-50/45" key={`${trip.tripId}-${trip.date}-${trip.requestType}`}>
                      <td className="px-4 py-3 font-mono text-xs font-bold text-slate-600">{trip.tripId || "N/A"}</td>
                      <td className="px-4 py-3 font-medium text-slate-700">{formatDate(trip.date)}</td>
                      <td className="px-4 py-3 font-medium text-slate-700">{trip.toDate ? formatDate(trip.toDate) : "—"}</td>
                      <td className="px-4 py-3 font-medium text-slate-700">{trip.requestType || "N/A"}</td>
                      <td className="px-4 py-3 font-medium text-slate-700">{trip.from || "N/A"} → {trip.to || "N/A"}</td>
                      <td className="px-4 py-3 text-right font-semibold text-slate-900">{formatMoney(trip.total)}</td>
                      <td className="px-4 py-3 text-right font-medium text-slate-700">{formatMoney(trip.travelCost)}</td>
                      <td className="px-4 py-3 text-right font-medium text-slate-700">{formatMoney(trip.meetingAmount)}</td>
                      <td className="px-4 py-3 text-right font-medium text-slate-700">{formatMoney(trip.allowance)}</td>
                      <td className="px-4 py-3 text-right font-medium text-slate-700">{formatKm(trip.km)}</td>
                      <td className="px-4 py-3"><Badge variant={statusVariant(category)}>{category}</Badge></td>
                      <td className="px-4 py-3 font-medium text-slate-700">{trip.transportationType || "N/A"}</td>
                      <td className="max-w-xs px-4 py-3 font-medium text-slate-700">{trip.description || "—"}</td>
                      <td className="max-w-xs px-4 py-3 font-medium text-slate-700">{trip.hrNotes || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 p-4 md:hidden">
            {pagedTrips.map((trip) => {
              const category = mapStatusCategory(trip.status);
              return (
                <Card key={`${trip.tripId}-${trip.date}-mobile`} className="rounded-2xl border border-orange-100 bg-white p-4 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-slate-900">{trip.tripId || "N/A"}</p>
                    <Badge variant={statusVariant(category)}>{category}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {formatDate(trip.date)} {trip.toDate ? `→ ${formatDate(trip.toDate)}` : ""}
                  </p>
                  <p className="mt-2 text-sm text-slate-700">{trip.requestType || "N/A"} · {trip.transportationType || "N/A"}</p>
                  <p className="mt-1 text-sm text-slate-700">{trip.from || "N/A"} → {trip.to || "N/A"}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                    <p className="text-slate-700">Total: <span className="font-semibold text-slate-900">{formatMoney(trip.total)}</span></p>
                    <p className="text-slate-700">KM: <span className="font-semibold text-slate-900">{formatKm(trip.km)}</span></p>
                    <p className="text-slate-700">Travel: <span className="font-semibold text-slate-900">{formatMoney(trip.travelCost)}</span></p>
                    <p className="text-slate-700">Meeting: <span className="font-semibold text-slate-900">{formatMoney(trip.meetingAmount)}</span></p>
                    <p className="text-slate-700">Allowance: <span className="font-semibold text-slate-900">{formatMoney(trip.allowance)}</span></p>
                  </div>
                </Card>
              );
            })}
            {pagedTrips.length === 0 ? <p className="px-3 py-6 text-sm text-slate-600">No trips available.</p> : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-orange-100 bg-orange-50/70 px-4 py-3">
            <p className="text-xs font-bold text-slate-500">
              {sortedTrips.length === 0 ? "No records" : `Showing ${pageSummary}`}
            </p>
            <div className="flex items-center gap-2">
              <button
                className="rounded-xl border border-orange-100 bg-white p-2 text-slate-600 shadow-sm transition hover:text-orange-600 disabled:opacity-50"
                disabled={safePage <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                type="button"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs font-black text-slate-700">{safePage} / {totalPages}</span>
              <button
                className="rounded-xl border border-orange-100 bg-white p-2 text-slate-600 shadow-sm transition hover:text-orange-600 disabled:opacity-50"
                disabled={safePage >= totalPages}
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                type="button"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}
