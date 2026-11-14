"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Banknote, Building2, Landmark, ShieldCheck } from "lucide-react";

import { AdminCallout, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { downloadFromApiRoute } from "@/lib/navigation/browser-navigation";

import { SectionHeading } from "./section-shell";
import { SelectField } from "./select-field";
import { phxFieldClassName } from "@/components/ui/form-tokens";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The first year this module has a run for — the Year list starts here (as on the HR wizard). */
const FIRST_PAYROLL_YEAR = 2026;

type Availability = { hasRun: boolean; part1: boolean; full: boolean; published: boolean };

/** YYYY-MM-25 for the given month/year — the FAB sheet's default value date. */
function defaultFabValueDate(m: number, y: number): string {
  return `${y}-${String(m).padStart(2, "0")}-25`;
}

export function FinanceDownloadPanel({ initialMonth, initialYear }: { initialMonth: number; initialYear: number }) {
  const [month, setMonth] = useState(initialMonth);
  const [year, setYear] = useState(initialYear);
  const [availability, setAvailability] = useState<Availability | null>(null);
  /**
   * Where the read for the chosen month stands. Before this the page said "No Automated Payroll run
   * exists" while it was still asking, and again when the question failed — the same words for
   * "not yet known", "could not tell" and "there is none", on the page finance pays the bank from.
   */
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fabValueDate, setFabValueDate] = useState(() => defaultFabValueDate(initialMonth, initialYear));
  /** Only the newest read may write to the screen: a slow answer for the month just left is dropped. */
  const loadSeq = useRef(0);

  const load = useCallback(async (m: number, y: number) => {
    const seq = ++loadSeq.current;
    setBusy(true);
    setError(null);
    setAvailability(null);
    setLoadState("loading");
    try {
      const res = await fetch(`/api/automated-payroll/finance?month=${m}&year=${y}`);
      const data = await res.json().catch(() => {
        throw new Error(`The server did not answer properly (${res.status}). Check again in a moment.`);
      });
      if (seq !== loadSeq.current) return;
      if (!res.ok) throw new Error(data.error ?? "Failed to load.");
      setAvailability(data.availability as Availability);
      setLoadState("loaded");
    } catch (loadError) {
      if (seq !== loadSeq.current) return;
      setError(loadError instanceof Error ? loadError.message : "Failed to load.");
      setLoadState("failed");
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(month, year);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * A new month is read at once. It used to wait for "Check", so the page showed one month's
   * files under another month's name — and each download button sent the NEW month to the server.
   */
  const choosePeriod = (m: number, y: number) => {
    setMonth(m);
    setYear(y);
    setFabValueDate(defaultFabValueDate(m, y));
    void load(m, y);
  };

  const yearOptions = useMemo(() => {
    const last = Math.max(initialYear + 1, year);
    const years: number[] = [];
    for (let value = Math.min(FIRST_PAYROLL_YEAR, year); value <= last; value += 1) years.push(value);
    return years;
  }, [initialYear, year]);
  const periodLabel = `${MONTHS[month - 1]} ${year}`;
  /** A FAB file with no value date is refused by the bank, so its buttons wait for one. */
  const fabDateMissing = !/^\d{4}-\d{2}-\d{2}$/.test(fabValueDate);

  const download = (scope: "part1" | "full") => {
    downloadFromApiRoute(`/api/automated-payroll/finance/download?month=${month}&year=${year}&scope=${scope}`);
  };

  const downloadFab = (scope: "part1" | "part2") => {
    downloadFromApiRoute(
      `/api/automated-payroll/finance/fab-download?month=${month}&year=${year}&scope=${scope}&valueDate=${fabValueDate}`,
    );
  };

  const downloadCib = (scope: "part1" | "part2") => {
    downloadFromApiRoute(`/api/automated-payroll/finance/cib-download?month=${month}&year=${year}&scope=${scope}`);
  };

  // Rebuilt 2026-08-10. It was a single 768px column of stacked full-width bands: hero, then a
  // period bar, then a status band, then FAB, then CIB — each holding two buttons and a paragraph.
  // Widening that column alone just turned narrow bands into wide empty ones, so the layout is what
  // changed: the period controls and status moved INTO the hero (they describe the whole page, they
  // are not a step), and the three deliverables became peer cards in one row on desktop. They are
  // genuinely parallel — same period, same run, three files — so a row is what they are.
  const periodControls = (
    <div className="flex flex-wrap items-end gap-3">
      <SelectField label="Month" value={month} onChange={(value) => choosePeriod(value, year)}>
        {MONTHS.map((label, index) => <option key={label} value={index + 1}>{label}</option>)}
      </SelectField>
      <SelectField label="Year" value={year} onChange={(value) => choosePeriod(month, value)}>
        {yearOptions.map((value) => <option key={value} value={value}>{value}</option>)}
      </SelectField>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => void load(month, year)}
        className="h-10 border-white/25 bg-white/10 font-bold text-white hover:bg-white/20"
      >
        {busy ? "Checking…" : "Check again"}
      </Button>
    </div>
  );

  const statusBadges = availability?.hasRun ? (
    <>
      {availability.published ? <Badge variant="success">Published</Badge> : null}
      {availability.full
        ? <Badge variant="success">Full sheet ready</Badge>
        : availability.part1
          ? <Badge variant="neutral">Part 1 ready</Badge>
          : <Badge variant="warning">In progress</Badge>}
    </>
  ) : loadState === "loading" ? (
    <Badge variant="neutral">Checking {periodLabel}…</Badge>
  ) : loadState === "failed" ? (
    <Badge variant="warning">Could not check {periodLabel}</Badge>
  ) : (
    <Badge variant="neutral">No run for {periodLabel}</Badge>
  );

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 px-4 py-6">
      <AdminPageHero
        eyebrow="Payroll"
        icon={<Landmark className="h-3.5 w-3.5" />}
        title="Automated Payroll — Finance"
        description="Download the HR-confirmed payroll sheet and the two bank transfer files for the selected period. All payroll cells are locked except the two Finance Edit columns for your execution notes."
        actions={periodControls}
        badges={statusBadges}
      />

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}

      {loadState === "loading" ? (
        <AdminCallout tone="neutral">Checking which files are ready for {periodLabel}…</AdminCallout>
      ) : loadState === "failed" ? (
        <AdminCallout tone="warning">
          Could not tell which files are ready for {periodLabel}. Press Check again above; nothing is shown until the
          answer is known.
        </AdminCallout>
      ) : !availability?.hasRun ? (
        <AdminCallout tone="neutral">
          No Automated Payroll run exists for {periodLabel} yet. Pick another period above, or wait for HR to confirm
          this one.
        </AdminCallout>
      ) : (
        <div className="grid gap-5 lg:grid-cols-3">
          <AdminTableShell
            title="Payroll Sheet"
            description="The HR-confirmed sheet, protected — only the Finance Edit and Finance Edit Reason columns accept input."
          >
            <div className="flex flex-col gap-3 p-5">
              <SectionHeading
                title="Locked workbook"
                icon={<ShieldCheck className="size-3.5 text-orange-500" />}
              />
              <Button
                disabled={!availability.part1}
                onClick={() => download("part1")}
                className="w-full border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
              >
                Download Part 1 (locked)
              </Button>
              <Button
                disabled={!availability.full}
                onClick={() => download("full")}
                className="w-full border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
              >
                Download Full sheet (locked)
              </Button>
            </div>
          </AdminTableShell>

          <AdminTableShell
            title="FAB Bank Transfer Sheet"
            description="FAB's own bulk-transfer format, matched cell-for-cell to the company's real submitted file — no branding, no extra columns."
          >
            <div className="flex flex-col gap-3 p-5">
              <SectionHeading
                title="Bank submission file"
                icon={<Building2 className="size-3.5 text-blue-600" />}
              />
              <label className="flex flex-col gap-1 text-[11px] font-black uppercase tracking-wide text-slate-500">
                Value Date
                <input
                  type="date"
                  value={fabValueDate}
                  onChange={(event) => setFabValueDate(event.target.value)}
                  className={phxFieldClassName}
                />
                {fabDateMissing ? (
                  <span className="normal-case tracking-normal text-[12px] font-semibold text-amber-700">
                    Choose the value date the bank should pay on.
                  </span>
                ) : null}
              </label>
              <Button
                disabled={!availability.part1 || fabDateMissing}
                onClick={() => downloadFab("part1")}
                className="w-full border border-blue-700 bg-blue-700 text-white hover:bg-blue-800"
              >
                Download FAB Sheet — Part 1
              </Button>
              <Button
                disabled={!availability.full || fabDateMissing}
                onClick={() => downloadFab("part2")}
                className="w-full border border-blue-700 bg-blue-700 text-white hover:bg-blue-800"
              >
                Download FAB Sheet — Part 2
              </Button>
              <p className="text-xs leading-5 text-slate-400">
                Only FAB-bank employees with a payable amount for that part are included; held employees and
                zero-amount rows are left out. Fully editable, so you can correct a value before submitting.
                Double-check every value before it goes to the bank.
              </p>
            </div>
          </AdminTableShell>

          <AdminTableShell
            title="CIB Bank Transfer Sheet"
            description="CIB's own bulk-credit format, matched cell-for-cell — same fixed-width fields, same header colors, same account-number highlight."
          >
            <div className="flex flex-col gap-3 p-5">
              <SectionHeading
                title="Bank submission file"
                icon={<Banknote className="size-3.5 text-indigo-600" />}
              />
              <Button
                disabled={!availability.part1}
                onClick={() => downloadCib("part1")}
                className="w-full border border-indigo-700 bg-indigo-700 text-white hover:bg-indigo-800"
              >
                Download CIB Sheet — Part 1
              </Button>
              <Button
                disabled={!availability.full}
                onClick={() => downloadCib("part2")}
                className="w-full border border-indigo-700 bg-indigo-700 text-white hover:bg-indigo-800"
              >
                Download CIB Sheet — Part 2
              </Button>
              <p className="text-xs leading-5 text-slate-400">
                Only CIB-bank employees with a payable amount for that part are included; held employees and
                zero-amount rows are left out. Fully editable, so you can correct a value before submitting.
                Double-check every value before it goes to the bank.
              </p>
            </div>
          </AdminTableShell>
        </div>
      )}
    </div>
  );
}
