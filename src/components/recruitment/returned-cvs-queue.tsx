"use client";

// Recruitment / ATS — the administrator's Returned CVs queue, rendered.
//
// One pile per returning district manager, split by the reason he gave. The owner, 2026-09-01: *"the
// CV comes back in a folder based on the district manager who is sending it ... because area not
// match — or any other situation."* The admin reads each, re-routes it in the pipeline, then marks it
// handled — which clears the row here but leaves the CV suppressed from that manager's folder, so his
// decision stands. See district-returns.ts for the grouping and the resolve semantics.

import { useMemo, useState } from "react";

import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { ReturnedCvItem, ReturnedCvManagerGroup } from "@/lib/recruitment/district-returns";

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
      {children}
    </span>
  );
}

/**
 * One returned CV, with the reason its manager gave and a single button to clear it. The context
 * line is the seat snapshot taken at return time — area first, then line/region — so the admin can
 * see where it came from without opening anything.
 */
function ReturnedRow({
  item,
  busy,
  onResolve,
}: {
  item: ReturnedCvItem;
  busy: boolean;
  onResolve: (item: ReturnedCvItem) => void;
}) {
  const context = [item.areaName, item.lineName, item.regionName].filter(Boolean).join(" · ");
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-semibold text-slate-900" dir="auto">
          {item.candidateName?.trim() ? item.candidateName : "Unnamed candidate"}
        </p>
        <p className="text-xs text-slate-500">
          {context || "No area recorded"}
          {item.returnedAt ? ` · returned ${cairoDateTime(item.returnedAt)}` : ""}
        </p>
        {item.reasonNote?.trim() ? (
          <p className="max-w-2xl rounded-md bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600" dir="auto">
            &ldquo;{item.reasonNote}&rdquo;
          </p>
        ) : null}
      </div>
      <button
        className="shrink-0 whitespace-nowrap rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700 disabled:opacity-60"
        disabled={busy}
        onClick={() => onResolve(item)}
        type="button"
      >
        {busy ? "Clearing…" : "Mark handled"}
      </button>
    </li>
  );
}

export function ReturnedCvsQueue({ groups: initialGroups }: { groups: ReturnedCvManagerGroup[] }) {
  // Which returns the admin has cleared in THIS session, so a handled row drops in place. The list is
  // a server read that only refreshes on reload, so without this a cleared CV would sit here looking
  // un-cleared until the next navigation.
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(() => new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    return initialGroups
      .map((manager) => {
        const reasons = manager.reasons
          .map((reason) => ({ ...reason, items: reason.items.filter((item) => !resolvedIds.has(item.returnId)) }))
          .filter((reason) => reason.items.length > 0);
        const total = reasons.reduce((sum, reason) => sum + reason.items.length, 0);
        return { ...manager, reasons, total };
      })
      .filter((manager) => manager.total > 0);
  }, [initialGroups, resolvedIds]);

  const totalOpen = groups.reduce((sum, manager) => sum + manager.total, 0);

  async function resolve(item: ReturnedCvItem) {
    if (busyId) return;
    setBusyId(item.returnId);
    setError(null);
    try {
      const res = await fetch(`/api/recruitment/district-returns/${item.returnId}/resolve`, {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(payload?.message ?? "This CV could not be marked handled. Please try again.");
        return;
      }
      setResolvedIds((current) => {
        const next = new Set(current);
        next.add(item.returnId);
        return next;
      });
    } catch {
      setError("This CV could not be marked handled. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  if (initialGroups.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
        No CVs have been returned. When a district manager hands a CV back — because it is not for one of his areas, or
        for any other reason — it will appear here, grouped by the manager who returned it.
      </div>
    );
  }

  if (totalOpen === 0) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-6 text-sm font-medium text-emerald-800">
        Every returned CV has been handled. The queue is clear.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
        <div className="flex items-baseline gap-1.5">
          <span className="font-bold uppercase tracking-wide text-slate-400">Returned CVs</span>
          <span className="text-sm font-bold tabular-nums text-slate-800">{totalOpen}</span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="font-bold uppercase tracking-wide text-slate-400">Managers</span>
          <span className="text-sm font-bold tabular-nums text-slate-800">{groups.length}</span>
        </div>
      </div>

      {error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{error}</p>
      ) : null}

      {groups.map((manager) => (
        <div className="rounded-lg border border-slate-200 bg-white" key={manager.managerHrId}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900" dir="auto">
              {manager.managerName?.trim() ? manager.managerName : manager.managerHrId}
            </h2>
            <span className="shrink-0 whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium tabular-nums text-slate-600">
              {manager.total === 1 ? "1 CV" : `${manager.total} CVs`}
            </span>
          </div>

          <div className="space-y-4 px-4 py-3">
            {manager.reasons.map((reason) => (
              <div key={reason.reasonCode}>
                <div className="mb-1 flex items-center gap-2">
                  <Pill>{reason.reasonLabel}</Pill>
                  <span className="text-xs tabular-nums text-slate-400">
                    {reason.items.length === 1 ? "1 CV" : `${reason.items.length} CVs`}
                  </span>
                </div>
                <ul className="divide-y divide-slate-100">
                  {reason.items.map((item) => (
                    <ReturnedRow
                      busy={busyId === item.returnId}
                      item={item}
                      key={item.returnId}
                      onResolve={resolve}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
