"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarClock, Check, ChevronLeft, ChevronRight, Save } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import type { HolidayCalendarYearRow } from "@/lib/attendance/holiday-overrides";

type YearView = { rows: HolidayCalendarYearRow[]; sourceConnected: boolean };

type Props = {
  initialYear: number;
  initialView: YearView | null;
  initialError: string | null;
  canEdit: boolean;
  /** Official date of a specific holiday to scroll to and highlight — set when the
   * page is opened from the T-3-day System Admin confirmation email CTA. */
  focusDate?: string | null;
};

function observedRangeLabel(observedDate: string, observedEndDate: string) {
  return observedDate === observedEndDate ? observedDate : `${observedDate} to ${observedEndDate}`;
}

export function HolidayCalendarManager({ initialYear, initialView, initialError, canEdit, focusDate = null }: Props) {
  const [year, setYear] = useState(initialYear);
  const [rows, setRows] = useState<HolidayCalendarYearRow[]>(initialView?.rows ?? []);
  const [sourceConnected, setSourceConnected] = useState(initialView?.sourceConnected ?? true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDate, setConfirmingDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const focusedRowRef = useRef<HTMLDivElement | null>(null);
  const hasScrolledToFocus = useRef(false);

  useEffect(() => {
    if (!focusDate || hasScrolledToFocus.current || loading) return;
    if (!rows.some((row) => row.officialDate === focusDate)) return;
    focusedRowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    hasScrolledToFocus.current = true;
  }, [focusDate, loading, rows]);

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

  /** Observed date is a RANGE (some national vacations span more than one day) —
   * keep observedEndDate from ever falling before the (possibly just-edited)
   * observedDate rather than letting the row hold an invalid range client-side. */
  function updateObservedRange(officialDate: string, patch: { observedDate?: string; observedEndDate?: string }) {
    setRows((current) => current.map((row) => {
      if (row.officialDate !== officialDate) return row;
      const observedDate = patch.observedDate ?? row.observedDate;
      const observedEndDate = patch.observedEndDate ?? row.observedEndDate;
      return {
        ...row,
        hasOverride: true,
        observedDate,
        observedEndDate: observedEndDate < observedDate ? observedDate : observedEndDate,
      };
    }));
  }

  async function saveEntries(entries: Array<Pick<HolidayCalendarYearRow, "holidayName" | "notes" | "observedDate" | "observedEndDate" | "officialDate">>) {
    const response = await fetch("/api/attendance/holiday-calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message ?? "Holiday calendar save failed.");
    return payload as { saved: number };
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
        observedEndDate: row.observedEndDate,
        officialDate: row.officialDate,
      }));
      const payload = await saveEntries(entries);
      setNotice(`Saved ${payload.saved} holiday(s) for ${year}.`);
      await loadYear(year);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Bulk holiday calendar save failed.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * The confirmation CTA's whole point is a one-click "yes, same day" (or a
   * quick edited "actually these days") — an admin who just opened this page
   * from an email shouldn't have to re-review the whole year's list and hit
   * "Save All Changes" just to confirm ONE holiday.
   */
  async function confirmRow(officialDate: string, observedDateOverride?: string, observedEndDateOverride?: string) {
    const row = rows.find((current) => current.officialDate === officialDate);
    if (!row) return;
    const observedDate = observedDateOverride ?? row.observedDate;
    const observedEndDate = observedEndDateOverride ?? row.observedEndDate;
    setConfirmingDate(officialDate);
    setError(null);
    setNotice(null);
    try {
      await saveEntries([{
        holidayName: row.holidayName,
        notes: row.notes,
        observedDate,
        observedEndDate,
        officialDate: row.officialDate,
      }]);
      setNotice(
        observedDate === row.officialDate && observedEndDate === row.officialDate
          ? `Confirmed ${row.holidayName} for ${observedDate} (same as the official date).`
          : `Confirmed ${row.holidayName} — observed ${observedRangeLabel(observedDate, observedEndDate)} instead of the official ${row.officialDate}.`,
      );
      await loadYear(year);
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "Holiday confirmation failed.");
    } finally {
      setConfirmingDate(null);
    }
  }

  const shiftedCount = rows.filter((row) => row.observedDate !== row.officialDate).length;
  const multiDayCount = rows.filter((row) => row.observedEndDate !== row.observedDate).length;
  const unconfirmedCount = rows.filter((row) => !row.hasOverride).length;

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={
          <>
            <AdminInsightChip tone="orange">{rows.length} holiday(s) in {year}</AdminInsightChip>
            {shiftedCount > 0 ? <AdminInsightChip tone="orange">{shiftedCount} postponed</AdminInsightChip> : null}
            {multiDayCount > 0 ? <AdminInsightChip tone="orange">{multiDayCount} multi-day</AdminInsightChip> : null}
            {unconfirmedCount > 0 ? <AdminInsightChip tone="orange">{unconfirmedCount} awaiting confirmation</AdminInsightChip> : null}
            {!sourceConnected ? <AdminInsightChip tone="orange">Google Calendar unreachable — company list only</AdminInsightChip> : null}
          </>
        }
        description="Review a full year's official holidays in one pass and confirm the real observed day(s) off when a holiday is postponed or spans more than one day. Nothing is published to calendars, weekly/monthly plans, vacation, or attendance until it is confirmed here — the raw source date is a provisional default only."
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
        description="Official date is the raw source date. Observed from/to is the actual day(s) off — edit it when a holiday is postponed or spans more than one day, then confirm."
        title={`Holidays — ${year}`}
      >
        {loading ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">No holidays found for {year}.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {rows.map((row) => {
              const isFocused = focusDate === row.officialDate;
              const isConfirmingThisRow = confirmingDate === row.officialDate;
              const isUnchangedFromOfficial = row.observedDate === row.officialDate && row.observedEndDate === row.officialDate;
              return (
                <div
                  className={`flex flex-wrap items-center gap-3 p-4 transition-colors ${isFocused ? "bg-orange-50 ring-2 ring-inset ring-orange-400" : ""}`}
                  key={row.officialDate}
                  ref={isFocused ? focusedRowRef : undefined}
                >
                  <div className="w-32 shrink-0">
                    <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Official</p>
                    <p className="text-sm font-bold text-slate-900">{row.officialDate}</p>
                  </div>
                  <div className="min-w-[12rem] flex-1">
                    <label className="block space-y-1">
                      <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Name</span>
                      <input
                        className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100 disabled:bg-slate-50"
                        disabled={!canEdit}
                        value={row.holidayName}
                        onChange={(event) => updateRow(row.officialDate, { holidayName: event.target.value })}
                      />
                    </label>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <label className="block w-36 space-y-1">
                      <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Observed from</span>
                      <input
                        className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100 disabled:bg-slate-50"
                        disabled={!canEdit}
                        type="date"
                        value={row.observedDate}
                        onChange={(event) => updateObservedRange(row.officialDate, { observedDate: event.target.value })}
                      />
                    </label>
                    <label className="block w-36 space-y-1">
                      <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Observed to</span>
                      <input
                        className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100 disabled:bg-slate-50"
                        disabled={!canEdit}
                        min={row.observedDate}
                        type="date"
                        value={row.observedEndDate}
                        onChange={(event) => updateObservedRange(row.officialDate, { observedEndDate: event.target.value })}
                      />
                    </label>
                  </div>
                  <div className="min-w-[10rem] flex-1">
                    <label className="block space-y-1">
                      <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Notes</span>
                      <input
                        className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm font-medium text-slate-700 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100 disabled:bg-slate-50"
                        disabled={!canEdit}
                        value={row.notes ?? ""}
                        onChange={(event) => updateRow(row.officialDate, { notes: event.target.value })}
                      />
                    </label>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5 text-right">
                    <div className="flex items-center gap-1.5">
                      {row.observedDate !== row.officialDate ? <AdminInsightChip tone="orange">Postponed</AdminInsightChip> : null}
                      {row.observedEndDate !== row.observedDate ? <AdminInsightChip tone="orange">Multi-day</AdminInsightChip> : null}
                      {row.hasOverride ? <AdminInsightChip tone="slate">Confirmed</AdminInsightChip> : <AdminInsightChip tone="neutral">Awaiting confirmation</AdminInsightChip>}
                    </div>
                    {canEdit ? (
                      <div className="flex items-center gap-1.5">
                        {isUnchangedFromOfficial ? (
                          <Button
                            disabled={isConfirmingThisRow || row.hasOverride}
                            size="sm"
                            type="button"
                            variant="secondary"
                            onClick={() => confirmRow(row.officialDate)}
                          >
                            <Check className="h-3.5 w-3.5" />
                            {isConfirmingThisRow ? "Confirming…" : "Confirm same day"}
                          </Button>
                        ) : (
                          <Button
                            disabled={isConfirmingThisRow}
                            size="sm"
                            type="button"
                            variant="secondary"
                            onClick={() => confirmRow(row.officialDate, row.observedDate, row.observedEndDate)}
                          >
                            <Check className="h-3.5 w-3.5" />
                            {isConfirmingThisRow ? "Confirming…" : `Confirm ${observedRangeLabel(row.observedDate, row.observedEndDate)}`}
                          </Button>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </AdminTableShell>
    </div>
  );
}
