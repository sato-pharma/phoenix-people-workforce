"use client";

import { useCallback, useEffect, useState } from "react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { adminPanelClassName } from "@/components/admin/admin-design-tokens";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { SelectField } from "./select-field";

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

      <div className={cn(adminPanelClassName, "flex flex-wrap items-end gap-3 p-4")}>
        <SelectField label="Month" value={month} onChange={setMonth}>
          {MONTHS.map((label, index) => <option key={label} value={index + 1}>{label}</option>)}
        </SelectField>
        <SelectField label="Year" value={year} onChange={setYear}>
          {[year - 1, year, year + 1].map((value) => <option key={value} value={value}>{value}</option>)}
        </SelectField>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void load(month, year)}
          className="h-10 border-slate-300 font-bold text-slate-700 shadow-sm hover:bg-slate-100"
        >
          Check
        </Button>
      </div>

      {error ? <div className="border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div> : null}

      <div className={cn(adminPanelClassName, "flex flex-col gap-3 p-5")}>
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
              <Button
                disabled={!availability.part1}
                onClick={() => download("part1")}
                className="border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
              >
                Download Part 1 (locked)
              </Button>
              <Button
                disabled={!availability.full}
                onClick={() => download("full")}
                className="border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
              >
                Download Full sheet (locked)
              </Button>
            </div>
            <p className="text-xs text-slate-400">The downloaded workbook is protected: only the Finance Edit and Finance Edit Reason columns are editable.</p>
          </>
        )}
      </div>
    </div>
  );
}
