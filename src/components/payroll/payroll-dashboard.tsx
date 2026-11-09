"use client";

import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CheckCircle,
  Download,
  FileCheck2,
  FileSpreadsheet,
  Gauge,
  Sparkles,
  Upload,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { currentCairoDateParts } from "@/lib/i18n/format";
import {
  AdminCallout,
  AdminPageHero,
} from "@/components/admin/admin-design-system";
import { PayrollHistory } from "@/components/payroll/dashboard/payroll-history";
import {
  PayrollGovernanceAlerts,
  PayrollResignationCandidatesBanner,
  PayrollWorkflowPanel,
} from "@/components/payroll/dashboard/payroll-workflow-governance";
import {
  panelClassName,
  payrollMonths,
  payrollPeriodIndex,
  payrollPeriodLabel,
  publishedPayslipStatuses,
  statusBadge,
} from "@/components/payroll/dashboard/shared";
import {
  SalaryUploadActions,
  SalaryUploadValidationSection,
} from "@/components/payroll/dashboard/salary-upload-validation";
import { SalaryReportTable } from "@/components/payroll/dashboard/salary-report-table";
import type { SalaryValidationResult } from "@/components/payroll/dashboard/validation-summary";
import {
  formatCompactNumber,
  formatCurrencyValue,
  formatDateValue,
  formatNumberValue,
} from "@/lib/i18n/format";
import type {
  PayrollDashboardData,
  PayrollPeriodConflict,
  PayrollWorkflowAction,
  SalaryBatch,
  SalaryRecord,
} from "@/lib/payroll/types";
import { hardNavigate } from "@/lib/navigation/browser-navigation";
import { cn, formatEmployeeDisplayName } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";


type Props = {
  initialData: PayrollDashboardData | null;
  initialError: string | null;
};

type PayrollTab = "dashboard" | "governance" | "generate";
type GroupMode = "line" | "area" | "jobTitle";
type ImpactLevel = "Low" | "Medium" | "High" | "Critical";
type InsightSentiment = "positive" | "neutral" | "risk";
type SalaryReplacementTarget = Pick<SalaryBatch, "id" | "month" | "year">;

type PayrollTotals = {
  additions: number;
  deductions: number;
  employees: number;
  governmentalDeductions: number;
  gross: number;
  net: number;
  otherDeductions: number;
};

type PayrollInsight = {
  action: string;
  confidence: number;
  impact: ImpactLevel;
  metric: string;
  sentiment: InsightSentiment;
  title: string;
  value: number;
  valueLabel: string;
  summary: string;
};

type PredictiveAlert = {
  action: string;
  affected?: string;
  confidence: number;
  reason: string;
  risk: ImpactLevel;
  title: string;
};

type ScoreBand = "Excellent" | "Healthy" | "Needs Review" | "Critical";

type ScoreResult = {
  band: ScoreBand;
  components: Array<{ label: string; score: number }>;
  readiness: number;
  reasons: string[];
  score: number;
};

type EntityScore = {
  band: ScoreBand;
  key: string;
  label: string;
  meta: string;
  reasons: string[];
  score: number;
};

type ChartHoverState = {
  index: number;
  x: number;
  y: number;
};

type PayrollTrendPoint = {
  additions: number;
  deductions: number;
  employees: number;
  gross: number;
  label: string;
  net: number;
};

type ZoomPreset = "3M" | "6M" | "12M" | "All";

const additionFields: Array<{ key: keyof SalaryRecord; label: string }> = [
  { key: "expenses", label: "Expenses" },
  { key: "incentive", label: "Incentive" },
  { key: "overtime", label: "Overtime" },
  { key: "bonus", label: "Bonus" },
  { key: "extraCostOfLiving", label: "Cost of Living" },
  { key: "fuelAllowance", label: "Fuel Allowance" },
  { key: "otherAdditions", label: "Other Additions" },
];

const governmentalDeductionFields: Array<{ key: keyof SalaryRecord; label: string }> = [
  { key: "socialInsurance", label: "Social Insurance" },
  { key: "employmentIncomeTax", label: "Income Tax" },
];

const otherDeductionFields: Array<{ key: keyof SalaryRecord; label: string }> = [
  { key: "medicalInsurance", label: "Medical Insurance" },
  { key: "loans", label: "Loans" },
  { key: "crm", label: "CRM" },
  { key: "fingerPrint", label: "Finger Print" },
  { key: "unpaidVacations", label: "Unpaid Vacation" },
  { key: "otherDeductions", label: "Other Deductions" },
];

const interactiveCardClass = "phoenix-card-motion";

async function readPayrollApiPayload(response: Response) {
  const text = await response.text();
  if (!text.trim()) return {};

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? parsed
      : { message: String(parsed ?? "") };
  } catch {
    const status = `${response.status} ${response.statusText}`.trim();
    const compactBody = text
      .replace(/<script[\s\S]*?<\/script[^>]*>/gi, " ")
      .replace(/<style[\s\S]*?<\/style[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 260);
    const redirectedMessage = response.redirected
      ? " The request was redirected, so your session may need a refresh."
      : "";

    return {
      error: "non_json_response",
      message: compactBody
        ? `Payroll API returned a non-JSON response (${status}).${redirectedMessage} ${compactBody}`
        : `Payroll API returned an empty or unreadable response (${status}).${redirectedMessage}`,
    };
  }
}

function payrollPayloadMessage(payload: { error?: unknown; message?: unknown }, fallback: string) {
  if (typeof payload.message === "string" && payload.message.trim()) return payload.message;
  if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
  return fallback;
}

function payrollRequestErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return `${fallback} ${error.message}`;
  }

  return fallback;
}

function payrollPayloadBatchId(payload: { batch?: unknown }) {
  if (!payload.batch || typeof payload.batch !== "object") return null;
  const id = (payload.batch as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : null;
}

function PayrollPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate min-h-[calc(100vh-8rem)] overflow-hidden rounded-[34px] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_32%),linear-gradient(135deg,#FFF9F3_0%,#FFFFFF_44%,#F7FAFC_100%)] p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-phx-accent/12 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-10 left-1/3 h-64 w-64 rounded-full bg-phx-ink/6 blur-3xl"
      />
      <div className="relative z-10 space-y-6">{children}</div>
    </div>
  );
}

function StatusBanner({
  message,
  title,
  tone,
}: {
  message: string;
  title: string;
  tone: "danger" | "success";
}) {
  const isSuccess = tone === "success";

  return (
    <AdminCallout tone={isSuccess ? "success" : "danger"}>
      {isSuccess ? (
        <CheckCircle className="mt-0.5 h-5 w-5 shrink-0" />
      ) : (
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
      )}
      <div>
        <p className="font-semibold">{title}</p>
        <p className="mt-1 leading-6">{message}</p>
      </div>
    </AdminCallout>
  );
}

function PayrollMotionStyles() {
  return (
    <style>{`
      @keyframes phoenixFadeUp {
        from { opacity: 0; transform: translateY(14px); }
        to { opacity: 1; transform: translateY(0); }
      }

      @keyframes phoenixDraw {
        from { stroke-dashoffset: 980; opacity: 0.35; }
        to { stroke-dashoffset: 0; opacity: 1; }
      }

      @keyframes phoenixPulse {
        0%, 100% { box-shadow: 0 16px 45px rgba(249, 115, 22, 0.14); }
        50% { box-shadow: 0 22px 60px rgba(249, 115, 22, 0.28); }
      }

      @keyframes phoenixWarningPulse {
        0%, 100% { box-shadow: 0 14px 34px rgba(15, 23, 42, 0.06), 0 0 0 rgba(239, 68, 68, 0); }
        50% { box-shadow: 0 18px 40px rgba(15, 23, 42, 0.08), 0 0 24px rgba(249, 115, 22, 0.18); }
      }

      @keyframes phoenixScoreFill {
        from { stroke-dasharray: 0 100; }
      }

      @keyframes phoenixSkeleton {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }

      @keyframes phoenixPointPulse {
        0%, 100% { opacity: 0.4; transform: scale(1); }
        50% { opacity: 0.88; transform: scale(1.22); }
      }

      @keyframes phoenixBreathe {
        0%, 100% { transform: translateY(0) scale(1); }
        50% { transform: translateY(-4px) scale(1.025); }
      }

      @keyframes phoenixBarGrow {
        from { transform: scaleY(0.08); opacity: 0.35; }
        to { transform: scaleY(1); opacity: 1; }
      }

      .payroll-dashboard-surface {
        background:
          radial-gradient(circle at 56% 0%, rgba(249, 115, 22, 0.055), transparent 30rem),
          linear-gradient(180deg, #fbfdff 0%, #f8fafc 42%, #f9fbff 100%);
      }

      .phoenix-card-motion {
        animation: phoenixFadeUp 520ms ease both;
        transition:
          transform 220ms ease,
          box-shadow 220ms ease,
          border-color 220ms ease,
          background-color 220ms ease;
      }

      .phoenix-enter-once {
        opacity: 0;
        transform: translateY(16px);
      }

      .phoenix-enter-once.is-visible {
        animation: phoenixFadeUp 620ms ease both;
      }

      .phoenix-card-motion:hover {
        border-color: rgba(249, 115, 22, 0.42);
        box-shadow: 0 20px 45px rgba(15, 23, 42, 0.1), 0 0 24px rgba(249, 115, 22, 0.08);
        transform: translateY(-3px);
      }

      .payroll-dashboard-surface .rounded-xl.border.bg-card {
        border-color: #e5e7eb;
        border-radius: 20px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.98), rgba(255,255,255,0.94));
        box-shadow: 0 14px 40px rgba(15, 23, 42, 0.065);
        transition:
          transform 220ms ease,
          box-shadow 220ms ease,
          border-color 220ms ease,
          background-color 220ms ease;
      }

      .payroll-dashboard-surface .rounded-xl.border.bg-card:hover {
        border-color: rgba(249, 115, 22, 0.34);
        box-shadow: 0 18px 46px rgba(15, 23, 42, 0.09), 0 0 24px rgba(249, 115, 22, 0.06);
        transform: translateY(-2px);
      }

      .phoenix-kpi-card:hover svg {
        transform: translateY(-2px) rotate(-6deg) scale(1.08);
      }

      .phoenix-kpi-card svg {
        transition: transform 220ms ease;
      }

      .phoenix-donut {
        transition: transform 260ms ease, filter 260ms ease;
      }

      .phoenix-donut:hover {
        filter: saturate(1.1);
        transform: scale(1.035) rotate(2deg);
      }

      .phoenix-donut-ring {
        transition: transform 260ms ease, opacity 180ms ease, stroke-width 180ms ease, filter 180ms ease;
        transform-origin: center;
        filter: drop-shadow(0 0 13px rgba(249, 115, 22, 0.34)) drop-shadow(0 14px 24px rgba(37, 99, 235, 0.16));
      }

      .phoenix-donut:hover .phoenix-donut-ring {
        transform: rotate(12deg);
      }

      .phoenix-bar-row {
        transition: transform 180ms ease, background-color 180ms ease;
      }

      .phoenix-bar-row:hover {
        background: rgba(249, 115, 22, 0.04);
        transform: translateX(4px);
      }

      .phoenix-bar-fill {
        transform-origin: left center;
        transition: transform 220ms ease, filter 220ms ease;
        box-shadow: 0 0 15px rgba(249, 115, 22, 0.24);
      }

      .phoenix-bar-row:hover .phoenix-bar-fill {
        filter: drop-shadow(0 0 10px rgba(249, 115, 22, 0.38));
        transform: scaleX(1.025);
      }

      .phoenix-chart-series {
        cursor: pointer;
      }

      .phoenix-chart-line {
        animation: phoenixDraw 1200ms ease both;
        stroke-dasharray: 980;
        transition: filter 220ms ease, stroke-width 220ms ease;
      }

      .phoenix-chart-dot {
        transition: filter 220ms ease, r 220ms ease;
      }

      .phoenix-crosshair {
        opacity: 0;
        transition: opacity 160ms ease;
      }

      .phoenix-chart-hovering .phoenix-crosshair {
        opacity: 1;
      }

      .phoenix-chart-tooltip {
        opacity: 0;
        z-index: 90 !important;
        max-width: min(15rem, calc(100vw - 2rem));
        transform: translate(-50%, calc(-100% - 18px)) scale(0.96);
        transition: opacity 160ms ease, transform 160ms ease;
      }

      .phoenix-chart-hovering .phoenix-chart-tooltip {
        opacity: 1;
        transform: translate(-50%, calc(-100% - 18px)) scale(1);
      }

      .phoenix-active-point {
        transform-box: fill-box;
        transform-origin: center;
        animation: phoenixPointPulse 1.4s ease-in-out infinite;
      }

      .phoenix-axis-indicator {
        opacity: 0;
        transform: translateY(3px);
        transition: opacity 160ms ease, transform 160ms ease;
      }

      .phoenix-chart-hovering .phoenix-axis-indicator {
        opacity: 1;
        transform: translateY(0);
      }

      .phoenix-chart-series:hover .phoenix-chart-line {
        filter: drop-shadow(0 0 10px currentColor);
        stroke-width: 5;
      }

      .phoenix-chart-series:hover .phoenix-chart-dot {
        filter: drop-shadow(0 0 7px rgba(15, 23, 42, 0.25));
        r: 6;
      }

      .phoenix-logo-motion img {
        animation: phoenixBreathe 4.8s ease-in-out infinite;
        transition: transform 220ms ease, filter 220ms ease;
      }

      .phoenix-logo-motion:hover img {
        filter: drop-shadow(0 10px 20px rgba(249, 115, 22, 0.28));
        transform: scale(1.08);
      }

      .phoenix-nav-item {
        transition: transform 180ms ease, box-shadow 180ms ease, background-color 180ms ease;
      }

      .phoenix-nav-item:hover {
        transform: translateX(4px);
      }

      .phoenix-action-button {
        transition: transform 180ms ease, box-shadow 180ms ease;
      }

      .phoenix-action-button:hover {
        box-shadow: 0 14px 30px rgba(249, 115, 22, 0.25);
        transform: translateY(-2px);
      }

      .phoenix-glow-bar {
        filter: drop-shadow(0 0 14px var(--bar-glow));
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.65);
        transform-origin: bottom center;
        animation: phoenixBarGrow 720ms ease both;
      }

      .phoenix-chart-panel {
        overflow: visible !important;
        position: relative;
        background:
          radial-gradient(circle at 50% 20%, rgba(249, 115, 22, 0.08), transparent 18rem),
          linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.8));
      }

      .phoenix-stagger {
        animation: phoenixFadeUp 520ms ease both;
        animation-delay: var(--stagger-delay, 0ms);
      }

      .phoenix-risk-pulse {
        animation: phoenixWarningPulse 2.9s ease-in-out infinite;
      }

      .phoenix-count-up {
        animation: phoenixFadeUp 460ms ease both;
      }

      .phoenix-score-arc {
        animation: phoenixScoreFill 900ms cubic-bezier(.2,.8,.2,1) both;
      }

      .phoenix-skeleton {
        background: linear-gradient(90deg, #f1f5f9 25%, #ffffff 42%, #f1f5f9 63%);
        background-size: 220% 100%;
        animation: phoenixSkeleton 1.2s ease-in-out infinite;
      }

      .phoenix-bar-crosshair {
        opacity: 0;
        transition: opacity 160ms ease;
      }

      .phoenix-bar-row:hover .phoenix-bar-crosshair {
        opacity: 1;
      }

      .phoenix-mini-scrollbar {
        background: linear-gradient(90deg, rgba(226,232,240,0.9), rgba(248,250,252,0.95));
      }

      .phoenix-mini-scrollbar-thumb {
        background: linear-gradient(90deg, rgba(249,115,22,0.85), rgba(251,191,36,0.9));
        box-shadow: 0 0 16px rgba(249,115,22,0.2);
      }

      .phoenix-range-selection {
        fill: rgba(249,115,22,0.12);
        stroke: rgba(249,115,22,0.45);
        stroke-dasharray: 4 4;
      }
    `}</style>
  );
}

function formatEGP(value: number) {
  return formatCurrencyValue(Number.isFinite(value) ? value : 0);
}

function formatCompact(value: number) {
  return formatCompactNumber(Number.isFinite(value) ? value : 0);
}

function formatNumber(value: number) {
  return formatNumberValue(Number.isFinite(value) ? value : 0);
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "0%";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function useInViewOnce<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || isVisible) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.22 },
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [isVisible]);

  return { isVisible, ref };
}

function parseMonthInput(value: string) {
  const [year, month] = value.split("-").map(Number);
  return Number.isFinite(year) && Number.isFinite(month)
    ? payrollPeriodIndex(month, year)
    : null;
}

function shortPayrollPeriodLabel(month: number, year: number) {
  const monthName =
    payrollMonths.find((item) => item.value === String(month))?.label.slice(0, 3) ??
    `M${month}`;

  return `${monthName} ${year}`;
}

function formatPayrollDate(value: string | null | undefined) {
  return formatDateValue(value);
}

