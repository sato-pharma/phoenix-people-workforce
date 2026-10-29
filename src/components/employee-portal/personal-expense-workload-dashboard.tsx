"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useHydrated } from "@/hooks/use-hydrated";
import { useRouter } from "next/navigation";
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
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  MapPin,
  PlusCircle,
  Printer,
  RefreshCw,
  Search,
} from "lucide-react";
import Link from "next/link";

import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import {
  ExpenseHeatmapLayer,
  type ExpenseBubbleInput,
} from "@/components/outstation/expense-heatmap-layer";
import { OutstationDescription } from "@/components/outstation/outstation-description";
import { Card } from "@/components/ui/card";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import type { MedicalRepPortalData } from "@/lib/employee-portal/service";
import { resolveRegionCentroid } from "@/lib/outstation/region-centroids";
import { extractKnownPlace } from "@/lib/utils/places";
import { canonicalizeTransport, resolveGovernorate } from "@/lib/geo/egypt-locations";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ExtraTicketRowEditor } from "@/components/outstation/extra-ticket-manager";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import { formatOutstationDescriptionInline } from "@/lib/outstation/description-format";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { rowDetailToggleProps, TableRowDetail } from "@/components/ui/table-row-detail";
import { adminControlDepthClassName, adminPanelDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";


/** Inline relative-date helper for the pending-approval chip ("yesterday", "5 days ago"). */
function relativeDaysFrom(iso: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const days = Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.round(days / 7)} week${days < 14 ? "" : "s"} ago`;
  if (days < 365) return `${Math.round(days / 30)} month${days < 60 ? "" : "s"} ago`;
  return `${Math.round(days / 365)} year${days < 730 ? "" : "s"} ago`;
}

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type ExpenseRow = {
  hrId: string;
  ownerName: string;
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
  // The claim's "other" amount (other_amount) — a taxi, a toll, a transport the form has no field
  // for. It is part of Total, so a card that leaves it out shows parts that do not add up.
  other: number;
  total: number;
  km: number;
  transportationType: string;
  amWorkload: number;
  pmWorkload: number;
  // The third workload figure (AM · PM · Pharmacies golden rule). null = not counted separately:
  // a trip stamped before the 2026-09-21 split carries its pharmacy visits inside AM/PM.
  pharmacyWorkload: number | null;
  // Doctor/pharmacy/institution split of the trip's regular CRM visits — recorded only on
  // Phoenix-submitted requests since the pharmacy-split change; undefined on historical /
  // Excel-imported rows (deliberately NOT zero, so "not recorded" never reads as "none").
  doctorVisits?: number;
  pharmacyVisits?: number;
  institutionVisits?: number;
  description: string;
  hrNotes: string;
  approvedAt: string; // ISO timestamp of the HR decision; "" when no decision yet
  hrApproved: boolean;
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
  | "ownerName"
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

type PeriodPreset = "7d" | "30d" | "90d" | "ytd" | "thismonth" | "lastmonth" | "custom";

/* ------------------------------------------------------------------ */
/*  Design tokens                                                     */
/* ------------------------------------------------------------------ */

const cardShadow = adminPanelDepthClassName;

const inputClass  = phxFieldClassName;

const labelClass =
  "text-phx-2xs font-bold uppercase tracking-wider text-slate-500";

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
  return stableCurrencyFormatter("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

// Numbers are written "en-US" (1,234), never in the reader's own style: a phone set to Arabic wrote
// "١٬٢٣٤" where the server wrote "1,234", and this text is re-drawn in the browser (System Audit
// APP-CDB55BF6). Every count on this dashboard follows the same rule.
function formatKm(value: number) {
  return `${Math.max(0, Number.isFinite(value) ? value : 0).toLocaleString("en-US")} km`;
}

function formatDate(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return stableEnGbFormatter({
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

/** Recovers the numeric outstation_expense_requests.id from a ledger tripId
 *  built by outstationPayrollTripId ("OUTSTATION-<id>"). Rows sourced from
 *  historical/Excel-imported payroll expenses never match this shape, so they
 *  correctly never qualify for the self-service extra-ticket control below. */
function parseOutstationRequestId(tripId: string): number | null {
  const match = /^OUTSTATION-(\d+)$/.exec(String(tripId ?? "").trim());
  return match ? Number(match[1]) : null;
}

/** Returns the request id when the VIEWER may add an extra ticket to this row
 *  right here (own request, train/bus, still waiting for HR's decision) — a UI hint only;
 *  the server independently re-validates ownership/transport/decision/payroll-lock. After HR has
 *  approved or rejected the claim nothing can be added (owner, 2026-10-19), so no button is offered. */
function extraTicketEligibleId(trip: ExpenseRow, viewerHrId: string | null | undefined): number | null {
  if (!viewerHrId) return null;
  if (trip.hrId.trim().toLowerCase() !== viewerHrId.trim().toLowerCase()) return null;
  if (trip.transportationType !== "Train" && trip.transportationType !== "Bus") return null;
  if (mapStatusCategory(trip.status) !== "Pending") return null;
  return parseOutstationRequestId(trip.tripId);
}

/* Flat, square premium status pill (replaces the gradient/ring/shadow Badge). */
const STATUS_PILL_STYLES: Record<string, string> = {
  "Confirmed by HR": "bg-emerald-50 text-emerald-700 ring-emerald-200",
  "System Approval": "bg-orange-50 text-orange-700 ring-orange-200",
  Pending: "bg-amber-50 text-amber-700 ring-amber-200",
  Declined: "bg-rose-50 text-rose-700 ring-rose-200",
  Other: "bg-slate-100 text-slate-600 ring-slate-200",
};

function StatusPill({ category }: { category: string }) {
  const styles = STATUS_PILL_STYLES[category] ?? STATUS_PILL_STYLES.Other;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wider ring-1 ${styles}`}
    >
      {category}
    </span>
  );
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

function extractDestination(to: string, fallback: string, description: string) {
  // Resolve the DESTINATION governorate from RECORDED data only: the trip's "to"
  // part first, then the location column, then the free-text description. We do NOT
  // guess/infer a destination (e.g. from the rep's territory) — a trip whose
  // destination was never recorded returns "" and is quarantined into the
  // "Unresolved" tab, kept out of every KPI/chart/map until it's actually resolved.
  const toPart = extractRoutePart(to || "", "to") || to || "";
  return resolveGovernorate(toPart) || resolveGovernorate(fallback || "") || resolveGovernorate(description || "") || "";
}

/**
 * A trip is "unresolved" when it is a real journey whose destination was never
 * recorded. Meetings are excluded — a meeting legitimately has no destination and
 * still belongs in the dashboard. Unresolved trips are quarantined into their own tab
 * and never counted in the analytics until their destination is resolved upstream.
 */
