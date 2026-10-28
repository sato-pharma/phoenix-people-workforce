"use client";

import React, { useState } from "react";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from "recharts";
import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { repTargetGap } from "@/lib/employee-portal/rep-target-gap";
import type { DsmTeamMemberData, DsmTeamMemberProductData } from "@/lib/employee-portal/service";
import { INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT } from "@/lib/incentives/eligibility-threshold";
import { chartPersonName } from "@/lib/format/chart-person-name";
import { formatEmployeeDisplayName } from "@/lib/utils";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";

const LEADERBOARD_PAGE_SIZE = 25;

type AchievementChartDatum = {
  achievementPercent: number;
  name: string;
  fullName?: string;
  totalSales: number;
  totalTarget: number;
};

type SalesVsTargetChartDatum = {
  name: string;
  Sales: number;
  Target: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

function egp(value: number) {
  return stableCurrencyFormatter("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function pct(value: number) {
  return `${Number.isFinite(value) ? value.toFixed(1) : "0.0"}%`;
}

function compactEgp(value: number) {
  return stableCurrencyFormatter("en-US", {
    compactDisplay: "short",
    currency: "EGP",
    maximumFractionDigits: 1,
    notation: "compact",
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

/** Chart axis labels ONLY — first and last name; tables, cards and tooltips keep the full name. */
function displayName(fullName: string) {
  return chartPersonName(fullName);
}

/**
 * The incentive-line chip. The 90% line is a PERCENTAGE of target, so the gap is in percentage
 * points to it — never "more sales" (owner, 2026-10-26: "Needs 8.8% more" read as 8.8% more sales).
 */
function incentiveLineLabel(achievementPercent: number): string {
  if (achievementPercent >= INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT) {
    return `Reached the ${INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT}% line`;
  }
  const points = Math.max(0, INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT - achievementPercent);
  return `${points.toFixed(1)} points to ${INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT}%`;
}

function isAchievementChartDatum(value: unknown): value is AchievementChartDatum {
  return Boolean(
    value &&
    typeof value === "object" &&
    "achievementPercent" in value &&
    "name" in value &&
    "totalSales" in value &&
    "totalTarget" in value,
  );
}

function isSalesVsTargetChartDatum(value: unknown): value is SalesVsTargetChartDatum {
  return Boolean(
    value &&
    typeof value === "object" &&
    "name" in value &&
    "Sales" in value &&
    "Target" in value,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Achievement colours (insight-driven degrading)
// ─────────────────────────────────────────────────────────────────────────────

function achievementColor(pct: number, isTop = false): string {
  if (pct >= 100) return "#10b981"; // green - over-achieved
  if (pct >= INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT) return "#22c55e"; // lighter green - eligible
  if (pct >= 70) return "#f97316"; // orange - within reach
  if (isTop) return "#f59e0b"; // amber - top but still low
  return "#ef4444"; // red - needs work
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom tooltip for the achievement chart
// ─────────────────────────────────────────────────────────────────────────────

function AchievementTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { name: string; fullName?: string; achievementPercent: number; totalSales: number; totalTarget: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="max-w-[calc(100vw-4rem)] rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-sm">
      <p className="mb-1 break-words font-semibold text-slate-900">{d.fullName ?? d.name}</p>
      <p className="text-slate-600">Achievement: <span className="font-bold text-slate-900">{pct(d.achievementPercent)}</span></p>
      <p className="text-slate-600">Sales: <span className="font-medium">{egp(d.totalSales)}</span></p>
      <p className="text-slate-600">Target: <span className="font-medium">{egp(d.totalTarget)}</span></p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Achievement bar chart (horizontal)
// ─────────────────────────────────────────────────────────────────────────────

export function TeamAchievementChart({
  members,
  teamAchievementPercent,
}: {
  members: DsmTeamMemberData[];
  teamAchievementPercent: number;
}) {
  const [activeDatum, setActiveDatum] = useState<AchievementChartDatum | null>(null);
  const chartData = members.map((m) => ({
    name: displayName(m.name),
    fullName: formatEmployeeDisplayName(m.name),
    achievementPercent: Math.round(m.achievementPercent * 10) / 10,
    totalSales: m.totalSales,
    totalTarget: m.totalTarget,
  }));
  const chartHeight = Math.max(288, Math.min(680, chartData.length * 48 + 84));

  return (
    <div className="min-w-0 overflow-hidden pb-2">
      <div role="img" aria-label="Team achievement percentage bar chart showing each rep's achievement against target">
        <SafeResponsiveContainer className="w-full min-w-0" minHeight={chartHeight} style={{ height: chartHeight }}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 6, top: 8, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
            <XAxis
              type="number"
              domain={[0, Math.max(120, Math.ceil(Math.max(...chartData.map((d) => d.achievementPercent), 0) / 10) * 10)]}
              tickFormatter={(v) => `${v}%`}
              tick={{ fontSize: 11, fill: "#94a3b8" }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="name"
              tickFormatter={(value) => String(value).replace(/\s+/g, " ")}
              width={86}
              tick={{ fontSize: 10, fill: "#475569" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<AchievementTooltip />} />
            <ReferenceLine
              x={INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT}
              stroke="#94a3b8"
              strokeDasharray="4 4"
              label={{ value: `${INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT}%`, position: "top", fontSize: 10, fill: "#94a3b8" }}
            />
            {teamAchievementPercent > 0 && (
              <ReferenceLine
                x={Math.round(teamAchievementPercent * 10) / 10}
                stroke="#f97316"
                strokeDasharray="4 4"
                label={{ value: "Team", position: "top", fontSize: 10, fill: "#f97316" }}
              />
            )}
            <Bar
              dataKey="achievementPercent"
              name="Achievement %"
              onClick={(entry: unknown) => {
                if (isAchievementChartDatum(entry)) setActiveDatum(entry);
              }}
              radius={[0, 0, 0, 0]}
            >
              {chartData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={achievementColor(entry.achievementPercent, index === 0)} />
              ))}
            </Bar>
          </BarChart>
        </SafeResponsiveContainer>
      </div>
      {activeDatum ? (
        <div className="mt-3 rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 break-words font-bold text-slate-900">{activeDatum.fullName ?? activeDatum.name}</p>
            <p className="shrink-0 font-bold" style={{ color: achievementColor(activeDatum.achievementPercent) }}>
              {pct(activeDatum.achievementPercent)}
            </p>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-2 text-slate-500">
            <p>Sales <span className="font-semibold text-slate-800">{egp(activeDatum.totalSales)}</span></p>
            <p>Target <span className="font-semibold text-slate-800">{egp(activeDatum.totalTarget)}</span></p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sales vs Target bar chart (grouped, vertical)
// ─────────────────────────────────────────────────────────────────────────────

function SalesVsTargetTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; fill: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="max-w-[calc(100vw-4rem)] rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-sm">
      <p className="mb-1 break-words font-semibold text-slate-900">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="text-slate-600">
          {p.name}: <span className="font-medium" style={{ color: p.fill }}>{egp(p.value)}</span>
        </p>
      ))}
    </div>
  );
}

export function TeamSalesVsTargetChart({
  members,
  minHeightPx = 320,
}: {
  members: DsmTeamMemberData[];
  minHeightPx?: number;
}) {
  const [activeDatum, setActiveDatum] = useState<SalesVsTargetChartDatum | null>(null);
  const chartData = members.map((m) => ({
    name: displayName(m.name),
    Sales: Math.round(m.totalSales),
    Target: Math.round(m.totalTarget),
  }));
  return (
    <div className="min-w-0 overflow-hidden pb-2">
      <div role="img" aria-label="Sales versus target comparison bar chart for each team member">
        <SafeResponsiveContainer className="w-full min-w-0" minHeight={minHeightPx} style={{ height: minHeightPx }}>
          <BarChart data={chartData} margin={{ left: 0, right: 0, top: 8, bottom: 36 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
            <XAxis
              dataKey="name"
              angle={-35}
              axisLine={false}
              height={68}
              interval={0}
              minTickGap={0}
              tick={{ fontSize: 9, fill: "#475569" }}
              tickLine={false}
              tickMargin={10}
              textAnchor="end"
            />
            <YAxis
              tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
              width={34}
              tick={{ fontSize: 9, fill: "#94a3b8" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<SalesVsTargetTooltip />} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar
              dataKey="Sales"
              fill="#f97316"
              onClick={(entry: unknown) => {
                if (isSalesVsTargetChartDatum(entry)) setActiveDatum(entry);
              }}
              radius={[0, 0, 0, 0]}
            />
            <Bar
              dataKey="Target"
              fill="#e2e8f0"
              onClick={(entry: unknown) => {
                if (isSalesVsTargetChartDatum(entry)) setActiveDatum(entry);
              }}
              radius={[0, 0, 0, 0]}
            />
          </BarChart>
        </SafeResponsiveContainer>
      </div>
      {activeDatum ? (
        <div className="mt-3 rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs shadow-sm">
          <p className="min-w-0 break-words font-bold text-slate-900">{activeDatum.name}</p>
          <div className="mt-1 grid grid-cols-2 gap-2 text-slate-500">
            <p>Sales <span className="font-semibold text-orange-600">{egp(activeDatum.Sales)}</span></p>
            <p>Target <span className="font-semibold text-slate-800">{egp(activeDatum.Target)}</span></p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-rep product breakdown row
// ─────────────────────────────────────────────────────────────────────────────

function ProductRow({ product }: { product: DsmTeamMemberProductData }) {
  const barWidth = Math.min(100, Math.max(0, product.achievementPercent));
  const color = achievementColor(product.achievementPercent);
  return (
    <div className="py-2 border-b border-slate-50 last:border-0">
      <div className="flex items-center justify-between mb-1 gap-2">
        <span className="text-xs font-medium text-slate-700 break-words flex-1 min-w-0">{product.product}</span>
        <span className="text-xs font-bold text-slate-900 shrink-0" style={{ color }}>
          {pct(product.achievementPercent)}
        </span>
      </div>
      <div className="grid gap-1.5 sm:flex sm:items-center sm:gap-2">
        <div className="flex-1 h-1.5 rounded bg-slate-100 overflow-hidden">
          <div
            className="h-full rounded transition-all duration-500"
            style={{ width: `${barWidth}%`, backgroundColor: color }}
          />
        </div>
        <span className="text-phx-2xs text-slate-400 sm:shrink-0 sm:w-20 sm:text-right">
          {egp(product.sales)} / {egp(product.target)}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-rep expandable card
// ─────────────────────────────────────────────────────────────────────────────

function RepCard({ member, rank }: { member: DsmTeamMemberData; rank: number }) {
  const [expanded, setExpanded] = useState(false);
  const color = achievementColor(member.achievementPercent, rank === 1);
  const isEligible = member.achievementPercent >= INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT;

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-slate-100 bg-white shadow-sm">
      <button
        className="w-full min-w-0 p-4 text-left transition-colors hover:bg-slate-50"
        onClick={() => setExpanded((v) => !v)}
        type="button"
      >
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 sm:flex sm:items-center">
          {/* Rank badge */}
          <div
            className="w-9 h-9 rounded flex items-center justify-center text-sm font-bold text-white shrink-0"
            style={{ backgroundColor: rank <= 3 ? color : "#94a3b8" }}
          >
            #{rank}
          </div>

          {/* Name + status */}
          <div className="min-w-0 sm:flex-1">
            <p className="break-words text-sm font-semibold leading-tight text-slate-900">{formatEmployeeDisplayName(member.name)}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span
                className="text-phx-2xs font-medium px-1.5 py-0.5 rounded"
                style={{
                  backgroundColor: isEligible ? "#dcfce7" : "#fef3c7",
                  color: isEligible ? "#15803d" : "#92400e",
                }}
              >
                {incentiveLineLabel(member.achievementPercent)}
              </span>
              <span className="text-phx-2xs text-slate-400">
                {member.products.length} products
              </span>
            </div>
          </div>

          {/* Achievement */}
          <div className="col-span-3 grid grid-cols-[1fr_auto] items-center gap-2 text-left sm:block sm:text-right sm:shrink-0">
            <p className="text-lg font-bold sm:text-xl" style={{ color }}>
              {pct(member.achievementPercent)}
            </p>
            <p className="min-w-0 break-words text-right text-phx-2xs text-slate-400 sm:text-right" title={`${egp(member.totalSales)} / ${egp(member.totalTarget)}`}>
              {compactEgp(member.totalSales)} / {compactEgp(member.totalTarget)}
            </p>
          </div>

          {/* Expand arrow */}
          <svg
            className={`row-start-1 col-start-3 mt-2 w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 sm:mt-0 ${expanded ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>

        {/* Achievement progress bar */}
        <div className="mt-3 h-2 rounded bg-slate-100 overflow-hidden">
          <div
            className="h-full rounded transition-all duration-700"
            style={{
              width: `${Math.min(100, member.achievementPercent)}%`,
              backgroundColor: color,
            }}
          />
        </div>
      </button>

      {/* Product breakdown (expanded) */}
      {expanded && member.products.length > 0 && (
        <div className="px-4 pb-4 border-t border-slate-50">
          <p className="text-phx-2xs uppercase tracking-widest text-slate-400 pt-3 pb-1">
            Product Breakdown
          </p>
          {member.products.map((product) => (
            <ProductRow key={product.product} product={product} />
          ))}
        </div>
      )}
      {expanded && member.products.length === 0 && (
        <div className="px-4 pb-4 pt-2 border-t border-slate-50">
          <p className="text-xs text-slate-400 text-center py-2">No product data available</p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Full leaderboard table
// ─────────────────────────────────────────────────────────────────────────────

export function TeamLeaderboardTable({
  members,
  showProductCount = true,
}: {
  members: DsmTeamMemberData[];
  /** False on a roll-up (Regional Managers): its "products" are the districts' products, not his own. */
  showProductCount?: boolean;
}) {
  const [page, setPage] = useState(0);

  const [prevMembers, setPrevMembers] = useState(members);
  if (members !== prevMembers) {
    setPrevMembers(members);
    setPage(0);
  }

  const pageMembers = members.slice(page * LEADERBOARD_PAGE_SIZE, (page + 1) * LEADERBOARD_PAGE_SIZE);

  return (
    <div className="min-w-0">
      {/* Mobile card view */}
      <div className="grid gap-2.5 sm:hidden">
        {pageMembers.map((member) => {
          // Achieved means the target is met — never the 90% incentive line (rep-target-gap.ts).
          const { achieved: isAchieved, gap } = repTargetGap(member.totalSales, member.totalTarget);
          const color = achievementColor(member.achievementPercent, member.position === 1);
          const progressWidth = Math.min(100, Math.max(0, member.achievementPercent));
          return (
            <div
              className="relative min-w-0 overflow-hidden rounded-lg border border-slate-100 bg-white shadow-sm"
              key={member.hrId}
            >
              {/* Left accent bar */}
              <div
                className="absolute inset-y-0 left-0 w-[3px]"
                style={{ backgroundColor: color }}
              />

              <div className="pl-4 pr-3 pt-3 pb-2.5">
                {/* Top row: rank + name + achievement */}
                <div className="flex items-start gap-2.5">
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded text-phx-xs font-bold text-white shrink-0"
                    style={{ backgroundColor: member.position <= 3 ? color : "#cbd5e1" }}
                  >
                    {member.position}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`break-words text-sm font-semibold leading-tight ${member.isRegionWithoutManager ? "italic text-slate-500" : "text-slate-900"}`}>
                      {formatEmployeeDisplayName(member.name)}
                    </p>
                    {showProductCount ? (
                      <p className="mt-0.5 text-phx-2xs text-slate-400">{member.products.length} products</p>
                    ) : null}
                  </div>
                  <p className="shrink-0 text-base font-bold" style={{ color }}>
                    {pct(member.achievementPercent)}
                  </p>
                </div>

                {/* Achievement progress bar */}
                <div className="mt-2 h-1.5 rounded bg-slate-100 overflow-hidden">
                  <div
                    className="h-full rounded transition-all duration-500"
                    style={{ width: `${progressWidth}%`, backgroundColor: color }}
                  />
                </div>

                {/* Metadata pills */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center rounded bg-slate-50 px-1.5 py-0.5 text-phx-2xs font-medium text-slate-600">
                    Sales: {compactEgp(member.totalSales)}
                  </span>
                  <span className="inline-flex items-center rounded bg-slate-50 px-1.5 py-0.5 text-phx-2xs font-medium text-slate-600">
                    Target: {compactEgp(member.totalTarget)}
                  </span>
                  {!isAchieved ? (
                    <span className="inline-flex items-center rounded bg-red-50 px-1.5 py-0.5 text-phx-2xs font-medium text-red-600">
                      Gap: {compactEgp(gap)}
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded bg-green-50 px-1.5 py-0.5 text-phx-2xs font-medium text-green-700">
                      Achieved
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Desktop table view.
          `table-fixed` with a colgroup, and NO `overflow-x-auto` — the prescribed fix rather than
          the permission to overflow. AGENTS.md §4: fit by merging or sizing columns, never by
          granting a sideways scroll. The scroll here was dead permission anyway: this block is
          `hidden md:block`, so it only ever renders at 768px and up, and three of its six columns
          are themselves hidden below `sm`. Percentages, so the table divides whatever width it is
          given instead of carrying a floor it can exceed. Name takes the slack because it is the
          only column with words in it. */}
      <div className="hidden md:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[8%]" />
            <col className="w-[36%]" />
            <col className="w-[16%]" />
            <col className="w-[14%]" />
            <col className="w-[14%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-100">
              <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 w-10 border-r border-slate-100">#</th>
              <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 border-r border-slate-100">Name</th>
              <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 border-r border-slate-100">Achievement</th>
              <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 hidden sm:table-cell border-r border-slate-100">Sales</th>
              <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 hidden sm:table-cell border-r border-slate-100">Target</th>
              <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 hidden min-[420px]:table-cell">Gap</th>
            </tr>
          </thead>
          <tbody>
            {pageMembers.map((member) => {
              const { achieved: isAchieved, gap } = repTargetGap(member.totalSales, member.totalTarget);
              const color = achievementColor(member.achievementPercent, member.position === 1);
              return (
                <tr key={member.hrId} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                  <td className="py-2.5 px-3 border-r border-slate-100">
                    <span
                      className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold text-white"
                      style={{ backgroundColor: member.position <= 3 ? color : "#cbd5e1" }}
                    >
                      {member.position}
                    </span>
                  </td>
                  <td className="min-w-0 py-2.5 px-3 border-r border-slate-100">
                    <p className={`break-words font-medium leading-tight ${member.isRegionWithoutManager ? "italic text-slate-500" : "text-slate-900"}`}>{formatEmployeeDisplayName(member.name)}</p>
                    {showProductCount ? <p className="text-phx-2xs text-slate-400">{member.products.length} products</p> : null}
                  </td>
                  <td className="py-2.5 px-3 text-right border-r border-slate-100">
                    <span className="font-bold" style={{ color }}>
                      {pct(member.achievementPercent)}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-right hidden sm:table-cell border-r border-slate-100">
                    <span className="text-slate-700">{egp(member.totalSales)}</span>
                  </td>
                  <td className="py-2.5 px-3 text-right hidden sm:table-cell border-r border-slate-100">
                    <span className="text-slate-500">{egp(member.totalTarget)}</span>
                  </td>
                  <td className="py-2.5 px-3 text-right hidden min-[420px]:table-cell">
                    {!isAchieved ? (
                      <span className="text-xs text-red-500 font-medium">{egp(gap)}</span>
                    ) : (
                      <span className="text-xs text-green-600 font-medium">Achieved</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <PaginationControls
        onPageChange={setPage}
        page={page}
        pageSize={LEADERBOARD_PAGE_SIZE}
        total={members.length}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Rep cards grid (all reps with expandable product breakdown)
// ─────────────────────────────────────────────────────────────────────────────

export function TeamMembersBreakdown({ members }: { members: DsmTeamMemberData[] }) {
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {members.map((member) => (
        <RepCard key={member.hrId} member={member} rank={member.position} />
      ))}
    </div>
  );
}