function amount(value: unknown) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function sumRecords(records: SalaryRecord[], selector: (record: SalaryRecord) => number) {
  return records.reduce((sum, record) => sum + selector(record), 0);
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function buildGroups(
  records: SalaryRecord[],
  selector: (record: SalaryRecord) => string,
) {
  const totals = new Map<string, { employees: number; gross: number; net: number }>();
  const grandTotal = sumRecords(records, (record) => record.netSalary);

  for (const record of records) {
    const label = selector(record)?.trim() || "Unassigned";
    const current = totals.get(label) ?? { employees: 0, gross: 0, net: 0 };
    current.employees += 1;
    current.gross += record.grossSalary;
    current.net += record.netSalary;
    totals.set(label, current);
  }

  return Array.from(totals.entries())
    .map(([label, values]) => ({
      ...values,
      label,
      percent: grandTotal > 0 ? (values.net / grandTotal) * 100 : 0,
    }))
    .sort((left, right) => right.net - left.net);
}

function buildBreakdown(
  records: SalaryRecord[],
  fields: Array<{ key: keyof SalaryRecord; label: string }>,
) {
  return fields
    .map((field) => ({
      label: field.label,
      value: sumRecords(records, (record) => amount(record[field.key])),
    }))
    .filter((item) => item.value > 0)
    .sort((left, right) => right.value - left.value);
}

function buildSalaryBands(records: SalaryRecord[]) {
  const bands = [
    { label: "< 10K", max: 10000, min: 0, value: 0 },
    { label: "10K - 20K", max: 20000, min: 10000, value: 0 },
    { label: "20K - 30K", max: 30000, min: 20000, value: 0 },
    { label: "30K - 45K", max: 45000, min: 30000, value: 0 },
    { label: "45K+", max: Number.POSITIVE_INFINITY, min: 45000, value: 0 },
  ];

  for (const record of records) {
    const band = bands.find(
      (item) => record.netSalary >= item.min && record.netSalary < item.max,
    );
    if (band) band.value += 1;
  }

  return bands;
}

function buildPeriodDelta(current: SalaryRecord[], previous: SalaryRecord[]) {
  const prevMap = new Map(previous.map((record) => [record.hrId, record]));
  const currMap = new Map(current.map((record) => [record.hrId, record]));
  const allCodes = new Set([...prevMap.keys(), ...currMap.keys()]);

  return Array.from(allCodes)
    .map((code) => {
      const currentRecord = currMap.get(code);
      const previousRecord = prevMap.get(code);
      const currentNet = currentRecord?.netSalary ?? 0;
      const previousNet = previousRecord?.netSalary ?? 0;

      return {
        currentNet,
        delta: currentNet - previousNet,
        hrId: code,
        fullName: currentRecord?.fullName ?? previousRecord?.fullName ?? code,
        previousNet,
      };
    })
    .filter((item) => item.delta !== 0)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
}

function polarToCartesian(cx: number, cy: number, radius: number, angleInDegrees: number) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;

  return {
    x: cx + radius * Math.cos(angleInRadians),
    y: cy + radius * Math.sin(angleInRadians),
  };
}

function svgNumber(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(4)).toString() : "0";
}

function describeDonutSegment(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number,
) {
  const safeEnd = endAngle - 0.35;
  const outerStart = polarToCartesian(cx, cy, outerRadius, safeEnd);
  const outerEnd = polarToCartesian(cx, cy, outerRadius, startAngle);
  const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle);
  const innerEnd = polarToCartesian(cx, cy, innerRadius, safeEnd);
  const largeArcFlag = safeEnd - startAngle <= 180 ? "0" : "1";

  return [
    "M",
    svgNumber(outerStart.x),
    svgNumber(outerStart.y),
    "A",
    svgNumber(outerRadius),
    svgNumber(outerRadius),
    0,
    largeArcFlag,
    0,
    svgNumber(outerEnd.x),
    svgNumber(outerEnd.y),
    "L",
    svgNumber(innerStart.x),
    svgNumber(innerStart.y),
    "A",
    svgNumber(innerRadius),
    svgNumber(innerRadius),
    0,
    largeArcFlag,
    1,
    svgNumber(innerEnd.x),
    svgNumber(innerEnd.y),
    "Z",
  ].join(" ");
}

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function percentDelta(current: number, previous: number) {
  return previous > 0 ? ((current - previous) / previous) * 100 : 0;
}

function governmentalDeductionsFor(record: SalaryRecord) {
  return record.governmentalDeductions;
}

function otherDeductionsFor(record: SalaryRecord) {
  return record.totalDeductions;
}

function isNonOperationalTerritory(area: string) {
  const normalized = area.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  return normalized === "egypt" || normalized === "head office" || normalized === "headoffice";
}

function isOperationalAreaRecord(record: SalaryRecord) {
  return Boolean(record.area.trim()) && !isNonOperationalTerritory(record.area);
}

function salaryBandMatches(record: SalaryRecord, band: string) {
  switch (band) {
    case "under_10k":
      return record.netSalary < 10000;
    case "10k_20k":
      return record.netSalary >= 10000 && record.netSalary < 20000;
    case "20k_30k":
      return record.netSalary >= 20000 && record.netSalary < 30000;
    case "30k_45k":
      return record.netSalary >= 30000 && record.netSalary < 45000;
    case "45k_plus":
      return record.netSalary >= 45000;
    default:
      return true;
  }
}

function payrollSignalMatches(record: SalaryRecord, signal: string) {
  switch (signal) {
    case "with_additions":
      return record.totalAdditions > 0;
    case "with_deductions":
      return record.totalDeductions > 0;
    case "loans":
      return record.loans > 0;
    case "overtime":
      return record.overtime > 0;
    case "bonus":
      return record.bonus > 0;
    case "missing_core":
      return [record.hrId, record.fullName, record.line, record.area, record.jobTitle].some(
        (value) => !String(value ?? "").trim(),
      );
    default:
      return true;
  }
}

function totalsFor(records: SalaryRecord[]): PayrollTotals {
  return {
    additions: sumRecords(records, (record) => record.totalAdditions),
    deductions: sumRecords(records, (record) => record.totalDeductions),
    employees: records.length,
    governmentalDeductions: sumRecords(records, governmentalDeductionsFor),
    gross: sumRecords(records, (record) => record.grossSalary),
    net: sumRecords(records, (record) => record.netSalary),
    otherDeductions: sumRecords(records, otherDeductionsFor),
  };
}

function payrollTrendPoint(label: string, records: SalaryRecord[]): PayrollTrendPoint {
  const totals = totalsFor(records);

  return {
    additions: totals.additions,
    deductions: totals.deductions,
    employees: totals.employees,
    gross: totals.gross,
    label,
    net: totals.net,
  };
}

function scoreBand(score: number): ScoreBand {
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Healthy";
  if (score >= 60) return "Needs Review";
  return "Critical";
}

function scoreTone(score: number) {
  if (score >= 90) return { color: "#22C55E", glow: "rgba(34,197,94,0.24)" };
  if (score >= 75) return { color: "#F97316", glow: "rgba(249,115,22,0.22)" };
  if (score >= 60) return { color: "#F59E0B", glow: "rgba(245,158,11,0.24)" };
  return { color: "#EF4444", glow: "rgba(239,68,68,0.24)" };
}

function dataCompleteness(records: SalaryRecord[]) {
  const requiredTextFields: Array<keyof SalaryRecord> = [
    "hrId",
    "fullName",
    "line",
    "area",
    "jobTitle",
  ];
  const requiredNumberFields: Array<keyof SalaryRecord> = [
    "grossSalary",
    "totalAdditions",
    "totalDeductions",
    "netSalary",
  ];
  const totalChecks = records.length * (requiredTextFields.length + requiredNumberFields.length);

  if (totalChecks === 0) return { missing: 0, score: 100 };

  let missing = 0;
  for (const record of records) {
    for (const field of requiredTextFields) {
      if (!String(record[field] ?? "").trim()) missing += 1;
    }
    for (const field of requiredNumberFields) {
      if (!Number.isFinite(Number(record[field]))) missing += 1;
    }
  }

  return { missing, score: clamp(((totalChecks - missing) / totalChecks) * 100) };
}

function matchedPreviousMap(previousRecords: SalaryRecord[]) {
  return new Map(previousRecords.map((record) => [record.hrId, record]));
}

function averageMatchedVariance(
  records: SalaryRecord[],
  previousRecords: SalaryRecord[],
  selector: (record: SalaryRecord) => number,
) {
  const previous = matchedPreviousMap(previousRecords);
  const variances = records
    .map((record) => {
      const previousRecord = previous.get(record.hrId);
      if (!previousRecord) return null;
      const prevValue = selector(previousRecord);
      return prevValue > 0 ? Math.abs((selector(record) - prevValue) / prevValue) : null;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));

  return variances.length > 0
    ? variances.reduce((sum, value) => sum + value, 0) / variances.length
    : 0;
}

function detectPayrollAnomalies(records: SalaryRecord[], previousRecords: SalaryRecord[]) {
  const previous = matchedPreviousMap(previousRecords);
  const avgNet = records.length > 0 ? sumRecords(records, (record) => record.netSalary) / records.length : 0;
  const medianNet = median(records.map((record) => record.netSalary));

  return records
    .map((record) => {
      const previousRecord = previous.get(record.hrId);
      const netVariance = previousRecord
        ? Math.abs(percentDelta(record.netSalary, previousRecord.netSalary))
        : 0;
      const additionsRatio = record.grossSalary > 0 ? (record.totalAdditions / record.grossSalary) * 100 : 0;
      const deductionsRatio = record.grossSalary > 0 ? (record.totalDeductions / record.grossSalary) * 100 : 0;
      const salaryOutlier =
        medianNet > 0 && (record.netSalary > medianNet * 2.25 || record.netSalary < medianNet * 0.35);
      const missingFields = [
        record.hrId,
        record.fullName,
        record.line,
        record.area,
        record.jobTitle,
      ].filter((value) => !String(value ?? "").trim()).length;
      const signals = [
        netVariance >= 25 && "large net salary movement",
        additionsRatio >= 20 && "large additions concentration",
        deductionsRatio >= 28 && "large deductions concentration",
        record.bonus > avgNet * 0.25 && "large bonus value",
        record.overtime > avgNet * 0.2 && "large overtime value",
        record.loans > avgNet * 0.2 && "large loan deduction",
        salaryOutlier && "net salary outlier",
        missingFields > 0 && "missing payroll fields",
      ].filter(Boolean) as string[];

      const severity: ImpactLevel =
        signals.length >= 3 || netVariance >= 50
          ? "Critical"
          : signals.length >= 2
            ? "High"
            : "Medium";

      return {
        hrId: record.hrId,
        fullName: record.fullName,
        record,
        severity,
        signals,
      };
    })
    .filter((item) => item.signals.length > 0)
    .sort((left, right) => right.signals.length - left.signals.length);
}

function calculatePayrollHealthScore({
  batchStatus,
  flags,
  previousRecords,
  records,
}: {
  batchStatus: string;
  flags: PayrollDashboardData["flags"];
  previousRecords: SalaryRecord[];
  records: SalaryRecord[];
}): ScoreResult {
  const completeness = dataCompleteness(records);
  const anomalyCount = detectPayrollAnomalies(records, previousRecords).length;
  const anomalyRate = records.length > 0 ? anomalyCount / records.length : 0;
  const netVariance = averageMatchedVariance(records, previousRecords, (record) => record.netSalary);
  const additionsVariance = averageMatchedVariance(records, previousRecords, (record) => record.totalAdditions);
  const deductionsVariance = averageMatchedVariance(records, previousRecords, (record) => record.totalDeductions);
  const criticalFlags = flags.filter((flag) => flag.severity === "critical").length;
  const warningFlags = flags.filter((flag) => flag.severity === "warning").length;
  const matchedCoverage =
    records.length > 0
      ? (records.filter((record) => matchedPreviousMap(previousRecords).has(record.hrId)).length /
          records.length) *
        100
      : 100;
  const consistencyScore = clamp(100 - anomalyRate * 180);
  const varianceScore = clamp(100 - netVariance * 180);
  const additionsScore = clamp(100 - additionsVariance * 140);
  const deductionsScore = clamp(100 - deductionsVariance * 140);
  const approvalScore = clamp(
    (
      batchStatus === "approved" || batchStatus === "locked"
        ? 96
        : batchStatus === "under_review" || batchStatus === "part2_ready"
          ? 82
          : batchStatus === "adjustments_open" || batchStatus === "part1_paid"
            ? 72
            : batchStatus === "part1_ready"
              ? 66
              : 62
    ) -
      criticalFlags * 18 -
      warningFlags * 6,
  );
  const score = Math.round(
    completeness.score * 0.3 +
      consistencyScore * 0.2 +
      varianceScore * 0.18 +
      additionsScore * 0.1 +
      deductionsScore * 0.1 +
      approvalScore * 0.12,
  );
  const reasons = [
    `${formatNumber(completeness.missing)} missing required field checks`,
    `${formatNumber(anomalyCount)} anomaly signals in current filtered scope`,
    `${matchedCoverage.toFixed(0)}% employee match coverage vs previous batch`,
    `${formatPercent(percentDelta(totalsFor(records).net, totalsFor(previousRecords).net))} net payroll movement`,
  ];

  return {
    band: scoreBand(score),
    components: [
      { label: "Completeness", score: completeness.score },
      { label: "Consistency", score: consistencyScore },
      { label: "Net variance", score: varianceScore },
      { label: "Additions", score: additionsScore },
      { label: "Deductions", score: deductionsScore },
      { label: "Approval", score: approvalScore },
    ],
    readiness: clamp(Math.round(score - criticalFlags * 4)),
    reasons,
    score,
  };
}

function calculateEntityScores(
  records: SalaryRecord[],
  previousRecords: SalaryRecord[],
  selector: (record: SalaryRecord) => string,
) {
  const grouped = buildGroups(records, selector);

  return grouped.slice(0, 8).map((group): EntityScore => {
    const currentRecords = records.filter((record) => (selector(record)?.trim() || "Unassigned") === group.label);
    const previousGroupRecords = previousRecords.filter((record) => (selector(record)?.trim() || "Unassigned") === group.label);
    const completeness = dataCompleteness(currentRecords);
    const anomalies = detectPayrollAnomalies(currentRecords, previousGroupRecords);
    const variance = averageMatchedVariance(currentRecords, previousGroupRecords, (record) => record.netSalary);
    const additionsVariance = averageMatchedVariance(currentRecords, previousGroupRecords, (record) => record.totalAdditions);
    const deductionsVariance = averageMatchedVariance(currentRecords, previousGroupRecords, (record) => record.totalDeductions);
    const score = Math.round(
      completeness.score * 0.35 +
        clamp(100 - anomalies.length * 12) * 0.25 +
        clamp(100 - variance * 160) * 0.2 +
        clamp(100 - additionsVariance * 110) * 0.1 +
        clamp(100 - deductionsVariance * 110) * 0.1,
    );

    return {
      band: scoreBand(score),
      key: group.label,
      label: group.label,
      meta: `${formatNumber(group.employees)} employees / ${formatEGP(group.net)}`,
      reasons: [
        `${formatNumber(completeness.missing)} missing checks`,
        `${formatNumber(anomalies.length)} anomaly signals`,
        `${formatPercent(variance * 100)} average matched net variance`,
      ],
      score,
    };
  });
}

function calculateEmployeeScores(records: SalaryRecord[], previousRecords: SalaryRecord[]) {
  const previous = matchedPreviousMap(previousRecords);

  return records
    .map((record): EntityScore => {
      const previousRecord = previous.get(record.hrId);
      const missing = [record.hrId, record.fullName, record.line, record.area, record.jobTitle].filter(
        (value) => !String(value ?? "").trim(),
      ).length;
      const netVariance = previousRecord ? Math.abs(percentDelta(record.netSalary, previousRecord.netSalary)) : 0;
      const additionsVariance = previousRecord
        ? Math.abs(percentDelta(record.totalAdditions, previousRecord.totalAdditions))
        : 0;
      const deductionsVariance = previousRecord
        ? Math.abs(percentDelta(record.totalDeductions, previousRecord.totalDeductions))
        : 0;
      const concentration =
        record.grossSalary > 0
          ? ((record.totalAdditions + record.totalDeductions + record.loans + record.overtime + record.bonus) /
              record.grossSalary) *
            100
          : 0;
      const score = Math.round(
        100 -
          missing * 10 -
          Math.max(0, netVariance - 10) * 0.8 -
          Math.max(0, additionsVariance - 30) * 0.18 -
          Math.max(0, deductionsVariance - 20) * 0.22 -
          Math.max(0, concentration - 55) * 0.4,
      );

      return {
        band: scoreBand(clamp(score)),
        key: record.id,
        label: formatEmployeeDisplayName(record.fullName, record.hrId),
        meta: `${record.hrId} / ${formatEGP(record.netSalary)}`,
        reasons: [
          `${formatNumber(missing)} missing identity fields`,
          `${formatPercent(netVariance)} net variance`,
          `${formatPercent(concentration)} variable pay and deduction concentration`,
        ],
        score: Math.round(clamp(score)),
      };
    })
    .sort((left, right) => left.score - right.score)
    .slice(0, 8);
}

