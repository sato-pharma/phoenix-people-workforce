"use client";

import { formatNumberValue } from "@/lib/i18n/format";
import { ALL_KINDS_LABEL, CLAIM_KINDS, CLAIM_KIND_LABEL } from "@/lib/outstation/approvals/claim-kind";
import type { ClaimKind } from "@/lib/outstation/approvals/types";
import { cn } from "@/lib/utils";

/**
 * The kind filter: All kinds · Traveling · Meeting · Other (owner, 2026-11-23: "I want to be able to
 * filter by, for example, meeting, for example, other, for example, traveling").
 *
 * One press narrows the lane on screen — Ready, Your call or History — and the choice is kept in
 * the address, so a reload or a shared link opens the same list. On a waiting lane each button says
 * how many claims of that kind the lane holds; History is read from the server a page at a time, so
 * there the buttons carry no figure rather than a guessed one.
 */
export function DeskKindFilter({
  counts,
  kind,
  onChoose,
}: {
  /** How many claims of each kind the lane on screen holds; null when the lane is History. */
  counts: Record<ClaimKind, number> | null;
  kind: ClaimKind | null;
  onChoose: (kind: ClaimKind | null) => void;
}) {
  const all = counts ? CLAIM_KINDS.reduce((sum, key) => sum + counts[key], 0) : null;
  const options: ReadonlyArray<{ count: number | null; key: ClaimKind | null; label: string }> = [
    { count: all, key: null, label: ALL_KINDS_LABEL },
    ...CLAIM_KINDS.map((key) => ({ count: counts ? counts[key] : null, key, label: CLAIM_KIND_LABEL[key] })),
  ];
  return (
    <div aria-label="Kind of claim" className="flex min-w-0 flex-wrap items-center gap-1.5" data-desk-kinds role="group">
      {options.map((entry) => (
        <button
          aria-pressed={kind === entry.key}
          className={cn(
            "inline-flex min-h-11 min-w-0 items-center border px-3 py-1 text-xs font-black transition md:min-h-9",
            kind === entry.key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-slate-500",
          )}
          data-kind={entry.key ?? "all"}
          key={entry.key ?? "all"}
          onClick={() => onChoose(entry.key)}
          type="button"
        >
          <span className="break-words">
            {entry.label}
            {entry.count !== null ? <span className="tabular-nums"> ({formatNumberValue(entry.count)})</span> : null}
          </span>
        </button>
      ))}
    </div>
  );
}
