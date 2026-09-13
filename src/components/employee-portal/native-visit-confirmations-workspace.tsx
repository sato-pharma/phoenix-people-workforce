"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, RefreshCcw, XCircle } from "lucide-react";

import {
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalSection,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import { Button } from "@/components/ui/button";
import type { NativeVisitConfirmationRow } from "@/lib/crm/native-visits/types";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

/**
 * A manager's answers to "you were with me on this visit" (pilot). Each row names HIM; the answer is
 * his own click and nothing here answers for him. Rows for reps outside his team never arrive — the
 * server drops them.
 */

const DAY_FORMAT = stableEnGbFormatter({
  day: "numeric",
  month: "long",
  timeZone: "Africa/Cairo",
  weekday: "long",
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

function gpsLabel(status: NativeVisitConfirmationRow["gpsStatus"]) {
  if (status === "captured") return "Captured";
  if (status === "out_of_bounds") return "Outside Egypt";
  return "No location";
}

export function NativeVisitConfirmationsWorkspace() {
  const [rows, setRows] = useState<NativeVisitConfirmationRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch("/api/crm/native-visits/confirmations", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { rows?: NativeVisitConfirmationRow[]; message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? "Could not load the visits waiting for you.");
      setRows(body?.rows ?? []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the visits waiting for you.");
      setRows((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(row: NativeVisitConfirmationRow, decision: "confirmed" | "rejected") {
    setBusyId(row.partnerId);
    setRowError((current) => ({ ...current, [row.partnerId]: "" }));
    try {
      const response = await fetch("/api/crm/native-visits/confirmations", {
        body: JSON.stringify({ decision, note: notes[row.partnerId] ?? "", partnerId: row.partnerId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? "Could not record your answer.");
      await load();
    } catch (error) {
      setRowError((current) => ({
        ...current,
        [row.partnerId]: error instanceof Error ? error.message : "Could not record your answer.",
      }));
    } finally {
      setBusyId(null);
    }
  }

  const pending = (rows ?? []).filter((row) => row.status === "pending");
  const answered = (rows ?? []).filter((row) => row.status !== "pending");

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
        description="Visits your reps entered in Phoenix naming you as accompanying them. Confirm only what you attended."
        eyebrow="Pilot"
        title="Waiting for your answer"
      >
        {rows === null ? (
          <p className="px-4 py-6 text-sm text-slate-500">Loading visits</p>
        ) : pending.length === 0 ? (
          <PortalEmptyState message="No rep has named you on a visit that still needs your answer." title="Nothing waiting" />
        ) : (
          <div className="grid gap-px bg-slate-100">
            {pending.map((row) => (
              <PortalRecordCard
                accent="amber"
                actions={
                  <div className="grid w-full gap-2">
                    <input
                      aria-label="Note (optional)"
                      className={portalInputClassName}
                      maxLength={500}
                      onChange={(event) => setNotes((current) => ({ ...current, [row.partnerId]: event.target.value }))}
                      placeholder="Note (optional)"
                      value={notes[row.partnerId] ?? ""}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={busyId === row.partnerId}
                        onClick={() => void decide(row, "confirmed")}
                        type="button"
                      >
                        <CheckCircle2 />
                        I was there
                      </Button>
                      <Button
                        disabled={busyId === row.partnerId}
                        onClick={() => void decide(row, "rejected")}
                        type="button"
                        variant="destructive"
                      >
                        <XCircle />
                        I was not there
                      </Button>
                    </div>
                    {rowError[row.partnerId] ? (
                      <p className="text-sm text-red-700">{rowError[row.partnerId]}</p>
                    ) : null}
                  </div>
                }
                key={row.partnerId}
                meta={`${dayLabel(row.visitDate)} · ${row.shift} · ${row.typeLabel}`}
                title={row.repName}
              >
                <PortalRecordFields
                  fields={[
                    { label: "Doctor", value: row.contactName ?? row.prospectName ?? "None" },
                    { label: "Location", value: gpsLabel(row.gpsStatus) },
                    { label: "Named you as", value: row.isDirectManager ? "Direct manager" : "Manager" },
                    { label: "Comment", value: row.comment ?? "None" },
                  ]}
                />
              </PortalRecordCard>
            ))}
          </div>
        )}
      </PortalSection>

      {answered.length > 0 ? (
        <PortalSection description="Visits you have already answered." title="Answered">
          <div className="grid gap-px bg-slate-100">
            {answered.map((row) => (
              <PortalRecordCard
                accent={row.status === "confirmed" ? "emerald" : "rose"}
                key={row.partnerId}
                meta={`${dayLabel(row.visitDate)} · ${row.shift} · ${row.typeLabel}`}
                status={
                  <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-600">
                    {row.status === "confirmed" ? "Confirmed" : "Rejected"}
                  </span>
                }
                title={row.repName}
              >
                <PortalRecordFields
                  fields={[
                    { label: "Doctor", value: row.contactName ?? row.prospectName ?? "None" },
                    { label: "Answered", value: row.decidedAt ? TIME_FORMAT.format(new Date(row.decidedAt)) : "None" },
                    { label: "Your note", value: row.decisionNote ?? "None" },
                  ]}
                />
              </PortalRecordCard>
            ))}
          </div>
        </PortalSection>
      ) : null}
    </div>
  );
}
