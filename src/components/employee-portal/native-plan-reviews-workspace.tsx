"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, RefreshCcw, Undo2 } from "lucide-react";

import {
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalSection,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import { Button } from "@/components/ui/button";
import { nativePlanStatusLabel, type NativePlanItemOutcome } from "@/lib/crm/native-visits/plan-rules";
import type { NativePlanReviewRow } from "@/lib/crm/native-visits/plan-types";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

/**
 * A manager's plan reviews (pilot). Each plan was sent to THIS manager; verifying or returning it is
 * the manager's own click, and nothing here decides for them. Plans for reps outside the manager's
 * team never arrive — the server drops them.
 */

const DAY_FORMAT = stableEnGbFormatter({
  day: "numeric",
  month: "long",
  timeZone: "Africa/Cairo",
  weekday: "long",
});
const SHORT_DAY_FORMAT = stableEnGbFormatter({
  day: "numeric",
  month: "short",
  timeZone: "Africa/Cairo",
});
const TIME_FORMAT = stableEnGbFormatter({
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
});

function dayLabel(isoDay: string) {
  return DAY_FORMAT.format(new Date(`${isoDay}T12:00:00Z`));
}

function weekLabel(row: { weekStart: string; weekEnd: string }) {
  return `${SHORT_DAY_FORMAT.format(new Date(`${row.weekStart}T12:00:00Z`))} to ${SHORT_DAY_FORMAT.format(new Date(`${row.weekEnd}T12:00:00Z`))}`;
}

function outcomeLabel(outcome: NativePlanItemOutcome) {
  if (outcome === "visited") return "Visited";
  if (outcome === "missed") return "Not visited";
  if (outcome === "due_today") return "Today";
  return "Planned";
}

function PlanDays({ row }: { row: NativePlanReviewRow }) {
  return (
    <div className="grid min-w-0 gap-3">
      {row.days.map((day) => {
        const dayItems = row.items.filter((item) => item.planDate === day.date);
        return (
          <div className="grid min-w-0 gap-1" key={day.date}>
            <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">
              {`${dayLabel(day.date)} · ${dayItems.length} ${dayItems.length === 1 ? "doctor" : "doctors"}`}
            </p>
            {day.doubleVisits.map((visit, index) => (
              <p className="break-words text-sm text-sky-800" key={`${visit.managerName}-${index}`}>
                {`Double visit with ${visit.managerName}: ${visit.title}`}
              </p>
            ))}
            {dayItems.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing planned.</p>
            ) : (
              <ul className="grid min-w-0 gap-px border border-slate-100 bg-slate-100">
                {dayItems.map((item) => (
                  <li className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 bg-white px-3 py-1.5 text-sm" key={item.id}>
                    <span className="min-w-0 break-words font-bold text-slate-900">
                      {`${item.shift} · ${item.contactName}`}
                      {item.speciality ? <span className="font-normal text-slate-500">{` · ${item.speciality}`}</span> : null}
                    </span>
                    <span className="text-xs font-bold text-slate-500">{outcomeLabel(item.outcome)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function NativePlanReviewsWorkspace() {
  const [rows, setRows] = useState<NativePlanReviewRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch("/api/crm/native-visits/plan-reviews", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { rows?: NativePlanReviewRow[]; message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? "Could not load the plans sent to you.");
      setRows(body?.rows ?? []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the plans sent to you.");
      setRows((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(row: NativePlanReviewRow, decision: "verified" | "returned") {
    const note = (notes[row.planId] ?? "").trim();
    if (decision === "returned" && !note) {
      setRowError((current) => ({ ...current, [row.planId]: "Say what the rep should change before you return the plan." }));
      return;
    }
    setBusyId(row.planId);
    setRowError((current) => ({ ...current, [row.planId]: "" }));
    try {
      const response = await fetch("/api/crm/native-visits/plan-reviews", {
        body: JSON.stringify({ decision, note, planId: row.planId, revision: row.revision }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? "Could not record your decision.");
      await load();
    } catch (error) {
      setRowError((current) => ({
        ...current,
        [row.planId]: error instanceof Error ? error.message : "Could not record your decision.",
      }));
    } finally {
      setBusyId(null);
    }
  }

  const pending = (rows ?? []).filter((row) => row.canDecide);
  const others = (rows ?? []).filter((row) => !row.canDecide);

  return (
    <div className="grid min-w-0 gap-4">
      {loadError ? (
        <p className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p>
      ) : null}

      <PortalSection
        actions={
          <Button onClick={() => void load()} size="sm" type="button" variant="outline">
            <RefreshCcw />
            Refresh
          </Button>
        }
        description="Weekly plans your reps sent you in Phoenix. Verify a plan, or return it with a note saying what to change."
        eyebrow="Pilot"
        title="Waiting for your decision"
      >
        {rows === null ? (
          <p className="px-4 py-6 text-sm text-slate-500">Loading plans</p>
        ) : pending.length === 0 ? (
          <PortalEmptyState message="No rep has a plan waiting for your decision." title="Nothing waiting" />
        ) : (
          <div className="grid gap-px bg-slate-100">
            {pending.map((row) => (
              <PortalRecordCard
                accent="amber"
                actions={
                  <div className="grid w-full gap-2">
                    <textarea
                      aria-label="Note to the rep"
                      className={portalInputClassName}
                      maxLength={500}
                      onChange={(event) => setNotes((current) => ({ ...current, [row.planId]: event.target.value }))}
                      placeholder="Note to the rep (needed to return the plan)"
                      rows={2}
                      value={notes[row.planId] ?? ""}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button disabled={busyId === row.planId} onClick={() => void decide(row, "verified")} type="button">
                        <CheckCircle2 />
                        Verify
                      </Button>
                      <Button
                        disabled={busyId === row.planId}
                        onClick={() => void decide(row, "returned")}
                        type="button"
                        variant="destructive"
                      >
                        <Undo2 />
                        Return with note
                      </Button>
                    </div>
                    {rowError[row.planId] ? <p className="text-sm text-red-700">{rowError[row.planId]}</p> : null}
                  </div>
                }
                key={row.planId}
                meta={[`Week of ${weekLabel(row)}`, row.repJobTitle, row.areaName].filter(Boolean).join(" · ")}
                title={row.repName}
              >
                <div className="grid min-w-0 gap-3">
                  <PortalRecordFields
                    fields={[
                      { label: "Doctors planned", value: String(row.items.length) },
                      { label: "Sent", value: row.submittedAt ? TIME_FORMAT.format(new Date(row.submittedAt)) : "None" },
                    ]}
                  />
                  <PlanDays row={row} />
                </div>
              </PortalRecordCard>
            ))}
          </div>
        )}
      </PortalSection>

      {others.length > 0 ? (
        <PortalSection description="Plans from the last two weeks that are not waiting for you." title="Recent plans">
          <div className="grid gap-px bg-slate-100">
            {others.map((row) => (
              <PortalRecordCard
                accent={row.status === "verified" ? "emerald" : row.status === "returned" ? "rose" : "slate"}
                key={row.planId}
                meta={[`Week of ${weekLabel(row)}`, row.repJobTitle, row.areaName].filter(Boolean).join(" · ")}
                status={
                  <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-600">
                    {row.status === "draft" ? "Reopened by the rep" : nativePlanStatusLabel(row.status)}
                  </span>
                }
                title={row.repName}
              >
                <div className="grid min-w-0 gap-3">
                  <PortalRecordFields
                    fields={[
                      { label: "Doctors planned", value: String(row.items.length) },
                      { label: "Answered", value: row.decidedAt ? TIME_FORMAT.format(new Date(row.decidedAt)) : "None" },
                      { label: "Your note", value: row.decisionNote ?? "None" },
                    ]}
                  />
                  <PlanDays row={row} />
                </div>
              </PortalRecordCard>
            ))}
          </div>
        </PortalSection>
      ) : null}
    </div>
  );
}
