"use client";

import { formatNumberValue } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

import { PANEL_CLASS, egp } from "./shared";

/**
 * The queue in one line (owner, 2026-11-07: "one compact line … nothing repeated").
 *
 * Four cells — awaiting, approved, adjusted, rejected — each a count with the money beside it.
 * This is the ONLY place these four figures render: the hero carries no chips and the rail's
 * header repeats nothing. The numbers follow the filters, so the line always describes the trips
 * on screen.
 */
export function StatLine({
  adjustedCount,
  adjustedDelta,
  approvedCount,
  approvedValue,
  pendingCount,
  pendingValue,
  rejectedCount,
}: {
  adjustedCount: number;
  adjustedDelta: number;
  approvedCount: number;
  approvedValue: number;
  pendingCount: number;
  pendingValue: number;
  rejectedCount: number;
}) {
  const cells = [
    {
      key: "pending",
      label: "awaiting",
      money: pendingValue > 0 ? egp(pendingValue) : "",
      tone: "border-l-orange-500",
      value: pendingCount,
    },
    {
      key: "approved",
      label: "approved",
      money: approvedValue > 0 ? egp(approvedValue) : "",
      tone: "border-l-emerald-500",
      value: approvedCount,
    },
    {
      key: "adjusted",
      label: "adjusted",
      money: adjustedCount > 0 ? `${egp(adjustedDelta)} below the claim` : "",
      tone: "border-l-blue-500",
      value: adjustedCount,
    },
    {
      key: "rejected",
      label: "rejected",
      money: "",
      tone: "border-l-rose-500",
      value: rejectedCount,
    },
  ] as const;

  return (
    <div className={cn(PANEL_CLASS, "grid grid-cols-2 sm:grid-cols-4 [&>*]:min-w-0")} data-stat-line>
      {cells.map((cell, index) => (
        <div
          className={cn(
            "flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-l-[3px] px-4 py-2.5",
            cell.tone,
            index < 2 ? "border-b border-b-slate-200 sm:border-b-0" : "",
          )}
          key={cell.key}
        >
          <span className="font-mono text-lg font-black tabular-nums text-slate-900">{formatNumberValue(cell.value)}</span>
          <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{cell.label}</span>
          {cell.money ? (
            <span className="min-w-0 break-words font-mono text-xs font-bold tabular-nums text-slate-600">
              · {cell.money}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
