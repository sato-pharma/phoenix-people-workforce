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
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import type { DsmTeamMemberData, DsmTeamMemberProductData } from "@/lib/employee-portal/service";
import { formatEmployeeDisplayName } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function pct(value: number) {
  return `${Number.isFinite(value) ? value.toFixed(1) : "0.0"}%`;
}

function shortName(fullName: string) {
  return formatEmployeeDisplayName(fullName);
}

// ─────────────────────────────────────────────────────────────────────────────
// Achievement colours
// ─────────────────────────────────────────────────────────────────────────────

function achievementColor(pct: number, isTop = false): string {
  if (pct >= 100) return "#10b981"; // green – over-achieved
  if (pct >= 90) return "#22c55e"; // lighter green – eligible
  if (pct >= 70) return "#f97316"; // orange – within reach
  if (isTop) return "#f59e0b"; // amber – top but still low
  return "#ef4444"; // red – needs work
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom tooltip for the achievement chart
// ─────────────────────────────────────────────────────────────────────────────

function AchievementTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { name: string; achievementPercent: number; totalSales: number; totalTarget: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-lg text-sm">
      <p className="font-semibold text-slate-900 mb-1">{d.name}</p>
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
  const chartData = members.map((m) => ({
    name: shortName(m.name),
    achievementPercent: Math.round(m.achievementPercent * 10) / 10,
    totalSales: m.totalSales,
    totalTarget: m.totalTarget,
  }));

  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 20, top: 4, bottom: 4 }}>
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
            width={110}
            tick={{ fontSize: 11, fill: "#475569" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={<AchievementTooltip />} />
          <ReferenceLine
            x={90}
            stroke="#94a3b8"
            strokeDasharray="4 4"
            label={{ value: "90%", position: "top", fontSize: 10, fill: "#94a3b8" }}
          />
          {teamAchievementPercent > 0 && (
            <ReferenceLine
              x={Math.round(teamAchievementPercent * 10) / 10}
              stroke="#f97316"
              strokeDasharray="4 4"
              label={{ value: "Avg", position: "top", fontSize: 10, fill: "#f97316" }}
            />
          )}
          <Bar dataKey="achievementPercent" name="Achievement %" radius={[0, 4, 4, 0]}>
            {chartData.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={achievementColor(entry.achievementPercent, index === 0)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
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
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-lg text-sm">
      <p className="font-semibold text-slate-900 mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="text-slate-600">
          {p.name}: <span className="font-medium" style={{ color: p.fill }}>{egp(p.value)}</span>
        </p>
      ))}
    </div>
  );
}

