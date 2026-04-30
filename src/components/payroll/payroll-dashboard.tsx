"use client";

import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BarChart3,
  Bell,
  CalendarDays,
  CheckCircle,
  Download,
  DollarSign,
  FileCheck2,
  FileSpreadsheet,
  Gauge,
  Landmark,
  Layers3,
  Loader2,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  TrendingUp,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type {
  PayrollDashboardData,
  SalaryBatch,
  SalaryRecord,
} from "@/lib/payroll/types";
import { cn } from "@/lib/utils";

type Props = {
  initialData: PayrollDashboardData | null;
  initialError: string | null;
  initialTab?: PayrollTab;
};

type SalaryValidationIssue = {
  code: string;
  column?: string;
  employeeCode?: string;
  message: string;
  row: number;
};

type SalaryValidationResult = {
  detectedColumns: string[];
  duplicateHrIds: string[];
  failedRows: number;
  missingRequiredColumns: string[];
  payrollPeriod: {
    month: number;
    year: number;
  };
  rowsToImport: Array<{
    area: string;
    employeeCode: string;
    fullName: string;
    jobTitle: string;
    line: string;
    monthSalary: number;
    row: number;
  }>;
  totalRows: number;
  validRows: number;
  validationErrors: SalaryValidationIssue[];
  validationWarnings: SalaryValidationIssue[];
  warningRows: number;
};

type PayrollTab = "dashboard" | "governance" | "generate";
type GroupMode = "line" | "area" | "jobTitle";
type ImpactLevel = "Low" | "Medium" | "High" | "Critical";
type InsightSentiment = "positive" | "neutral" | "risk";

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

const payrollMonths = [
  { label: "January", value: "1" },
  { label: "February", value: "2" },
  { label: "March", value: "3" },
  { label: "April", value: "4" },
  { label: "May", value: "5" },
  { label: "June", value: "6" },
  { label: "July", value: "7" },
  { label: "August", value: "8" },
  { label: "September", value: "9" },
  { label: "October", value: "10" },
  { label: "November", value: "11" },
  { label: "December", value: "12" },
];

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
        border-radius: 18px 18px 6px 6px;
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
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(Number.isFinite(value) ? value : 0);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    Number.isFinite(value) ? value : 0,
  );
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

function payrollPeriodLabel(month: number, year: number) {
  const monthName =
    payrollMonths.find((item) => item.value === String(month))?.label ??
    `Month ${month}`;

  return `${monthName} ${year}`;
}

