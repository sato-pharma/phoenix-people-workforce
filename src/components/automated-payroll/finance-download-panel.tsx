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

/** YYYY-MM-25 for the given month/year — the FAB sheet's default value date. */
function defaultFabValueDate(m: number, y: number): string {
  return `${y}-${String(m).padStart(2, "0")}-25`;
}

export function FinanceDownloadPanel({ initialMonth, initialYear }: { initialMonth: number; initialYear: number }) {
  const [month, setMonth] = useState(initialMonth);
  const [year, setYear] = useState(initialYear);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fabValueDate, setFabValueDate] = useState(() => defaultFabValueDate(initialMonth, initialYear));

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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFabValueDate(defaultFabValueDate(month, year));
  }, [month, year]);

  const download = (scope: "part1" | "full") => {
    window.location.href = `/api/automated-payroll/finance/download?month=${month}&year=${year}&scope=${scope}`;
  };

  const downloadFab = (scope: "part1" | "part2") => {
    window.location.href = `/api/automated-payroll/finance/fab-download?month=${month}&year=${year}&scope=${scope}&valueDate=${fabValueDate}`;
  };

  const downloadCib = (scope: "part1" | "part2") => {
    window.location.href = `/api/automated-payroll/finance/cib-download?month=${month}&year=${year}&scope=${scope}`;
  };

  // max-w-[1600px], not max-w-3xl: this shell is copied from automated-payroll-wizard.tsx and the
  // width was never updated with it, so the page rendered in a 768px column with ~1000px of dead
  // gutter on a normal desktop. Every other surface in this module uses 1600px.
  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 px-4 py-6">
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

      {availability?.hasRun ? (
        <div className={cn(adminPanelClassName, "flex flex-col gap-3 border-blue-200 p-5")}>
          <div>
            <h3 className="text-sm font-bold text-slate-800">FAB Bank Transfer Sheet</h3>
            <p className="text-xs text-slate-500">
              The literal file for bank submission — FAB&apos;s own bulk-transfer format, matched cell-for-cell to
              the company&apos;s real submitted file. No branding, no extra columns. Double-check every value before
              submitting to the bank.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
              Value Date
              <input
                type="date"
                value={fabValueDate}
                onChange={(event) => setFabValueDate(event.target.value)}
                className="h-10 rounded-md border border-slate-300 px-3 text-sm text-slate-700 shadow-sm"
              />
            </label>
            <Button
              disabled={!availability.part1}
              onClick={() => downloadFab("part1")}
              className="border border-blue-700 bg-blue-700 text-white hover:bg-blue-800"
            >
              Download FAB Sheet — Part 1
            </Button>
            <Button
              disabled={!availability.full}
              onClick={() => downloadFab("part2")}
              className="border border-blue-700 bg-blue-700 text-white hover:bg-blue-800"
            >
              Download FAB Sheet — Part 2
            </Button>
          </div>
          <p className="text-xs text-slate-400">
            Only FAB-bank employees with a payable amount for that part are included; held employees and zero-amount
            rows are left out. This workbook is fully editable so you can correct a value before submitting it.
          </p>
        </div>
      ) : null}

      {availability?.hasRun ? (
        <div className={cn(adminPanelClassName, "flex flex-col gap-3 border-indigo-200 p-5")}>
          <div>
            <h3 className="text-sm font-bold text-slate-800">CIB Bank Transfer Sheet</h3>
            <p className="text-xs text-slate-500">
              CIB&apos;s own bulk-credit format, matched cell-for-cell to the company&apos;s real submitted file — same
              fixed-width fields, same header colors, same account-number highlight. Double-check every value before
              submitting to the bank.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Button
              disabled={!availability.part1}
              onClick={() => downloadCib("part1")}
              className="border border-indigo-700 bg-indigo-700 text-white hover:bg-indigo-800"
            >
              Download CIB Sheet — Part 1
            </Button>
            <Button
              disabled={!availability.full}
              onClick={() => downloadCib("part2")}
              className="border border-indigo-700 bg-indigo-700 text-white hover:bg-indigo-800"
            >
              Download CIB Sheet — Part 2
            </Button>
          </div>
          <p className="text-xs text-slate-400">
            Only CIB-bank employees with a payable amount for that part are included; held employees and zero-amount
            rows are left out. This workbook is fully editable so you can correct a value before submitting it.
          </p>
        </div>
      ) : null}
    </div>
  );
}