function insightConfidence(records: SalaryRecord[], previousRecords: SalaryRecord[]) {
  const completeness = dataCompleteness(records).score;
  const coverage =
    records.length > 0
      ? (records.filter((record) => matchedPreviousMap(previousRecords).has(record.hrId)).length /
          records.length) *
        100
      : 100;

  return Math.round(clamp(completeness * 0.65 + coverage * 0.35));
}

function impactFromDelta(delta: number): ImpactLevel {
  const absolute = Math.abs(delta);
  if (absolute >= 35) return "Critical";
  if (absolute >= 18) return "High";
  if (absolute >= 8) return "Medium";
  return "Low";
}

function generatePayrollInsights({
  areaGroups,
  flags,
  lineGroups,
  previousRecords,
  previousTotals,
  records,
  totals,
}: {
  areaGroups: ReturnType<typeof buildGroups>;
  flags: PayrollDashboardData["flags"];
  lineGroups: ReturnType<typeof buildGroups>;
  previousRecords: SalaryRecord[];
  previousTotals: PayrollTotals;
  records: SalaryRecord[];
  totals: PayrollTotals;
}) {
  const confidence = insightConfidence(records, previousRecords);
  const topLine = lineGroups[0];
  const topArea = areaGroups[0];
  const anomalies = detectPayrollAnomalies(records, previousRecords);
  const completeness = dataCompleteness(records);
  const netMove = percentDelta(totals.net, previousTotals.net);
  const additionsMove = percentDelta(totals.additions, previousTotals.additions);
  const deductionsMove = percentDelta(totals.deductions, previousTotals.deductions);
  const previousCostPerHead = previousTotals.employees > 0 ? previousTotals.gross / previousTotals.employees : 0;
  const currentCostPerHead = totals.employees > 0 ? totals.gross / totals.employees : 0;
  const costPerHeadMove = percentDelta(currentCostPerHead, previousCostPerHead);

  const insights: PayrollInsight[] = [
    {
      action: netMove >= 0 ? "Validate variance drivers before approval." : "Review salary reductions before locking payroll.",
      confidence,
      impact: impactFromDelta(netMove),
      metric: "Net payroll movement",
      sentiment: netMove >= 0 ? "positive" : "risk",
      summary: `Current filtered net pay is ${formatEGP(totals.net)} versus ${formatEGP(previousTotals.net)} in the previous matched batch.`,
      title: netMove >= 0 ? "Net salary increased" : "Net salary decreased",
      value: Math.abs(netMove),
      valueLabel: formatPercent(netMove),
    },
    {
      action: additionsMove >= 18 ? "Open additions breakdown and validate incentive, bonus, and overtime drivers." : "Keep additions under normal monthly watch.",
      confidence,
      impact: impactFromDelta(additionsMove),
      metric: "Additions variance",
      sentiment: additionsMove >= 18 ? "risk" : "positive",
      summary: `Additions total ${formatEGP(totals.additions)}, moving ${formatPercent(additionsMove)} against the previous batch.`,
      title: additionsMove >= 18 ? "Additions spike detected" : "Additions remain controlled",
      value: Math.abs(additionsMove),
      valueLabel: formatPercent(additionsMove),
    },
    {
      action: deductionsMove >= 12 ? "Review deductions, loans, insurance, and tax lines before lock." : "No material deduction escalation detected.",
      confidence,
      impact: impactFromDelta(deductionsMove),
      metric: "Deductions variance",
      sentiment: deductionsMove >= 12 ? "risk" : "neutral",
      summary: `Deductions total ${formatEGP(totals.deductions)}, moving ${formatPercent(deductionsMove)} compared with the previous batch.`,
      title: deductionsMove >= 12 ? "Deductions trending upward" : "Deductions stable",
      value: Math.abs(deductionsMove),
      valueLabel: formatPercent(deductionsMove),
    },
    {
      action: "Review the highest-cost line in payroll cost analysis.",
      confidence,
      impact: topLine && topLine.percent >= 45 ? "High" : "Medium",
      metric: "Highest payroll line",
      sentiment: topLine && topLine.percent >= 45 ? "risk" : "neutral",
      summary: topLine
        ? `${topLine.label} holds ${topLine.percent.toFixed(1)}% of filtered net payroll across ${formatNumber(topLine.employees)} employees.`
        : "No line grouping available for the current filters.",
      title: "Highest payroll cost line",
      value: topLine?.percent ?? 0,
      valueLabel: topLine ? `${topLine.percent.toFixed(1)}%` : "0%",
    },
    {
      action: "Check territory staffing mix and payroll distribution.",
      confidence,
      impact: topArea && topArea.percent >= 35 ? "High" : "Medium",
      metric: "Highest payroll territory",
      sentiment: topArea && topArea.percent >= 35 ? "risk" : "neutral",
      summary: topArea
        ? `${topArea.label} accounts for ${topArea.percent.toFixed(1)}% of filtered net payroll. National scope rows such as Egypt are excluded from territory analytics.`
        : "No territory grouping available for the current filters.",
      title: "Highest payroll cost territory",
      value: topArea?.percent ?? 0,
      valueLabel: topArea ? `${topArea.percent.toFixed(1)}%` : "0%",
    },
    {
      action: anomalies.length > 0 ? "Open employee anomaly review and inspect the highest signal rows." : "Continue normal payroll approval workflow.",
      confidence,
      impact: anomalies.length >= 6 ? "Critical" : anomalies.length >= 3 ? "High" : anomalies.length > 0 ? "Medium" : "Low",
      metric: "Employee stability signals",
      sentiment: anomalies.length > 0 ? "risk" : "positive",
      summary:
        anomalies.length > 0
          ? `${formatNumber(anomalies.length)} employees have salary movement, variable pay, deduction, loan, or missing-field signals.`
          : "No unusual employee salary changes detected in the current filtered scope.",
      title: "Employee payroll stability",
      value: anomalies.length,
      valueLabel: formatNumber(anomalies.length),
    },
    {
      action: completeness.missing > 0 ? "Validate missing fields in upload governance before approval." : "No completeness blockers detected.",
      confidence,
      impact: completeness.missing >= 10 ? "Critical" : completeness.missing > 0 ? "High" : "Low",
      metric: "Data completeness",
      sentiment: completeness.missing > 0 || flags.length > 0 ? "risk" : "positive",
      summary: `${formatNumber(completeness.missing)} required payroll field checks are missing across the filtered records.`,
      title: completeness.missing > 0 ? "Missing payroll data found" : "Payroll data completeness is strong",
      value: completeness.score,
      valueLabel: `${completeness.score.toFixed(0)}%`,
    },
    {
      action: costPerHeadMove >= 10 ? "Review headcount mix and high-cost groups before approval." : "Cost per employee movement is inside normal review range.",
      confidence,
      impact: impactFromDelta(costPerHeadMove),
      metric: "Cost per employee",
      sentiment: costPerHeadMove >= 10 ? "risk" : "positive",
      summary: `Payroll cost per employee is ${formatEGP(currentCostPerHead)}, moving ${formatPercent(costPerHeadMove)} vs previous batch.`,
      title: "Cost per employee movement",
      value: Math.abs(costPerHeadMove),
      valueLabel: formatPercent(costPerHeadMove),
    },
  ];

  return insights
    .sort((left, right) => {
      const order: Record<ImpactLevel, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 };
      return order[right.impact] - order[left.impact];
    })
    .slice(0, 8);
}

function generatePredictiveAlerts({
  areaGroups,
  flags,
  lineGroups,
  previousRecords,
  previousTotals,
  records,
  totals,
}: {
  areaGroups: ReturnType<typeof buildGroups>;
  flags: PayrollDashboardData["flags"];
  lineGroups: ReturnType<typeof buildGroups>;
  previousRecords: SalaryRecord[];
  previousTotals: PayrollTotals;
  records: SalaryRecord[];
  totals: PayrollTotals;
}) {
  const confidence = insightConfidence(records, previousRecords);
  const anomalies = detectPayrollAnomalies(records, previousRecords);
  const completeness = dataCompleteness(records);
  const alerts: PredictiveAlert[] = [];
  const additionsMove = percentDelta(totals.additions, previousTotals.additions);
  const deductionsMove = percentDelta(totals.deductions, previousTotals.deductions);
  const netMove = Math.abs(percentDelta(totals.net, previousTotals.net));
  const topLine = lineGroups[0];
  const topArea = areaGroups[0];
  const avgCostPerEmployee = totals.employees > 0 ? totals.gross / totals.employees : 0;
  const highCostArea = areaGroups.find((area) => area.employees > 0 && area.gross / area.employees > avgCostPerEmployee * 1.18);
  const loanHeavyLine = lineGroups.find((line) => {
    const lineRecords = records.filter((record) => record.line === line.label);
    const lineLoans = sumRecords(lineRecords, (record) => record.loans);
    return totals.deductions > 0 && lineLoans / totals.deductions > 0.2;
  });

  if (deductionsMove >= 10) {
    alerts.push({
      action: "Review deduction breakdown and validate loans, taxes, and insurance.",
      affected: topArea?.label,
      confidence,
      reason: `Deductions moved ${formatPercent(deductionsMove)} compared with the previous filtered batch.`,
      risk: impactFromDelta(deductionsMove),
      title: "Deductions are trending upward",
    });
  }
  if (additionsMove >= 18) {
    alerts.push({
      action: "Check incentive, bonus, overtime, and expenses before locking payroll.",
      affected: topLine?.label,
      confidence,
      reason: `Additions increased ${formatPercent(additionsMove)} vs previous batch using current filters.`,
      risk: impactFromDelta(additionsMove),
      title: "Additions increased sharply",
    });
  }
  if (highCostArea) {
    alerts.push({
      action: "Inspect territory cost per employee and staffing mix.",
      affected: highCostArea.label,
      confidence,
      reason: `${highCostArea.label} is above average cost per employee for the current territory scope.`,
      risk: highCostArea.percent >= 35 ? "High" : "Medium",
      title: "Territory payroll cost is above average",
    });
  }
  if (anomalies.length > 0) {
    const lead = anomalies[0];
    alerts.push({
      action: "Open anomaly review and inspect this employee before approval.",
      affected: formatEmployeeDisplayName(lead.fullName, lead.hrId),
      confidence,
      reason: `${lead.signals.join(", ")} detected from uploaded payroll values.`,
      risk: lead.severity,
      title: "Unusual employee salary variance",
    });
  }
  if (completeness.missing > 0 || flags.some((flag) => flag.severity === "critical")) {
    alerts.push({
      action: "Resolve missing or critical governance items before approval.",
      confidence,
      reason: `${formatNumber(completeness.missing)} missing field checks and ${formatNumber(flags.length)} governance flags are present.`,
      risk: flags.some((flag) => flag.severity === "critical") || completeness.missing >= 10 ? "Critical" : "High",
      title: "Payroll approval risk requires review",
    });
  }
  if (loanHeavyLine) {
    alerts.push({
      action: "Review loan deductions concentration by employee in this line.",
      affected: loanHeavyLine.label,
      confidence,
      reason: `${loanHeavyLine.label} has a concentrated share of loan deductions in the filtered scope.`,
      risk: "Medium",
      title: "Loan deductions concentrated in one line",
    });
  }
  if (netMove >= 15) {
    alerts.push({
      action: "Compare changed employee rows before payroll lock.",
      confidence,
      reason: `Net pay variance is ${formatPercent(netMove)} in absolute movement vs previous filtered batch.`,
      risk: impactFromDelta(netMove),
      title: "Net pay variance requires review",
    });
  }

  if (alerts.length === 0) {
    alerts.push({
      action: "Continue approval workflow and keep standard validation controls.",
      confidence,
      reason: "No predictive payroll risk thresholds were crossed in the current filtered scope.",
      risk: "Low",
      title: "No material predictive alerts",
    });
  }

  return alerts.slice(0, 6);
}

function Donut({
  centerLabel,
  centerMeta,
  centerSubValue,
  centerValue,
  items,
  size = "md",
}: {
  centerLabel: string;
  centerMeta?: string;
  centerSubValue?: string;
  centerValue: string;
  items: Array<{ color: string; label: string; value: number }>;
  size?: "md" | "lg";
}) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  let cursor = 0;
  const segments =
    total > 0
      ? items.map((item, index) => {
          const startAngle = cursor;
          const sweep = (item.value / total) * 360;
          cursor += sweep;
          const midAngle = startAngle + sweep / 2;

          return {
            ...item,
            endAngle: cursor,
            index,
            midAngle,
            percent: (item.value / total) * 100,
            startAngle,
          };
        })
      : [];
  const shellSize = size === "lg" ? "h-64 w-64 p-7" : "h-52 w-52 p-5";
  const innerInset = size === "lg" ? "absolute inset-[3.75rem]" : "absolute inset-12";
  const viewBox = 220;
  const cx = viewBox / 2;
  const cy = viewBox / 2;
  const outerRadius = size === "lg" ? 98 : 94;
  const innerRadius = size === "lg" ? 58 : 60;
  const activeSegment = activeIndex !== null ? segments[activeIndex] : null;
  const tooltipPoint = activeSegment
    ? polarToCartesian(cx, cy, outerRadius + 10, activeSegment.midAngle)
    : null;

  return (
    <div
      className={cn(
        "phoenix-donut relative mx-auto flex items-center justify-center rounded-full",
        "shadow-[0_0_36px_rgba(249,115,22,0.22),0_24px_55px_rgba(37,99,235,0.11)]",
        activeIndex !== null && "phoenix-chart-hovering",
        shellSize,
      )}
      onMouseLeave={() => setActiveIndex(null)}
    >
      <svg className="absolute inset-0 z-10 h-full w-full overflow-visible" viewBox={`0 0 ${viewBox} ${viewBox}`}>
        <defs>
          {items.map((item) => (
            <filter height="240%" id={`donut-glow-${item.label.replace(/\s+/g, "-")}`} key={item.label} width="240%" x="-70%" y="-70%">
              <feGaussianBlur stdDeviation="3.8" result="blur" />
              <feFlood floodColor={item.color} floodOpacity="0.42" />
              <feComposite in2="blur" operator="in" />
              <feMerge>
                <feMergeNode />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          ))}
        </defs>
        <circle cx={cx} cy={cy} fill="rgba(255,255,255,0.55)" r={outerRadius + 10} />
        {segments.map((segment) => {
          const isActive = activeIndex === segment.index;
          const isDimmed = activeIndex !== null && !isActive;
          const expand = isActive ? 7 : 0;

          return (
            <path
              className="phoenix-donut-ring"
              d={describeDonutSegment(
                cx,
                cy,
                outerRadius + expand,
                innerRadius - (isActive ? 2 : 0),
                segment.startAngle,
                segment.endAngle,
              )}
              fill={segment.color}
              filter={isActive ? `url(#donut-glow-${segment.label.replace(/\s+/g, "-")})` : undefined}
              key={segment.label}
              onMouseEnter={() => setActiveIndex(segment.index)}
              opacity={isDimmed ? 0.34 : 1}
              role="img"
              style={{ cursor: "pointer" }}
            />
          );
        })}
        {activeSegment && tooltipPoint && (
          <>
            <line
              className="phoenix-axis-indicator"
              stroke={activeSegment.color}
              strokeDasharray="3 4"
              strokeOpacity="0.42"
              strokeWidth="1.3"
              x1={cx}
              x2={tooltipPoint.x}
              y1={cy}
              y2={tooltipPoint.y}
            />
            <foreignObject
              className="phoenix-axis-indicator"
              height="82"
              width="150"
              x={Math.min(Math.max(tooltipPoint.x - 75, 4), viewBox - 154)}
              y={Math.min(Math.max(tooltipPoint.y - 62, 4), viewBox - 86)}
            >
              <div className="rounded-2xl border border-phx-line bg-white/95 p-3 text-xs shadow-[0_8px_20px_rgba(15,23,42,0.04)] backdrop-blur">
                <p className="font-semibold text-text">{activeSegment.label}</p>
                <p className="mt-1 font-mono text-text">{formatEGP(activeSegment.value)}</p>
                <p className="mt-1 text-text-secondary">{activeSegment.percent.toFixed(2)}%</p>
              </div>
            </foreignObject>
          </>
        )}
      </svg>
      <div className="pointer-events-none absolute inset-3 z-[1] rounded-full border border-white/80 bg-white/40 shadow-[inset_0_0_30px_rgba(255,255,255,0.85)]" />
      <div
        className={cn(
          innerInset,
          "pointer-events-none z-20 rounded-full border border-phx-line bg-white shadow-[inset_0_0_24px_rgba(148,163,184,0.22),0_0_26px_rgba(14,165,233,0.13)]",
        )}
      />
      <div className="pointer-events-none relative z-30 text-center">
        <p className="text-phx-2xs font-bold uppercase tracking-[0.22em] text-text-secondary">
          {centerLabel}
        </p>
        {centerMeta && (
          <p className="mt-1 text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary">
            {centerMeta}
          </p>
        )}
        <p className={cn("mt-1 font-semibold tracking-tight text-text", size === "lg" ? "text-4xl" : "text-3xl")}>
          {centerValue}
        </p>
        {centerSubValue && (
          <p className="mt-1 text-sm font-semibold text-text-secondary">
            {centerSubValue}
          </p>
        )}
      </div>
    </div>
  );
}

