"use client";

import { useCallback, useEffect, useState } from "react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Availability = { hasRun: boolean; part1: boolean; full: boolean; published: boolean };

export function FinanceDownloadPanel({ initialMonth, initialYear }: { initialMonth: number; initialYear: number }) {
  const [month, setMonth] = useState(initialMonth);
  const [year, setYear] = useState(initialYear);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (m: number, y: number) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/finance?month=${m}&year=${y}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load.");
      setAvailability(data.availability as Availability);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load.");
      setAvailability(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(month, year);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const download = (scope: "part1" | "full") => {
    window.location.href = `/api/automated-payroll/finance/download?month=${month}&year=${year}&scope=${scope}`;
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
      <AdminPageHero
        eyebrow="Payroll"
        title="Automated Payroll — Finance"
        description="Download the HR-confirmed payroll sheet. All cells are locked except two Finance Edit columns for your execution notes."
      />

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <label className="flex flex-col text-xs font-semibold text-slate-500">
          Month
          <select value={month} onChange={(event) => setMonth(Number(event.target.value))} className="mt-1 h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm">
            {MONTHS.map((label, index) => <option key={label} value={index + 1}>{label}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-xs font-semibold text-slate-500">
          Year
          <select value={year} onChange={(event) => setYear(Number(event.target.value))} className="mt-1 h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm">
            {[year - 1, year, year + 1].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <Button variant="outline" disabled={busy} onClick={() => void load(month, year)}>Check</Button>
      </Card>

      {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div> : null}

      <Card className="flex flex-col gap-3 p-5">
        {!availability?.hasRun ? (
          <p className="text-sm text-slate-500">No Automated Payroll run for this period yet.</p>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-slate-500">Status:</span>
              {availability.published ? <Badge variant="success">Published</Badge> : null}
              {availability.full ? <Badge variant="success">Full sheet ready</Badge> : availability.part1 ? <Badge variant="neutral">Part 1 ready</Badge> : <Badge variant="warning">In progress</Badge>}
            </div>
            <div className="flex flex-wrap gap-3">
              <Button disabled={!availability.part1} onClick={() => download("part1")}>Download Part 1 (locked)</Button>
              <Button disabled={!availability.full} onClick={() => download("full")}>Download Full sheet (locked)</Button>
            </div>
            <p className="text-xs text-slate-400">The downloaded workbook is protected: only the Finance Edit and Finance Edit Reason columns are editable.</p>
          </>
        )}
      </Card>
    </div>
  );
}
