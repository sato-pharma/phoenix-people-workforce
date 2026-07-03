"use client";

import { useState } from "react";
import { CalendarClock, ChevronLeft, ChevronRight, Save } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import type { HolidayCalendarYearRow } from "@/lib/attendance/holiday-overrides";

type YearView = { rows: HolidayCalendarYearRow[]; sourceConnected: boolean };

type Props = {
  initialYear: number;
  initialView: YearView | null;
  initialError: string | null;
  canEdit: boolean;
};

export function HolidayCalendarManager({ initialYear, initialView, initialError, canEdit }: Props) {
  const [year, setYear] = useState(initialYear);
  const [rows, setRows] = useState<HolidayCalendarYearRow[]>(initialView?.rows ?? []);
  const [sourceConnected, setSourceConnected] = useState(initialView?.sourceConnected ?? true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadYear(nextYear: number) {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/attendance/holiday-calendar?year=${nextYear}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Holiday calendar failed to load.");
      setYear(nextYear);
      setRows(payload.rows as HolidayCalendarYearRow[]);
      setSourceConnected(payload.sourceConnected as boolean);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Holiday calendar failed to load.");
    } finally {
      setLoading(false);
    }
  }

  function updateRow(officialDate: string, patch: Partial<HolidayCalendarYearRow>) {
    setRows((current) => current.map((row) => (row.officialDate === officialDate ? { ...row, ...patch, hasOverride: true } : row)));
  }

  async function saveAll() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const entries = rows.map((row) => ({
        holidayName: row.holidayName,
        notes: row.notes,
        observedDate: row.observedDate,
        officialDate: row.officialDate,
      }));
      const response = await fetch("/api/attendance/holiday-calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Bulk holiday calendar save failed.");
      setNotice(`Saved ${payload.saved} holiday(s) for ${year}.`);
      await loadYear(year);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Bulk holiday calendar save failed.");
    } finally {
      setSaving(false);
    }
  }

  const shiftedCount = rows.filter((row) => row.observedDate !== row.officialDate).length;

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={
          <>
            <AdminInsightChip tone="orange">{rows.length} holiday(s) in {year}</AdminInsightChip>
            {shiftedCount > 0 ? <AdminInsightChip tone="orange">{shiftedCount} postponed</AdminInsightChip> : null}
            {!sourceConnected ? <AdminInsightChip tone="orange">Google Calendar unreachable — company list only</AdminInsightChip> : null}
          </>
        }
        description="Review a full year's official holidays in one pass and confirm the real (observed) day off when it's postponed from the official date. Attendance reconciliation judges the observed date."
        eyebrow="Attendance"
        icon={<CalendarClock className="h-3.5 w-3.5" />}
        title="Bulk Holiday Calendar"
      />

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
      {notice ? <AdminCallout tone="neutral">{notice}</AdminCallout> : null}

      <AdminTableShell
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={loading} size="icon" type="button" variant="secondary" onClick={() => loadYear(year - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[3.5rem] text-center text-sm font-black text-slate-950">{year}</span>
            <Button disabled={loading} size="icon" type="button" variant="secondary" onClick={() => loadYear(year + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            {canEdit ? (
              <Button disabled={saving || rows.length === 0} type="button" onClick={saveAll}>
                <Save className="h-4 w-4" />
                {saving ? "Saving…" : "Save All Changes"}
              </Button>
            ) : null}
          </div>
        }
        description="Official date is the raw source date. Observed date is the actual day off — edit it when a holiday is postponed."
        title={`Holidays — ${year}`}
      >
        {loading ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">No holidays found for {year}.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {rows.map((row) => (
              <div className="flex flex-wrap items-center gap-3 p-4" key={row.officialDate}>
                <div className="w-32 shrink-0">
                  <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Official</p>
                  <p className="text-sm font-bold text-slate-900">{row.officialDate}</p>
                </div>
                <div className="min-w-[12rem] flex-1">
                  <label className="block space-y-1">
                    <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Name</span>
                    <input
                      className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100 disabled:bg-slate-50"
                      disabled={!canEdit}
                      value={row.holidayName}
                      onChange={(event) => updateRow(row.officialDate, { holidayName: event.target.value })}
                    />
                  </label>
                </div>
                <div className="w-40 shrink-0">
                  <label className="block space-y-1">
                    <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Observed date</span>
                    <input
                      className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100 disabled:bg-slate-50"
                      disabled={!canEdit}
                      type="date"
                      value={row.observedDate}
                      onChange={(event) => updateRow(row.officialDate, { observedDate: event.target.value })}
                    />
                  </label>
                </div>
                <div className="min-w-[10rem] flex-1">
                  <label className="block space-y-1">
                    <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Notes</span>
                    <input
                      className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm font-medium text-slate-700 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100 disabled:bg-slate-50"
                      disabled={!canEdit}
                      value={row.notes ?? ""}
                      onChange={(event) => updateRow(row.officialDate, { notes: event.target.value })}
                    />
                  </label>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1 text-right">
                  {row.observedDate !== row.officialDate ? <AdminInsightChip tone="orange">Postponed</AdminInsightChip> : null}
                  {row.hasOverride ? <AdminInsightChip tone="slate">Confirmed</AdminInsightChip> : <AdminInsightChip tone="neutral">Default</AdminInsightChip>}
                </div>
              </div>
            ))}
          </div>
        )}
      </AdminTableShell>
    </div>
  );
}