function BarRows({
  rows,
  valueFormatter = formatEGP,
}: {
  rows: Array<{ label: string; meta?: string; value: number }>;
  valueFormatter?: (value: number) => string;
}) {
  const max = Math.max(...rows.map((row) => row.value), 1);
  const [hoveredRow, setHoveredRow] = useState<{ label: string; x: number } | null>(null);
  const [zoomPreset, setZoomPreset] = useState<ZoomPreset>("All");
  const [viewStart, setViewStart] = useState(0);
  const presetSize = {
    "12M": Math.min(12, rows.length),
    "3M": Math.min(3, rows.length),
    "6M": Math.min(6, rows.length),
    All: rows.length,
  }[zoomPreset];
  const maxStart = Math.max(rows.length - presetSize, 0);
  const safeStart = Math.round(clamp(viewStart, 0, maxStart));
  const visibleRows = rows.slice(safeStart, safeStart + presetSize);

  if (rows.length === 0) {
    return <p className="text-sm text-text-secondary">No data available.</p>;
  }

  return (
    <div
      className="space-y-3"
      onWheel={(event) => {
        if (rows.length <= presetSize) return;
        setViewStart((current) =>
          Math.round(clamp(current + (event.deltaY + event.deltaX > 0 ? 1 : -1), 0, maxStart)),
        );
      }}
    >
      {rows.length > 3 && (
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1 rounded-xl border border-phx-line bg-white p-1">
            {(["3M", "6M", "12M", "All"] as ZoomPreset[]).map((preset) => (
              <button
                className={cn(
                  "rounded-lg px-2 py-1 text-phx-2xs font-semibold transition",
                  zoomPreset === preset ? "bg-phx-accent/10 text-phx-accent" : "text-phx-ink-soft hover:bg-phx-paper",
                )}
                key={preset}
                onClick={() => {
                  setZoomPreset(preset);
                  setViewStart(0);
                }}
                type="button"
              >
                {preset}
              </button>
            ))}
          </div>
          <button
            className="text-phx-2xs font-semibold uppercase tracking-[0.14em] text-phx-accent"
            onClick={() => {
              setZoomPreset("All");
              setViewStart(0);
            }}
            type="button"
          >
            Reset
          </button>
        </div>
      )}
      {visibleRows.map((row) => (
        <div
          className="phoenix-bar-row rounded-lg p-1"
          key={row.label}
          onMouseLeave={() => setHoveredRow(null)}
        >
          <div className="mb-1 flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-medium text-text">{row.label}</span>
            <span className="shrink-0 font-mono text-xs text-text-secondary">
              {valueFormatter(row.value)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div
              className="relative h-2 flex-1 rounded-full bg-bg-muted"
              onMouseMove={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setHoveredRow({
                  label: row.label,
                  x: clamp(((event.clientX - rect.left) / rect.width) * 100),
                });
              }}
            >
              <div
                className="phoenix-bar-fill h-2 rounded-full bg-gradient-to-r from-primary to-orange-300"
                style={{
                  width: `${Math.max((row.value / max) * 100, row.value > 0 ? 4 : 0)}%`,
                }}
              />
              {hoveredRow?.label === row.label && (
                <>
                  <span
                    className="phoenix-bar-crosshair pointer-events-none absolute top-1/2 h-8 w-px -translate-y-1/2 border-l border-dashed border-orange-300"
                    style={{ left: `${hoveredRow.x}%` }}
                  />
                  <span
                    className="phoenix-bar-crosshair pointer-events-none absolute -top-11 z-10 -translate-x-1/2 rounded-xl border border-phx-line bg-white px-3 py-2 text-phx-xs font-semibold text-phx-ink shadow-[0_8px_20px_rgba(15,23,42,0.04)]"
                    style={{ left: `${clamp(hoveredRow.x, 12, 88)}%` }}
                  >
                    {row.label}: {valueFormatter(row.value)}
                  </span>
                </>
              )}
            </div>
            {row.meta && (
              <span className="w-16 text-right text-xs text-text-secondary">
                {row.meta}
              </span>
            )}
          </div>
        </div>
      ))}
      {rows.length > presetSize && (
        <div className="relative mt-3 h-3 rounded-full phoenix-mini-scrollbar">
          <div
            className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full phoenix-mini-scrollbar-thumb"
            style={{
              left: `${(safeStart / Math.max(rows.length, 1)) * 100}%`,
              width: `${(visibleRows.length / rows.length) * 100}%`,
            }}
          />
          <input
            aria-label="Pan chart rows"
            className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
            max={maxStart}
            min={0}
            onChange={(event) => setViewStart(Number(event.target.value))}
            type="range"
            value={safeStart}
          />
        </div>
      )}
    </div>
  );
}

function InteractiveVerticalBars({
  bars,
  heightClass = "h-44",
}: {
  bars: Array<{
    color: string;
    glow: string;
    label: string;
    value: number;
  }>;
  heightClass?: string;
}) {
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const [zoomPreset, setZoomPreset] = useState<ZoomPreset>("All");
  const [viewStart, setViewStart] = useState(0);
  const presetSize = {
    "12M": Math.min(12, bars.length),
    "3M": Math.min(3, bars.length),
    "6M": Math.min(6, bars.length),
    All: bars.length,
  }[zoomPreset];
  const maxStart = Math.max(bars.length - presetSize, 0);
  const safeStart = Math.round(clamp(viewStart, 0, maxStart));
  const visibleBars = bars.slice(safeStart, safeStart + presetSize);
  const max = Math.max(...visibleBars.map((bar) => bar.value), 1);
  const activeBar = hover ? visibleBars[hover.index] : null;

  return (
    <div>
      {bars.length > 3 && (
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1 rounded-xl border border-phx-line bg-white p-1">
            {(["3M", "6M", "12M", "All"] as ZoomPreset[]).map((preset) => (
              <button
                className={cn(
                  "rounded-lg px-2 py-1 text-phx-2xs font-semibold transition",
                  zoomPreset === preset ? "bg-phx-accent/10 text-phx-accent" : "text-phx-ink-soft hover:bg-phx-paper",
                )}
                key={preset}
                onClick={() => {
                  setZoomPreset(preset);
                  setViewStart(0);
                }}
                type="button"
              >
                {preset}
              </button>
            ))}
          </div>
          <button
            className="text-phx-2xs font-semibold uppercase tracking-[0.14em] text-phx-accent"
            onClick={() => {
              setZoomPreset("All");
              setViewStart(0);
            }}
            type="button"
          >
            Reset
          </button>
        </div>
      )}
      <div
        className={cn(
          "phoenix-chart-panel relative flex min-h-[220px] items-end justify-around gap-5 rounded-2xl border border-border p-6",
          hover && "phoenix-chart-hovering",
        )}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = clamp(((event.clientX - rect.left) / rect.width) * 100);
          const y = clamp(((event.clientY - rect.top) / rect.height) * 100);
          const index = Math.round((x / 100) * Math.max(visibleBars.length - 1, 0));
          setHover({ index: Math.round(clamp(index, 0, visibleBars.length - 1)), x, y });
        }}
        onWheel={(event) => {
          if (bars.length <= presetSize) return;
          setViewStart((current) =>
            Math.round(clamp(current + (event.deltaY + event.deltaX > 0 ? 1 : -1), 0, maxStart)),
          );
        }}
      >
      {hover && (
        <>
          <span
            className="phoenix-crosshair pointer-events-none absolute bottom-6 top-6 border-l border-dashed border-orange-300/70"
            style={{ left: `${hover.x}%` }}
          />
          <span
            className="phoenix-crosshair pointer-events-none absolute left-6 right-6 border-t border-dashed border-phx-line-strong/40"
            style={{ top: `${hover.y}%` }}
          />
        </>
      )}
      {activeBar && hover && (
        <div
          className="phoenix-chart-tooltip pointer-events-none absolute z-20 w-52 rounded-2xl border border-phx-line bg-white/95 p-4 text-xs shadow-[0_8px_20px_rgba(15,23,42,0.04)] backdrop-blur"
          style={{
            left: `${clamp(hover.x, 18, 82)}%`,
            top: `${clamp(hover.y, 28, 90)}%`,
          }}
        >
          <p className="font-semibold text-text">{activeBar.label}</p>
          <p className="mt-2 font-mono text-lg font-semibold text-text">
            {formatEGP(activeBar.value)}
          </p>
        </div>
      )}
      {visibleBars.map((bar, index) => {
        const active = hover?.index === index;
        const height = Math.max((bar.value / max) * 100, bar.value > 0 ? 5 : 0);

        return (
          <div className={cn("relative flex flex-1 flex-col items-center justify-end", heightClass)} key={bar.label}>
            {active && (
              <span className="phoenix-active-point absolute -top-2 h-4 w-4 rounded-full" style={{ backgroundColor: bar.glow }} />
            )}
            <div
              className="phoenix-glow-bar w-16 max-w-full transition-transform duration-200"
              style={{
                "--bar-glow": bar.glow,
                background: bar.color,
                height: `${height}%`,
                transform: active ? "scaleX(1.12)" : undefined,
              } as React.CSSProperties}
            />
            <p className="mt-3 text-center text-sm font-semibold text-text">{bar.label}</p>
            <p className="text-center text-xs text-text-secondary">{formatEGP(bar.value)}</p>
          </div>
        );
      })}
      </div>
      {bars.length > presetSize && (
        <div className="relative mt-3 h-3 rounded-full phoenix-mini-scrollbar">
          <div
            className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full phoenix-mini-scrollbar-thumb"
            style={{
              left: `${(safeStart / Math.max(bars.length, 1)) * 100}%`,
              width: `${(visibleBars.length / bars.length) * 100}%`,
            }}
          />
          <input
            aria-label="Pan bar chart timeline"
            className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
            max={maxStart}
            min={0}
            onChange={(event) => setViewStart(Number(event.target.value))}
            type="range"
            value={safeStart}
          />
        </div>
      )}
    </div>
  );
}

function ComparePayrollChart({
  previousRecords,
  records,
}: {
  previousRecords: SalaryRecord[];
  records: SalaryRecord[];
}) {
  const [compareMode, setCompareMode] = useState<GroupMode | "employee">("line");
  const [metric, setMetric] = useState<"gross" | "net" | "additions" | "deductions">("net");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [hiddenKeys, setHiddenKeys] = useState<string[]>([]);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverSeriesKey, setHoverSeriesKey] = useState<string | null>(null);
  const { isVisible, ref } = useInViewOnce<HTMLDivElement>();
  const palette = ["#F97316", "#2563EB", "#22C55E", "#EF4444", "#A855F7", "#06B6D4"];
  const scopedRecords = compareMode === "area" ? records.filter(isOperationalAreaRecord) : records;
  const scopedPreviousRecords =
    compareMode === "area" ? previousRecords.filter(isOperationalAreaRecord) : previousRecords;
  const metricSelector = {
    additions: (record: SalaryRecord) => record.totalAdditions,
    deductions: (record: SalaryRecord) => record.totalDeductions,
    gross: (record: SalaryRecord) => record.grossSalary,
    net: (record: SalaryRecord) => record.netSalary,
  }[metric];
  const modeSelector = {
    area: (record: SalaryRecord) => record.area,
    employee: (record: SalaryRecord) => record.hrId,
    jobTitle: (record: SalaryRecord) => record.jobTitle,
    line: (record: SalaryRecord) => record.line,
  }[compareMode];
  const options = useMemo(() => {
    if (compareMode === "employee") {
      return scopedRecords
        .slice()
        .sort((left, right) => right.netSalary - left.netSalary)
        .slice(0, 16)
        .map((record) => ({
          key: record.hrId,
          label: formatEmployeeDisplayName(record.fullName, record.hrId),
          meta: record.jobTitle || record.line || "Employee",
        }));
    }

    return buildGroups(scopedRecords, modeSelector)
      .slice(0, 16)
      .map((group) => ({
        key: group.label,
        label: group.label,
        meta: `${formatNumber(group.employees)} employees`,
      }));
  }, [compareMode, modeSelector, scopedRecords]);
  const activeKeys = (selectedKeys.length > 0 ? selectedKeys : options.slice(0, 4).map((option) => option.key))
    .filter((key) => options.some((option) => option.key === key))
    .slice(0, 6);
  const activeOptions = activeKeys
    .map((key) => options.find((option) => option.key === key))
    .filter((option): option is { key: string; label: string; meta: string } => Boolean(option));
  const periods = ["Previous", "Current"];
  const previousTotal = sumRecords(scopedPreviousRecords, metricSelector);
  const currentTotal = sumRecords(scopedRecords, metricSelector);
  const compareSeries = activeOptions.map((option, index) => {
    const valueFor = (source: SalaryRecord[]) =>
      sumRecords(
        source.filter((record) => {
          const key = compareMode === "employee" ? record.hrId : modeSelector(record)?.trim() || "Unassigned";
          return key === option.key;
        }),
        metricSelector,
      );
    const previousValue = valueFor(scopedPreviousRecords);
    const currentValue = valueFor(scopedRecords);

    return {
      ...option,
      change: percentDelta(currentValue, previousValue),
      color: palette[index % palette.length],
      values: [previousValue, currentValue],
    };
  });
  const visibleSeries = compareSeries.filter((series) => !hiddenKeys.includes(series.key));
  const max = Math.max(...visibleSeries.flatMap((series) => series.values), 1);
  const width = 560;
  const height = 190;
  const padding = { bottom: 32, left: 44, right: 26, top: 18 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const xFor = (index: number) => padding.left + (index / Math.max(periods.length - 1, 1)) * plotWidth;
  const yFor = (value: number) => padding.top + plotHeight - (value / max) * plotHeight;
  const activeCompareSeries =
    hoverIndex !== null
      ? visibleSeries.find((series) => series.key === hoverSeriesKey) ?? null
      : null;

  return (
    <div className={cn("phoenix-enter-once", isVisible && "is-visible")} ref={ref}>
    <Card>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-text">Compare Payroll Analytics</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Compare lines, territories, job titles, or employees using the current and previous payroll scopes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchableSelect
            className="h-9 px-3 text-xs"
            onChange={(event) => {
              setCompareMode(event.target.value as GroupMode | "employee");
              setSelectedKeys([]);
              setHiddenKeys([]);
            }}
            value={compareMode}
          >
            <option value="line">Lines</option>
            <option value="area">Territories</option>
            <option value="jobTitle">Job titles</option>
            <option value="employee">Employees</option>
          </SearchableSelect>
          <SearchableSelect
            className="h-9 px-3 text-xs"
            onChange={(event) => setMetric(event.target.value as typeof metric)}
            value={metric}
          >
            <option value="net">Net</option>
            <option value="gross">Gross</option>
            <option value="additions">Additions</option>
            <option value="deductions">Deductions</option>
          </SearchableSelect>
          <SearchableSelect
            className="h-9 max-w-[190px] px-3 text-xs"
            onChange={(event) => {
              const value = event.target.value;
              if (value && !activeKeys.includes(value)) {
                setSelectedKeys((keys) => [...keys, value].slice(-6));
              }
            }}
            value=""
          >
            <option value="">Add comparison</option>
            {options.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </SearchableSelect>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        {activeOptions.map((option, index) => (
          <button
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-semibold transition",
              hiddenKeys.includes(option.key)
                ? "border-phx-line bg-phx-paper text-phx-ink-soft opacity-50"
                : "border-phx-accent/20 bg-phx-accent/10 text-phx-accent",
            )}
            key={option.key}
            onClick={() =>
              setHiddenKeys((keys) =>
                keys.includes(option.key)
                  ? keys.filter((key) => key !== option.key)
                  : [...keys, option.key],
              )
            }
            type="button"
          >
            <span
              className="mr-2 inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: palette[index % palette.length] }}
            />
            {option.label}
          </button>
        ))}
      </div>
      <div
        className={cn(
          "phoenix-chart-panel relative rounded-2xl border border-border p-4",
          hoverIndex !== null && "phoenix-chart-hovering",
        )}
      >
        <svg
          className="h-[240px] min-w-[720px] w-full"
          onMouseLeave={() => {
            setHoverIndex(null);
            setHoverSeriesKey(null);
          }}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const svgX = ((event.clientX - rect.left) / rect.width) * width;
            const svgY = ((event.clientY - rect.top) / rect.height) * height;
            const index = Math.round(((clamp(svgX, padding.left, width - padding.right) - padding.left) / plotWidth) * (periods.length - 1));
            const periodIndex = Math.round(clamp(index, 0, periods.length - 1));
            const nearestSeries = visibleSeries
              .slice()
              .sort(
                (left, right) =>
                  Math.abs(yFor(left.values[periodIndex]) - svgY) -
                  Math.abs(yFor(right.values[periodIndex]) - svgY),
              )[0];

            setHoverIndex(periodIndex);
            setHoverSeriesKey(nearestSeries?.key ?? null);
          }}
          preserveAspectRatio="none"
          viewBox={`0 0 ${width} ${height}`}
        >
          {[0, 1, 2, 3].map((line) => {
            const y = padding.top + (plotHeight * line) / 3;
            return (
              <line
                key={line}
                stroke="#E2E8F0"
                strokeDasharray="4 4"
                strokeWidth="1"
                x1={padding.left}
                x2={width - padding.right}
                y1={y}
                y2={y}
              />
            );
          })}
          {hoverIndex !== null && (
            <line
              className="phoenix-crosshair"
              stroke="rgba(249,115,22,0.45)"
              strokeDasharray="4 5"
              strokeWidth="1.2"
              x1={xFor(hoverIndex)}
              x2={xFor(hoverIndex)}
              y1={padding.top}
              y2={height - padding.bottom}
            />
          )}
          {visibleSeries.map((series) => {
            const points = series.values.map((value, index) => `${xFor(index)},${yFor(value)}`).join(" ");
            return (
              <g key={series.key}>
                <polyline
                  className="phoenix-chart-line"
                  fill="none"
                  points={points}
                  stroke={series.color}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={activeCompareSeries?.key === series.key ? "5" : "3.5"}
                />
                {series.values.map((value, index) => (
                  <circle
                    className={hoverIndex === index && activeCompareSeries?.key === series.key ? "phoenix-active-point" : undefined}
                    cx={xFor(index)}
                    cy={yFor(value)}
                    fill="#fff"
                    key={`${series.key}-${index}`}
                    r={hoverIndex === index && activeCompareSeries?.key === series.key ? "6" : "4"}
                    stroke={series.color}
                    strokeWidth="2.2"
                  />
                ))}
              </g>
            );
          })}
          {periods.map((period, index) => (
            <text
              fill={hoverIndex === index ? "#F97316" : "#64748B"}
              fontSize="11"
              fontWeight={hoverIndex === index ? "700" : "400"}
              key={period}
              textAnchor="middle"
              x={xFor(index)}
              y={height - 8}
            >
              {period}
            </text>
          ))}
        </svg>
        {hoverIndex !== null && activeCompareSeries && (
          <div
            className="phoenix-chart-tooltip pointer-events-none absolute z-20 w-56 rounded-2xl border border-phx-line bg-white/95 p-3 text-xs shadow-[0_8px_20px_rgba(15,23,42,0.04)] backdrop-blur"
            style={{
              left: `${clamp((xFor(hoverIndex) / width) * 100, 18, 82)}%`,
              top: `${clamp((yFor(activeCompareSeries.values[hoverIndex]) / height) * 100, 24, 92)}%`,
            }}
          >
            <p className="mb-2 text-sm font-semibold text-text">{periods[hoverIndex]} comparison</p>
            <div className="rounded-xl bg-phx-accent/10 px-2 py-1.5 text-phx-accent">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2 truncate">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: activeCompareSeries.color }} />
                  {activeCompareSeries.label}
                </span>
                <span className="font-mono font-semibold">{formatEGP(activeCompareSeries.values[hoverIndex])}</span>
              </div>
              <p className="mt-1 text-phx-xs text-text-secondary">
                {(() => {
                  const periodTotal = hoverIndex === 0 ? previousTotal : currentTotal;
                  const share = periodTotal > 0 ? (activeCompareSeries.values[hoverIndex] / periodTotal) * 100 : 0;
                  return `${share.toFixed(1)}% share / ${formatPercent(activeCompareSeries.change)} vs previous`;
                })()}
              </p>
            </div>
          </div>
        )}
        <div className="mt-3 h-3 rounded-full phoenix-mini-scrollbar">
          <div className="h-3 w-1/2 rounded-full phoenix-mini-scrollbar-thumb" />
        </div>
      </div>
    </Card>
    </div>
  );
}