export function TeamSalesVsTargetChart({ members }: { members: DsmTeamMemberData[] }) {
  const chartData = members.map((m) => ({
    name: shortName(m.name),
    Sales: Math.round(m.totalSales),
    Target: Math.round(m.totalTarget),
  }));

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 10, fill: "#475569" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
            tick={{ fontSize: 10, fill: "#94a3b8" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={<SalesVsTargetTooltip />} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="Sales" fill="#f97316" radius={[4, 4, 0, 0]} />
          <Bar dataKey="Target" fill="#e2e8f0" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-rep product breakdown card (expandable)
// ─────────────────────────────────────────────────────────────────────────────

function ProductRow({ product }: { product: DsmTeamMemberProductData }) {
  const barWidth = Math.min(100, Math.max(0, product.achievementPercent));
  const color = achievementColor(product.achievementPercent);
  return (
    <div className="py-2 border-b border-slate-50 last:border-0">
      <div className="flex items-center justify-between mb-1 gap-2">
        <span className="text-xs font-medium text-slate-700 truncate flex-1">{product.product}</span>
        <span className="text-xs font-bold text-slate-900 shrink-0" style={{ color }}>
          {pct(product.achievementPercent)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${barWidth}%`, backgroundColor: color }}
          />
        </div>
        <span className="text-[10px] text-slate-400 shrink-0 w-20 text-right">
          {egp(product.sales)} / {egp(product.target)}
        </span>
      </div>
    </div>
  );
}

function RepCard({ member, rank }: { member: DsmTeamMemberData; rank: number }) {
  const [expanded, setExpanded] = useState(false);
  const color = achievementColor(member.achievementPercent, rank === 1);
  const isEligible = member.achievementPercent >= 90;

  return (
    <div className="rounded-2xl border border-slate-100 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <button
        className="w-full text-left p-4 hover:bg-slate-50 transition-colors"
        onClick={() => setExpanded((v) => !v)}
        type="button"
      >
        <div className="flex items-center gap-3">
          {/* Rank badge */}
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-black text-white shrink-0"
            style={{ backgroundColor: rank <= 3 ? color : "#94a3b8" }}
          >
            #{rank}
          </div>

          {/* Name + status */}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-slate-900 text-sm truncate">{formatEmployeeDisplayName(member.name)}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <span
                className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                style={{
                  backgroundColor: isEligible ? "#dcfce7" : "#fef3c7",
                  color: isEligible ? "#15803d" : "#92400e",
                }}
              >
                {isEligible ? "Incentive Eligible" : `Needs ${pct(Math.max(0, 90 - member.achievementPercent))} more`}
              </span>
              <span className="text-[10px] text-slate-400">
                {member.products.length} products
              </span>
            </div>
          </div>

          {/* Achievement */}
          <div className="text-right shrink-0">
            <p className="text-xl font-black" style={{ color }}>
              {pct(member.achievementPercent)}
            </p>
            <p className="text-[10px] text-slate-400">
              {egp(member.totalSales)} / {egp(member.totalTarget)}
            </p>
          </div>

          {/* Expand arrow */}
          <svg
            className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>

        {/* Achievement progress bar */}
        <div className="mt-3 h-2 rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
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
          <p className="text-[10px] uppercase tracking-widest text-slate-400 pt-3 pb-1">
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

export function TeamLeaderboardTable({ members }: { members: DsmTeamMemberData[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100">
            <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 w-10">#</th>
            <th className="text-left py-2 px-3 text-xs font-medium text-slate-500">Name</th>
            <th className="text-right py-2 px-3 text-xs font-medium text-slate-500">Achievement</th>
            <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 hidden sm:table-cell">Sales</th>
            <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 hidden sm:table-cell">Target</th>
            <th className="text-right py-2 px-3 text-xs font-medium text-slate-500">Gap</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const gap = Math.max(0, member.totalTarget - member.totalSales);
            const color = achievementColor(member.achievementPercent, member.position === 1);
            return (
              <tr key={member.hrId} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                <td className="py-2.5 px-3">
                  <span
                    className="w-6 h-6 rounded-lg flex items-center justify-center text-xs font-bold text-white"
                    style={{ backgroundColor: member.position <= 3 ? color : "#cbd5e1" }}
                  >
                    {member.position}
                  </span>
                </td>
                <td className="py-2.5 px-3">
                  <p className="font-medium text-slate-900">{formatEmployeeDisplayName(member.name)}</p>
                  <p className="text-[10px] text-slate-400">{member.products.length} products</p>
                </td>
                <td className="py-2.5 px-3 text-right">
                  <span className="font-bold" style={{ color }}>
                    {pct(member.achievementPercent)}
                  </span>
                </td>
                <td className="py-2.5 px-3 text-right hidden sm:table-cell">
                  <span className="text-slate-700">{egp(member.totalSales)}</span>
                </td>
                <td className="py-2.5 px-3 text-right hidden sm:table-cell">
                  <span className="text-slate-500">{egp(member.totalTarget)}</span>
                </td>
                <td className="py-2.5 px-3 text-right">
                  {gap > 0 ? (
                    <span className="text-xs text-red-500 font-medium">{egp(gap)}</span>
                  ) : (
                    <span className="text-xs text-green-600 font-medium">✓ Achieved</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Rep cards grid (all reps with expandable product breakdown)
// ─────────────────────────────────────────────────────────────────────────────

export function TeamMembersBreakdown({ members }: { members: DsmTeamMemberData[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {members.map((member) => (
        <RepCard key={member.hrId} member={member} rank={member.position} />
      ))}
    </div>
  );
}