function payrollPeriodIndex(month: number, year: number) {
  return year * 12 + month;
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

function statusBadge(status: string) {
  switch (status) {
    case "approved":
      return <Badge variant="success">Approved</Badge>;
    case "locked":
      return <Badge variant="success">Locked</Badge>;
    case "rejected":
      return <Badge variant="danger">Rejected</Badge>;
    case "under_review":
      return <Badge variant="warning">Under Review</Badge>;
    default:
      return <Badge variant="neutral">Uploaded</Badge>;
  }
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
  const prevMap = new Map(previous.map((record) => [record.employeeCode, record]));
  const currMap = new Map(current.map((record) => [record.employeeCode, record]));
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
        employeeCode: code,
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
  return record.socialInsurance + record.employmentIncomeTax;
}

function otherDeductionsFor(record: SalaryRecord) {
  return Math.max(0, record.totalDeductions - governmentalDeductionsFor(record));
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
      return [record.employeeCode, record.fullName, record.line, record.area, record.jobTitle].some(
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
    "employeeCode",
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
  return new Map(previousRecords.map((record) => [record.employeeCode, record]));
}

function averageMatchedVariance(
  records: SalaryRecord[],
  previousRecords: SalaryRecord[],
  selector: (record: SalaryRecord) => number,
) {
  const previous = matchedPreviousMap(previousRecords);
  const variances = records
    .map((record) => {
      const previousRecord = previous.get(record.employeeCode);
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
      const previousRecord = previous.get(record.employeeCode);
      const netVariance = previousRecord
        ? Math.abs(percentDelta(record.netSalary, previousRecord.netSalary))
        : 0;
      const additionsRatio = record.grossSalary > 0 ? (record.totalAdditions / record.grossSalary) * 100 : 0;
      const deductionsRatio = record.grossSalary > 0 ? (record.totalDeductions / record.grossSalary) * 100 : 0;
      const salaryOutlier =
        medianNet > 0 && (record.netSalary > medianNet * 2.25 || record.netSalary < medianNet * 0.35);
      const missingFields = [
        record.employeeCode,
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
        employeeCode: record.employeeCode,
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
      ? (records.filter((record) => matchedPreviousMap(previousRecords).has(record.employeeCode)).length /
          records.length) *
        100
      : 100;
  const consistencyScore = clamp(100 - anomalyRate * 180);
  const varianceScore = clamp(100 - netVariance * 180);
  const additionsScore = clamp(100 - additionsVariance * 140);
  const deductionsScore = clamp(100 - deductionsVariance * 140);
  const approvalScore = clamp(
    (batchStatus === "approved" || batchStatus === "locked" ? 96 : batchStatus === "under_review" ? 78 : 62) -
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
      const previousRecord = previous.get(record.employeeCode);
      const missing = [record.employeeCode, record.fullName, record.line, record.area, record.jobTitle].filter(
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
        label: record.fullName || record.employeeCode,
        meta: `${record.employeeCode} / ${formatEGP(record.netSalary)}`,
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
      ? (records.filter((record) => matchedPreviousMap(previousRecords).has(record.employeeCode)).length /
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
      affected: lead.fullName || lead.employeeCode,
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
              <div className="rounded-2xl border border-slate-200 bg-white/95 p-3 text-xs shadow-[0_18px_44px_rgba(15,23,42,0.16)] backdrop-blur">
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
          "pointer-events-none z-20 rounded-full border border-slate-100 bg-white shadow-[inset_0_0_24px_rgba(148,163,184,0.22),0_0_26px_rgba(14,165,233,0.13)]",
        )}
      />
      <div className="pointer-events-none relative z-30 text-center">
        <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-text-secondary">
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
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1">
            {(["3M", "6M", "12M", "All"] as ZoomPreset[]).map((preset) => (
              <button
                className={cn(
                  "rounded-lg px-2 py-1 text-[10px] font-semibold transition",
                  zoomPreset === preset ? "bg-orange-50 text-primary" : "text-text-secondary hover:bg-slate-50",
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
            className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary"
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
                    className="phoenix-bar-crosshair pointer-events-none absolute -top-11 z-10 -translate-x-1/2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] font-semibold text-text shadow-[0_14px_34px_rgba(15,23,42,0.14)]"
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
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1">
            {(["3M", "6M", "12M", "All"] as ZoomPreset[]).map((preset) => (
              <button
                className={cn(
                  "rounded-lg px-2 py-1 text-[10px] font-semibold transition",
                  zoomPreset === preset ? "bg-orange-50 text-primary" : "text-text-secondary hover:bg-slate-50",
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
            className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary"
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
            className="phoenix-crosshair pointer-events-none absolute left-6 right-6 border-t border-dashed border-slate-400/40"
            style={{ top: `${hover.y}%` }}
          />
        </>
      )}
      {activeBar && hover && (
        <div
          className="phoenix-chart-tooltip pointer-events-none absolute z-20 w-52 rounded-2xl border border-slate-200 bg-white/95 p-4 text-xs shadow-[0_22px_55px_rgba(15,23,42,0.16)] backdrop-blur"
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
    employee: (record: SalaryRecord) => record.employeeCode,
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
          key: record.employeeCode,
          label: record.fullName || record.employeeCode,
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
          const key = compareMode === "employee" ? record.employeeCode : modeSelector(record)?.trim() || "Unassigned";
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
          <select
            className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-xs text-text shadow-sm"
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
          </select>
          <select
            className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-xs text-text shadow-sm"
            onChange={(event) => setMetric(event.target.value as typeof metric)}
            value={metric}
          >
            <option value="net">Net</option>
            <option value="gross">Gross</option>
            <option value="additions">Additions</option>
            <option value="deductions">Deductions</option>
          </select>
          <select
            className="h-9 max-w-[190px] rounded-xl border border-slate-200 bg-white px-3 text-xs text-text shadow-sm"
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
          </select>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        {activeOptions.map((option, index) => (
          <button
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-semibold transition",
              hiddenKeys.includes(option.key)
                ? "border-slate-200 bg-slate-50 text-text-secondary opacity-50"
                : "border-orange-200 bg-orange-50 text-primary",
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
            className="phoenix-chart-tooltip pointer-events-none absolute z-20 w-56 rounded-2xl border border-slate-200 bg-white/95 p-3 text-xs shadow-[0_18px_44px_rgba(15,23,42,0.16)] backdrop-blur"
            style={{
              left: `${clamp((xFor(hoverIndex) / width) * 100, 18, 82)}%`,
              top: `${clamp((yFor(activeCompareSeries.values[hoverIndex]) / height) * 100, 24, 92)}%`,
            }}
          >
            <p className="mb-2 text-sm font-semibold text-text">{periods[hoverIndex]} comparison</p>
            <div className="rounded-xl bg-orange-50 px-2 py-1.5 text-primary">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2 truncate">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: activeCompareSeries.color }} />
                  {activeCompareSeries.label}
                </span>
                <span className="font-mono font-semibold">{formatEGP(activeCompareSeries.values[hoverIndex])}</span>
              </div>
              <p className="mt-1 text-[11px] text-text-secondary">
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
              "flex items-center gap-2 text-[11px] text-text-secondary transition hover:text-text",
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
        <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          {(["3M", "6M", "12M", "All"] as ZoomPreset[]).map((preset) => (
            <button
              className={cn(
                "rounded-lg px-2.5 py-1 text-[11px] font-semibold transition",
                zoomPreset === preset ? "bg-orange-50 text-primary" : "text-text-secondary hover:bg-slate-50",
              )}
              key={preset}
              onClick={() => setPreset(preset)}
              type="button"
            >
              {preset}
            </button>
          ))}
          <button
            className="rounded-lg px-2.5 py-1 text-[11px] font-semibold text-text-secondary transition hover:bg-slate-50 hover:text-text"
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
              className="phoenix-chart-tooltip pointer-events-none absolute z-20 w-52 rounded-2xl border border-slate-200 bg-white/95 p-3 text-xs shadow-[0_18px_44px_rgba(15,23,42,0.16)] backdrop-blur"
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
              <span className="font-mono text-[11px] text-text">{formatCompact(Number(value))}</span>
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
    orange: "bg-orange-50 text-primary shadow-[0_0_18px_rgba(249,115,22,0.12)]",
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
    { label: "Generate Ready Monthly Payroll Sheet", value: "generate" },
    { label: "Upload & Governance", value: "governance" },
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
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-primary shadow-[0_0_24px_rgba(249,115,22,0.18)]">
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
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-primary">
            Payroll Period
          </p>
          <div className="mt-4 grid gap-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                Month
              </span>
              <select
                className="h-11 w-full rounded-xl border border-border bg-white px-3 text-sm text-text shadow-sm focus:outline-none"
                onChange={(event) => onMonthChange(event.target.value)}
                value={month}
              >
                <option value="">Select month</option>
                {months.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                Year
              </span>
              <select
                className="h-11 w-full rounded-xl border border-border bg-white px-3 text-sm text-text shadow-sm focus:outline-none"
                onChange={(event) => onYearChange(event.target.value)}
                value={year}
              >
                <option value="">Select year</option>
                {years.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-4 rounded-xl border border-white bg-white/80 p-4 text-sm text-text-secondary">
            {canGenerate
              ? `Ready to generate ${selectedMonthLabel} ${year} payroll.`
              : "Select month and year to enable the download."}
          </div>

          {canGenerate ? (
            <Link href={`/api/payroll/template?ready=1&month=${month}&year=${year}`}>
              <Button className="mt-4 w-full gap-2">
                <Download className="h-4 w-4" />
                Download Ready Payroll Sheet
              </Button>
            </Link>
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
    High: "border-orange-200 bg-orange-50 text-primary",
    Low: "border-green-200 bg-green-50 text-success",
    Medium: "border-amber-200 bg-amber-50 text-amber-600",
  }[level];

  return (
    <span className={cn("rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em]", className)}>
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
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-text-secondary">
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
      <p className="mt-4 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
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
            <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-orange-50 text-primary shadow-[0_0_18px_rgba(249,115,22,0.18)]">
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
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-text-secondary">
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
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary">
                Suggested action
              </p>
              <p className="mt-1 text-xs text-text">{insight.action}</p>
              <p className="mt-2 text-[11px] text-text-secondary">
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
              <div className="h-2 rounded-full bg-slate-200">
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
                        row.score >= 75 && row.score < 90 && "bg-orange-50 text-primary",
                        row.score >= 60 && row.score < 75 && "bg-amber-50 text-amber-600",
                        row.score < 60 && "bg-red-50 text-danger",
                      )}
                    >
                      {row.score}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-slate-200">
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
        <div className="rounded-3xl border border-orange-200 bg-white p-5 shadow-[0_0_32px_rgba(249,115,22,0.12)]">
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
            Executive Action Panel
          </p>
          <p className="mt-4 text-5xl font-semibold tracking-tight text-text">
            {Math.round(readiness)}%
          </p>
          <p className="mt-1 text-sm font-medium text-text-secondary">
            Payroll readiness
          </p>
          <button
            className="phoenix-action-button mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-white shadow-[0_16px_34px_rgba(249,115,22,0.28)]"
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
            className="mt-3 text-xs font-semibold text-primary"
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

function ValidationSummary({ result }: { result: SalaryValidationResult }) {
  const issuePreview = [
    ...result.validationErrors.map((issue) => ({ ...issue, severity: "error" })),
    ...result.validationWarnings.map((issue) => ({
      ...issue,
      severity: "warning",
    })),
  ].slice(0, 12);

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text">
            Salary Upload Validation
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            {payrollPeriodLabel(
              result.payrollPeriod.month,
              result.payrollPeriod.year,
            )}{" "}
            was checked before import.
          </p>
        </div>
        <Badge variant={result.failedRows === 0 ? "success" : "danger"}>
          {result.failedRows === 0 ? "Ready" : "Needs fixes"}
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ["Rows", result.totalRows],
          ["Valid", result.validRows],
          ["Warnings", result.warningRows],
          ["Failed", result.failedRows],
        ].map(([label, value]) => (
          <div className="rounded-xl border border-border bg-bg-muted p-3" key={label}>
            <p className="text-xs text-text-secondary">{label}</p>
            <p className="mt-1 text-xl font-semibold text-text">{value}</p>
          </div>
        ))}
      </div>

      {result.missingRequiredColumns.length > 0 && (
        <div className="mt-4 rounded-lg border border-danger/20 bg-red-50 p-3 text-sm text-danger dark:bg-red-950/20">
          Missing headers: {result.missingRequiredColumns.join(", ")}
        </div>
      )}

      {result.duplicateHrIds.length > 0 && (
        <div className="mt-4 rounded-lg border border-danger/20 bg-red-50 p-3 text-sm text-danger dark:bg-red-950/20">
          Duplicate HR_IDs: {result.duplicateHrIds.join(", ")}
        </div>
      )}

      <div className="mt-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-secondary">
          Detected Columns
        </p>
        <div className="flex flex-wrap gap-2">
          {result.detectedColumns.map((column) => (
            <Badge key={column} variant="neutral">
              {column}
            </Badge>
          ))}
        </div>
      </div>

      {issuePreview.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-border">
                {["Row", "HR ID", "Column", "Type", "Message"].map((column) => (
                  <th
                    className="pb-2 pr-4 font-medium text-text-secondary"
                    key={column}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {issuePreview.map((issue, index) => (
                <tr key={`${issue.row}-${issue.code}-${index}`}>
                  <td className="py-2 pr-4 font-mono text-xs text-text-secondary">
                    {issue.row}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-text-secondary">
                    {issue.employeeCode ?? "-"}
                  </td>
                  <td className="py-2 pr-4 text-text-secondary">
                    {issue.column ?? "-"}
                  </td>
                  <td className="py-2 pr-4">
                    <Badge
                      variant={
                        issue.severity === "error" ? "danger" : "warning"
                      }
                    >
                      {issue.code}
                    </Badge>
                  </td>
                  <td className="py-2 pr-4 text-text">{issue.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PayrollHistory({
  activeBatchId,
  batches,
  deletingBatchId,
  onDelete,
}: {
  activeBatchId?: string;
  batches: SalaryBatch[];
  deletingBatchId: string | null;
  onDelete: (batchId: string) => void;
}) {
  if (batches.length === 0) return null;

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text">
            Uploaded Files History
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            Review payroll runs and delete incorrect batches before approval.
          </p>
        </div>
        <Badge variant="neutral">{batches.length} files</Badge>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-border">
              {["Period", "File", "Status", "Uploaded", "Action"].map((column) => (
                <th className="pb-3 pr-4 font-medium text-text-secondary" key={column}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {batches.map((batch) => (
              <tr
                className={cn(
                  "transition-colors hover:bg-bg-muted",
                  activeBatchId === batch.id && "bg-orange-50/70 dark:bg-orange-950/10",
                )}
                key={batch.id}
              >
                <td className="py-3 pr-4 font-medium text-text">
                  <a href={`/payroll?batchId=${batch.id}`}>
                    {payrollPeriodLabel(batch.month, batch.year)}
                  </a>
                </td>
                <td className="max-w-[260px] truncate py-3 pr-4 text-text-secondary">
                  {batch.fileName}
                </td>
                <td className="py-3 pr-4">{statusBadge(batch.status)}</td>
                <td className="py-3 pr-4 text-text-secondary">
                  {new Date(batch.createdAt).toLocaleString()}
                </td>
                <td className="py-3 pr-4">
                  <Button
                    className="px-3 py-1.5 text-xs"
                    disabled={deletingBatchId === batch.id || batch.status === "locked"}
                    onClick={() => onDelete(batch.id)}
                    variant="secondary"
                  >
                    {deletingBatchId === batch.id ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                    )}
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function PayrollDashboard({
  initialData,
  initialError,
  initialTab = "governance",
}: Props) {
  const currentYear = new Date().getFullYear();
  const [search, setSearch] = useState("");
  const [lineFilter, setLineFilter] = useState("__all__");
  const [areaFilter, setAreaFilter] = useState("__all__");
  const [jobTitleFilter, setJobTitleFilter] = useState("__all__");
  const [employeeFilter, setEmployeeFilter] = useState("__all__");
  const [salaryBandFilter, setSalaryBandFilter] = useState("__all__");
  const [batchStatusFilter, setBatchStatusFilter] = useState("__all__");
  const [payrollSignalFilter, setPayrollSignalFilter] = useState("__all__");
  const [periodFromFilter, setPeriodFromFilter] = useState("");
  const [periodToFilter, setPeriodToFilter] = useState("");
  const [groupMode, setGroupMode] = useState<GroupMode>("line");
  const [isAnalyzingIntelligence, setIsAnalyzingIntelligence] = useState(false);
  const [payrollMonth, setPayrollMonth] = useState("");
  const [payrollYear, setPayrollYear] = useState("");
  const [generateMonth, setGenerateMonth] = useState("");
  const [generateYear, setGenerateYear] = useState(String(currentYear));
  const [activePayrollTab, setActivePayrollTab] = useState<PayrollTab>(initialTab);
  const [showAnomalyReview, setShowAnomalyReview] = useState(false);
  const [salaryValidation, setSalaryValidation] =
    useState<SalaryValidationResult | null>(null);
  const [salaryUploadError, setSalaryUploadError] = useState<string | null>(null);
  const [selectedSalaryFile, setSelectedSalaryFile] = useState<File | null>(null);
  const [confirmingSalary, setConfirmingSalary] = useState(false);
  const [deletingBatchId, setDeletingBatchId] = useState<string | null>(null);
  const [validatingSalary, setValidatingSalary] = useState(false);
  const [workflowMessage, setWorkflowMessage] = useState<{
    text: string;
    type: "success" | "error";
  } | null>(null);
  const [working, setWorking] = useState(false);
  const salaryFileInputRef = useRef<HTMLInputElement | null>(null);

  const data = initialData;
  const activeBatch = data?.batch ?? null;
  const allBatches = data?.batches ?? [];
  const records = data?.records ?? [];
  const flags = data?.flags ?? [];
  const previousRecords = data?.previousRecords ?? [];
  const payrollYears = Array.from({ length: 7 }, (_, index) =>
    String(currentYear - 3 + index),
  );
  const hasPayrollPeriod = Boolean(payrollMonth && payrollYear);
  const canConfirmSalaryUpload = Boolean(
    selectedSalaryFile &&
      salaryValidation &&
      salaryValidation.failedRows === 0 &&
      salaryValidation.missingRequiredColumns.length === 0 &&
      salaryValidation.duplicateHrIds.length === 0,
  );

  async function handleSalaryTemplateUpload(file: File | null) {
    if (!file) return;
    if (!hasPayrollPeriod) {
      setSalaryUploadError("Choose payroll month and year before uploading.");
      return;
    }

    setSelectedSalaryFile(file);
    setSalaryValidation(null);
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
      const payload = await response.json();

      if (!response.ok) {
        setActivePayrollTab("governance");
        setSalaryUploadError(
          payload.error === "missing_payroll_period"
            ? "Choose payroll month and year before uploading."
            : payload.message ?? payload.error ?? "Salary validation failed.",
        );
        return;
      }

      setSalaryValidation(payload as SalaryValidationResult);
      setActivePayrollTab("governance");
    } catch {
      setSalaryUploadError("Unable to validate salary file.");
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
      setSalaryUploadError("Fix blocking validation errors before confirming the upload.");
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
      const payload = await response.json();

      if (!response.ok) {
        setSalaryUploadError(
          payload.error === "payroll_schema_not_ready"
            ? payload.message ?? "Payroll database tables are not ready."
            : payload.message ?? payload.error ?? "Payroll upload failed.",
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
      setActivePayrollTab("governance");
      window.location.href = `/payroll?tab=governance&batchId=${payload.batch.id}`;
    } catch {
      setSalaryUploadError("Unable to confirm payroll upload.");
    } finally {
      setConfirmingSalary(false);
    }
  }

  async function handleWorkflow(action: string) {
    if (!data?.batch) return;
    setWorking(true);
    setWorkflowMessage(null);

    try {
      const response = await fetch(`/api/payroll/${data.batch.id}/workflow`, {
        body: JSON.stringify({ action }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();

      if (payload.success) {
        setWorkflowMessage({
          text: `Action "${action}" completed.`,
          type: "success",
        });
        window.location.reload();
      } else {
        setWorkflowMessage({
          text: payload.error ?? "Action failed.",
          type: "error",
        });
      }
    } catch {
      setWorkflowMessage({ text: "Network error.", type: "error" });
    } finally {
      setWorking(false);
    }
  }

  async function handleDeleteBatch(batchId: string) {
    const confirmed = window.confirm(
      "Delete this payroll upload? This removes the batch, salary records, and governance flags.",
    );

    if (!confirmed) return;

    setDeletingBatchId(batchId);
    setWorkflowMessage(null);

    try {
      const response = await fetch(`/api/payroll/${batchId}`, {
        method: "DELETE",
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        setWorkflowMessage({
          text: payload.error ?? "Payroll upload delete failed.",
          type: "error",
        });
        return;
      }

      setWorkflowMessage({ text: "Payroll upload deleted.", type: "success" });
      window.location.href = "/payroll";
    } catch {
      setWorkflowMessage({ text: "Network error.", type: "error" });
    } finally {
      setDeletingBatchId(null);
    }
  }

  const salaryTemplateActions = (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-2">
      <input
        accept=".xlsx"
        className="hidden"
        onChange={(event) =>
          void handleSalaryTemplateUpload(event.target.files?.[0] ?? null)
        }
        ref={salaryFileInputRef}
        type="file"
      />
      <select
        className="h-10 rounded-lg border border-border bg-card px-3 text-sm text-text focus:outline-none"
        onChange={(event) => {
          setPayrollMonth(event.target.value);
          setSelectedSalaryFile(null);
          setSalaryValidation(null);
          setSalaryUploadError(null);
        }}
        value={payrollMonth}
      >
        <option value="">Month</option>
        {payrollMonths.map((month) => (
          <option key={month.value} value={month.value}>
            {month.label}
          </option>
        ))}
      </select>
      <select
        className="h-10 rounded-lg border border-border bg-card px-3 text-sm text-text focus:outline-none"
        onChange={(event) => {
          setPayrollYear(event.target.value);
          setSelectedSalaryFile(null);
          setSalaryValidation(null);
          setSalaryUploadError(null);
        }}
        value={payrollYear}
      >
        <option value="">Year</option>
        {payrollYears.map((year) => (
          <option key={year} value={year}>
            {year}
          </option>
        ))}
      </select>
      <Link href="/api/payroll/template">
        <Button variant="secondary">
          <Download className="mr-2 h-4 w-4" />
          Download Salary Template
        </Button>
      </Link>
      {hasPayrollPeriod ? (
        <Link href={`/api/payroll/template?ready=1&month=${payrollMonth}&year=${payrollYear}`}>
          <Button variant="secondary">
            <Download className="mr-2 h-4 w-4" />
            Download Ready Payroll
          </Button>
        </Link>
      ) : (
        <Button disabled variant="secondary">
          <Download className="mr-2 h-4 w-4" />
          Download Ready Payroll
        </Button>
      )}
      <Button
        disabled={validatingSalary || !hasPayrollPeriod}
        onClick={() => {
          if (!hasPayrollPeriod) {
            setSalaryUploadError("Choose payroll month and year before uploading.");
            return;
          }

          salaryFileInputRef.current?.click();
        }}
      >
        {validatingSalary ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Upload className="mr-2 h-4 w-4" />
        )}
        Upload & Validate
      </Button>
      <Button
        disabled={!canConfirmSalaryUpload || confirmingSalary}
        onClick={handleConfirmSalaryUpload}
        variant={canConfirmSalaryUpload ? "primary" : "secondary"}
      >
        {confirmingSalary ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <FileCheck2 className="mr-2 h-4 w-4" />
        )}
        Confirm Upload
      </Button>
    </div>
  );

  const lines = [...new Set(records.map((record) => record.line).filter(Boolean))].sort();
  const areas = [
    ...new Set(records.filter(isOperationalAreaRecord).map((record) => record.area)),
  ].sort();
  const jobTitles = [...new Set(records.map((record) => record.jobTitle).filter(Boolean))].sort();
  const employees = Array.from(
    new Map(
      records
        .filter((record) => record.employeeCode || record.fullName)
        .map((record) => [
          record.employeeCode || record.fullName,
          {
            key: record.employeeCode || record.fullName,
            label: record.fullName || record.employeeCode,
            meta: record.employeeCode,
          },
        ]),
    ).values(),
  ).sort((left, right) => left.label.localeCompare(right.label));
  const batchStatusById = new Map(allBatches.map((item) => [item.id, item.status]));
  const batchPeriodById = new Map(
    allBatches.map((item) => [item.id, payrollPeriodIndex(item.month, item.year)]),
  );
  const batchStatuses = [...new Set(allBatches.map((item) => item.status).filter(Boolean))].sort();
  const fromPeriodIndex = parseMonthInput(periodFromFilter);
  const toPeriodIndex = parseMonthInput(periodToFilter);
  const periodRangeStart =
    fromPeriodIndex !== null && toPeriodIndex !== null
      ? Math.min(fromPeriodIndex, toPeriodIndex)
      : fromPeriodIndex;
  const periodRangeEnd =
    fromPeriodIndex !== null && toPeriodIndex !== null
      ? Math.max(fromPeriodIndex, toPeriodIndex)
      : toPeriodIndex;
  const periodRangeMatches = (record: SalaryRecord) => {
    const recordPeriod = batchPeriodById.get(record.batchId);

    if (recordPeriod === undefined) return true;
    if (periodRangeStart !== null && recordPeriod < periodRangeStart) return false;
    if (periodRangeEnd !== null && recordPeriod > periodRangeEnd) return false;
    return true;
  };
  const advancedFilterCount = [
    search.trim(),
    periodFromFilter,
    periodToFilter,
    lineFilter !== "__all__",
    areaFilter !== "__all__",
    jobTitleFilter !== "__all__",
    employeeFilter !== "__all__",
    salaryBandFilter !== "__all__",
    batchStatusFilter !== "__all__",
    payrollSignalFilter !== "__all__",
  ].filter(Boolean).length;
  const resetDashboardFilters = () => {
    triggerIntelligenceAnalysis();
    setSearch("");
    setLineFilter("__all__");
    setAreaFilter("__all__");
    setJobTitleFilter("__all__");
    setEmployeeFilter("__all__");
    setSalaryBandFilter("__all__");
    setBatchStatusFilter("__all__");
    setPayrollSignalFilter("__all__");
    setPeriodFromFilter("");
    setPeriodToFilter("");
  };

  const filteredRecords = useMemo(() => {
    const query = search.trim().toLowerCase();

    return records.filter((record) => {
      const matchesSearch =
        !query ||
        `${record.employeeCode} ${record.fullName} ${record.jobTitle} ${record.line} ${record.area}`
          .toLowerCase()
          .includes(query);
      const matchesLine = lineFilter === "__all__" || record.line === lineFilter;
      const matchesArea = areaFilter === "__all__" || record.area === areaFilter;
      const matchesJobTitle = jobTitleFilter === "__all__" || record.jobTitle === jobTitleFilter;
      const matchesEmployee =
        employeeFilter === "__all__" ||
        record.employeeCode === employeeFilter ||
        record.fullName === employeeFilter;
      const matchesSalaryBand = salaryBandMatches(record, salaryBandFilter);
      const matchesBatchStatus =
        batchStatusFilter === "__all__" || batchStatusById.get(record.batchId) === batchStatusFilter;
      const matchesPayrollSignal = payrollSignalMatches(record, payrollSignalFilter);
      const matchesPeriodRange = periodRangeMatches(record);

      return (
        matchesSearch &&
        matchesLine &&
        matchesArea &&
        matchesJobTitle &&
        matchesEmployee &&
        matchesSalaryBand &&
        matchesBatchStatus &&
        matchesPayrollSignal &&
        matchesPeriodRange
      );
    });
  }, [
    areaFilter,
    batchPeriodById,
    batchStatusById,
    batchStatusFilter,
    employeeFilter,
    jobTitleFilter,
    lineFilter,
    payrollSignalFilter,
    periodRangeEnd,
    periodRangeStart,
    records,
    salaryBandFilter,
    search,
  ]);

  const previousFilteredRecords = useMemo(
    () =>
      previousRecords.filter((record) => {
        const matchesLine = lineFilter === "__all__" || record.line === lineFilter;
        const matchesArea = areaFilter === "__all__" || record.area === areaFilter;
        const matchesJobTitle = jobTitleFilter === "__all__" || record.jobTitle === jobTitleFilter;
        const matchesEmployee =
          employeeFilter === "__all__" ||
          record.employeeCode === employeeFilter ||
          record.fullName === employeeFilter;
        const matchesSalaryBand = salaryBandMatches(record, salaryBandFilter);
        const matchesBatchStatus =
          batchStatusFilter === "__all__" || batchStatusById.get(record.batchId) === batchStatusFilter;
        const matchesPayrollSignal = payrollSignalMatches(record, payrollSignalFilter);
        const matchesPeriodRange = periodRangeMatches(record);
        return (
          matchesLine &&
          matchesArea &&
          matchesJobTitle &&
          matchesEmployee &&
          matchesSalaryBand &&
          matchesBatchStatus &&
          matchesPayrollSignal &&
          matchesPeriodRange
        );
      }),
    [
      areaFilter,
      batchPeriodById,
      batchStatusById,
      batchStatusFilter,
      employeeFilter,
      jobTitleFilter,
      lineFilter,
      payrollSignalFilter,
      periodRangeEnd,
      periodRangeStart,
      previousRecords,
      salaryBandFilter,
    ],
  );
  const operationalAreaRecords = useMemo(
    () => filteredRecords.filter(isOperationalAreaRecord),
    [filteredRecords],
  );
  const previousOperationalAreaRecords = useMemo(
    () => previousFilteredRecords.filter(isOperationalAreaRecord),
    [previousFilteredRecords],
  );

  const totals = {
    additions: sumRecords(filteredRecords, (record) => record.totalAdditions),
    deductions: sumRecords(filteredRecords, (record) => record.totalDeductions),
    employees: filteredRecords.length,
    governmentalDeductions: sumRecords(filteredRecords, governmentalDeductionsFor),
    gross: sumRecords(filteredRecords, (record) => record.grossSalary),
    net: sumRecords(filteredRecords, (record) => record.netSalary),
    otherDeductions: sumRecords(filteredRecords, otherDeductionsFor),
  };
  const previousTotals = {
    additions: sumRecords(previousFilteredRecords, (record) => record.totalAdditions),
    deductions: sumRecords(previousFilteredRecords, (record) => record.totalDeductions),
    employees: previousFilteredRecords.length,
    governmentalDeductions: sumRecords(previousFilteredRecords, governmentalDeductionsFor),
    gross: sumRecords(previousFilteredRecords, (record) => record.grossSalary),
    net: sumRecords(previousFilteredRecords, (record) => record.netSalary),
    otherDeductions: sumRecords(previousFilteredRecords, otherDeductionsFor),
  };
  const payrollTrendPoints = useMemo(() => {
    if (!activeBatch) return [];

    if (data?.scope !== "batch") {
      return allBatches
        .slice()
        .sort((left, right) => left.year - right.year || left.month - right.month)
        .map((item) =>
          payrollTrendPoint(
            shortPayrollPeriodLabel(item.month, item.year),
            filteredRecords.filter((record) => record.batchId === item.id),
          ),
        )
        .filter((point) => point.employees > 0);
    }

    const points: PayrollTrendPoint[] = [];
    const previousBatchId = previousFilteredRecords[0]?.batchId;
    const previousBatch = previousBatchId
      ? allBatches.find((item) => item.id === previousBatchId)
      : null;

    if (previousBatch && previousFilteredRecords.length > 0) {
      points.push(
        payrollTrendPoint(
          shortPayrollPeriodLabel(previousBatch.month, previousBatch.year),
          previousFilteredRecords,
        ),
      );
    }

    if (filteredRecords.length > 0) {
      points.push(
        payrollTrendPoint(
          shortPayrollPeriodLabel(activeBatch.month, activeBatch.year),
          filteredRecords,
        ),
      );
    }

    return points;
  }, [activeBatch, allBatches, data?.scope, filteredRecords, previousFilteredRecords]);
  const comparisonCurrentPoint =
    payrollTrendPoints[payrollTrendPoints.length - 1] ??
    payrollTrendPoint("Current", filteredRecords);
  const comparisonPreviousPoint =
    payrollTrendPoints.length > 1
      ? payrollTrendPoints[payrollTrendPoints.length - 2]
      : null;
  const comparisonBatches = data?.scope !== "batch"
    ? allBatches
        .slice()
        .sort((left, right) => left.year - right.year || left.month - right.month)
        .filter((item) => filteredRecords.some((record) => record.batchId === item.id))
    : [];
  const comparisonCurrentBatch = comparisonBatches[comparisonBatches.length - 1] ?? null;
  const comparisonPreviousBatch =
    comparisonBatches.length > 1 ? comparisonBatches[comparisonBatches.length - 2] : null;
  const comparisonChartRecords =
    data?.scope !== "batch" && comparisonCurrentBatch
      ? filteredRecords.filter((record) => record.batchId === comparisonCurrentBatch.id)
      : filteredRecords;
  const comparisonChartPreviousRecords =
    data?.scope !== "batch" && comparisonPreviousBatch
      ? filteredRecords.filter((record) => record.batchId === comparisonPreviousBatch.id)
      : previousFilteredRecords;
  const avgNet = totals.employees > 0 ? totals.net / totals.employees : 0;
  const medianNet = median(filteredRecords.map((record) => record.netSalary));
  const costPerHead = totals.employees > 0 ? totals.gross / totals.employees : 0;
  const netGrossRatio = totals.gross > 0 ? (totals.net / totals.gross) * 100 : 0;
  const deltaPercent = (current: number, previous: number) =>
    previous > 0 ? ((current - previous) / previous) * 100 : null;

  const lineGroups = useMemo(
    () => buildGroups(filteredRecords, (record) => record.line),
    [filteredRecords],
  );
  const areaGroups = useMemo(
    () => buildGroups(operationalAreaRecords, (record) => record.area),
    [operationalAreaRecords],
  );
  const jobGroups = useMemo(
    () => buildGroups(filteredRecords, (record) => record.jobTitle),
    [filteredRecords],
  );
  const currentGroups =
    groupMode === "area" ? areaGroups : groupMode === "jobTitle" ? jobGroups : lineGroups;
  const salaryBands = useMemo(() => buildSalaryBands(filteredRecords), [filteredRecords]);
  const additionsBreakdown = useMemo(
    () => buildBreakdown(filteredRecords, additionFields),
    [filteredRecords],
  );
  const governmentalDeductionsBreakdown = useMemo(
    () => buildBreakdown(filteredRecords, governmentalDeductionFields),
    [filteredRecords],
  );
  const otherDeductionsBreakdown = useMemo(
    () => buildBreakdown(filteredRecords, otherDeductionFields),
    [filteredRecords],
  );
  const periodDelta = useMemo(
    () => buildPeriodDelta(filteredRecords, previousFilteredRecords),
    [filteredRecords, previousFilteredRecords],
  );
  const anomalyThreshold = avgNet * 2.25;
  const anomalyRecords = useMemo(
    () =>
      filteredRecords
        .filter((record) => avgNet > 0 && record.netSalary > anomalyThreshold)
        .sort((left, right) => right.netSalary - left.netSalary),
    [avgNet, anomalyThreshold, filteredRecords],
  );
  const topJobTitles = jobGroups.slice(0, 5);
  const payrollScore = useMemo(
    () =>
      calculatePayrollHealthScore({
        batchStatus: activeBatch?.status ?? "uploaded",
        flags,
        previousRecords: previousFilteredRecords,
        records: filteredRecords,
      }),
    [activeBatch?.status, filteredRecords, flags, previousFilteredRecords],
  );
  const lineScores = useMemo(
    () => calculateEntityScores(filteredRecords, previousFilteredRecords, (record) => record.line),
    [filteredRecords, previousFilteredRecords],
  );
  const areaScores = useMemo(
    () => calculateEntityScores(operationalAreaRecords, previousOperationalAreaRecords, (record) => record.area),
    [operationalAreaRecords, previousOperationalAreaRecords],
  );
  const employeeScores = useMemo(
    () => calculateEmployeeScores(filteredRecords, previousFilteredRecords),
    [filteredRecords, previousFilteredRecords],
  );
  const payrollInsights = useMemo(
    () =>
      generatePayrollInsights({
        areaGroups,
        flags,
        lineGroups,
        previousRecords: previousFilteredRecords,
        previousTotals,
        records: filteredRecords,
        totals,
      }),
    [areaGroups, filteredRecords, flags, lineGroups, previousFilteredRecords, previousTotals, totals],
  );
  const predictiveAlerts = useMemo(
    () =>
      generatePredictiveAlerts({
        areaGroups,
        flags,
        lineGroups,
        previousRecords: previousFilteredRecords,
        previousTotals,
        records: filteredRecords,
        totals,
      }),
    [areaGroups, filteredRecords, flags, lineGroups, previousFilteredRecords, previousTotals, totals],
  );

  if (initialError) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-text">Payroll Operations</h1>
          <p className="mt-1 text-text-secondary">
            Payroll generation, upload validation, and governance workflow management.
          </p>
        </div>
        <Card className="border-danger/20 bg-red-50 dark:bg-red-950/20">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-danger" />
            <p className="text-sm text-danger">{initialError}</p>
          </div>
        </Card>
      </div>
    );
  }

  if (!activeBatch) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-text">Payroll Operations</h1>
            <p className="mt-1 text-text-secondary">
              Download the monthly salary template, fill it, then upload it for validation.
            </p>
          </div>
          {salaryTemplateActions}
        </div>

        <PayrollTabs activeTab={activePayrollTab} onChange={setActivePayrollTab} />

        {activePayrollTab === "generate" && (
          <GenerateReadyPayrollSheet
            month={generateMonth}
            months={payrollMonths}
            onMonthChange={setGenerateMonth}
            onYearChange={setGenerateYear}
            year={generateYear}
            years={payrollYears}
          />
        )}

        {activePayrollTab !== "generate" && salaryUploadError && (
          <Card className="border-danger/20 bg-red-50 dark:bg-red-950/20">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-danger" />
              <p className="text-sm text-danger">{salaryUploadError}</p>
            </div>
          </Card>
        )}

        {activePayrollTab !== "generate" && salaryValidation && <ValidationSummary result={salaryValidation} />}

        {activePayrollTab !== "generate" && workflowMessage && (
          <Card
            className={cn(
              "border",
              workflowMessage.type === "success"
                ? "border-green-200 bg-green-50 dark:bg-green-950/20"
                : "border-red-200 bg-red-50 dark:bg-red-950/20",
            )}
          >
            <div className="flex items-center gap-3">
              {workflowMessage.type === "success" ? (
                <CheckCircle className="h-4 w-4 text-success" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-danger" />
              )}
              <p className="text-sm">{workflowMessage.text}</p>
            </div>
          </Card>
        )}

        {activePayrollTab !== "generate" && (
          <PayrollHistory
            batches={allBatches}
            deletingBatchId={deletingBatchId}
            onDelete={handleDeleteBatch}
          />
        )}

        {activePayrollTab !== "generate" && <Card>
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <FileCheck2 className="h-10 w-10 text-text-secondary" />
            <p className="font-medium text-text">No payroll batch selected</p>
            <p className="max-w-xl text-sm text-text-secondary">
              The upload step validates headers A to AD, duplicate HR_IDs, salary
              numbers, additions, deductions, net salary, gross salary, and salary split.
            </p>
          </div>
        </Card>}
      </div>
    );
  }

  const batch = activeBatch;
  const isAllTimeScope = data?.scope !== "batch";
  const selectedPeriod = isAllTimeScope ? "All Time" : payrollPeriodLabel(batch.month, batch.year);
  const selectedStatusLabel = isAllTimeScope
    ? `${formatNumber(allBatches.length)} payroll runs`
    : batch.status.replace(/_/g, " ");
  const periodFilterValue = isAllTimeScope ? "__all_time__" : batch.id;
  const triggerIntelligenceAnalysis = () => {
    setIsAnalyzingIntelligence(true);
    window.setTimeout(() => setIsAnalyzingIntelligence(false), 320);
  };
  const handlePeriodFilterChange = (value: string) => {
    triggerIntelligenceAnalysis();
    window.location.href = value === "__all_time__" ? "/payroll" : `/payroll?batchId=${value}`;
  };
  const primaryWorkflowAction =
    !isAllTimeScope && batch.status === "uploaded"
      ? { action: "mark_review", label: "Mark Review" }
      : !isAllTimeScope && batch.status === "under_review"
        ? { action: "approve", label: "Approve Payroll" }
        : !isAllTimeScope && batch.status === "approved"
          ? { action: "lock", label: "Lock Payroll" }
          : null;

  return (
    <div className="payroll-dashboard-surface min-h-screen bg-bg-soft text-text">
      <PayrollMotionStyles />
      <div className="mx-auto w-full max-w-[1880px] px-5 py-3">
            <div className="mb-4 grid grid-cols-[1fr_auto_1fr] items-center gap-5">
              <div className="md:hidden">
                <Link className="flex items-center gap-2" href="/">
                  <img
                    alt="Phoenix"
                    className="h-10 w-10 object-contain"
                    src="/brand/phoenix-bird-icon.png"
                  />
                  <span className="text-sm font-bold tracking-[0.22em] text-text">
                    PHOENIX <span className="text-primary">X</span>
                  </span>
                </Link>
              </div>
              <div className="text-center">
                <h1 className="text-2xl font-semibold uppercase tracking-[0.32em] text-text">
                  Godmode <span className="text-primary">Advanced Premium</span> SaaS
                </h1>
                <p className="mt-1 text-sm font-semibold uppercase tracking-[0.32em] text-text-secondary">
                  Enterprise Payroll Intelligence Platform
                </p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button className="phoenix-action-button flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-text-secondary shadow-sm" type="button">
                  <Star className="h-4 w-4" />
                </button>
                <button className="phoenix-action-button flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-text-secondary shadow-sm" type="button">
                  <Layers3 className="h-4 w-4" />
                </button>
                <button className="phoenix-action-button relative flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-text-secondary shadow-sm" type="button">
                  <Bell className="h-4 w-4" />
                  {predictiveAlerts.some((alert) => alert.risk === "High" || alert.risk === "Critical") && (
                    <span className="absolute -right-1 -top-1 h-4 min-w-4 rounded-full bg-red-500 px-1 text-[9px] font-bold leading-4 text-white">
                      {predictiveAlerts.filter((alert) => alert.risk === "High" || alert.risk === "Critical").length}
                    </span>
                  )}
                </button>
                <button className="phoenix-action-button flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-text-secondary shadow-sm" type="button">
                  <Settings className="h-4 w-4" />
                </button>
                <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
                  <img
                    alt=""
                    className="h-8 w-8 rounded-full bg-orange-50 object-contain p-1"
                    src="/brand/phoenix-bird-icon.png"
                  />
                  <div>
                    <p className="text-xs font-semibold text-text">GODMODE ADMIN</p>
                    <p className="text-[10px] text-text-secondary">Super Administrator</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="mb-4 grid grid-cols-[minmax(320px,1fr)_150px_190px_210px_230px] items-center gap-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
                <Input
                  className="h-11 rounded-xl border-slate-200 bg-white pl-10 text-sm shadow-[0_8px_22px_rgba(15,23,42,0.04)]"
                  onChange={(event) => {
                    triggerIntelligenceAnalysis();
                    setSearch(event.target.value);
                  }}
                  placeholder="Search employees, departments, payroll runs..."
                  value={search}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-text-secondary">
                  {formatNumber(totals.employees)}
                </span>
              </div>
              <select
                className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs text-text shadow-sm focus:outline-none"
                onChange={(event) => {
                  triggerIntelligenceAnalysis();
                  setLineFilter(event.target.value);
                }}
                value={lineFilter}
              >
                <option value="__all__">All Lines</option>
                {lines.map((line) => (
                  <option key={line} value={line}>
                    {line}
                  </option>
                ))}
              </select>
              <select
                className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs text-text shadow-sm focus:outline-none"
                onChange={(event) => {
                  triggerIntelligenceAnalysis();
                  setAreaFilter(event.target.value);
                }}
                value={areaFilter}
              >
                <option value="__all__">All Territories</option>
                {areas.map((area) => (
                  <option key={area} value={area}>
                    {area}
                  </option>
                ))}
              </select>
              <div className="relative">
                <select
                  className="h-11 w-full appearance-none rounded-xl border border-slate-200 bg-white px-9 text-xs font-semibold text-text shadow-sm focus:outline-none"
                  onChange={(event) => handlePeriodFilterChange(event.target.value)}
                  value={periodFilterValue}
                >
                  <option value="__all_time__">All Time / All Runs</option>
                  {allBatches.map((item) => (
                    <option key={item.id} value={item.id}>
                      {payrollPeriodLabel(item.month, item.year)} / {item.status.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
                  <CalendarDays className="h-4 w-4 text-text-secondary" />
                </span>
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary">
                  v
                </span>
              </div>
              <Button
                className="phoenix-action-button h-11 justify-between rounded-xl px-5 text-sm shadow-[0_16px_32px_rgba(249,115,22,0.22)]"
                disabled={!primaryWorkflowAction || working}
                onClick={() => {
                  if (primaryWorkflowAction) {
                    void handleWorkflow(primaryWorkflowAction.action);
                  }
                }}
              >
                {primaryWorkflowAction?.label ?? (isAllTimeScope ? "Select Period" : "Payroll Locked")}
                <span className="ml-3 border-l border-white/30 pl-4">v</span>
              </Button>
            </div>

            <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-3 shadow-[0_12px_30px_rgba(15,23,42,0.05)]">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-text-secondary">
                    Advanced Filters
                  </p>
                  <p className="mt-1 text-xs text-text-secondary">
                    {formatNumber(filteredRecords.length)} of {formatNumber(records.length)} payroll rows in scope
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={advancedFilterCount > 0 ? "warning" : "neutral"}>
                    {advancedFilterCount} active
                  </Badge>
                  <Button
                    className="h-9 rounded-xl px-3 text-xs"
                    onClick={resetDashboardFilters}
                    variant="secondary"
                  >
                    Reset Filters
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary">
                    From
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-14 pr-3 text-xs text-text shadow-sm focus:outline-none"
                    onChange={(event) => {
                      triggerIntelligenceAnalysis();
                      setPeriodFromFilter(event.target.value);
                    }}
                    type="month"
                    value={periodFromFilter}
                  />
                </div>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary">
                    To
                  </span>
                  <input
                    className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-3 text-xs text-text shadow-sm focus:outline-none"
                    onChange={(event) => {
                      triggerIntelligenceAnalysis();
                      setPeriodToFilter(event.target.value);
                    }}
                    type="month"
                    value={periodToFilter}
                  />
                </div>
                <select
                  className="h-10 min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-xs text-text shadow-sm focus:outline-none"
                  onChange={(event) => {
                    triggerIntelligenceAnalysis();
                    setJobTitleFilter(event.target.value);
                  }}
                  value={jobTitleFilter}
                >
                  <option value="__all__">All Job Titles</option>
                  {jobTitles.map((jobTitle) => (
                    <option key={jobTitle} value={jobTitle}>
                      {jobTitle}
                    </option>
                  ))}
                </select>
                <select
                  className="h-10 min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-xs text-text shadow-sm focus:outline-none"
                  onChange={(event) => {
                    triggerIntelligenceAnalysis();
                    setEmployeeFilter(event.target.value);
                  }}
                  value={employeeFilter}
                >
                  <option value="__all__">All Employees</option>
                  {employees.map((employee) => (
                    <option key={employee.key} value={employee.key}>
                      {employee.label}{employee.meta ? ` / ${employee.meta}` : ""}
                    </option>
                  ))}
                </select>
                <select
                  className="h-10 min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-xs text-text shadow-sm focus:outline-none"
                  onChange={(event) => {
                    triggerIntelligenceAnalysis();
                    setSalaryBandFilter(event.target.value);
                  }}
                  value={salaryBandFilter}
                >
                  <option value="__all__">All Salary Bands</option>
                  <option value="under_10k">&lt; 10K Net</option>
                  <option value="10k_20k">10K - 20K Net</option>
                  <option value="20k_30k">20K - 30K Net</option>
                  <option value="30k_45k">30K - 45K Net</option>
                  <option value="45k_plus">45K+ Net</option>
                </select>
                <select
                  className="h-10 min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-xs text-text shadow-sm focus:outline-none"
                  onChange={(event) => {
                    triggerIntelligenceAnalysis();
                    setBatchStatusFilter(event.target.value);
                  }}
                  value={batchStatusFilter}
                >
                  <option value="__all__">All Payroll Statuses</option>
                  {batchStatuses.map((status) => (
                    <option key={status} value={status}>
                      {status.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
                <select
                  className="h-10 min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-xs text-text shadow-sm focus:outline-none"
                  onChange={(event) => {
                    triggerIntelligenceAnalysis();
                    setPayrollSignalFilter(event.target.value);
                  }}
                  value={payrollSignalFilter}
                >
                  <option value="__all__">All Payroll Signals</option>
                  <option value="with_additions">Has Additions</option>
                  <option value="with_deductions">Has Deductions</option>
                  <option value="loans">Has Loans</option>
                  <option value="overtime">Has Overtime</option>
                  <option value="bonus">Has Bonus</option>
                  <option value="missing_core">Missing Core Fields</option>
                </select>
              </div>
            </div>

            <div className="mb-3 flex items-center justify-between gap-3 md:hidden">
              <PayrollTabs activeTab={activePayrollTab} onChange={setActivePayrollTab} />
              <div className="flex items-center gap-2">
                {isAllTimeScope ? <Badge variant="neutral">All Time</Badge> : statusBadge(batch.status)}
                {!isAllTimeScope && batch.status === "uploaded" && (
                  <Button className="h-8 px-3 text-xs" disabled={working} onClick={() => void handleWorkflow("mark_review")}>
                    Mark for Review
                  </Button>
                )}
                {!isAllTimeScope && batch.status === "under_review" && (
                  <Button className="h-8 px-3 text-xs" disabled={working} onClick={() => void handleWorkflow("approve")}>
                    Approve
                  </Button>
                )}
                {!isAllTimeScope && batch.status === "approved" && (
                  <Button className="h-8 px-3 text-xs" disabled={working} onClick={() => void handleWorkflow("lock")}>
                    Lock Payroll
                  </Button>
                )}
                {!isAllTimeScope && (batch.status === "uploaded" || batch.status === "under_review") && (
                  <Button
                    className="h-8 px-3 text-xs"
                    disabled={working}
                    onClick={() => void handleWorkflow("reject")}
                    variant="secondary"
                  >
                    Reject
                  </Button>
                )}
              </div>
            </div>

      {workflowMessage && (
        <Card
          className={cn(
            "border",
            workflowMessage.type === "success"
              ? "border-green-200 bg-green-50 dark:bg-green-950/20"
              : "border-red-200 bg-red-50 dark:bg-red-950/20",
          )}
        >
          <div className="flex items-center gap-3">
            {workflowMessage.type === "success" ? (
              <CheckCircle className="h-4 w-4 text-success" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-danger" />
            )}
            <p className="text-sm">{workflowMessage.text}</p>
          </div>
        </Card>
      )}

      {activePayrollTab === "generate" && (
        <GenerateReadyPayrollSheet
          month={generateMonth}
          months={payrollMonths}
          onMonthChange={setGenerateMonth}
          onYearChange={setGenerateYear}
          year={generateYear}
          years={payrollYears}
        />
      )}

      {activePayrollTab === "governance" && (
        <div className="space-y-5">
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-text">
                  Upload, Validation & Governance
                </h2>
                <p className="mt-1 max-w-2xl text-sm text-text-secondary">
                  Validate the monthly salary template, confirm clean files, review governance warnings, and manage payroll uploads.
                </p>
              </div>
              {salaryTemplateActions}
            </div>
          </Card>

          {salaryUploadError && (
            <Card className="border-danger/20 bg-red-50 dark:bg-red-950/20">
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-5 w-5 text-danger" />
                <p className="text-sm text-danger">{salaryUploadError}</p>
              </div>
            </Card>
          )}

          {salaryValidation && <ValidationSummary result={salaryValidation} />}

          {flags.length > 0 && (
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning" />
                <h2 className="text-base font-semibold text-text">
                  Payroll Alerts ({flags.length})
                </h2>
              </div>
              <div className="space-y-2">
                {flags.slice(0, 14).map((flag) => (
                  <div
                    className="flex items-start justify-between gap-4 rounded-lg border border-border bg-bg-muted px-4 py-3"
                    key={flag.id}
                  >
                    <div>
                      {flag.employeeCode && (
                        <p className="font-mono text-xs text-text-secondary">
                          {flag.employeeCode}
                        </p>
                      )}
                      <p className="text-sm text-text">{flag.message}</p>
                    </div>
                    <Badge
                      variant={
                        flag.severity === "critical"
                          ? "danger"
                          : flag.severity === "warning"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {flag.severity}
                    </Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <PayrollHistory
            activeBatchId={isAllTimeScope ? undefined : batch.id}
            batches={allBatches}
            deletingBatchId={deletingBatchId}
            onDelete={handleDeleteBatch}
          />
        </div>
      )}

      {activePayrollTab === "dashboard" && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              delta={deltaPercent(totals.gross, previousTotals.gross)}
              icon={<DollarSign className="h-5 w-5" />}
              label="Total Gross Salary"
              value={formatEGP(totals.gross)}
            />
            <KpiCard
              delta={deltaPercent(totals.additions, previousTotals.additions)}
              icon={<Layers3 className="h-5 w-5" />}
              label="Total Additions"
              tone="green"
              value={formatEGP(totals.additions)}
            />
            <KpiCard
              delta={deltaPercent(totals.governmentalDeductions, previousTotals.governmentalDeductions)}
              icon={<Landmark className="h-5 w-5" />}
              label="Governmental Deductions"
              tone="red"
              value={formatEGP(totals.governmentalDeductions)}
            />
            <KpiCard
              delta={deltaPercent(totals.otherDeductions, previousTotals.otherDeductions)}
              icon={<Trash2 className="h-5 w-5" />}
              label="Other Deductions"
              tone="red"
              value={formatEGP(totals.otherDeductions)}
            />
            <KpiCard
              delta={deltaPercent(totals.net, previousTotals.net)}
              icon={<ShieldCheck className="h-5 w-5" />}
              label="Net Pay"
              tone="blue"
              value={formatEGP(totals.net)}
            />
            <KpiCard
              delta={deltaPercent(totals.employees, previousTotals.employees)}
              icon={<Users className="h-5 w-5" />}
              label="Total Employees"
              tone="violet"
              value={formatNumber(totals.employees)}
            />
            <KpiCard
              icon={<TrendingUp className="h-5 w-5" />}
              label="Avg Net Salary"
              value={formatEGP(avgNet)}
            />
            <KpiCard
              icon={<BarChart3 className="h-5 w-5" />}
              label="Payroll Cost / Head"
              value={formatEGP(costPerHead)}
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.25fr_0.95fr_0.9fr]">
            <Card>
              <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-text">
                    Payroll Overview
                  </h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    Previous batch compared with the current approved scope.
                  </p>
                </div>
                <Badge variant="neutral">
                  {previousFilteredRecords.length > 0 ? "2 periods" : "Current only"}
                </Badge>
              </div>
              <PayrollOverviewChart points={payrollTrendPoints} />
            </Card>

            <Card>
              <div className="mb-4">
                <h2 className="text-base font-semibold text-text">
                  Component Breakdown ({selectedPeriod})
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  Net pay calculated from the uploaded net_salary column.
                </p>
              </div>
              <div className="grid items-center gap-5 md:grid-cols-[1fr_0.95fr]">
                <Donut
                  centerLabel="Net Pay"
                  centerMeta="EGP"
                  centerSubValue={`${netGrossRatio.toFixed(2)}%`}
                  centerValue={formatCompact(totals.net)}
                  items={[
                    { color: "#F97316", label: "Gross Salary", value: totals.gross },
                    { color: "#22C55E", label: "Additions", value: totals.additions },
                    { color: "#EF4444", label: "Gov. Deductions", value: totals.governmentalDeductions },
                    { color: "#F59E0B", label: "Other Deductions", value: totals.otherDeductions },
                    { color: "#2563EB", label: "Net Pay", value: totals.net },
                  ]}
                  size="lg"
                />
                <div className="space-y-4">
                  {[
                    ["Gross Salary", totals.gross, totals.gross > 0 ? 100 : 0, "#F97316"],
                    ["Additions", totals.additions, totals.gross > 0 ? (totals.additions / totals.gross) * 100 : 0, "#22C55E"],
                    ["Gov. Deductions", totals.governmentalDeductions, totals.gross > 0 ? (totals.governmentalDeductions / totals.gross) * 100 : 0, "#EF4444"],
                    ["Other Deductions", totals.otherDeductions, totals.gross > 0 ? (totals.otherDeductions / totals.gross) * 100 : 0, "#F59E0B"],
                    ["Net Pay", totals.net, netGrossRatio, "#2563EB"],
                  ].map(([label, value, percent, color]) => (
                    <div className="grid grid-cols-[auto_1fr] items-start gap-3 text-sm" key={String(label)}>
                      <span className="mt-1 h-3 w-3 rounded-sm" style={{ backgroundColor: String(color) }} />
                      <div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-medium text-text">{label}</span>
                          <span className="font-mono font-semibold text-text">
                            {formatEGP(Number(value))}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-text-secondary">
                          {Number(percent).toFixed(2)}%
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card className="relative overflow-hidden">
              <div className="absolute -right-2 top-8 h-72 w-72 opacity-[0.18]">
                <img
                  alt=""
                  className="h-full w-full object-contain drop-shadow-[0_0_26px_rgba(249,115,22,0.32)]"
                  src="/brand/phoenix-bird-icon.png"
                />
              </div>
              <div className="relative">
                <h2 className="text-base font-semibold text-text">Payroll Summary</h2>
                <p className="mt-1 text-sm capitalize text-text-secondary">
                  {selectedPeriod} / {selectedStatusLabel}
                </p>
                <div className="mt-5 space-y-3">
                  {[
                    { Icon: Users, label: "Employees", value: formatNumber(totals.employees) },
                    { Icon: DollarSign, label: "Gross Salary", value: formatEGP(totals.gross) },
                    { Icon: Layers3, label: "Additions", value: formatEGP(totals.additions) },
                    { Icon: Landmark, label: "Governmental Deductions", value: formatEGP(totals.governmentalDeductions) },
                    { Icon: Trash2, label: "Other Deductions", value: formatEGP(totals.otherDeductions) },
                    { Icon: FileCheck2, label: "Total Deductions", value: formatEGP(totals.deductions) },
                    { Icon: ShieldCheck, label: "Net Pay", value: formatEGP(totals.net) },
                  ].map(({ Icon, label, value }) => (
                    <div
                      className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50/90 px-3 py-2.5 text-sm"
                      key={label}
                    >
                      <span className="flex items-center gap-2 text-text-secondary">
                        <Icon className="h-4 w-4" />
                        {label}
                      </span>
                      <span className="font-mono font-semibold text-text">{value}</span>
                    </div>
                  ))}
                </div>
                <Button
                  className="mt-5 w-full rounded-2xl border-orange-200 bg-white py-3 text-primary hover:bg-orange-50"
                  onClick={() => setActivePayrollTab("governance")}
                  variant="secondary"
                >
                  View Payroll Run Details <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </Card>
          </div>

          <ComparePayrollChart
            previousRecords={comparisonChartPreviousRecords}
            records={comparisonChartRecords}
          />

          <div className="grid gap-5 xl:grid-cols-[0.9fr_1.05fr_0.95fr_1fr]">
            <Card>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold text-text">Payroll by Line</h2>
                <Badge variant="neutral">{lineGroups.length} lines</Badge>
              </div>
              <Donut
                centerLabel="Employees"
                centerValue={formatNumber(totals.employees)}
                items={lineGroups.slice(0, 5).map((group, index) => ({
                  color: ["#F97316", "#22C55E", "#0F172A", "#F59E0B", "#64748B"][index] ?? "#94A3B8",
                  label: group.label,
                  value: group.net,
                }))}
              />
              <div className="mt-4 space-y-2">
                {lineGroups.slice(0, 5).map((group) => (
                  <div className="flex items-center justify-between text-xs" key={group.label}>
                    <span className="text-text-secondary">{group.label}</span>
                    <span className="font-mono text-text">
                      {group.employees} / {formatCompact(group.net)}
                    </span>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold text-text">Payroll by Territory</h2>
                <a className="text-xs font-medium text-primary" href="/organogram">
                  View structure
                </a>
              </div>
              <BarRows
                rows={areaGroups.slice(0, 7).map((group) => ({
                  label: group.label,
                  meta: `${group.employees}`,
                  value: group.net,
                }))}
              />
            </Card>

            <Card>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold text-text">
                  Top Job Titles by Net Pay
                </h2>
                <Badge variant="neutral">By Net</Badge>
              </div>
              <div className="space-y-3">
                {topJobTitles.map((group, index) => (
                  <div className="flex items-center justify-between gap-3 text-sm" key={group.label}>
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-orange-50 text-xs font-semibold text-primary dark:bg-orange-950/30">
                        {index + 1}
                      </span>
                      <span className="truncate font-medium text-text">{group.label}</span>
                    </div>
                    <span className="shrink-0 font-mono text-xs text-text-secondary">
                      {formatEGP(group.net)}
                    </span>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold text-text">Payroll Runs</h2>
                <button
                  className="text-xs font-medium text-primary"
                  onClick={() => setActivePayrollTab("governance")}
                  type="button"
                >
                  View All
                </button>
              </div>
              <div className="space-y-3">
                {allBatches.slice(0, 5).map((item) => (
                  <a
                    className={cn(
                      "grid grid-cols-[1fr_auto] gap-3 rounded-xl border border-border bg-bg-soft px-3 py-2 text-sm transition hover:border-primary/40",
                      item.id === batch.id && "border-primary/40 bg-orange-50 dark:bg-orange-950/10",
                    )}
                    href={`/payroll?batchId=${item.id}`}
                    key={item.id}
                  >
                    <div>
                      <p className="font-medium text-text">
                        {payrollPeriodLabel(item.month, item.year)}
                      </p>
                      <p className="max-w-[180px] truncate text-xs text-text-secondary">
                        {item.fileName}
                      </p>
                    </div>
                    {statusBadge(item.status)}
                  </a>
                ))}
              </div>
            </Card>
          </div>

          <div className="grid gap-5 xl:grid-cols-[1fr_1fr_0.9fr]">
            <Card>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold text-text">
                  Additions vs Deductions
                </h2>
                <Badge variant="neutral">Current Scope</Badge>
              </div>
              <InteractiveVerticalBars
                bars={[
                  {
                    color: "linear-gradient(180deg, #22C55E 0%, #86EFAC 100%)",
                    glow: "rgba(34,197,94,0.42)",
                    label: "Additions",
                    value: totals.additions,
                  },
                  {
                    color: "linear-gradient(180deg, #EF4444 0%, #FB7185 100%)",
                    glow: "rgba(239,68,68,0.42)",
                    label: "Gov. Deductions",
                    value: totals.governmentalDeductions,
                  },
                  {
                    color: "linear-gradient(180deg, #F59E0B 0%, #FDBA74 100%)",
                    glow: "rgba(245,158,11,0.42)",
                    label: "Other Deductions",
                    value: totals.otherDeductions,
                  },
                ]}
              />
            </Card>

            <Card>
              <div className="mb-4">
                <h2 className="text-base font-semibold text-text">
                  Month Over Month Comparison
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  Based on real payroll periods in the current filter scope.
                </p>
              </div>
              <div className="mb-4">
                <InteractiveVerticalBars
                  bars={[
                    {
                      color: "linear-gradient(180deg, #FDBA74 0%, #F97316 100%)",
                      glow: "rgba(249,115,22,0.38)",
                      label: `${comparisonPreviousPoint?.label ?? "Previous"} Gross`,
                      value: comparisonPreviousPoint?.gross ?? 0,
                    },
                    {
                      color: "linear-gradient(180deg, #60A5FA 0%, #2563EB 100%)",
                      glow: "rgba(37,99,235,0.36)",
                      label: `${comparisonPreviousPoint?.label ?? "Previous"} Net`,
                      value: comparisonPreviousPoint?.net ?? 0,
                    },
                    {
                      color: "linear-gradient(180deg, #FDBA74 0%, #F97316 100%)",
                      glow: "rgba(249,115,22,0.42)",
                      label: `${comparisonCurrentPoint.label} Gross`,
                      value: comparisonCurrentPoint.gross,
                    },
                    {
                      color: "linear-gradient(180deg, #60A5FA 0%, #2563EB 100%)",
                      glow: "rgba(37,99,235,0.4)",
                      label: `${comparisonCurrentPoint.label} Net`,
                      value: comparisonCurrentPoint.net,
                    },
                  ]}
                  heightClass="h-32"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  [`${comparisonPreviousPoint?.label ?? "Previous"} Net`, comparisonPreviousPoint?.net ?? 0],
                  [`${comparisonCurrentPoint.label} Net`, comparisonCurrentPoint.net],
                  ["Changed Rows", periodDelta.length],
                  ["Median Net", medianNet],
                ].map(([label, value]) => (
                  <div className="rounded-xl border border-border bg-bg-soft p-4" key={label}>
                    <p className="text-xs text-text-secondary">{label}</p>
                    <p className="mt-2 text-lg font-semibold text-text">
                      {typeof value === "number" && label !== "Changed Rows"
                        ? formatEGP(value)
                        : formatNumber(Number(value))}
                    </p>
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-xl border border-border bg-card p-4">
                <p className="text-xs text-text-secondary">Net Movement</p>
                <p
                  className={cn(
                    "mt-1 text-xl font-semibold",
                    comparisonCurrentPoint.net - (comparisonPreviousPoint?.net ?? 0) >= 0 ? "text-success" : "text-danger",
                  )}
                >
                  {formatEGP(comparisonCurrentPoint.net - (comparisonPreviousPoint?.net ?? 0))}
                </p>
              </div>
            </Card>

            <Card>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold text-text">
                  Salary Distribution
                </h2>
                <Badge variant="neutral">Net Pay</Badge>
              </div>
              <BarRows
                rows={salaryBands.map((band) => ({
                  label: band.label,
                  value: band.value,
                }))}
                valueFormatter={(value) => `${formatNumber(value)} employees`}
              />
            </Card>
          </div>

          <div className="grid gap-5 xl:grid-cols-[0.82fr_0.82fr_0.86fr_1fr]">
            <Card>
              <div className="mb-4">
                <h2 className="text-base font-semibold text-text">
                  Governmental Deductions
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  Statutory payroll deductions separated from operational deductions.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="pb-2 pr-4 font-medium text-text-secondary">
                        Deduction Type
                      </th>
                      <th className="pb-2 pr-4 font-medium text-text-secondary">
                        Amount
                      </th>
                      <th className="pb-2 font-medium text-text-secondary">
                        %
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {governmentalDeductionsBreakdown.map((item) => (
                      <tr key={item.label}>
                        <td className="py-2 pr-4 text-text">{item.label}</td>
                        <td className="py-2 pr-4 font-mono text-text-secondary">
                          {formatEGP(item.value)}
                        </td>
                        <td className="py-2 text-text-secondary">
                          {totals.governmentalDeductions > 0
                            ? `${((item.value / totals.governmentalDeductions) * 100).toFixed(1)}%`
                            : "0%"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card>
              <div className="mb-4">
                <h2 className="text-base font-semibold text-text">
                  Other Deductions
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  Medical, loans, attendance, CRM, and uploaded other deductions.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="pb-2 pr-4 font-medium text-text-secondary">
                        Deduction Type
                      </th>
                      <th className="pb-2 pr-4 font-medium text-text-secondary">
                        Amount
                      </th>
                      <th className="pb-2 font-medium text-text-secondary">
                        %
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {otherDeductionsBreakdown.map((item) => (
                      <tr key={item.label}>
                        <td className="py-2 pr-4 text-text">{item.label}</td>
                        <td className="py-2 pr-4 font-mono text-text-secondary">
                          {formatEGP(item.value)}
                        </td>
                        <td className="py-2 text-text-secondary">
                          {totals.otherDeductions > 0
                            ? `${((item.value / totals.otherDeductions) * 100).toFixed(1)}%`
                            : "0%"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card>
              <div className="mb-4">
                <h2 className="text-base font-semibold text-text">
                  Additions Breakdown
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  Incentives, allowances, and variable additions.
                </p>
              </div>
              <BarRows rows={additionsBreakdown.slice(0, 7)} />
            </Card>

            <Card>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-text">
                    Payroll Cost Analysis
                  </h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    Grouped view by line, area, or job title.
                  </p>
                </div>
                <select
                  className="h-9 rounded-lg border border-border bg-card px-3 text-xs text-text focus:outline-none"
                  onChange={(event) => setGroupMode(event.target.value as GroupMode)}
                  value={groupMode}
                >
                  <option value="line">By Line</option>
                  <option value="area">By Territory</option>
                  <option value="jobTitle">By Job Title</option>
                </select>
              </div>
              <BarRows
                rows={currentGroups.slice(0, 7).map((group) => ({
                  label: group.label,
                  meta: `${group.percent.toFixed(1)}%`,
                  value: group.net,
                }))}
              />
              <div className="mt-4 rounded-xl border border-border bg-bg-soft p-3">
                <p className="text-xs text-text-secondary">Overall Cost / Head</p>
                <p className="mt-1 text-lg font-semibold text-text">
                  {formatEGP(costPerHead)}
                </p>
              </div>
            </Card>
          </div>

          <ExecutiveActionPanel
            alerts={predictiveAlerts}
            insights={payrollInsights}
            onApprove={() => {
              if (primaryWorkflowAction) {
                void handleWorkflow(primaryWorkflowAction.action);
                return;
              }
              setActivePayrollTab("governance");
            }}
            onDrilldown={() => setShowAnomalyReview(true)}
            readiness={payrollScore.readiness}
          />

          <AiPayrollInsights
            insights={payrollInsights}
            isAnalyzing={isAnalyzingIntelligence}
          />

          <PayrollScoringPanel
            areaScores={areaScores}
            employeeScores={employeeScores}
            isAnalyzing={isAnalyzingIntelligence}
            lineScores={lineScores}
            score={payrollScore}
          />

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-text">Anomaly Review</h2>
                <p className="mt-1 text-sm text-text-secondary">
                  Hidden by default. Open only when you want to inspect net salaries above {formatEGP(anomalyThreshold)}.
                </p>
              </div>
              <Button
                onClick={() => setShowAnomalyReview((value) => !value)}
                variant={showAnomalyReview ? "primary" : "secondary"}
              >
                {showAnomalyReview
                  ? "Hide Anomalies"
                  : `Show Anomalies (${anomalyRecords.length})`}
              </Button>
            </div>

            {showAnomalyReview && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[880px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      {["HR ID", "Employee", "Job Title", "Line", "Area", "Net Salary", "Reason"].map((column) => (
                        <th className="pb-3 pr-4 font-medium text-text-secondary" key={column}>
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {anomalyRecords.length === 0 && (
                      <tr>
                        <td className="py-6 text-center text-sm text-text-secondary" colSpan={7}>
                          No salary anomalies detected for this batch.
                        </td>
                      </tr>
                    )}
                    {anomalyRecords.map((record) => (
                      <tr
                        className="bg-orange-50/40 transition-colors hover:bg-orange-50 dark:bg-orange-950/10"
                        key={record.id}
                      >
                        <td className="py-3 pr-4 font-mono text-xs text-text-secondary">
                          {record.employeeCode}
                        </td>
                        <td className="py-3 pr-4 font-medium text-text">
                          {record.fullName}
                        </td>
                        <td className="py-3 pr-4 text-text-secondary">
                          {record.jobTitle || "-"}
                        </td>
                        <td className="py-3 pr-4 text-text-secondary">
                          {record.line || "-"}
                        </td>
                        <td className="py-3 pr-4 text-text-secondary">
                          {record.area || "-"}
                        </td>
                        <td className="py-3 pr-4 font-mono font-semibold text-text">
                          {formatEGP(record.netSalary)}
                        </td>
                        <td className="py-3 pr-4 text-text-secondary">
                          {formatEGP(record.netSalary - avgNet)} above average net salary.
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="mx-auto flex max-w-4xl items-center justify-center gap-2 rounded-3xl border border-slate-200 bg-white p-2 shadow-[0_14px_40px_rgba(15,23,42,0.07)]">
            {[
              "Executive Dashboard",
              "Deep Analytics",
              "Employee Drilldown",
              "Validation & Audit",
            ].map((label, index) => (
              <button
                className={cn(
                  "flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold transition",
                  index === 0
                    ? "bg-primary text-white shadow-[0_12px_26px_rgba(249,115,22,0.28)]"
                    : "text-text-secondary hover:bg-slate-50 hover:text-text",
                )}
                key={label}
                onClick={() => {
                  if (index === 2) setShowAnomalyReview(true);
                  if (index === 3) setActivePayrollTab("governance");
                }}
                type="button"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/20 font-mono text-xs">
                  {index + 1}
                </span>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