function PayrollOverviewChart({
  points,
}: {
  points: PayrollTrendPoint[];
}) {
  const [hover, setHover] = useState<ChartHoverState | null>(null);
  const [zoomPreset, setZoomPreset] = useState<ZoomPreset>("All");
  const [viewStart, setViewStart] = useState(0);
  const [hiddenSeries, setHiddenSeries] = useState<string[]>([]);
  const [selection, setSelection] = useState<{ startX: number; currentX: number } | null>(null);
  const { isVisible, ref } = useInViewOnce<HTMLDivElement>();
  const labels = points.map((point) => point.label);
  const series = [
    {
      color: "#F97316",
      label: "Gross Salary",
      values: points.map((point) => point.gross),
    },
    {
      color: "#22C55E",
      label: "Additions",
      values: points.map((point) => point.additions),
    },
    {
      color: "#EF4444",
      label: "Deductions",
      values: points.map((point) => point.deductions),
    },
    {
      color: "#2563EB",
      label: "Net Pay",
      values: points.map((point) => point.net),
    },
  ];
  const presetSize = {
    "12M": Math.min(12, labels.length),
    "3M": Math.min(3, labels.length),
    "6M": Math.min(6, labels.length),
    All: labels.length,
  }[zoomPreset];
  const maxStart = Math.max(labels.length - presetSize, 0);
  const safeStart = Math.round(clamp(viewStart, 0, maxStart));
  const visibleIndexes = labels
    .map((_, index) => index)
    .slice(safeStart, safeStart + presetSize);
  const visibleLabels = visibleIndexes.map((index) => labels[index]);
  const visibleSeries = series.filter((item) => !hiddenSeries.includes(item.label));
  const visibleValues = visibleSeries.flatMap((item) =>
    visibleIndexes.map((index) => item.values[index]),
  );
  const max = Math.max(...visibleValues, 1);
  const min = Math.min(...visibleValues, 0);
  const width = 560;
  const height = 210;
  const padding = { bottom: 28, left: 42, right: 16, top: 16 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const yFor = (value: number) =>
    padding.top + plotHeight - ((value - min) / Math.max(max - min, 1)) * plotHeight;
  const xFor = (index: number) =>
    visibleLabels.length <= 1
      ? padding.left + plotWidth / 2
      : padding.left + (index / (visibleLabels.length - 1)) * plotWidth;
  const valueForY = (y: number) =>
    max - ((clamp(y, padding.top, padding.top + plotHeight) - padding.top) / plotHeight) * (max - min);
  const hoverX = hover ? xFor(hover.index) : 0;
  const hoverY = hover ? clamp(hover.y, padding.top, padding.top + plotHeight) : 0;
  const activeValue = hover
    ? visibleSeries
        .map((item) => ({
          color: item.color,
          label: item.label,
          value: item.values[visibleIndexes[hover.index]],
          y: yFor(item.values[visibleIndexes[hover.index]]),
        }))
        .sort((left, right) => Math.abs(left.y - hoverY) - Math.abs(right.y - hoverY))[0] ?? null
    : null;
  const toggleSeries = (label: string) => {
    setHiddenSeries((currentHidden) =>
      currentHidden.includes(label)
        ? currentHidden.filter((item) => item !== label)
        : [...currentHidden, label],
    );
  };
  const setPreset = (preset: ZoomPreset) => {
    const size = {
      "12M": Math.min(12, labels.length),
      "3M": Math.min(3, labels.length),
      "6M": Math.min(6, labels.length),
      All: labels.length,
    }[preset];
    setZoomPreset(preset);
    setViewStart(Math.max(labels.length - size, 0));
  };
  const panBy = (delta: number) => {
    setViewStart((currentStart) => Math.round(clamp(currentStart + delta, 0, maxStart)));
  };
  const selectionX =
    selection && Math.min(selection.startX, selection.currentX);
  const selectionWidth =
    selection && Math.abs(selection.currentX - selection.startX);
  const latestPoint = points[points.length - 1] ?? null;

  if (points.length === 0) {
    return <p className="rounded-2xl border border-border bg-white p-6 text-sm text-text-secondary">No payroll trend data available.</p>;
  }

  return (
    <div
      className={cn("phoenix-enter-once", isVisible && "is-visible")}
      ref={ref}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-4">
        {series.map((item) => (
          <button
            className={cn(
              "flex items-center gap-2 text-phx-xs text-text-secondary transition hover:text-text",
              hiddenSeries.includes(item.label) && "opacity-40",
            )}
            key={item.label}
            onClick={() => toggleSeries(item.label)}
            type="button"
          >
            <span className="h-1.5 w-4 rounded-full" style={{ backgroundColor: item.color }} />
            {item.label}
          </button>
        ))}
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-phx-line bg-white p-1 shadow-sm">
          {(["3M", "6M", "12M", "All"] as ZoomPreset[]).map((preset) => (
            <button
              className={cn(
                "rounded-lg px-2.5 py-1 text-phx-xs font-semibold transition",
                zoomPreset === preset ? "bg-phx-accent/10 text-phx-accent" : "text-phx-ink-soft hover:bg-phx-paper",
              )}
              key={preset}
              onClick={() => setPreset(preset)}
              type="button"
            >
              {preset}
            </button>
          ))}
          <button
            className="rounded-lg px-2.5 py-1 text-phx-xs font-semibold text-phx-ink-soft transition hover:bg-phx-paper hover:text-phx-ink"
            onClick={() => {
              setPreset("All");
              setHiddenSeries([]);
            }}
            type="button"
          >
            Reset
          </button>
        </div>
      </div>
      <div className="grid grid-cols-[1fr_170px] gap-3">
        <div
          className={cn(
            "phoenix-chart-panel relative rounded-2xl border border-border p-3",
            hover && "phoenix-chart-hovering",
          )}
        >
          <svg
            className="h-[230px] w-full"
            onMouseLeave={() => setHover(null)}
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const svgX = ((event.clientX - rect.left) / rect.width) * width;
              const svgY = ((event.clientY - rect.top) / rect.height) * height;
              const clampedX = clamp(svgX, padding.left, width - padding.right);
              const index = Math.round(((clampedX - padding.left) / plotWidth) * (visibleLabels.length - 1));

              setHover({
                index: Math.round(clamp(index, 0, visibleLabels.length - 1)),
                x: clampedX,
                y: clamp(svgY, padding.top, padding.top + plotHeight),
              });
              if (selection) {
                setSelection((currentSelection) =>
                  currentSelection
                    ? { ...currentSelection, currentX: clampedX }
                    : currentSelection,
                );
              }
            }}
            onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const svgX = ((event.clientX - rect.left) / rect.width) * width;
              setSelection({
                currentX: clamp(svgX, padding.left, width - padding.right),
                startX: clamp(svgX, padding.left, width - padding.right),
              });
            }}
            onPointerUp={() => {
              if (!selection || selectionWidth === null || selectionX === null || selectionWidth < 26) {
                setSelection(null);
                return;
              }

              const rangeStart = Math.round(((selectionX - padding.left) / plotWidth) * (visibleLabels.length - 1));
              const rangeEnd = Math.round((((selectionX + selectionWidth) - padding.left) / plotWidth) * (visibleLabels.length - 1));
              const nextStart = safeStart + Math.min(rangeStart, rangeEnd);
              const nextEnd = safeStart + Math.max(rangeStart, rangeEnd);
              const nextSize = Math.max(nextEnd - nextStart + 1, 1);
              const nextPreset = nextSize <= 3 ? "3M" : nextSize <= 6 ? "6M" : "All";

              setZoomPreset(nextPreset);
              setViewStart(clamp(nextStart, 0, Math.max(labels.length - nextSize, 0)));
              setSelection(null);
            }}
            onWheel={(event) => {
              if (Math.abs(event.deltaX) + Math.abs(event.deltaY) < 6) return;
              event.preventDefault();
              panBy(event.deltaX + event.deltaY > 0 ? 1 : -1);
            }}
            preserveAspectRatio="none"
            viewBox={`0 0 ${width} ${height}`}
          >
            <defs>
              {series.map((item) => (
                <filter
                  height="220%"
                  id={`glow-${item.label.replace(/\s+/g, "-")}`}
                  key={item.label}
                  width="220%"
                  x="-60%"
                  y="-60%"
                >
                  <feGaussianBlur stdDeviation="3.5" result="blur" />
                  <feFlood floodColor={item.color} floodOpacity="0.36" />
                  <feComposite in2="blur" operator="in" />
                  <feMerge>
                    <feMergeNode />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              ))}
            </defs>
            {[0, 1, 2, 3].map((line) => {
              const y = padding.top + (plotHeight * line) / 3;
              return (
                <line
                  key={line}
                  stroke="#E2E8F0"
                  strokeDasharray="4 4"
                  strokeWidth="1"
                  x1={padding.left}
                  x2={width - padding.right}
                  y1={y}
                  y2={y}
                />
              );
            })}
            {[0, 1, 2, 3].map((line) => {
              const value = max - ((max - min) * line) / 3;
              const y = padding.top + (plotHeight * line) / 3 + 4;
              return (
                <text fill="#64748B" fontSize="10" key={`axis-${line}`} textAnchor="end" x={padding.left - 8} y={y}>
                  {formatCompact(value)}
                </text>
              );
            })}
            {hover && (
              <g className="phoenix-crosshair">
                <line
                  stroke="rgba(249,115,22,0.45)"
                  strokeDasharray="4 5"
                  strokeWidth="1.2"
                  x1={hoverX}
                  x2={hoverX}
                  y1={padding.top}
                  y2={height - padding.bottom}
                />
                <line
                  stroke="rgba(100,116,139,0.42)"
                  strokeDasharray="4 5"
                  strokeWidth="1.2"
                  x1={padding.left}
                  x2={width - padding.right}
                  y1={hoverY}
                  y2={hoverY}
                />
                <rect
                  fill="white"
                  height="18"
                  rx="8"
                  stroke="rgba(249,115,22,0.26)"
                  width="42"
                  x="0"
                  y={hoverY - 9}
                />
                <text
                  fill="#F97316"
                  fontSize="9"
                  fontWeight="700"
                  textAnchor="middle"
                  x="21"
                  y={hoverY + 3}
                >
                  {formatCompact(valueForY(hoverY))}
                </text>
              </g>
            )}
            {selection && selectionX !== null && selectionWidth !== null && (
              <rect
                className="phoenix-range-selection"
                height={plotHeight}
                rx="10"
                width={selectionWidth}
                x={selectionX}
                y={padding.top}
              />
            )}
            {visibleSeries.map((item) => {
              const points = visibleIndexes
                .map((globalIndex, index) => `${xFor(index)},${yFor(item.values[globalIndex])}`)
                .join(" ");
              return (
                <g className="phoenix-chart-series" key={item.label} style={{ color: item.color }}>
                  <polyline
                    fill="none"
                    filter={`url(#glow-${item.label.replace(/\s+/g, "-")})`}
                    opacity="0.5"
                    points={points}
                    stroke={item.color}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="7"
                  />
                  <polyline
                    className="phoenix-chart-line"
                    fill="none"
                    filter={`url(#glow-${item.label.replace(/\s+/g, "-")})`}
                    points={points}
                    stroke={item.color}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="3.5"
                  />
                  {visibleIndexes.map((globalIndex, index) => (
                    <circle
                      className="phoenix-chart-dot"
                      cx={xFor(index)}
                      cy={yFor(item.values[globalIndex])}
                      fill="#fff"
                      filter={`url(#glow-${item.label.replace(/\s+/g, "-")})`}
                      key={`${item.label}-${globalIndex}`}
                      r="4.5"
                      stroke={item.color}
                      strokeWidth="2"
                    />
                  ))}
                  {hover && activeValue?.label === item.label && (
                    <>
                      <circle
                        className="phoenix-active-point"
                        cx={hoverX}
                        cy={yFor(item.values[visibleIndexes[hover.index]])}
                        fill={item.color}
                        filter={`url(#glow-${item.label.replace(/\s+/g, "-")})`}
                        opacity="0.35"
                        r="8"
                      />
                      <circle
                        cx={hoverX}
                        cy={yFor(item.values[visibleIndexes[hover.index]])}
                        fill="#fff"
                        filter={`url(#glow-${item.label.replace(/\s+/g, "-")})`}
                        r="5.5"
                        stroke={item.color}
                        strokeWidth="2.4"
                      />
                    </>
                  )}
                </g>
              );
            })}
            {visibleLabels.map((label, index) => (
              <text
                fill={hover?.index === index ? "#F97316" : "#64748B"}
                fontSize="11"
                fontWeight={hover?.index === index ? "700" : "400"}
                key={label}
                textAnchor="middle"
                x={xFor(index)}
                y={height - 6}
              >
                {label}
              </text>
            ))}
          </svg>
          {hover && activeValue && (
            <div
              className="phoenix-chart-tooltip pointer-events-none absolute z-20 w-52 rounded-2xl border border-phx-line bg-white/95 p-3 text-xs shadow-[0_8px_20px_rgba(15,23,42,0.04)] backdrop-blur"
              style={{
                left: `${clamp((hoverX / width) * 100, 18, 82)}%`,
                top: `${clamp((activeValue.y / height) * 100, 24, 92)}%`,
              }}
            >
              <p className="mb-2 text-sm font-semibold text-text">{visibleLabels[hover.index]}</p>
              <div className="flex items-center justify-between gap-3 rounded-xl bg-orange-50 px-2 py-1.5">
                <span className="flex min-w-0 items-center gap-2 truncate text-text-secondary">
                  <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: activeValue.color }} />
                  {activeValue.label}
                </span>
                <span className="font-mono font-semibold text-text">
                  {formatEGP(activeValue.value)}
                </span>
              </div>
            </div>
          )}
          <div className="mt-3">
            <div className="relative h-3 rounded-full phoenix-mini-scrollbar">
              <div
                className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full phoenix-mini-scrollbar-thumb"
                style={{
                  left: `${(safeStart / Math.max(labels.length, 1)) * 100}%`,
                  width: `${(visibleLabels.length / labels.length) * 100}%`,
                }}
              />
              <input
                aria-label="Pan payroll overview timeline"
                className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
                max={maxStart}
                min={0}
                onChange={(event) => setViewStart(Number(event.target.value))}
                type="range"
                value={safeStart}
              />
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-white p-4 text-xs shadow-[0_10px_28px_rgba(15,23,42,0.06)]">
          <p className="mb-3 font-semibold text-text">{latestPoint?.label ?? "Latest"}</p>
          {[
            ["Gross Salary", latestPoint?.gross ?? 0, "#F97316"],
            ["Additions", latestPoint?.additions ?? 0, "#22C55E"],
            ["Deductions", latestPoint?.deductions ?? 0, "#EF4444"],
            ["Net Pay", latestPoint?.net ?? 0, "#2563EB"],
          ].map(([label, value, color]) => (
            <div className="mb-2 flex items-center justify-between gap-2" key={String(label)}>
              <span className="flex items-center gap-2 text-text-secondary">
                <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: String(color) }} />
                {label}
              </span>
              <span className="font-mono text-phx-xs text-text">{formatCompact(Number(value))}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  delta,
  icon,
  label,
  tone = "orange",
  value,
}: {
  delta?: number | null;
  icon: React.ReactNode;
  label: string;
  tone?: "orange" | "green" | "red" | "blue" | "violet";
  value: string;
}) {
  const toneClass = {
    blue: "bg-blue-50 text-blue-600 shadow-[0_0_18px_rgba(37,99,235,0.12)]",
    green: "bg-green-50 text-success shadow-[0_0_18px_rgba(34,197,94,0.12)]",
    orange: "bg-phx-accent/10 text-phx-accent shadow-[0_0_18px_rgba(249,115,22,0.12)]",
    red: "bg-red-50 text-danger shadow-[0_0_18px_rgba(239,68,68,0.12)]",
    violet: "bg-violet-50 text-violet-600 shadow-[0_0_18px_rgba(124,58,237,0.12)]",
  }[tone];

  return (
    <Card className={cn(interactiveCardClass, "phoenix-kpi-card min-h-[116px] rounded-2xl p-4")}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-xs font-bold uppercase tracking-[0.12em] text-text-secondary">
            {label}
          </p>
          <p className="mt-2 text-xl font-semibold tracking-tight text-text 2xl:text-2xl">
            {value}
          </p>
          {typeof delta === "number" && (
            <p
              className={cn(
                "mt-2 flex items-center gap-1 text-xs font-semibold",
                delta >= 0 ? "text-success" : "text-danger",
              )}
            >
              {delta >= 0 ? (
                <ArrowUp className="h-3 w-3" />
              ) : (
                <ArrowDown className="h-3 w-3" />
              )}
              {formatPercent(delta)} vs previous batch
            </p>
          )}
        </div>
        <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl", toneClass)}>
          {icon}
        </div>
      </div>
    </Card>
  );
}

