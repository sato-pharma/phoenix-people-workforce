"use client";

// Recruitment / ATS — the administrator's Returned CVs queue, rendered.
//
// One pile per returning district manager, split by the reason he gave. The owner, 2026-09-01: *"the
// CV comes back in a folder based on the district manager who is sending it ... because area not
// match — or any other situation."* The admin reads each, re-routes it in the pipeline, then marks it
// handled — which clears the row here but leaves the CV suppressed from that manager's folder, so his
// decision stands. See district-returns.ts for the grouping and the resolve semantics.
//
// THE LOOK (owner, 2026-10-19, the full-module premium sweep): the live counts are the module's KPI
// strip, each manager's pile is a panel under the house dark band, and each reason is a pill heading
// the CVs given for it. The counts are worked out from what is still open, so they fall the moment a
// CV is marked handled.

import { useMemo, useState } from "react";
import { Check, CheckCircle2, Inbox, Loader2, MapPin, MessageSquareQuote, Tags, Undo2, UserRound, Users } from "lucide-react";

import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { ReturnedCvItem, ReturnedCvManagerGroup } from "@/lib/recruitment/district-returns";
import { managerLabel } from "@/lib/recruitment/person-labels";
import { adminControlDepthClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  RecruitmentEmptyState,
  RecruitmentKpiStrip,
  RecruitmentPanel,
  RecruitmentPill,
} from "@/components/recruitment/recruitment-premium";

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
      <div className="min-w-0 grow basis-64 space-y-1">
        <p className="break-words text-sm font-bold text-slate-900" dir="auto">
          {item.candidateName?.trim() ? item.candidateName : "Unnamed candidate"}
        </p>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500">
          <MapPin aria-hidden="true" className="h-3 w-3 text-slate-400" />
          <span className="break-words">{context || "No area recorded"}</span>
          {item.returnedAt ? <span className="tabular-nums">· returned {cairoDateTime(item.returnedAt)}</span> : null}
        </p>
        {item.reasonNote?.trim() ? (
          <p
            className={`flex max-w-2xl items-start gap-2 border border-slate-200 border-l-2 border-l-orange-300 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700 ${adminRecessedDepthClassName}`}
            dir="auto"
          >
            <MessageSquareQuote aria-hidden="true" className="mt-px h-3.5 w-3.5 flex-none text-orange-500" />
            <span className="min-w-0 break-words">&ldquo;{item.reasonNote}&rdquo;</span>
          </p>
        ) : null}
      </div>
      <button
        className={`inline-flex items-center gap-1.5 border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-emerald-400 hover:text-emerald-700 disabled:opacity-60 ${adminControlDepthClassName} disabled:shadow-none`}
        disabled={busy}
        onClick={() => onResolve(item)}
        type="button"
      >
        {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Check aria-hidden="true" className="h-3.5 w-3.5" />}
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
  // How many different reasons are still open across every pile, for the strip.
  const openReasons = new Set(groups.flatMap((manager) => manager.reasons.map((reason) => reason.reasonCode))).size;
  const handledHere = resolvedIds.size;

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
      <RecruitmentPanel icon={<Undo2 aria-hidden="true" className="h-4 w-4" />} title="Returned CVs">
        <RecruitmentEmptyState
          icon={<Inbox aria-hidden="true" className="h-5 w-5" />}
          message="When a district manager hands a CV back — because it is not for one of their areas, or for any other reason — it will appear here, grouped by the manager who returned it."
          title="No CVs have been returned"
        />
      </RecruitmentPanel>
    );
  }

  if (totalOpen === 0) {
    return (
      <RecruitmentPanel icon={<Undo2 aria-hidden="true" className="h-4 w-4" />} title="Returned CVs">
        <RecruitmentEmptyState
          icon={<CheckCircle2 aria-hidden="true" className="h-5 w-5" />}
          message="Every returned CV has been handled. The queue is clear."
          title="The queue is clear"
        />
      </RecruitmentPanel>
    );
  }

  return (
    <div className="space-y-5">
      <RecruitmentKpiStrip
        items={[
          {
            description: "still waiting to be handled",
            icon: <Undo2 aria-hidden="true" className="h-4 w-4" />,
            label: "Returned CVs",
            tone: "orange",
            value: <span className="tabular-nums">{totalOpen}</span>,
          },
          {
            description: "who handed CVs back",
            icon: <Users aria-hidden="true" className="h-4 w-4" />,
            label: "Managers",
            tone: "blue",
            value: <span className="tabular-nums">{groups.length}</span>,
          },
          {
            description: "different reasons given",
            icon: <Tags aria-hidden="true" className="h-4 w-4" />,
            label: "Reasons",
            tone: "violet",
            value: <span className="tabular-nums">{openReasons}</span>,
          },
          {
            description: "marked handled since this page opened",
            icon: <CheckCircle2 aria-hidden="true" className="h-4 w-4" />,
            label: "Handled now",
            tone: "emerald",
            value: <span className="tabular-nums">{handledHere}</span>,
          },
        ]}
      />

      {error ? (
        <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700" role="alert">
          {error}
        </p>
      ) : null}

      {groups.map((manager) => (
        <RecruitmentPanel
          count={manager.total === 1 ? "1 CV" : `${manager.total} CVs`}
          icon={<UserRound aria-hidden="true" className="h-4 w-4" />}
          key={manager.managerHrId}
          title={
            <span dir="auto">
              {/* A pile is headed by the manager who sent it back — by name, or by words when his
                  HR id resolved to nobody. Never the id itself. */}
              {managerLabel(manager.managerName)}
            </span>
          }
        >
          <div className="divide-y divide-slate-100">
            {manager.reasons.map((reason) => (
              <div className="px-4 pt-3 sm:px-5" key={reason.reasonCode}>
                <div className="flex flex-wrap items-center gap-2">
                  <RecruitmentPill tone="amber">{reason.reasonLabel}</RecruitmentPill>
                  <span className="text-xs font-semibold tabular-nums text-slate-400">
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
        </RecruitmentPanel>
      ))}
    </div>
  );
}