function isUnresolvedRow(trip: ExpenseRow): boolean {
  return trip.destinationCity === "" && !/meeting/i.test(trip.requestType);
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
    border: "1px solid #cbd5e1",
    borderRadius: 0,
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
      <p className="text-phx-xs font-semibold uppercase tracking-wider text-orange-600">
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
    } else if (next === "thismonth") {
      const from = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1));
      const to = new Date(Date.UTC(today.getFullYear(), today.getMonth() + 1, 0));
      onChange(toIso(from), toIso(to));
    } else if (next === "lastmonth") {
      const from = new Date(Date.UTC(today.getFullYear(), today.getMonth() - 1, 1));
      const to = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 0));
      onChange(toIso(from), toIso(to));
    } else if (next === "custom") {
      // leave existing values
    }
  };

  const segmentBtn = (key: PeriodPreset, label: string) => {
    const active = preset === key;
    return (
      <button
        aria-pressed={active}
        className={`flex-1 whitespace-nowrap  px-2.5 py-1.5 text-phx-sm font-semibold transition sm:flex-initial ${
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
          className={`mt-1.5 flex w-full flex-wrap items-center gap-0.5 border border-slate-300 bg-slate-50 p-0.5 sm:inline-flex sm:w-auto ${adminSoftDepthClassName}`}
          role="group"
        >
          {segmentBtn("7d", "7 days")}
          {segmentBtn("30d", "30 days")}
          {segmentBtn("90d", "90 days")}
          {segmentBtn("ytd", "YTD")}
          {segmentBtn("thismonth", "This Month")}
          {segmentBtn("lastmonth", "Last Month")}
          {segmentBtn("custom", "Custom")}
        </div>
      </div>
      {preset === "custom" && (
        <div
          className="grid gap-3 border border-orange-100 bg-orange-50/30 p-3 sm:grid-cols-2"
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
        <p className="mt-1 text-phx-xs leading-snug text-slate-500">{helper}</p>
      )}
      {showDelta && (
        <span
          className={`mt-1.5 inline-block  px-1.5 py-0.5 text-phx-2xs font-bold ${
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
      <p className="mt-1 text-phx-xs leading-snug text-slate-500">{helper}</p>
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
      className={`overflow-hidden border border-slate-200 p-4 sm:p-5 ${cardShadow}`}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-phx-md font-semibold text-slate-800">{title}</h3>
          {description && (
            <p className="mt-0.5 text-phx-xs text-slate-500">{description}</p>
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
/*  Unresolved trips panel                                            */
/* ------------------------------------------------------------------ */

/**
 * Quarantine view for trips whose destination was never recorded. They are held
 * here — out of every KPI, chart, map, and the main trip table — and no location is
 * ever guessed for them. They rejoin the dashboard automatically once a destination
 * is recorded at the source.
 */
function UnresolvedTripsPanel({ trips }: { trips: ExpenseRow[] }) {
  const total = trips.reduce((sum, trip) => sum + trip.total, 0);
  return (
    <Card className={`overflow-hidden border border-amber-200 p-0 ${cardShadow}`}>
      <div className="border-b border-amber-200 bg-amber-50/70 px-4 py-3">
        <h3 className="text-sm font-bold text-amber-900">Unresolved trips</h3>
        <p className="mt-0.5 max-w-2xl text-phx-sm text-amber-800">
          These trips have no destination recorded, so they are kept out of every KPI, chart,
          and the map until a destination is added at the source. No location is ever guessed.
        </p>
        <p className="mt-1 text-phx-sm font-semibold text-amber-900">
          {trips.length} trip{trips.length === 1 ? "" : "s"} · {formatMoney(total)} pending resolution
        </p>
      </div>
      <PortalResponsiveDataList
        empty={
          <p className="px-4 py-8 text-center text-sm text-slate-500">
            Nothing to resolve — every visible trip has a recorded destination.
          </p>
        }
        getKey={(trip) => `${trip.tripId}-${trip.date}-unresolved`}
        items={trips}
        renderCard={(trip) => (
          <PortalRecordCard
            meta={formatDate(trip.date)}
            status={<StatusPill category={mapStatusCategory(trip.status)} />}
            title={trip.tripId || "—"}
          >
            <PortalRecordFields
              fields={[
                { label: "Employee", value: trip.ownerName || "Employee" },
                { label: "Type", value: trip.requestType || "—" },
                { label: "Origin (home)", value: trip.fromCity || trip.from || "—" },
                { label: "Transport", value: trip.transportationType || "—" },
                { label: "Amount", value: formatMoney(trip.total) },
              ]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable
            cols={
              <colgroup>
                <col className="w-[12%]" />
                <col className="w-[11%]" />
                <col className="w-[17%]" />
                <col className="w-[12%]" />
                <col className="w-[15%]" />
                <col className="w-[12%]" />
                <col className="w-[11%]" />
                <col className="w-[10%]" />
              </colgroup>
            }
          >
            <thead className="border-b border-slate-200 bg-slate-50 text-phx-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Trip</th>
                <th className="px-3 py-2 font-semibold">Date</th>
                <th className="px-3 py-2 font-semibold">Employee</th>
                <th className="px-3 py-2 font-semibold">Type</th>
                <th className="px-3 py-2 font-semibold">Origin (home)</th>
                <th className="px-3 py-2 font-semibold">Transport</th>
                <th className="px-3 py-2 text-right font-semibold">Amount</th>
                <th className="px-3 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {trips.map((trip) => (
                <tr className="hover:bg-slate-50" key={`${trip.tripId}-${trip.date}-unresolved`}>
                  <td className="break-words px-3 py-2 font-mono text-phx-xs font-bold text-slate-600">{trip.tripId || "—"}</td>
                  <td className="break-words px-3 py-2 text-slate-700">{formatDate(trip.date)}</td>
                  <td className="px-3 py-2 text-slate-800">{trip.ownerName || "Employee"}</td>
                  <td className="px-3 py-2 text-slate-700">{trip.requestType || "—"}</td>
                  <td className="px-3 py-2 text-slate-500">{trip.fromCity || trip.from || "—"}</td>
                  <td className="px-3 py-2 text-slate-700">{trip.transportationType || "—"}</td>
                  <td className="break-words px-3 py-2 text-right font-semibold text-slate-900">{formatMoney(trip.total)}</td>
                  <td className="px-3 py-2"><StatusPill category={mapStatusCategory(trip.status)} /></td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

export function PersonalExpenseWorkloadDashboard({
  adminKeyCards,
  data,
  showHero = true,
  submitExpenseHref = "/employee-portals/submit-expense",
  ticketCountsByRequestId,
  viewerHrId,
}: {
  adminKeyCards?: WorkloadAdminKeyCards | null;
  data: Pick<MedicalRepPortalData, "workload">;
  showHero?: boolean;
  submitExpenseHref?: string;
  /** Extra-ticket count per outstation request id, for the "Extra Tickets"
   *  tracking column. Omit to render that column as "—" throughout. */
  ticketCountsByRequestId?: Record<number, number>;
  /** Enables the self-service "add extra ticket" control on the viewer's own
   *  train/bus rows. Omit (default) to keep the dashboard read-only — e.g. an
   *  admin/manager view of someone else's expenses should never pass this. */
  viewerHrId?: string | null;
}) {
  const router = useRouter();
  /* -------- data normalization (UNCHANGED LOGIC) -------- */
  const rows: ExpenseRow[] = useMemo(() => {
    const source = data.workload?.expenseRows ?? [];

    return source.map((expense) => ({
      hrId: normalizeString(expense.hrId),
      ownerName: normalizeString(expense.specialist || "Employee"),
      tripId: normalizeString(expense.tripId),
      date: normalizeString(expense.date),
      toDate: normalizeString(expense.toDate),
      requestType: normalizeString(expense.requestType),
      from: normalizeString(expense.from),
      fromCity: compactTripPlace(expense.from || "", expense.to || "", "from"),
      to: normalizeString(expense.to),
      toCity: compactTripPlace(expense.to || "", expense.from || "", "to", expense.location),
      destinationCity: extractDestination(expense.to || "", expense.location, expense.description || ""),
      status: normalizeString(expense.status),
      travelCost: Number(expense.travelCost ?? 0),
      meetingAmount: Number(expense.meetingAmount ?? 0),
      allowance: Number(expense.allowance ?? 0),
      other: Number(expense.other ?? 0),
      total: Number(expense.total ?? 0),
      km: Number(expense.km ?? 0),
      transportationType: canonicalizeTransport(expense.transportationType) ?? "",
      amWorkload: Number(expense.amWorkload ?? 0),
      pmWorkload: Number(expense.pmWorkload ?? 0),
      pharmacyWorkload: typeof expense.pharmacyWorkload === "number" ? expense.pharmacyWorkload : null,
      doctorVisits: typeof expense.doctorVisits === "number" ? expense.doctorVisits : undefined,
      pharmacyVisits: typeof expense.pharmacyVisits === "number" ? expense.pharmacyVisits : undefined,
      institutionVisits: typeof expense.institutionVisits === "number" ? expense.institutionVisits : undefined,
      description: normalizeString(expense.description),
      hrNotes: normalizeString(expense.hrNotes || expense.description),
      approvedAt: normalizeString(expense.approvedAt ?? ""),
      hrApproved: Boolean(expense.hrApproved),
    }));
  }, [data.workload?.expenseRows]);

  /* -------- filter state -------- */
  const [searchTerm, setSearchTerm] = useState(() => {
    if (typeof window === "undefined") return "";
    const initialUrl = new URL(window.location.href);
    return initialUrl.searchParams.get("q") ?? "";
  });
  const [dateFrom, setDateFrom] = useState(() => {
    if (typeof window === "undefined") return "";
    const initialUrl = new URL(window.location.href);
    return initialUrl.searchParams.get("from") ?? "";
  });
  const [dateTo, setDateTo] = useState(() => {
    if (typeof window === "undefined") return "";
    const initialUrl = new URL(window.location.href);
    return initialUrl.searchParams.get("to") ?? "";
  });
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>(() => {
    if (typeof window === "undefined") return "custom";
    const initialUrl = new URL(window.location.href);
    return (initialUrl.searchParams.get("period") as PeriodPreset) || "custom";
  });
  const [statusFilter, setStatusFilter] = useState<(typeof statusOptions)[number]>(() => {
    if (typeof window === "undefined") return "All";
    const initialUrl = new URL(window.location.href);
    return (initialUrl.searchParams.get("status") ?? "All") as (typeof statusOptions)[number];
  });
  const [requestTypeFilter, setRequestTypeFilter] = useState("All");
  const [transportationFilter, setTransportationFilter] = useState("All");
  const [destinationFilter, setDestinationFilter] = useState("All");
  const [showCostByTransportation, setShowCostByTransportation] = useState(false);
  const [activeView, setActiveView] = useState<"overview" | "unresolved">("overview");
  const [page, setPage] = useState(1);
  const [searchSortField, setSearchSortField] = useState<SortField>("date");
  const [searchSortDirection, setSearchSortDirection] = useState<SortDirection>("desc");
  const [density, setDensity] = useState<"compact" | "comfortable">("comfortable");
  const [expandedTripKey, setExpandedTripKey] = useState<string | null>(null);
  const [expandedTicketTripId, setExpandedTicketTripId] = useState<string | null>(null);
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

  const matchingTrips = useMemo(() => {
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
          `${trip.ownerName} ${trip.hrId} ${trip.tripId} ${trip.requestType} ${trip.from} ${trip.fromCity} ${trip.to} ${trip.toCity} ${trip.status} ${trip.transportationType} ${trip.description} ${trip.hrNotes} ${trip.destinationCity}`.toLowerCase();
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

  // Split the filter result: RESOLVED trips (a recorded destination, or a meeting that
  // needs none) feed the whole dashboard; UNRESOLVED trips (a non-meeting trip whose
  // destination was never recorded) are quarantined into the "Unresolved" tab and kept
  // out of every KPI, chart, map, and the trip table until their destination is fixed.
  const filteredTrips = useMemo(() => matchingTrips.filter((trip) => !isUnresolvedRow(trip)), [matchingTrips]);
  const unresolvedTrips = useMemo(() => matchingTrips.filter(isUnresolvedRow), [matchingTrips]);

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
            | "ownerName"
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
  const scopeEmployeeCount = new Set(filteredTrips.map((trip) => trip.hrId || trip.ownerName).filter(Boolean)).size;
  const scopeEmployeeLabel = `${scopeEmployeeCount.toLocaleString("en-US")} visible employee${scopeEmployeeCount === 1 ? "" : "s"}`;

  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const previousMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const previousMonth = `${previousMonthDate.getUTCFullYear()}-${String(previousMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
  const tripsThisMonth = filteredTrips.filter((trip) => trip.date.startsWith(currentMonth)).length;
  const tripsLastMonth = filteredTrips.filter((trip) => trip.date.startsWith(previousMonth)).length;
  const tripsDeltaPercent = tripsLastMonth > 0 ? ((tripsThisMonth - tripsLastMonth) / tripsLastMonth) * 100 : null;
  const pendingCount = filteredTrips.filter((t) => mapStatusCategory(t.status) === "Pending").length;
  // Most recent decision date across all rows on this view — drives the "Last decision: …" line
  // on the pending chip so reps can see how stale (or fresh) approval activity has been.
  const lastDecisionAt = filteredTrips.reduce(
    (latest, trip) => (trip.approvedAt && trip.approvedAt > latest ? trip.approvedAt : latest),
    "",
  );
  // "today / yesterday / 5 days ago" is worked out from the CLOCK, and the server's clock and the
  // phone's are read at different moments — so it is drawn only once the page has come alive, never
  // in the server HTML the phone must match (System Audit APP-CDB55BF6).
  const hydrated = useHydrated();
  const lastDecisionLabel = hydrated && lastDecisionAt ? relativeDaysFrom(lastDecisionAt) : "";

  // Personal dot map — aggregate the filtered trips by destination region centroid so reps see
  // where they've travelled. Pure client-side: the curated `resolveRegionCentroid` lookup is
  // static (no API calls). Spend per dot drives colour. The All / Approved / Pending pill
  // (admin Batch 3) is intentionally NOT wired here yet — it lands automatically when #234 merges.
  const personalMapPoints = useMemo<ExpenseBubbleInput[]>(() => {
    const map = new Map<string, ExpenseBubbleInput>();
    for (const trip of filteredTrips) {
      const label = trip.destinationCity || trip.toCity || trip.to || "";
      const centroid = resolveRegionCentroid(label);
      if (!centroid) continue;
      const lat = centroid.lat;
      const lng = centroid.lng;
      const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
      const amount = Number(trip.total) || 0;
      const existing = map.get(key);
      if (existing) {
        existing.weight = (existing.weight ?? 0) + amount;
        existing.count = (existing.count ?? 0) + 1;
      } else {
        map.set(key, {
          id: key,
          lat,
          lng,
          weight: amount,
          region: label || null,
          count: 1,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  }, [filteredTrips]);
  const personalMapUnmappedCount = useMemo(
    () =>
      filteredTrips.filter((trip) => {
        const label = trip.destinationCity || trip.toCity || trip.to || "";
        return !resolveRegionCentroid(label);
      }).length,
    [filteredTrips],
  );
  const personalMapUnmappedAmount = useMemo(
    () =>
      filteredTrips.reduce((sum, trip) => {
        const label = trip.destinationCity || trip.toCity || trip.to || "";
        return resolveRegionCentroid(label) ? sum : sum + (Number(trip.total) || 0);
      }, 0),
    [filteredTrips],
  );
  const approvedSpend = filteredTrips
    .filter((t) => mapStatusCategory(t.status) === "Confirmed by HR")
    .reduce((s, t) => s + t.total, 0);

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
    const other = filteredTrips.reduce((sum, item) => sum + item.other, 0);
    const itemised = travel + meeting + allowance + other;
    // Whatever of the visible Total no category carries (an older imported row whose parts were
    // never split out) gets its own named slice, so this card foots to "Visible Expenses".
    const notItemised = Math.round((totalExpenses - itemised) * 100) / 100;
    const data = [
      { name: "Travel Cost", value: travel, color: "#f97316" },
      { name: "Meeting Amount", value: meeting, color: "#f59e0b" },
      { name: "Allowance", value: allowance, color: "#94a3b8" },
      { name: "Other", value: other, color: "#0ea5e9" },
    ];
    if (notItemised >= 1) data.push({ name: "Not split by category", value: notItemised, color: "#cbd5e1" });
    return {
      total: itemised + (notItemised >= 1 ? notItemised : 0),
      // Parts that come to MORE than the visible Total (a claim whose Total was entered lower than
      // its parts) are said in words, never hidden.
      overItemised: notItemised <= -1 ? -notItemised : 0,
      data,
    };
  }, [filteredTrips, totalExpenses]);

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
      const key = normalizeString(trip.transportationType);
      if (!key) return; // meetings / non-travel rows have no transport mode — excluded from this chart
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
      const city = trip.destinationCity;
      if (!city) return; // unresolved destination — kept in KPIs/map, omitted from the city chart (no "Unknown")
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
  // Pharmacies is its own figure, never inside AM or PM. A trip stamped before the split has no
  // third figure (its pharmacy visits already sit inside AM/PM), so it adds 0 here, not a guess.
  const totalPharmacyWorkload = filteredTrips.reduce((sum, row) => sum + (row.pharmacyWorkload ?? 0), 0);
  const pharmacyUncountedTrips = filteredTrips.filter((row) => row.pharmacyWorkload === null).length;
  // No trip in view counted pharmacies apart: the figure is unknown, never a measured 0.
  const pharmacyCounted = filteredTrips.length > pharmacyUncountedTrips;
  const totalTripWorkload = totalAmWorkload + totalPmWorkload + totalPharmacyWorkload;
  const workloadTripCount = filteredTrips.length;
  const averageWorkloadPerTrip = workloadTripCount > 0 ? totalTripWorkload / workloadTripCount : 0;

  const workloadChartData = [
    { name: "AM", value: totalAmWorkload, color: "#10b981" },
    { name: "PM", value: totalPmWorkload, color: "#f97316" },
    ...(pharmacyCounted ? [{ name: "Pharmacies", value: totalPharmacyWorkload, color: "#0ea5e9" }] : []),
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

  /* -------- active filter count -------- */
  const activeFilterCount = [
    statusFilter !== "All",
    requestTypeFilter !== "All",
    transportationFilter !== "All",
    destinationFilter !== "All",
    !!(dateFrom || dateTo),
    !!searchTerm,
  ].filter(Boolean).length;

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
      className="inline-flex items-center gap-1 text-left text-phx-2xs font-bold uppercase tracking-wider text-slate-200 transition hover:text-orange-400"
      onClick={() => onSort(field)}
      type="button"
    >
      <span>{title}</span>
      <span className="text-phx-3xs opacity-60">
        {searchSortField === field ? (searchSortDirection === "desc" ? "▼" : "▲") : "↕"}
      </span>
    </button>
  );

  /* -------- Excel export (premium Phoenix-styled XLSX, honours current filters) -------- */
  const [isExporting, setIsExporting] = useState(false);
  const exportExcel = async () => {
    if (typeof window === "undefined" || sortedTrips.length === 0) return;
    setIsExporting(true);
    try {
      // Lazy-load the styled workbook builder (pulls exceljs) only on demand so it
      // stays out of this dashboard's initial bundle.
      const { buildPhoenixTableWorkbook } = await import("@/lib/export/table-workbook");
      const columns = [
        { key: "tripId", label: "Trip ID" },
        { key: "ownerName", label: "Employee" },
        { key: "hrId", label: "HR ID" },
        { key: "date", label: "Date" },
        { key: "toDate", label: "To Date" },
        { key: "requestType", label: "Type" },
        { key: "from", label: "From" },
        { key: "to", label: "To" },
        { key: "total", label: "Total (EGP)", numeric: true },
        { key: "travelCost", label: "Travel (EGP)", numeric: true },
        { key: "meetingAmount", label: "Meeting (EGP)", numeric: true },
        { key: "allowance", label: "Allowance (EGP)", numeric: true },
        { key: "km", label: "KM", numeric: true },
        { key: "status", label: "Status" },
        { key: "transportationType", label: "Transport" },
        { key: "description", label: "Description" },
        { key: "hrNotes", label: "HR Notes" },
      ];
      const exportRows = sortedTrips.map((trip) => ({
        tripId: trip.tripId || "",
        ownerName: trip.ownerName || "",
        hrId: trip.hrId || "",
        date: trip.date ? formatDate(trip.date) : "",
        toDate: trip.toDate ? formatDate(trip.toDate) : "",
        requestType: trip.requestType || "",
        from: trip.fromCity || "",
        to: trip.toCity || "",
        total: trip.total,
        travelCost: trip.travelCost,
        meetingAmount: trip.meetingAmount,
        allowance: trip.allowance,
        km: trip.km,
        status: mapStatusCategory(trip.status),
        transportationType: trip.transportationType || "",
        // Read through the same formatter as the screen: the stored text carries a machine audit
        // line (source=… hr_id=… gps=… draft_id=…) that no one should meet in a spreadsheet.
        description: formatOutstationDescriptionInline(trip.description),
        hrNotes: formatOutstationDescriptionInline(trip.hrNotes),
      }));
      const buffer = await buildPhoenixTableWorkbook({
        title: "Visible Expense Scope Report",
        subtitle: `${scopeEmployeeLabel} - ${exportRows.length} trips - exported ${new Date().toLocaleString("en-GB")}`,
        sheetName: "Expense Scope",
        columns,
        rows: exportRows,
      });
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `expense-scope-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setIsExporting(false);
    }
  };

  /* -------- table density classes -------- */
  const cellPaddingClass = density === "compact" ? "px-2 py-1.5" : "px-3 py-2.5";

  if (!rows.length) {
    return (
      <Card className={`overflow-hidden border border-slate-200 ${cardShadow}`}>
        <EmptyState title="No expense records" message="No visible expense records are available for your expense scope yet." />
      </Card>
    );
  }

  /* -------- render -------- */
  return (
    <div className="space-y-5" dir="auto">
      <style dangerouslySetInnerHTML={{ __html: printStyles }} />

      {showHero && (
        <section className="relative overflow-hidden rounded border border-slate-800 bg-[linear-gradient(135deg,#070707_0%,#111827_52%,#2C1605_100%)] p-5 sm:p-6 lg:p-8">
          <p className="text-phx-xs font-semibold uppercase tracking-wider text-orange-300">
            EXPENSES
          </p>
          <h1 className="mt-2 text-2xl font-bold text-white sm:text-3xl">Expense Dashboard</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-slate-300">
            Track trips, expenses, approvals, and workload across your visible expense scope.
          </p>
        </section>
      )}

      {/* ---- Submit CTA ---- */}
      <Link
        className={`group flex items-center justify-between gap-4 rounded border border-orange-200 bg-gradient-to-r from-orange-50 via-amber-50 to-white p-4 transition-all hover:border-orange-300 hover:shadow-md print:hidden ${cardShadow}`}
        href={submitExpenseHref}
      >
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-orange-100 text-orange-600">
            <PlusCircle className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="whitespace-nowrap text-sm font-bold text-slate-900">Submit a new outstation expense</p>
            <p className="mt-0.5 text-phx-sm text-slate-600">
              Start the guided trip submission. Captures location, distance, and allowance automatically.
            </p>
          </div>
        </div>
        <span className="hidden flex-none items-center gap-2 rounded-full bg-phx-warn px-4 py-2 text-phx-sm font-semibold text-white shadow-sm transition-colors group-hover:bg-phx-warn sm:inline-flex">
          Start submission
          <ChevronRight className="h-4 w-4" />
        </span>
      </Link>

      {/* ---- Tabs: Overview vs Unresolved ---- */}
      <div className="flex items-center gap-1 border-b border-slate-200 print:hidden" role="tablist">
        <button
          aria-selected={activeView === "overview"}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold transition ${activeView === "overview" ? "border-orange-500 text-orange-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}
          onClick={() => setActiveView("overview")}
          role="tab"
          type="button"
        >
          Overview
        </button>
        <button
          aria-selected={activeView === "unresolved"}
          className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold transition ${activeView === "unresolved" ? "border-orange-500 text-orange-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}
          onClick={() => setActiveView("unresolved")}
          role="tab"
          type="button"
        >
          Unresolved
          {unresolvedTrips.length > 0 && (
            <span className="rounded-full bg-phx-warn-bg px-1.5 py-0.5 text-phx-xs font-bold text-phx-warn">
              {unresolvedTrips.length}
            </span>
          )}
        </button>
      </div>

      {activeView === "unresolved" ? (
        <UnresolvedTripsPanel trips={unresolvedTrips} />
      ) : (
      <>
      {/* ---- KPI Stat Cards ---- */}
      <Card className={`overflow-hidden border border-slate-200 p-0 print:break-inside-avoid ${cardShadow}`}>
        <div className="grid grid-cols-2 divide-x divide-y divide-slate-200 sm:grid-cols-3 xl:grid-cols-5">
          <StatCard
            accent="border-l-emerald-400"
            helper={approvedSpend > 0 ? `${formatMoney(approvedSpend)} confirmed by HR` : "Sum of visible Total for this period"}
            label="Visible Expenses"
            value={formatMoney(totalExpenses)}
          />
          <StatCard
            accent="border-l-sky-400"
            helper={pendingCount > 0 ? `${pendingCount} pending - ${scopeEmployeeLabel}` : scopeEmployeeLabel}
            label="Visible Trips"
            value={totalTrips.toLocaleString("en-US")}
          />
          <StatCard
            accent="border-l-orange-400"
            helper="Visible expenses / visible trips"
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
            value={tripsThisMonth.toLocaleString("en-US")}
          />
        </div>
      </Card>

      {/* ---- Admin Key Cards (NSM/DSM scope) ---- */}
      {adminKeyCards && (
        <Card className={`overflow-hidden border border-slate-200 p-0 print:break-inside-avoid ${cardShadow}`}>
          <div className="grid grid-cols-1 divide-x divide-y divide-slate-200 sm:grid-cols-3">
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
        <Card className={`overflow-hidden border border-slate-200 p-0 print:break-inside-avoid ${cardShadow}`}>
          <div className="grid grid-cols-1 divide-x divide-y divide-slate-200 sm:grid-cols-3">
            <div className="px-4 py-3">
              <p className={labelClass}>Top destination</p>
              <p className="mt-1 whitespace-nowrap text-sm font-bold text-slate-800">
                {insights.top?.city ?? "—"}
              </p>
              <p className="mt-0.5 text-phx-xs text-slate-500">
                {insights.top
                  ? `${insights.top.trips} trips · ${formatMoney(insights.top.total)}`
                  : "No data"}
              </p>
            </div>
            <div className="px-4 py-3">
              <p className={labelClass}>Cost outlier</p>
              <p className="mt-1 break-words text-sm font-bold text-slate-800">
                {insights.outlier
                  ? `${insights.outlier.ownerName || "Employee"} → ${insights.outlier.toCity || "Unknown"}`
                  : "—"}
              </p>
              <p className="mt-0.5 text-phx-xs text-rose-600">
                {insights.outlier
                  ? `${formatMoney(insights.outlier.total)} · ${formatDate(insights.outlier.date)}`
                  : "No outliers detected"}
              </p>
            </div>
            <div className="px-4 py-3">
              <p className={labelClass}>Cost efficiency</p>
              <p className="mt-1 text-sm font-bold text-slate-800">
                {insights.costPerKm > 0 ? `${formatMoney(insights.costPerKm)}/km` : "—"}
              </p>
              <p className="mt-0.5 text-phx-xs text-slate-500">
                Average spend per kilometer
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Filters Card */}
      <Card className={`overflow-hidden border border-slate-200 p-4 sm:p-5 print:hidden ${cardShadow}`}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-phx-xs font-black uppercase tracking-wide text-slate-700">
            <span className="h-4 w-1 bg-orange-500" />
            Filters
          </span>
          <button
            aria-label="Reset all expense filters"
            className="inline-flex h-9 items-center gap-1.5 border border-slate-300 bg-white px-3 text-phx-sm font-semibold text-slate-600 shadow-sm transition hover:border-orange-200 hover:text-orange-600"
            onClick={resetFilters}
            type="button"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reset{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
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
            <SearchableSelect
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
            </SearchableSelect>
          </label>
          <label className="min-w-0">
            <span className={labelClass}>Request type</span>
            <SearchableSelect
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
            </SearchableSelect>
          </label>
          <label className="min-w-0">
            <span className={labelClass}>Transportation</span>
            <SearchableSelect
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
            </SearchableSelect>
          </label>
          <label className="min-w-0">
            <span className={labelClass}>Destination</span>
            <SearchableSelect
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
            </SearchableSelect>
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
                      if (name === "trips") return [Number(value).toLocaleString("en-US"), "Trips"];
                      return [String(value), String(name)];
                    }}
                    labelFormatter={(label) => `${label}`}
                  />
                  <ReferenceLine y={0} stroke="#e2e8f0" yAxisId="expense" />
                  <Bar dataKey="expense" radius={[0, 0, 0, 0]} yAxisId="expense">
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
          description="Travel cost, meeting amount, allowance and other — adds up to Visible Expenses"
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
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-phx-xs">
            {categoryBreakdown.data.map((entry) => (
              <span className="inline-flex items-center gap-1.5 text-slate-600" key={entry.name}>
                <span className="h-2 w-2" style={{ backgroundColor: entry.color }} />
                {entry.name}: <strong className="text-slate-800">{formatMoney(entry.value)}</strong>
              </span>
            ))}
          </div>
          {categoryBreakdown.overItemised > 0 && (
            <p className="mt-2 text-phx-xs text-slate-500">
              The category amounts come to {formatMoney(categoryBreakdown.overItemised)} more than Visible Expenses
              ({formatMoney(totalExpenses)}) — some claims carry a Total lower than their parts.
            </p>
          )}
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
                    <div className="flex items-center justify-between text-phx-sm">
                      <span className="inline-flex items-center gap-2 font-medium text-slate-700">
                        <span className="h-2 w-2" style={{ backgroundColor: status.color }} />
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
                      className="mt-1 h-1.5 overflow-hidden bg-slate-100"
                      role="progressbar"
                    >
                      <div className="h-full" style={{ width: `${pct}%`, backgroundColor: status.color }} />
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
              className={`border border-slate-300 bg-white px-2.5 py-1 text-phx-xs font-semibold text-slate-600 transition hover:border-orange-200 hover:text-orange-600 ${adminControlDepthClassName}`}
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
                    radius={[0, 0, 0, 0]}
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
          description="Top 8 destinations by spend"
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
                        : [Number(value).toLocaleString("en-US"), "Trips"]
                    }
                  />
                  <Bar dataKey="trips" radius={[0, 0, 0, 0]}>
                    {destinationSummary.map((row) => (
                      <Cell key={row.city} fill={spendColorForValue(row.trips, destinationTripsMax)} />
                    ))}
                  </Bar>
                </BarChart>
              </SafeResponsiveContainer>
            )}
          </div>
        </ChartCard>

        <ChartCard description="AM · PM · Pharmacies visit balance and totals" title="Workload Summary">
          {!hasWorkloadData ? (
            <EmptyState
              title="No workload data"
              message="Workload data is not available for this period."
            />
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 divide-x divide-slate-200 border-y border-slate-200 sm:grid-cols-5">
                <div className="px-3 py-3">
                  <p className={labelClass}>AM visits</p>
                  <p className="mt-1 text-base font-bold text-slate-800">
                    {Math.round(totalAmWorkload).toLocaleString("en-US")}
                  </p>
                </div>
                <div className="px-3 py-3">
                  <p className={labelClass}>PM visits</p>
                  <p className="mt-1 text-base font-bold text-slate-800">
                    {Math.round(totalPmWorkload).toLocaleString("en-US")}
                  </p>
                </div>
                <div className="px-3 py-3">
                  <p className={labelClass}>Pharmacies</p>
                  {pharmacyCounted ? (
                    <p className="mt-1 text-base font-bold text-slate-800">
                      {Math.round(totalPharmacyWorkload).toLocaleString("en-US")}
                    </p>
                  ) : (
                    <p className="mt-1 text-sm font-semibold text-slate-500">Not counted separately</p>
                  )}
                </div>
                <div className="px-3 py-3">
                  <p className={labelClass}>Total visits</p>
                  <p className="mt-1 text-base font-bold text-slate-800">
                    {totalTripWorkload.toLocaleString("en-US")}
                  </p>
                </div>
                <div className="px-3 py-3">
                  <p className={labelClass}>Avg / trip</p>
                  <p className="mt-1 text-base font-bold text-slate-800">
                    {averageWorkloadPerTrip.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                  </p>
                </div>
              </div>
              {pharmacyUncountedTrips > 0 && (
                <p className="text-xs leading-relaxed text-slate-500">
                  {pharmacyUncountedTrips.toLocaleString("en-US")} earlier{" "}
                  {pharmacyUncountedTrips === 1 ? "trip carries its" : "trips carry their"} pharmacy visits inside AM
                  and PM — Pharmacies has been counted separately since 21 Sep 2026.
                </p>
              )}
              {(() => {
                // Doctor/pharmacy/institution mix — only trips whose snapshot recorded the split
                // (Phoenix-submitted since the pharmacy-split change); historical imports never
                // carry it, so the line states its own scope instead of implying zeros.
                const split = filteredTrips.reduce(
                  (sum, row) =>
                    row.doctorVisits === undefined && row.pharmacyVisits === undefined && row.institutionVisits === undefined
                      ? sum
                      : {
                          doctor: sum.doctor + (row.doctorVisits ?? 0),
                          institution: sum.institution + (row.institutionVisits ?? 0),
                          pharmacy: sum.pharmacy + (row.pharmacyVisits ?? 0),
                          recorded: sum.recorded + 1,
                        },
                  { doctor: 0, institution: 0, pharmacy: 0, recorded: 0 },
                );
                if (split.recorded === 0) return null;
                return (
                  <p className="border-b border-slate-200 pb-3 text-phx-xs text-slate-500">
                    <span className="font-bold uppercase tracking-[0.12em] text-slate-400">Visit mix</span>{" "}
                    Doctor {split.doctor.toLocaleString("en-US")} · Pharmacy {split.pharmacy.toLocaleString("en-US")} · Institution{" "}
                    {split.institution.toLocaleString("en-US")}{" "}
                    <span className="text-slate-400">
                      — {split.recorded.toLocaleString("en-US")} live request{split.recorded === 1 ? "" : "s"} with a recorded
                      split only
                    </span>
                  </p>
                );
              })()}
              <div className="h-44">
                <SafeResponsiveContainer className="h-full">
                  <BarChart data={workloadChartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="name" stroke="#94a3b8" style={{ fontSize: 11 }} />
                    <YAxis stroke="#94a3b8" style={{ fontSize: 11 }} width={40} />
                    <Tooltip
                      contentStyle={chartTooltipStyle()}
                      formatter={(value) => Number(value).toLocaleString("en-US")}
                    />
                    <Bar dataKey="value" radius={[0, 0, 0, 0]}>
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

      {/* ---- Personal Dot Map: Where I've travelled ---- */}
      {personalMapPoints.length > 0 ? (
        <section className="space-y-3 print:hidden">
          <div className="flex items-center gap-2">
            <span className="h-7 w-1 bg-orange-500" />
            <div>
              <h2 className="text-base font-bold text-slate-900 sm:text-lg">Where I&apos;ve travelled</h2>
              <p className="text-phx-sm text-slate-500">
                Each dot is a destination — colour shows your spend. Toggle All / Approved / Pending.
              </p>
            </div>
          </div>
          <ExpenseHeatmapLayer
            browserKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? ""}
            height={420}
            points={personalMapPoints}
            subtitle="Your destinations sized and shaded by spend. Click a dot for details."
            title="My outstation footprint"
            unmappedAmount={personalMapUnmappedAmount}
            unmappedCount={personalMapUnmappedCount}
          />
        </section>
      ) : personalMapUnmappedCount > 0 ? (
        <section className="flex items-start gap-3 border border-slate-200 bg-slate-50 px-4 py-3 text-phx-sm text-slate-600 print:hidden">
          <MapPin className="mt-0.5 h-4 w-4 flex-none text-slate-400" />
          <div>
            <p className="font-semibold text-slate-700">No destinations to map yet</p>
            <p className="mt-0.5">
              Once your trips carry recognised destinations they&apos;ll appear here as dots on a map.
            </p>
          </div>
        </section>
      ) : null}

      {pendingCount > 0 && (
        <div className="flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3 print:hidden">
          <div className="mt-0.5 h-2 w-2 flex-none bg-amber-400" />
          <div>
            <p className="text-phx-sm font-bold text-amber-800">
              {pendingCount} trip{pendingCount > 1 ? "s" : ""} pending HR approval
              {lastDecisionLabel ? (
                <span className="ml-2 font-medium text-amber-700">
                  · last decision {lastDecisionLabel}
                </span>
              ) : null}
            </p>
            <p className="mt-0.5 text-phx-xs text-amber-700">
              These trips are in the approval queue and have not yet been confirmed for payroll inclusion.
            </p>
          </div>
        </div>
      )}

      {/* ---- Trip Ledger ---- */}
      <section className="space-y-3 print:break-inside-avoid">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-center gap-2">
            <span className="h-7 w-1 bg-orange-500" />
            <div>
              <span className="text-phx-xs font-black uppercase tracking-wide text-slate-500">
                Trip ledger
              </span>
              <h2 className="text-sm font-bold text-slate-800">Detailed Trip Table</h2>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {/* Density toggle */}
            <div
              aria-label="Table density"
              className="inline-flex items-center gap-0.5 border border-slate-300 bg-slate-50 p-0.5 print:hidden"
              role="group"
            >
              <button
                aria-pressed={density === "comfortable"}
                className={` px-2 py-1 text-phx-xs font-semibold transition ${
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
                className={` px-2 py-1 text-phx-xs font-semibold transition ${
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
            {/* Excel export */}
            <button
              aria-label="Export my expenses to Excel"
              className="inline-flex h-9 items-center gap-1.5 border border-slate-900 bg-slate-900 px-3 text-phx-sm font-bold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-40 print:hidden"
              disabled={sortedTrips.length === 0 || isExporting}
              onClick={() => {
                void exportExcel();
              }}
              type="button"
            >
              <Download className="h-3.5 w-3.5" />
              {isExporting ? "Preparing…" : "Export Excel"}
            </button>
            <button
              aria-label="Print expense report"
              className="inline-flex h-9 items-center gap-1.5 border border-slate-300 bg-white px-3 text-phx-sm font-semibold text-slate-600 shadow-sm transition hover:border-orange-200 hover:text-orange-600 print:hidden"
              onClick={() => window.print()}
              type="button"
            >
              <Printer className="h-3.5 w-3.5" />
              Print
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

        <Card className={`overflow-hidden border border-slate-200 ${cardShadow}`}>
          {/* Desktop / wide tablet table. Fits the screen with no horizontal scroll (AGENTS.md §4):
              table-fixed over a colgroup, and twelve columns merged into seven — Type under the trip
              ID, From over To, KM under Total, Transport and extra tickets under Status. The
              narrowest box it has to fit is 679px (a 768px viewport). Values wrap; nothing is
              shrunk or cut. Never bring back a min-width over an overflow-x-auto wrapper. */}
          <div className="hidden md:block">
            <table className="w-full table-fixed border-collapse text-left text-sm" data-portal-desktop-table>
              <colgroup>
                <col className="w-[14%]" />
                <col />
                <col className="w-[11%]" />
                <col className="w-[20%]" />
                <col className="w-[14%]" />
                <col className="w-[17%]" />
                <col className="w-10" />
              </colgroup>
              <thead className="bg-slate-900">
                <tr>
                  <th className={cellPaddingClass}>
                    <div className="flex flex-col items-center gap-1">
                      {header("tripId", "TripID")}
                      {header("requestType", "Type")}
                    </div>
                  </th>
                  <th className={cellPaddingClass}>{header("ownerName", "Employee")}</th>
                  <th className={cellPaddingClass}>{header("date", "Date")}</th>
                  <th className={cellPaddingClass}>
                    <div className="flex flex-col items-center gap-1">
                      {header("fromCity", "From")}
                      {header("toCity", "To")}
                    </div>
                  </th>
                  <th className={`${cellPaddingClass} text-right`}>
                    <div className="flex flex-col items-center gap-1">
                      {header("total", "Total")}
                      {header("km", "KM")}
                    </div>
                  </th>
                  <th className={cellPaddingClass}>
                    <div className="flex flex-col items-center gap-1">
                      {header("status", "Status")}
                      {header("transportationType", "Transport")}
                    </div>
                  </th>
                  <th className={cellPaddingClass}><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {pagedTrips.length === 0 ? (
                  <tr>
                    <td className="px-3 py-8 text-center text-sm text-slate-400" colSpan={7}>
                      No trips match your filters.
                    </td>
                  </tr>
                ) : (
                  pagedTrips.map((trip) => {
                    const category = mapStatusCategory(trip.status);
                    const tripKey = `${trip.tripId}-${trip.date}-${trip.requestType}`;
                    const isExpanded = expandedTripKey === tripKey;
                    return (
                      <Fragment key={tripKey}>
                        <tr
                          className="cursor-pointer transition hover:bg-orange-50/40"
                          onClick={() => setExpandedTripKey((prev) => prev === tripKey ? null : tripKey)}
                          {...rowDetailToggleProps(`trip-detail-${tripKey}`, isExpanded)}
                        >
                          <td className={`align-top ${cellPaddingClass}`}>
                            <span className="block break-words font-mono text-phx-xs font-semibold text-slate-600">
                              {trip.tripId || "—"}
                            </span>
                            <span className="mt-0.5 block break-words text-phx-sm text-slate-700">
                              {trip.requestType || "—"}
                            </span>
                          </td>
                          <td className={`align-top text-phx-sm font-semibold text-slate-800 ${cellPaddingClass}`}>
                            <span className="block break-words">{trip.ownerName || "Employee"}</span>
                          </td>
                          <td className={`align-top break-words text-phx-sm text-slate-700 ${cellPaddingClass}`}>
                            {formatDate(trip.date)}
                          </td>
                          <td className={`align-top text-phx-sm font-semibold text-slate-800 ${cellPaddingClass}`}>
                            <span className="block break-words">{trip.fromCity || "—"}</span>
                            <span className="block break-words">
                              <span className="font-normal text-slate-400">→ </span>
                              {trip.toCity || "—"}
                            </span>
                          </td>
                          <td className={`align-top text-right ${cellPaddingClass}`}>
                            <span className="block break-words text-phx-sm font-bold text-slate-900">
                              {formatMoney(trip.total)}
                            </span>
                            <span className="mt-0.5 block break-words text-phx-sm text-slate-700">
                              {formatKm(trip.km)}
                            </span>
                          </td>
                          <td className={`align-top ${cellPaddingClass}`}>
                            <StatusPill category={category} />
                            <span className="mt-1 block break-words text-phx-sm text-slate-700">
                              {trip.transportationType || "—"}
                              {(() => {
                                const requestId = parseOutstationRequestId(trip.tripId);
                                const count = requestId != null ? ticketCountsByRequestId?.[requestId] : undefined;
                                return count != null
                                  ? ` · ${count} extra ticket${count === 1 ? "" : "s"}`
                                  : null;
                              })()}
                            </span>
                          </td>
                          <td className={`align-top ${cellPaddingClass}`}>
                            <ChevronDown
                              className={`h-3.5 w-3.5 text-slate-400 transition-transform duration-150 ${isExpanded ? "rotate-180" : ""}`}
                            />
                          </td>
                        </tr>
                        {isExpanded && (
                          <TableRowDetail className="p-0" colSpan={7} id={`trip-detail-${tripKey}`}>
                              <div className="border-l-4 border-orange-400 px-4 py-4">
                                <div className="grid gap-4 text-phx-sm sm:grid-cols-2 lg:grid-cols-4">
                                  <div>
                                    <p className={labelClass}>Full Route</p>
                                    {trip.from ? <p className="mt-1 break-words font-semibold leading-snug text-slate-800">{trip.from}</p> : null}
                                    {trip.to ? <p className="break-words leading-snug text-slate-500">→ {trip.to}</p> : null}
                                    {trip.toDate && trip.date !== trip.toDate && (
                                      <p className="mt-1 text-slate-400">
                                        Until {formatDate(trip.toDate)}
                                      </p>
                                    )}
                                  </div>
                                  <div>
                                    <p className={labelClass}>Expense Breakdown</p>
                                    <div className="mt-1 space-y-0.5">
                                      <div className="flex justify-between">
                                        <span className="text-slate-500">Travel</span>
                                        <span className="font-semibold text-slate-800">{formatMoney(trip.travelCost)}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-slate-500">Meeting</span>
                                        <span className="font-semibold text-slate-800">{formatMoney(trip.meetingAmount)}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-slate-500">Allowance</span>
                                        <span className="font-semibold text-slate-800">{formatMoney(trip.allowance)}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-slate-500">Other</span>
                                        <span className="font-semibold text-slate-800">{formatMoney(trip.other)}</span>
                                      </div>
                                    </div>
                                    {trip.total > 0 && (
                                      <div className="mt-2 flex h-1.5 overflow-hidden">
                                        {trip.travelCost > 0 && (
                                          <div className="bg-orange-400" style={{ width: `${(trip.travelCost / trip.total) * 100}%` }} />
                                        )}
                                        {trip.meetingAmount > 0 && (
                                          <div className="bg-amber-400" style={{ width: `${(trip.meetingAmount / trip.total) * 100}%` }} />
                                        )}
                                        {trip.allowance > 0 && (
                                          <div className="bg-slate-400" style={{ width: `${(trip.allowance / trip.total) * 100}%` }} />
                                        )}
                                        {trip.other > 0 && (
                                          <div className="bg-sky-500" style={{ width: `${(trip.other / trip.total) * 100}%` }} />
                                        )}
                                      </div>
                                    )}
                                  </div>
                                  <div>
                                    <p className={labelClass}>Description</p>
                                    <OutstationDescription className="mt-1" value={trip.description} />
                                    {trip.hrNotes && trip.hrNotes !== trip.description && (
                                      <>
                                        <p className={`${labelClass} mt-3`}>HR Notes</p>
                                        <p className="mt-1 leading-relaxed text-slate-700">{trip.hrNotes}</p>
                                      </>
                                    )}
                                  </div>
                                  {hasWorkloadData &&
                                    (trip.amWorkload > 0 || trip.pmWorkload > 0 || (trip.pharmacyWorkload ?? 0) > 0) && (
                                    <div>
                                      <p className={labelClass}>Workload</p>
                                      <div className="mt-1 flex flex-wrap gap-5">
                                        <div>
                                          <p className="text-slate-500">AM visits</p>
                                          <p className="text-base font-bold text-emerald-700">{trip.amWorkload}</p>
                                        </div>
                                        <div>
                                          <p className="text-slate-500">PM visits</p>
                                          <p className="text-base font-bold text-orange-600">{trip.pmWorkload}</p>
                                        </div>
                                        <div>
                                          <p className="text-slate-500">Pharmacies</p>
                                          <p className="text-base font-bold text-sky-700">
                                            {trip.pharmacyWorkload === null ? "Not counted separately" : trip.pharmacyWorkload}
                                          </p>
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </div>
                                {(() => {
                                  const ticketRequestId = extraTicketEligibleId(trip, viewerHrId);
                                  if (ticketRequestId == null) return null;
                                  const isTicketOpen = expandedTicketTripId === trip.tripId;
                                  return (
                                    <div className="mt-4 border-t border-slate-200 pt-4">
                                      <button
                                        className="inline-flex items-center gap-1 rounded-md border border-orange-300 bg-orange-50 px-3 py-1.5 text-xs font-semibold text-orange-700 transition hover:bg-orange-100"
                                        onClick={() =>
                                          setExpandedTicketTripId((prev) => (prev === trip.tripId ? null : trip.tripId))
                                        }
                                        type="button"
                                      >
                                        <PlusCircle className="h-3.5 w-3.5" />
                                        {isTicketOpen ? "Close" : "Add tickets"}
                                      </button>
                                      {isTicketOpen && (
                                        <div className="mt-3 max-w-xl">
                                          <ExtraTicketRowEditor
                                            onAdded={() => {
                                              setExpandedTicketTripId(null);
                                              router.refresh();
                                            }}
                                            requestId={ticketRequestId}
                                          />
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}
                              </div>
                          </TableRowDetail>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
              <tfoot className="border-t-2 border-slate-900">
                <tr className="bg-slate-50">
                  <td
                    className={`${cellPaddingClass} text-phx-2xs font-bold uppercase tracking-wider text-slate-500`}
                    colSpan={4}
                  >
                    {pagedTrips.length > 0 ? `Page total · ${pagedTrips.length} trips` : "No records"}
                  </td>
                  <td className={`${cellPaddingClass} text-right`}>
                    <span className="block break-words text-phx-sm font-bold text-orange-600">
                      {formatMoney(pagedTrips.reduce((s, t) => s + t.total, 0))}
                    </span>
                    <span className="mt-0.5 block break-words text-phx-sm font-semibold text-slate-700">
                      {formatKm(pagedTrips.reduce((s, t) => s + t.km, 0))}
                    </span>
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
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
                    className={`relative overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}
                    key={`${trip.tripId}-${trip.date}-mobile`}
                  >
                    <div className="absolute inset-y-0 left-0 w-[3px] bg-orange-400" />
                    <div className="px-3 py-3 pl-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="break-words font-mono text-phx-xs font-bold text-slate-600">
                            {trip.tripId || "—"}
                          </p>
                          <p className="mt-0.5 break-words text-phx-sm font-bold text-slate-800">
                            {trip.ownerName || "Employee"}
                          </p>
                          <p className="mt-0.5 text-phx-xs text-slate-500">
                            {formatDate(trip.date)}
                            {trip.toDate ? ` → ${formatDate(trip.toDate)}` : ""}
                          </p>
                        </div>
                        <StatusPill category={category} />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-phx-xs text-slate-600">
                        <span className="bg-slate-100 px-1.5 py-0.5 font-semibold">
                          {trip.fromCity || "?"} → {trip.toCity || "?"}
                        </span>
                        {trip.requestType && (
                          <span className="bg-slate-100 px-1.5 py-0.5">
                            {trip.requestType}
                          </span>
                        )}
                        {trip.transportationType && (
                          <span className="bg-slate-100 px-1.5 py-0.5">
                            {trip.transportationType}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2 border-t border-slate-200 pt-2 text-phx-xs">
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
                        {trip.other > 0 && (
                          <div>
                            <p className="text-slate-500">Other</p>
                            <p className="font-semibold text-slate-800">{formatMoney(trip.other)}</p>
                          </div>
                        )}
                        <div>
                          <p className="text-slate-500">Extra tickets</p>
                          <p className="font-semibold text-slate-800">
                            {(() => {
                              const requestId = parseOutstationRequestId(trip.tripId);
                              const count = requestId != null ? ticketCountsByRequestId?.[requestId] : undefined;
                              return count != null ? count : "—";
                            })()}
                          </p>
                        </div>
                      </div>
                      {(() => {
                        const ticketRequestId = extraTicketEligibleId(trip, viewerHrId);
                        if (ticketRequestId == null) return null;
                        const isTicketOpen = expandedTicketTripId === trip.tripId;
                        return (
                          <div className="mt-3 border-t border-slate-200 pt-3">
                            <button
                              className="inline-flex items-center gap-1 rounded-md border border-orange-300 bg-orange-50 px-3 py-1.5 text-xs font-semibold text-orange-700 transition hover:bg-orange-100"
                              onClick={() =>
                                setExpandedTicketTripId((prev) => (prev === trip.tripId ? null : trip.tripId))
                              }
                              type="button"
                            >
                              <PlusCircle className="h-3.5 w-3.5" />
                              {isTicketOpen ? "Close" : "Add tickets"}
                            </button>
                            {isTicketOpen && (
                              <div className="mt-3">
                                <ExtraTicketRowEditor
                                  onAdded={() => {
                                    setExpandedTicketTripId(null);
                                    router.refresh();
                                  }}
                                  requestId={ticketRequestId}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Pagination footer */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50/60 px-3 py-2">
            <p className="text-phx-xs font-semibold text-slate-500">
              {sortedTrips.length === 0 ? "No records" : `Showing ${pageSummary}`}
            </p>
            <div className="flex items-center gap-3">
              {/* Page size selector — useful past ~200 records */}
              <label className="flex items-center gap-1.5 text-phx-xs text-slate-500 print:hidden">
                <span>Rows</span>
                <SearchableSelect
                  aria-label="Rows per page"
                  className="h-7 px-1.5 text-phx-xs"
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
                </SearchableSelect>
              </label>
              <div className="flex items-center gap-2">
                <button
                  aria-label="Previous page"
                  className={`border border-slate-300 bg-white p-1.5 text-slate-600 transition hover:border-orange-200 hover:text-orange-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none ${adminControlDepthClassName}`}
                  disabled={safePage <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  type="button"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="text-phx-xs font-bold text-slate-700">
                  {safePage} / {totalPages}
                </span>
                <button
                  aria-label="Next page"
                  className={`border border-slate-300 bg-white p-1.5 text-slate-600 transition hover:border-orange-200 hover:text-orange-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none ${adminControlDepthClassName}`}
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
      </>
      )}
    </div>
  );
}