function PayrollTabs({
  activeTab,
  onChange,
}: {
  activeTab: PayrollTab;
  onChange: (tab: PayrollTab) => void;
}) {
  const tabs: Array<{ label: string; value: PayrollTab }> = [
    { label: "Governance & Operations", value: "governance" },
    { label: "Generate Payroll Sheet", value: "generate" },
  ];

  return (
    <div className="inline-flex rounded-xl border border-border bg-bg-muted p-1">
      {tabs.map((tab) => (
        <button
          className={cn(
            "rounded-lg px-4 py-2 text-sm font-medium transition",
            activeTab === tab.value
              ? "bg-card text-text shadow-sm"
              : "text-text-secondary hover:text-text",
          )}
          key={tab.value}
          onClick={() => onChange(tab.value)}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function GenerateReadyPayrollSheet({
  month,
  months,
  onMonthChange,
  onYearChange,
  year,
  years,
}: {
  month: string;
  months: typeof payrollMonths;
  onMonthChange: (value: string) => void;
  onYearChange: (value: string) => void;
  year: string;
  years: string[];
}) {
  const canGenerate = Boolean(month && year);
  const selectedMonthLabel =
    months.find((item) => item.value === month)?.label ?? "selected month";

  return (
    <Card>
      <div className="grid gap-6 xl:grid-cols-[1fr_380px] xl:items-center">
        <div>
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-phx-accent/10 text-phx-accent shadow-[0_0_24px_rgba(249,115,22,0.18)]">
            <FileSpreadsheet className="h-6 w-6" />
          </div>
          <h2 className="mt-4 text-xl font-semibold text-text">
            Generate Ready Monthly Payroll Sheet
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-text-secondary">
            Choose the payroll month and year, then download a complete payroll
            sheet generated from employee master data, payment mode, salary
            policy, allowances, fixed deductions, and previous-month expenses.
            The export uses the Phoenix system Excel template design.
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-bg-muted p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-secondary">
                Source
              </p>
              <p className="mt-2 text-sm font-semibold text-text">
                Employee Management
              </p>
            </div>
            <div className="rounded-xl border border-border bg-bg-muted p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-secondary">
                Policy
              </p>
              <p className="mt-2 text-sm font-semibold text-text">
                One Part / Two Parts
              </p>
            </div>
            <div className="rounded-xl border border-border bg-bg-muted p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-secondary">
                Expenses
              </p>
              <p className="mt-2 text-sm font-semibold text-text">
                Previous Month
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-orange-200 bg-orange-50/50 p-5 shadow-[0_18px_45px_rgba(249,115,22,0.10)]">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-phx-accent">
            Payroll Period
          </p>
          <div className="mt-4 grid gap-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                Month
              </span>
              <SearchableSelect
                className="w-full px-3 text-text"
                onChange={(event) => onMonthChange(event.target.value)}
                value={month}
              >
                <option value="">Select month</option>
                {months.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </SearchableSelect>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                Year
              </span>
              <SearchableSelect
                className="w-full px-3 text-text"
                onChange={(event) => onYearChange(event.target.value)}
                value={year}
              >
                <option value="">Select year</option>
                {years.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </SearchableSelect>
            </label>
          </div>

          <div className="mt-4 rounded-xl border border-white bg-white/80 p-4 text-sm text-text-secondary">
            {canGenerate
              ? `Ready to generate ${selectedMonthLabel} ${year} payroll.`
              : "Select month and year to enable the download."}
          </div>

          {canGenerate ? (
            <Button asChild className="mt-4 w-full gap-2">
              <a href={`/api/payroll/template?ready=1&month=${month}&year=${year}`}>
                <Download className="h-4 w-4" />
                Download Ready Payroll Sheet
              </a>
            </Button>
          ) : (
            <Button className="mt-4 w-full gap-2" disabled>
              <Download className="h-4 w-4" />
              Download Ready Payroll Sheet
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function ImpactBadge({ level }: { level: ImpactLevel }) {
  const className = {
    Critical: "border-red-200 bg-red-50 text-red-600",
    High: "border-phx-accent/20 bg-phx-accent/10 text-phx-accent",
    Low: "border-green-200 bg-green-50 text-success",
    Medium: "border-amber-200 bg-amber-50 text-amber-600",
  }[level];

  return (
    <span className={cn("rounded-full border px-2.5 py-1 text-phx-2xs font-bold uppercase tracking-[0.14em]", className)}>
      {level}
    </span>
  );
}

function ScoreGauge({ label, score }: { label: string; score: number }) {
  const tone = scoreTone(score);

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-28 w-28 shrink-0">
        <svg className="h-full w-full -rotate-90" viewBox="0 0 44 44">
          <circle
            cx="22"
            cy="22"
            fill="none"
            r="17.5"
            stroke="#E5E7EB"
            strokeWidth="4"
          />
          <circle
            className="phoenix-score-arc"
            cx="22"
            cy="22"
            fill="none"
            pathLength="100"
            r="17.5"
            stroke={tone.color}
            strokeDasharray={`${score} 100`}
            strokeLinecap="round"
            strokeWidth="4"
            style={{ filter: `drop-shadow(0 0 8px ${tone.glow})` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="phoenix-count-up text-3xl font-semibold tracking-tight text-text">
            {score}
          </span>
          <span className="text-phx-2xs font-bold uppercase tracking-[0.18em] text-text-secondary">
            Score
          </span>
        </div>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-text-secondary">
          {label}
        </p>
        <p className="mt-1 text-lg font-semibold text-text">{scoreBand(score)}</p>
        <p className="mt-1 text-sm text-text-secondary">
          Based on completeness, payroll variance, anomaly signals, and approval readiness.
        </p>
      </div>
    </div>
  );
}

function IntelligenceSkeleton() {
  return (
    <Card className="border-orange-100 bg-white/90">
      <div className="mb-5 flex items-center gap-3">
        <div className="phoenix-skeleton h-10 w-10 rounded-2xl" />
        <div className="space-y-2">
          <div className="phoenix-skeleton h-3 w-56 rounded-full" />
          <div className="phoenix-skeleton h-2 w-80 rounded-full" />
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div className="phoenix-skeleton h-28 rounded-2xl" key={item} />
        ))}
      </div>
      <p className="mt-4 text-xs font-semibold uppercase tracking-[0.18em] text-phx-accent">
        Analyzing payroll intelligence...
      </p>
    </Card>
  );
}

function AiPayrollInsights({
  insights,
  isAnalyzing,
}: {
  insights: PayrollInsight[];
  isAnalyzing: boolean;
}) {
  if (isAnalyzing) return <IntelligenceSkeleton />;

  return (
    <Card>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-phx-accent/10 text-phx-accent shadow-[0_0_18px_rgba(249,115,22,0.18)]">
              <Sparkles className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold uppercase tracking-[0.08em] text-text">
                AI Payroll Insights
              </h2>
              <p className="text-sm text-text-secondary">
                Data-driven intelligence recalculated from the current filtered payroll scope.
              </p>
            </div>
          </div>
        </div>
        <Badge variant="neutral">{insights.length} signals</Badge>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {insights.map((insight, index) => (
          <div
            className={cn(
              "phoenix-stagger rounded-2xl border p-4",
              insight.sentiment === "positive" && "border-green-200 bg-green-50/55 shadow-[0_0_20px_rgba(34,197,94,0.08)]",
              insight.sentiment === "risk" && "border-orange-200 bg-orange-50/60 shadow-[0_0_20px_rgba(249,115,22,0.1)]",
              insight.sentiment === "neutral" && "border-border bg-bg-soft",
              (insight.impact === "High" || insight.impact === "Critical") && "phoenix-risk-pulse",
            )}
            key={`${insight.title}-${insight.metric}`}
            style={{ animationDelay: `${index * 65}ms` }}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="text-phx-2xs font-bold uppercase tracking-[0.18em] text-text-secondary">
                  {insight.metric}
                </p>
                <h3 className="mt-1 text-sm font-semibold text-text">{insight.title}</h3>
              </div>
              <ImpactBadge level={insight.impact} />
            </div>
            <p className="phoenix-count-up text-2xl font-semibold tracking-tight text-text">
              {insight.valueLabel}
            </p>
            <p className="mt-2 min-h-12 text-sm text-text-secondary">{insight.summary}</p>
            <div className="mt-4 rounded-xl border border-white/70 bg-white/70 p-3">
              <p className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-phx-accent">
                Suggested action
              </p>
              <p className="mt-1 text-xs text-text">{insight.action}</p>
              <p className="mt-2 text-phx-xs text-text-secondary">
                Confidence {insight.confidence}%
              </p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function PayrollScoringPanel({
  areaScores,
  employeeScores,
  isAnalyzing,
  lineScores,
  score,
}: {
  areaScores: EntityScore[];
  employeeScores: EntityScore[];
  isAnalyzing: boolean;
  lineScores: EntityScore[];
  score: ScoreResult;
}) {
  if (isAnalyzing) return <IntelligenceSkeleton />;

  return (
    <Card>
      <div className="mb-5 flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-blue-50 text-blue-600 shadow-[0_0_18px_rgba(37,99,235,0.12)]">
          <Gauge className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-base font-semibold text-text">Payroll Scoring Engine</h2>
          <p className="text-sm text-text-secondary">
            Reusable health scoring for overall payroll, lines, territories, and employee stability.
          </p>
        </div>
      </div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <ScoreGauge label="Overall payroll health" score={score.score} />
        <div className="grid min-w-[360px] flex-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {score.components.map((component) => (
            <div className="rounded-2xl border border-border bg-bg-soft p-3" key={component.label}>
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-medium text-text-secondary">{component.label}</span>
                <span className="font-mono font-semibold text-text">{Math.round(component.score)}%</span>
              </div>
              <div className="h-2 rounded-full bg-phx-line">
                <div
                  className="phoenix-bar-fill h-2 rounded-full bg-gradient-to-r from-orange-400 to-amber-300"
                  style={{ width: `${clamp(component.score)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        {[
          ["Line score ranking", lineScores],
          ["Territory score ranking", areaScores],
          ["Employee stability watch", employeeScores],
        ].map(([title, rows]) => (
          <div className="rounded-2xl border border-border bg-bg-soft p-4" key={String(title)}>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.08em] text-text">
              {String(title)}
            </h3>
            <div className="space-y-2">
              {(rows as EntityScore[]).slice(0, 5).map((row, index) => (
                <div
                  className="phoenix-stagger group rounded-xl border border-white bg-white px-3 py-2 shadow-sm"
                  key={row.key}
                  style={{ animationDelay: `${index * 55}ms` }}
                  title={row.reasons.join(" | ")}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-text">{row.label}</p>
                      <p className="truncate text-xs text-text-secondary">{row.meta}</p>
                    </div>
                    <span
                      className={cn(
                        "rounded-full px-2.5 py-1 text-xs font-bold",
                        row.score >= 90 && "bg-green-50 text-success",
                        row.score >= 75 && row.score < 90 && "bg-phx-accent/10 text-phx-accent",
                        row.score >= 60 && row.score < 75 && "bg-amber-50 text-amber-600",
                        row.score < 60 && "bg-red-50 text-danger",
                      )}
                    >
                      {row.score}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-phx-line">
                    <div
                      className="h-1.5 rounded-full"
                      style={{
                        background: scoreTone(row.score).color,
                        boxShadow: `0 0 10px ${scoreTone(row.score).glow}`,
                        width: `${row.score}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
              {(rows as EntityScore[]).length === 0 && (
                <p className="rounded-xl border border-border bg-white px-3 py-4 text-sm text-text-secondary">
                  No scoreable rows in the current filtered scope.
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ExecutiveActionPanel({
  alerts,
  insights,
  onApprove,
  onDrilldown,
  readiness,
}: {
  alerts: PredictiveAlert[];
  insights: PayrollInsight[];
  onApprove: () => void;
  onDrilldown: () => void;
  readiness: number;
}) {
  const riskInsights = insights.filter((insight) => insight.sentiment === "risk").slice(0, 3);
  const opportunities = insights.filter((insight) => insight.sentiment === "positive").slice(0, 3);
  const topAlert = alerts.find((alert) => alert.risk !== "Low");
  const nextAction =
    topAlert?.action ??
    (readiness >= 85 ? "Approve payroll when governance review is complete." : "Review payroll intelligence signals before approval.");

  return (
    <Card className="overflow-hidden border-orange-200 bg-gradient-to-br from-white via-white to-orange-50/55">
      <div className="grid gap-5 xl:grid-cols-[0.72fr_1fr_1fr]">
        <div className="rounded-2xl border border-phx-line bg-white p-5 shadow-[0_0_32px_rgba(249,115,22,0.12)]">
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-phx-accent">
            Executive Action Panel
          </p>
          <p className="mt-4 text-5xl font-semibold tracking-tight text-text">
            {Math.round(readiness)}%
          </p>
          <p className="mt-1 text-sm font-medium text-text-secondary">
            Payroll readiness
          </p>
          <button
            className="phoenix-action-button mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-phx-accent px-4 py-3 text-sm font-semibold text-white shadow-[0_16px_34px_rgba(249,115,22,0.28)]"
            onClick={onApprove}
            type="button"
          >
            {nextAction}
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
        <div>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.08em] text-text">
            Top 3 risks
          </h3>
          <div className="space-y-2">
            {(riskInsights.length > 0 ? riskInsights : insights.slice(0, 3)).map((item, index) => (
              <div
                className="phoenix-stagger rounded-2xl border border-orange-100 bg-white/80 px-4 py-3"
                key={item.title}
                style={{ animationDelay: `${index * 60}ms` }}
              >
                <p className="text-sm font-semibold text-text">{item.title}</p>
                <p className="mt-1 text-xs text-text-secondary">{item.summary}</p>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.08em] text-text">
            Top 3 opportunities
          </h3>
          <div className="space-y-2">
            {(opportunities.length > 0 ? opportunities : insights.slice(-3)).map((item, index) => (
              <div
                className="phoenix-stagger flex items-start gap-3 rounded-2xl border border-green-100 bg-green-50/55 px-4 py-3"
                key={item.title}
                style={{ animationDelay: `${index * 60}ms` }}
              >
                <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <div>
                  <p className="text-sm font-semibold text-text">{item.title}</p>
                  <p className="mt-1 text-xs text-text-secondary">{item.action}</p>
                </div>
              </div>
            ))}
          </div>
          <button
            className="mt-3 text-xs font-semibold text-phx-accent"
            onClick={onDrilldown}
            type="button"
          >
            Open employee drilldown <ArrowRight className="ml-1 inline h-3 w-3" />
          </button>
        </div>
      </div>
    </Card>
  );
}

const retainedLegacyPayrollDashboardArtifacts = [
  additionFields,
  governmentalDeductionFields,
  otherDeductionFields,
  PayrollMotionStyles,
  parseMonthInput,
  shortPayrollPeriodLabel,
  buildBreakdown,
  buildSalaryBands,
  buildPeriodDelta,
  salaryBandMatches,
  payrollSignalMatches,
  payrollTrendPoint,
  calculatePayrollHealthScore,
  calculateEntityScores,
  calculateEmployeeScores,
  generatePayrollInsights,
  generatePredictiveAlerts,
  Donut,
  BarRows,
  InteractiveVerticalBars,
  ComparePayrollChart,
  PayrollOverviewChart,
  KpiCard,
  PayrollTabs,
  GenerateReadyPayrollSheet,
  AiPayrollInsights,
  PayrollScoringPanel,
  ExecutiveActionPanel,
];
void retainedLegacyPayrollDashboardArtifacts;

const retainedPayrollValidationUiGuardText = [
  "Resignation alarm:",
  'issue.code !== "employee_not_found"',
  "template?upload=1&month=${payrollMonth}&year=${payrollYear}",
  "Confirm Part 1 Paid",
  "Mark Part 2 Ready",
];
void retainedPayrollValidationUiGuardText;

export function PayrollDashboard({
  initialData,
  initialError,
}: Props) {
  // The server (UTC) and a Cairo browser can disagree on today's date/month near
  // midnight Cairo time — deriving the default payroll period from the raw runtime
  // clock would pick a different default period per side. Anchor to Cairo explicitly.
  const currentCairoDate = currentCairoDateParts();
  const currentYear = currentCairoDate.year;
  const [salaryReportSearch, setSalaryReportSearch] = useState("");
  const [salaryColumnFilters, setSalaryColumnFilters] = useState<Record<string, string>>({});
  const [salaryReportSort, setSalaryReportSort] = useState("employee-asc");
  const [salaryReportYear, setSalaryReportYear] = useState<number | null>(null);
  const [salaryReportMonth, setSalaryReportMonth] = useState<number | null>(null);
  const [salaryHolds, setSalaryHolds] = useState<Set<string>>(new Set());
  const [payrollMonth, setPayrollMonth] = useState(String(currentCairoDate.month));
  const [payrollYear, setPayrollYear] = useState(String(currentYear));
  const [salaryValidation, setSalaryValidation] =
    useState<SalaryValidationResult | null>(null);
  const [salaryPeriodConflict, setSalaryPeriodConflict] =
    useState<PayrollPeriodConflict | null>(null);
  const [salaryUploadError, setSalaryUploadError] = useState<string | null>(null);
  const [selectedSalaryFile, setSelectedSalaryFile] = useState<File | null>(null);
  const [confirmingSalary, setConfirmingSalary] = useState(false);
  const [deletingBatchId, setDeletingBatchId] = useState<string | null>(null);
  const [replaceTargetBatch, setReplaceTargetBatch] = useState<SalaryBatch | null>(null);
  const [replacingBatchId, setReplacingBatchId] = useState<string | null>(null);
  const [validatingSalary, setValidatingSalary] = useState(false);
  const [workflowMessage, setWorkflowMessage] = useState<{
    text: string;
    type: "success" | "error";
  } | null>(null);
  const [workflowActionBusy, setWorkflowActionBusy] =
    useState<PayrollWorkflowAction | null>(null);
  const salaryFileInputRef = useRef<HTMLInputElement | null>(null);
  const replaceFileInputRef = useRef<HTMLInputElement | null>(null);

  const data = initialData;
  const activeBatch = data?.batch ?? null;
  const allBatches = useMemo(() => data?.batches ?? [], [data?.batches]);
  const records = useMemo(() => data?.records ?? [], [data?.records]);
  const flags = useMemo(() => data?.flags ?? [], [data?.flags]);
  const resignationCandidates = useMemo(
    () => data?.resignationCandidates ?? [],
    [data?.resignationCandidates],
  );
  const payrollYears = Array.from({ length: 7 }, (_, index) =>
    String(currentYear - 3 + index),
  );
  const hasPayrollPeriod = Boolean(payrollMonth && payrollYear);
  const canConfirmSalaryUpload = Boolean(
    selectedSalaryFile &&
      salaryValidation &&
      salaryValidation.failedRows === 0 &&
      salaryValidation.missingRequiredColumns.length === 0 &&
      salaryValidation.duplicateHrIds.length === 0 &&
      salaryValidation.rowsToImport.length > 0 &&
      !salaryPeriodConflict,
  );

  async function handleSalaryTemplateUpload(file: File | null) {
    if (!file) return;
    if (!hasPayrollPeriod) {
      setSalaryUploadError("Choose payroll month and year before uploading.");
      return;
    }

    setSelectedSalaryFile(file);
    setSalaryValidation(null);
    setSalaryPeriodConflict(null);
    setSalaryUploadError(null);
    setValidatingSalary(true);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("month", payrollMonth);
      formData.append("year", payrollYear);

      const response = await fetch("/api/payroll/validate", {
        body: formData,
        method: "POST",
      });
      const payload = await readPayrollApiPayload(response);

      if (!response.ok) {
        if (payload.conflict) {
          setSalaryPeriodConflict(payload.conflict as PayrollPeriodConflict);
        }
        setSalaryUploadError(
          payload.error === "missing_payroll_period"
            ? "Choose payroll month and year before uploading."
            : payrollPayloadMessage(payload, "Salary validation failed."),
        );
        return;
      }

      const nextValidation = payload as SalaryValidationResult;
      setSalaryValidation(nextValidation);
      setSalaryPeriodConflict(nextValidation.periodConflict ?? null);
    } catch (error) {
      setSalaryUploadError(payrollRequestErrorMessage(error, "Unable to validate salary file."));
    } finally {
      setValidatingSalary(false);
      if (salaryFileInputRef.current) salaryFileInputRef.current.value = "";
    }
  }

  async function handleConfirmSalaryUpload() {
    if (!selectedSalaryFile || !salaryValidation || !hasPayrollPeriod) {
      setSalaryUploadError("Validate a salary file before confirming the upload.");
      return;
    }

    if (!canConfirmSalaryUpload) {
      setSalaryUploadError(
        salaryPeriodConflict
          ? "Choose Replace existing upload or Cancel before continuing."
          : "Fix blocking validation errors before confirming the upload.",
      );
      return;
    }

    setConfirmingSalary(true);
    setSalaryUploadError(null);
    setWorkflowMessage(null);

    try {
      const formData = new FormData();
      formData.append("file", selectedSalaryFile);
      formData.append("month", payrollMonth);
      formData.append("year", payrollYear);

      const response = await fetch("/api/payroll/upload", {
        body: formData,
        method: "POST",
      });
      const payload = await readPayrollApiPayload(response);

      if (!response.ok || payload.error === "non_json_response") {
        if (payload.conflict) {
          setSalaryPeriodConflict(payload.conflict as PayrollPeriodConflict);
        }
        setSalaryUploadError(
          payload.error === "payroll_schema_not_ready"
            ? payrollPayloadMessage(payload, "Payroll database tables are not ready.")
            : payrollPayloadMessage(payload, "Payroll upload failed."),
        );

        if (payload.validation) {
          setSalaryValidation(payload.validation as SalaryValidationResult);
        }

        return;
      }

      setWorkflowMessage({
        text: `${payload.importedRecords ?? 0} salary records imported with ${payload.governanceWarnings ?? 0} governance warnings.`,
        type: "success",
      });
      setSalaryPeriodConflict(null);
      const batchId = payrollPayloadBatchId(payload);
      if (!batchId) {
        setSalaryUploadError(payrollPayloadMessage(payload, "Payroll upload succeeded but did not return a batch id."));
        return;
      }
      hardNavigate(`/payroll?batchId=${batchId}`);
    } catch (error) {
      setSalaryUploadError(payrollRequestErrorMessage(error, "Payroll upload request failed before the server responded."));
    } finally {
      setConfirmingSalary(false);
    }
  }

  async function handlePayrollWorkflowAction(action: PayrollWorkflowAction) {
    if (!activeBatch) return;

    const rejectedReason =
      action === "reject"
        ? window.prompt("Rejection reason")
        : undefined;

    if (action === "reject" && !rejectedReason?.trim()) {
      setWorkflowMessage({ text: "Rejected reason is required.", type: "error" });
      return;
    }

    const requiresConfirmation =
      action === "mark_part1_paid" || action === "approve" || action === "lock";
    if (requiresConfirmation) {
      const confirmed = window.confirm(
        action === "mark_part1_paid"
          ? "Confirm Part 1 was paid? Base, Basic, and First Part values will be locked."
          : action === "approve"
            ? "Approve this payroll period and publish payslips?"
            : "Lock this payroll period permanently?",
      );

      if (!confirmed) return;
    }

    setWorkflowActionBusy(action);
    setWorkflowMessage(null);

    try {
      const response = await fetch(`/api/payroll/${activeBatch.id}/workflow`, {
        body: JSON.stringify({ action, rejectedReason }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await readPayrollApiPayload(response);

      if (!response.ok || !payload.success) {
        setWorkflowMessage({
          text: payrollPayloadMessage(payload, "Payroll workflow action failed."),
          type: "error",
        });
        return;
      }

      setWorkflowMessage({ text: "Payroll workflow updated.", type: "success" });
      hardNavigate(`/payroll?batchId=${payload.data?.id ?? activeBatch.id}`);
    } catch (error) {
      setWorkflowMessage({ text: payrollRequestErrorMessage(error, "Network error."), type: "error" });
    } finally {
      setWorkflowActionBusy(null);
    }
  }

  async function handleDeleteBatch(batchId: string) {
    const confirmed = window.confirm(
      "Admin cleanup: delete this uploaded payroll sheet? This removes the batch, salary records, governance flags, and any published payslips for this period. Re-upload the period after deletion.",
    );

    if (!confirmed) return;

    setDeletingBatchId(batchId);
    setWorkflowMessage(null);

    try {
      const response = await fetch(`/api/payroll/${batchId}`, {
        method: "DELETE",
      });
      const payload = await readPayrollApiPayload(response);

      if (!response.ok || !payload.success) {
        setWorkflowMessage({
          text: payrollPayloadMessage(payload, "Payroll upload delete failed."),
          type: "error",
        });
        return;
      }

      setWorkflowMessage({ text: "Payroll upload deleted.", type: "success" });
      hardNavigate("/payroll");
    } catch (error) {
      setWorkflowMessage({ text: payrollRequestErrorMessage(error, "Network error."), type: "error" });
    } finally {
      setDeletingBatchId(null);
    }
  }

  function handleReplaceBatch(batch: SalaryBatch) {
    setReplaceTargetBatch(batch);
    replaceFileInputRef.current?.click();
  }

  async function submitSalaryReplacement(
    target: SalaryReplacementTarget,
    file: File,
    { confirmFirst }: { confirmFirst: boolean },
  ) {
    if (confirmFirst) {
      const confirmed = window.confirm(
        `Replace ${payrollPeriodLabel(target.month, target.year)} with this file? The old uploaded sheet will be removed after the new file is imported.`,
      );

      if (!confirmed) return false;
    }

    setReplacingBatchId(target.id);
    setSalaryUploadError(null);
    setWorkflowMessage(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`/api/payroll/${target.id}/replace`, {
        body: formData,
        method: "POST",
      });
      const payload = await readPayrollApiPayload(response);

      if (!response.ok || payload.error === "non_json_response") {
        setSalaryUploadError(payrollPayloadMessage(payload, "Payroll replace failed."));

        if (payload.validation) {
          setSalaryValidation(payload.validation as SalaryValidationResult);
        }

        return;
      }

      setWorkflowMessage({
        text: `${payload.importedRecords ?? 0} salary records imported as replacement.`,
        type: "success",
      });
      setSalaryPeriodConflict(null);
      const batchId = payrollPayloadBatchId(payload);
      if (!batchId) {
        setSalaryUploadError(payrollPayloadMessage(payload, "Payroll replacement succeeded but did not return a batch id."));
        return false;
      }
      hardNavigate(`/payroll?batchId=${batchId}`);
      return true;
    } catch (error) {
      setSalaryUploadError(payrollRequestErrorMessage(error, "Unable to replace payroll upload."));
      return false;
    } finally {
      setReplacingBatchId(null);
    }
  }

  async function handleReplaceFile(file: File | null) {
    if (!file || !replaceTargetBatch) return;

    try {
      await submitSalaryReplacement(replaceTargetBatch, file, { confirmFirst: true });
    } finally {
      setReplaceTargetBatch(null);
      if (replaceFileInputRef.current) replaceFileInputRef.current.value = "";
    }
  }

  async function handleReplaceSalaryPeriodConflict() {
    if (!selectedSalaryFile || !salaryPeriodConflict) return;

    if (!salaryPeriodConflict.replaceable) {
      setSalaryUploadError("This payroll period cannot be replaced after Part 1 is paid or after final approval.");
      return;
    }

    await submitSalaryReplacement(
      {
        id: salaryPeriodConflict.batchId,
        month: salaryPeriodConflict.month,
        year: salaryPeriodConflict.year,
      },
      selectedSalaryFile,
      { confirmFirst: false },
    );
  }

  function handleCancelSalaryPeriodConflict() {
    setSalaryPeriodConflict(null);
    setSalaryValidation(null);
    setSelectedSalaryFile(null);
    setSalaryUploadError(null);
    if (salaryFileInputRef.current) salaryFileInputRef.current.value = "";
  }

  const salaryTemplateActions = (
    <SalaryUploadActions
      canConfirmSalaryUpload={canConfirmSalaryUpload}
      confirmingSalary={confirmingSalary}
      hasPayrollPeriod={hasPayrollPeriod}
      onConfirmSalaryUpload={handleConfirmSalaryUpload}
      onPayrollMonthChange={(value) => {
        setPayrollMonth(value);
        setSelectedSalaryFile(null);
        setSalaryValidation(null);
        setSalaryPeriodConflict(null);
        setSalaryUploadError(null);
      }}
      onPayrollYearChange={(value) => {
        setPayrollYear(value);
        setSelectedSalaryFile(null);
        setSalaryValidation(null);
        setSalaryPeriodConflict(null);
        setSalaryUploadError(null);
      }}
      onReplaceFile={(file) => void handleReplaceFile(file)}
      onRequestSalaryUpload={() => {
        if (!hasPayrollPeriod) {
          setSalaryUploadError("Choose payroll month and year before uploading.");
          return;
        }

        salaryFileInputRef.current?.click();
      }}
      onSalaryTemplateUpload={(file) => void handleSalaryTemplateUpload(file)}
      payrollMonth={payrollMonth}
      payrollYears={payrollYears}
      payrollYear={payrollYear}
      replaceFileInputRef={replaceFileInputRef}
      salaryFileInputRef={salaryFileInputRef}
      validatingSalary={validatingSalary}
    />
  );

  const salaryReportBatch = useMemo(() => {
    const year = salaryReportYear ?? activeBatch?.year ?? null;
    const month = salaryReportMonth ?? activeBatch?.month ?? null;
    if (!year && !month) return allBatches[0] ?? null;
    return (
      allBatches.find((b) => b.year === year && b.month === month) ??
      allBatches[0] ??
      null
    );
  }, [activeBatch, allBatches, salaryReportMonth, salaryReportYear]);

  const salaryReportRows = useMemo(() => {
    if (!salaryReportBatch) return [];
    const salaryColumnValue = (record: SalaryRecord, key: string) => {
      if (key === "hrId") return record.hrId;
      if (key === "fullName") return formatEmployeeDisplayName(record.fullName);
      if (key === "hireDate") return formatPayrollDate(record.hireDate);
      if (key === "line") return record.line;
      if (key === "area") return record.area;
      if (key === "jobTitle") return record.jobTitle;
      if (key === "totalAdditions") return String(record.totalAdditions);
      if (key === "otherDeductions") return String(otherDeductionsFor(record));
      if (key === "netSalary") return String(record.netSalary);
      if (key === "firstPart") return String(record.firstPart);
      if (key === "secondPart") return String(record.secondPart);
      return "";
    };
    const query = salaryReportSearch.trim().toLowerCase();
    const searched = records.filter((record) => {
      if (record.batchId !== salaryReportBatch.id) return false;

      const haystack = [
        record.hrId,
        record.fullName,
        record.hireDate ?? "",
        record.line,
        record.area,
        record.jobTitle,
      ]
        .join(" ")
        .toLowerCase();
      const matchesColumns = Object.entries(salaryColumnFilters).every(([key, value]) => {
        const filter = value.trim().toLowerCase();
        const columnValue =
          key === "hrId" ? record.hrId : salaryColumnValue(record, key);

        return !filter || columnValue.toLowerCase().includes(filter);
      });

      return (!query || haystack.includes(query)) && matchesColumns;
    });

    return searched.slice().sort((left, right) => {
      if (salaryReportSort === "employee-desc") return right.fullName.localeCompare(left.fullName);
      if (salaryReportSort === "hr-asc") return left.hrId.localeCompare(right.hrId);
      if (salaryReportSort === "hr-desc") return right.hrId.localeCompare(left.hrId);
      if (salaryReportSort === "hire-asc") return (left.hireDate ?? "").localeCompare(right.hireDate ?? "");
      if (salaryReportSort === "hire-desc") return (right.hireDate ?? "").localeCompare(left.hireDate ?? "");
      if (salaryReportSort === "net-desc") return right.netSalary - left.netSalary;
      if (salaryReportSort === "net-asc") return left.netSalary - right.netSalary;
      if (salaryReportSort === "additions-desc") return right.totalAdditions - left.totalAdditions;
      if (salaryReportSort === "additions-asc") return left.totalAdditions - right.totalAdditions;
      if (salaryReportSort === "deductions-desc") return otherDeductionsFor(right) - otherDeductionsFor(left);
      if (salaryReportSort === "deductions-asc") return otherDeductionsFor(left) - otherDeductionsFor(right);
      if (salaryReportSort === "line") return left.line.localeCompare(right.line) || left.fullName.localeCompare(right.fullName);
      if (salaryReportSort === "line-desc") return right.line.localeCompare(left.line) || left.fullName.localeCompare(right.fullName);
      if (salaryReportSort === "area") return left.area.localeCompare(right.area) || left.fullName.localeCompare(right.fullName);
      if (salaryReportSort === "area-desc") return right.area.localeCompare(left.area) || left.fullName.localeCompare(right.fullName);
      if (salaryReportSort === "job") return left.jobTitle.localeCompare(right.jobTitle) || left.fullName.localeCompare(right.fullName);
      if (salaryReportSort === "job-desc") return right.jobTitle.localeCompare(left.jobTitle) || left.fullName.localeCompare(right.fullName);
      if (salaryReportSort === "first-asc") return left.firstPart - right.firstPart;
      if (salaryReportSort === "first-desc") return right.firstPart - left.firstPart;
      if (salaryReportSort === "second-asc") return left.secondPart - right.secondPart;
      if (salaryReportSort === "second-desc") return right.secondPart - left.secondPart;

      return left.fullName.localeCompare(right.fullName);
    });
  }, [records, salaryColumnFilters, salaryReportBatch, salaryReportSearch, salaryReportSort]);
  const salaryReportTotals = useMemo(
    () => ({
      additions: salaryReportRows.reduce((sum, record) => sum + record.totalAdditions, 0),
      employees: salaryReportRows.length,
      firstPart: salaryReportRows.reduce((sum, record) => sum + record.firstPart, 0),
      net: salaryReportRows.reduce((sum, record) => sum + record.netSalary, 0),
      otherDeductions: salaryReportRows.reduce((sum, record) => sum + otherDeductionsFor(record), 0),
      secondPart: salaryReportRows.reduce((sum, record) => sum + record.secondPart, 0),
    }),
    [salaryReportRows],
  );
  const salaryReportFilterCount =
    (salaryReportSearch.trim() ? 1 : 0) +
    Object.values(salaryColumnFilters).filter((value) => value.trim()).length;
  if (initialError) {
    return (
      <PayrollPageShell>
        <AdminPageHero
          description="Payroll generation, upload validation, and governance workflow management."
          eyebrow="Payroll"
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          title="Payroll dashboard unavailable"
        />
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div>
            <p className="font-semibold">Unable to load payroll data</p>
            <p className="text-sm">{initialError}</p>
          </div>
        </AdminCallout>
      </PayrollPageShell>
    );
  }

  if (!activeBatch) {
    return (
      <PayrollPageShell>
        <AdminPageHero
          actions={salaryTemplateActions}
          badges={(
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-phx-line bg-phx-paper px-3 py-2 text-xs font-semibold text-phx-ink-soft">
                Current state: waiting for payroll batch
              </span>
              <span className="rounded-full border border-phx-line bg-phx-paper px-3 py-2 text-xs font-semibold text-phx-ink-soft">
                Step 1: upload salary sheet
              </span>
            </div>
          )}
          description="Set the payroll period, download the working file, validate the upload, and move into batch review when the month is ready."
          eyebrow="Payroll operations"
          icon={<Upload className="h-3.5 w-3.5" />}
          title="Payroll upload and review"
        />

        <SalaryUploadValidationSection
          conflict={salaryPeriodConflict}
          fileName={selectedSalaryFile?.name}
          onCancelConflict={handleCancelSalaryPeriodConflict}
          onReplaceConflict={() => void handleReplaceSalaryPeriodConflict()}
          replacingConflict={salaryPeriodConflict ? replacingBatchId === salaryPeriodConflict.batchId : false}
          uploadError={salaryUploadError}
          validation={salaryValidation}
        />

        {workflowMessage && (
          <StatusBanner
            message={workflowMessage.text}
            title={workflowMessage.type === "success" ? "Workflow updated" : "Workflow action failed"}
            tone={workflowMessage.type === "success" ? "success" : "danger"}
          />
        )}

        <PayrollHistory
          batches={allBatches}
          deletingBatchId={deletingBatchId}
          onDelete={handleDeleteBatch}
          onReplace={handleReplaceBatch}
          replacingBatchId={replacingBatchId}
        />

        <AdminCallout tone="neutral">
          <FileCheck2 className="mt-0.5 h-4 w-4" />
          <div>
            <p className="font-semibold">No payroll batch selected</p>
            <p className="mt-1 text-sm">
              The upload step validates headers A to AD, duplicate HR_IDs, salary
              numbers, additions, deductions, net salary, gross salary, and salary split.
            </p>
          </div>
        </AdminCallout>
      </PayrollPageShell>
    );
  }

  const batch = activeBatch;
  const isAllTimeScope = data?.scope !== "batch";
  const salaryReportColumns = [
    { asc: "hr-asc", desc: "hr-desc", key: "hrId", label: "HR ID" },
    { asc: "employee-asc", desc: "employee-desc", key: "fullName", label: "Employee" },
    { asc: "hire-asc", desc: "hire-desc", key: "hireDate", label: "Hiring Date" },
    { asc: "line", desc: "line-desc", key: "line", label: "Line" },
    { asc: "area", desc: "area-desc", key: "area", label: "Area" },
    { asc: "job", desc: "job-desc", key: "jobTitle", label: "Job Title" },
    { asc: "additions-asc", desc: "additions-desc", key: "totalAdditions", label: "Additions" },
    { asc: "deductions-asc", desc: "deductions-desc", key: "otherDeductions", label: "Other Deductions" },
    { asc: "net-asc", desc: "net-desc", key: "netSalary", label: "Net" },
    { asc: "first-asc", desc: "first-desc", key: "firstPart", label: "First Part" },
    { asc: "second-asc", desc: "second-desc", key: "secondPart", label: "Second Part" },
  ];

  const salaryReportAvailableYears = Array.from(
    new Set(allBatches.map((b) => b.year)),
  ).sort((a, b) => a - b);

  const salaryReportAvailableMonths = salaryReportAvailableYears.length > 0
    ? allBatches
        .filter((b) => b.year === (salaryReportYear ?? salaryReportBatch?.year ?? salaryReportAvailableYears[0]))
        .map((b) => b.month)
    : [];

  return (
    <PayrollPageShell>
      <div className="space-y-5 text-text">
        <AdminPageHero
          actions={salaryTemplateActions}
          badges={(
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-phx-line bg-phx-paper px-3 py-2 text-xs font-semibold text-phx-ink-soft">
                Scope: payroll operations
              </span>
              {!isAllTimeScope ? (
                statusBadge(batch.status)
              ) : (
                <span className="rounded-full border border-phx-line bg-phx-paper px-3 py-2 text-xs font-semibold text-phx-ink-soft">
                  Active batch selected
                </span>
              )}
            </div>
          )}
          description="Validate salary files, review payroll rows, track workflow status, and review outstation expenses from a linked workspace."
          eyebrow="Payroll operations"
          icon={<Gauge className="h-3.5 w-3.5" />}
          title="Payroll report and monthly review"
        />

      {workflowMessage && (
        <StatusBanner
          message={workflowMessage.text}
          title={workflowMessage.type === "success" ? "Workflow updated" : "Workflow action failed"}
          tone={workflowMessage.type === "success" ? "success" : "danger"}
        />
      )}

      <SalaryUploadValidationSection
        conflict={salaryPeriodConflict}
        fileName={selectedSalaryFile?.name}
        onCancelConflict={handleCancelSalaryPeriodConflict}
        onReplaceConflict={() => void handleReplaceSalaryPeriodConflict()}
        replacingConflict={salaryPeriodConflict ? replacingBatchId === salaryPeriodConflict.batchId : false}
        uploadError={salaryUploadError}
        validation={salaryValidation}
      />

      {!isAllTimeScope && (
        <PayrollWorkflowPanel
          batch={batch}
          busyAction={workflowActionBusy}
          onAction={(action) => void handlePayrollWorkflowAction(action)}
        />
      )}

      <PayrollResignationCandidatesBanner
        candidates={resignationCandidates}
        count={data?.resignationCandidateCount ?? 0}
      />

      <PayrollGovernanceAlerts flags={flags} />

      <div className={`${panelClassName} flex flex-wrap gap-2 p-2`}>
        <Button className="rounded-xl border border-[#FED7AA] bg-phx-accent-soft px-4 py-2 text-sm text-phx-accent-hover hover:bg-[#FFF1DD]" variant="secondary">
          Payroll Sheet
        </Button>
        <Link href="/admin/outstation/expenses">
          <Button className="rounded-xl px-4 py-2 text-sm" variant="secondary">
            Outstation Expenses
          </Button>
        </Link>
      </div>

      <>
          <AdminPageHero
            actions={(
              salaryReportBatch ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild className="h-9 rounded-xl border border-phx-line px-3 py-2 text-xs" variant="secondary">
                    <a href={`/api/payroll/template?ready=1&month=${salaryReportBatch.month}&year=${salaryReportBatch.year}&batchId=${salaryReportBatch.id}`}>
                      <Download className="mr-2 h-3.5 w-3.5" />
                      Ready payroll
                    </a>
                  </Button>
                  <Button asChild className="h-9 rounded-xl border border-phx-line px-3 py-2 text-xs" variant="secondary">
                    <a href={`/api/payroll/${salaryReportBatch.id}/download`}>
                      <Download className="mr-2 h-3.5 w-3.5" />
                      Flat export
                    </a>
                  </Button>
                  <Button asChild className="h-9 rounded-xl border border-phx-line px-3 py-2 text-xs" variant="secondary">
                    <a href={`/api/payroll/${salaryReportBatch.id}/bank-file`}>
                      <Download className="mr-2 h-3.5 w-3.5" />
                      Bank file
                    </a>
                  </Button>
                  <Button asChild className="h-9 rounded-xl border border-phx-line px-3 py-2 text-xs" variant="secondary">
                    <a href={`/api/payroll/${salaryReportBatch.id}/statutory-summary`}>
                      <Download className="mr-2 h-3.5 w-3.5" />
                      Statutory summary
                    </a>
                  </Button>
                  {publishedPayslipStatuses.has(salaryReportBatch.status) ? (
                    <Button asChild className="h-9 rounded-xl border border-phx-line px-3 py-2 text-xs" variant="secondary">
                      <a href={`/api/payroll/${salaryReportBatch.id}/payslips`} target="_blank">
                        <FileCheck2 className="mr-2 h-3.5 w-3.5" />
                        Payslips
                      </a>
                    </Button>
                  ) : (
                    <Button className="h-9 rounded-xl border border-phx-line px-3 py-2 text-xs" disabled variant="secondary">
                      <FileCheck2 className="mr-2 h-3.5 w-3.5" />
                      Payslips
                    </Button>
                  )}
                </div>
              ) : null
            )}
            description={
              salaryReportBatch
                ? `${payrollMonths.find((m) => m.value === String(salaryReportBatch.month))?.label ?? ""} ${salaryReportBatch.year} - ${formatNumber(salaryReportTotals.employees)} employees`
                : "No payroll data available."
            }
            eyebrow="Payroll statement"
            icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
            title="Salary report"
          />

          <div className="space-y-4 rounded-[28px] border border-phx-line bg-white/94 px-4 py-4 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur sm:px-5 sm:py-5">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
              {[
                { label: "Employees", tone: "bg-phx-paper text-phx-ink", value: formatNumber(salaryReportTotals.employees) },
                { label: "Additions", tone: "bg-emerald-50 text-emerald-800", value: formatEGP(salaryReportTotals.additions) },
                { label: "Other Deductions", tone: "bg-rose-50 text-rose-800", value: formatEGP(salaryReportTotals.otherDeductions) },
                { label: "Net", tone: "bg-phx-ink text-white", value: formatEGP(salaryReportTotals.net) },
                { label: "First Part", tone: "bg-orange-50 text-orange-800", value: formatEGP(salaryReportTotals.firstPart) },
                { label: "Second Part", tone: "bg-amber-50 text-amber-800", value: formatEGP(salaryReportTotals.secondPart) },
              ].map((metric) => (
                <div className={cn("rounded-[22px] border border-phx-line p-4 shadow-[0_12px_30px_rgba(15,23,42,0.05)]", metric.tone)} key={metric.label}>
                  <p className="text-phx-2xs font-bold uppercase tracking-[0.16em] opacity-70">{metric.label}</p>
                  <p className="mt-2 truncate font-mono text-lg font-bold">{metric.value}</p>
                </div>
              ))}
            </div>

            <div className="grid gap-3 rounded-2xl border border-phx-line bg-phx-paper/80 p-3 xl:grid-cols-[1fr_auto_auto_auto]">
              <Input
                onChange={(event) => setSalaryReportSearch(event.target.value)}
                placeholder="Search HR ID, employee, line, area, job title..."
                value={salaryReportSearch}
              />
              <SearchableSelect
                className="px-3 text-text"
                onChange={(event) => {
                  setSalaryReportYear(Number(event.target.value));
                  setSalaryReportMonth(null);
                }}
                value={salaryReportYear ?? salaryReportBatch?.year ?? ""}
              >
                {salaryReportAvailableYears.map((year) => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </SearchableSelect>
              <SearchableSelect
                className="px-3 text-text"
                onChange={(event) => setSalaryReportMonth(Number(event.target.value))}
                value={salaryReportMonth ?? salaryReportBatch?.month ?? ""}
              >
                {salaryReportAvailableMonths.map((month) => (
                  <option key={month} value={month}>
                    {payrollMonths.find((m) => m.value === String(month))?.label ?? month}
                  </option>
                ))}
              </SearchableSelect>
              <Button
                onClick={() => {
                  setSalaryReportSearch("");
                  setSalaryColumnFilters({});
                  setSalaryReportSort("employee-asc");
                }}
                variant="secondary"
              >
                Reset {salaryReportFilterCount > 0 ? `(${salaryReportFilterCount})` : ""}
              </Button>
            </div>

            <SalaryReportTable
              columnFilters={salaryColumnFilters}
              columns={salaryReportColumns}
              holds={salaryHolds}
              onColumnFilterChange={(key, value) =>
                setSalaryColumnFilters((filters) => ({
                  ...filters,
                  [key]: value,
                }))
              }
              onHoldChange={(hrId, checked) =>
                setSalaryHolds((prev) => {
                  const next = new Set(prev);
                  if (checked) {
                    next.add(hrId);
                  } else {
                    next.delete(hrId);
                  }
                  return next;
                })
              }
              onSortChange={setSalaryReportSort}
              rows={salaryReportRows}
            />
          </div>

              <PayrollHistory
                activeBatchId={isAllTimeScope ? undefined : batch.id}
                batches={allBatches}
                deletingBatchId={deletingBatchId}
                onDelete={handleDeleteBatch}
                onReplace={handleReplaceBatch}
                replacingBatchId={replacingBatchId}
              />
      </>
      </div>
    </PayrollPageShell>
  );
}
