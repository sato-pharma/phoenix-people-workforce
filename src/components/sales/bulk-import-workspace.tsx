"use client";

import { useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, Search, Upload, X, XCircle } from "lucide-react";

import { Card } from "@/components/ui/card";
import { isBulkSlotBlocking, type BulkSlotStage } from "@/lib/sales/bulk-import-gating";
import type { DistributorProfileSummary, SalesDistributorEntry } from "@/lib/sales/distributor-registry";
import { cn } from "@/lib/utils";
import {
  BreakdownTable,
  MONTHS,
  MonthlyUpload,
  UPLOAD_YEARS,
  money,
  num,
  type BreakdownRow,
  type BulkSlotStatus,
  type MapOption,
  type MonthlyUploadHandle,
} from "@/components/sales/sales-upload-workspace";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";

// ── Bulk Import mode ────────────────────────────────────────────────────────────────────────────
// One shared month, every monthly distributor listed as a horizontal card. Clicking a card opens
// its upload slot — the SAME MonthlyUpload component (AI verify → strict validate → confirm) used
// on the single-distributor page, just orchestrated across many distributors on one screen. No
// analyze/validate/commit logic is duplicated here; this file only colors cards from the status
// each slot already reports and, on "Confirm & Import All", calls each slot's own commit().

type Props = {
  distributors: SalesDistributorEntry[];
  summaries: Record<string, DistributorProfileSummary>;
  productOptions: MapOption[];
  brickOptions: MapOption[];
  aiEnabled: boolean;
};

const STAGE_STYLE: Record<BulkSlotStage, { dot: string; card: string; text: string; label: string }> = {
  idle: { dot: "bg-phx-line-strong", card: "border-phx-line bg-white hover:border-phx-accent", text: "text-phx-ink-soft", label: "Not started" },
  working: { dot: "bg-amber-400 animate-pulse", card: "border-amber-300 bg-amber-50/60", text: "text-amber-700", label: "In progress" },
  rejected: { dot: "bg-rose-500", card: "border-rose-300 bg-rose-50/60", text: "text-rose-700", label: "Rejected" },
  ready: { dot: "bg-emerald-500", card: "border-emerald-300 bg-emerald-50/60", text: "text-emerald-700", label: "Ready" },
  committed: { dot: "bg-emerald-600", card: "border-emerald-400 bg-emerald-50", text: "text-emerald-700", label: "Imported" },
  commit_failed: { dot: "bg-rose-600", card: "border-rose-400 bg-rose-50", text: "text-rose-700", label: "Import failed" },
};

function consolidateByProduct(rowsList: BreakdownRow[][]): BreakdownRow[] {
  const merged = new Map<string, BreakdownRow>();
  for (const rows of rowsList) {
    for (const r of rows) {
      const existing = merged.get(r.code);
      if (existing) {
        existing.rowCount += r.rowCount;
        existing.totalQty += r.totalQty;
        existing.totalBonusQty += r.totalBonusQty;
        existing.totalValue += r.totalValue;
      } else {
        merged.set(r.code, { ...r });
      }
    }
  }
  return [...merged.values()].sort((a, b) => b.totalValue - a.totalValue);
}

export function BulkImportWorkspace({ distributors, summaries, productOptions, brickOptions, aiEnabled }: Props) {
  const monthly = useMemo(() => distributors.filter((d) => d.monthlySupported), [distributors]);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return monthly;
    return monthly.filter((d) => d.code.toLowerCase().includes(q) || d.name.toLowerCase().includes(q));
  }, [monthly, query]);

  const [periodMonth, setPeriodMonth] = useState("");
  const [periodYear, setPeriodYear] = useState("");
  const period = periodMonth && periodYear ? `${periodYear}-${periodMonth}` : "";

  const [touchedCodes, setTouchedCodes] = useState<string[]>([]);
  const [activeCode, setActiveCode] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, BulkSlotStatus>>({});
  const [confirmBusy, setConfirmBusy] = useState(false);

  // Persistent store of each mounted slot's imperative handle, read only from the confirmAll() event
  // handler below (never during render — ref access during render is disallowed by the rules of hooks).
  const refsMap = useRef<Record<string, MonthlyUploadHandle | null>>({});

  // One stable onStatusChange closure per distributor, memoized by the touchedCodes array itself (not
  // a ref) so identity only changes when a distributor is added/reset — not on every parent re-render,
  // which would otherwise retrigger every mounted slot's status effect on every keystroke elsewhere.
  const statusHandlers = useMemo(() => {
    const map: Record<string, (status: BulkSlotStatus) => void> = {};
    for (const code of touchedCodes) {
      map[code] = (status: BulkSlotStatus) => setStatuses((prev) => ({ ...prev, [code]: status }));
    }
    return map;
  }, [touchedCodes]);

  function resetSession() {
    setTouchedCodes([]);
    setActiveCode(null);
    setStatuses({});
    refsMap.current = {};
  }

  function applyPeriod(nextMonth: string, nextYear: string) {
    if (touchedCodes.length > 0 && (nextMonth !== periodMonth || nextYear !== periodYear)) {
      const ok = window.confirm("Changing the month clears every distributor's progress in this bulk session (files picked, validation, everything). Continue?");
      if (!ok) return;
      resetSession();
    }
    setPeriodMonth(nextMonth);
    setPeriodYear(nextYear);
  }

  function openCard(code: string) {
    setTouchedCodes((prev) => (prev.includes(code) ? prev : [...prev, code]));
    setActiveCode((prev) => (prev === code ? null : code));
  }

  // Drops one distributor out of this bulk session (e.g. opened by mistake, or the user decided not
  // to import it this round) without touching anyone else's progress — the only other way to shed a
  // touched code is resetSession(), which wipes every distributor. Confirms only when a file was
  // actually picked (statuses[code] already exists at "idle" the instant the slot mounts).
  function removeCard(code: string) {
    const hasProgress = Boolean(statuses[code]?.fileName);
    if (hasProgress && !window.confirm(`Remove ${code} from this bulk session? Its picked file and progress will be discarded — the other distributors are unaffected.`)) return;
    setTouchedCodes((prev) => prev.filter((c) => c !== code));
    setStatuses((prev) => { const next = { ...prev }; delete next[code]; return next; });
    delete refsMap.current[code];
    setActiveCode((prev) => (prev === code ? null : prev));
  }

  const committableCodes = touchedCodes.filter((c) => {
    const stage = statuses[c]?.stage;
    return stage === "ready" || stage === "commit_failed";
  });
  const blockingCodes = touchedCodes.filter((c) => isBulkSlotBlocking(statuses[c]?.stage));
  const canConfirmAll = period !== "" && touchedCodes.length > 0 && blockingCodes.length === 0 && committableCodes.length > 0;

  async function confirmAll() {
    if (!canConfirmAll) return;
    setConfirmBusy(true);
    try {
      await Promise.allSettled(committableCodes.map((code) => refsMap.current[code]?.commit() ?? Promise.resolve()));
    } finally {
      setConfirmBusy(false);
    }
  }

  const readyForTables = touchedCodes.filter((c) => statuses[c]?.breakdowns);
  const consolidated = consolidateByProduct(readyForTables.map((c) => statuses[c]!.breakdowns!.byProduct));

  return (
    <div className="space-y-4">
      {/* Shared month for this bulk session */}
      <Card className="space-y-2 rounded-[6px] border border-phx-line bg-white p-4">
        <span className="text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-faint">Month for this bulk import</span>
        <div className="flex gap-2">
          <select className={phxSelectClassName} onChange={(e) => applyPeriod(e.target.value, periodYear)} value={periodMonth}>
            <option value="">Month</option>
            {MONTHS.map((m, i) => <option key={m} value={String(i + 1).padStart(2, "0")}>{m}</option>)}
          </select>
          <select className={phxSelectClassName} onChange={(e) => applyPeriod(periodMonth, e.target.value)} value={periodYear}>
            <option value="">Year</option>
            {UPLOAD_YEARS.map((y) => <option key={y} value={String(y)}>{y}</option>)}
          </select>
        </div>
        {!period ? <p className="text-xs font-semibold text-amber-700">Pick the month first, then open a distributor card below.</p> : null}
      </Card>

      {/* Horizontal distributor grid */}
      <Card className="space-y-3 rounded-[6px] border border-phx-line bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Distributors ({filtered.length})</span>
          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-faint" />
            <input className={cn(phxFieldClassName, "pl-8")} onChange={(e) => setQuery(e.target.value)} placeholder="Search distributor" value={query} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {filtered.map((d) => {
            const status = statuses[d.code];
            const stage = status?.stage ?? "idle";
            const style = STAGE_STYLE[stage];
            const active = activeCode === d.code;
            return (
              <button
                key={d.code}
                className={cn(
                  "flex min-w-[168px] flex-col gap-1 rounded-[6px] border px-3 py-2 text-left transition",
                  style.card,
                  active && "ring-2 ring-phx-ink ring-offset-1",
                  !period && "cursor-not-allowed opacity-60",
                )}
                disabled={!period}
                onClick={() => openCard(d.code)}
                type="button"
              >
                <div className="flex items-center gap-1.5">
                  <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", style.dot)} />
                  <span className="truncate text-xs font-black text-phx-ink">{d.name}</span>
                </div>
                <span className="font-mono text-phx-sm text-phx-ink-faint">{d.code}</span>
                <span className={cn("text-phx-sm font-bold", style.text)}>{style.label}</span>
                {status?.reconciliation ? (
                  <span className="text-phx-sm font-medium text-phx-ink-soft">{num(status.reconciliation.rowsCoded)} rows · {money(status.reconciliation.totalValue)}</span>
                ) : null}
              </button>
            );
          })}
          {filtered.length === 0 ? <p className="px-2 py-3 text-xs text-phx-ink-soft">No distributors match.</p> : null}
        </div>
      </Card>

      {/* Active + previously-touched slots. Every touched slot stays mounted (hidden via CSS, not
          unmounted) so its file/analysis state survives switching between cards. */}
      {touchedCodes.map((code) => {
        const distributor = monthly.find((d) => d.code === code);
        if (!distributor) return null;
        const summary = summaries[code];
        const isActive = activeCode === code;
        return (
          <div className={cn(!isActive && "hidden")} key={code}>
            <Card className="space-y-3 rounded-[6px] border border-phx-line bg-white p-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-base font-black tracking-tight text-slate-950">{distributor.name} <span className="font-mono text-sm text-phx-ink-faint">{distributor.code}</span></h3>
                <div className="flex items-center gap-2">
                  <button className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-phx-line px-2.5 text-xs font-bold text-phx-ink-soft transition hover:bg-phx-paper" onClick={() => setActiveCode(null)} type="button">
                    <ChevronDown className="h-3.5 w-3.5" /> Collapse
                  </button>
                  <button className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[#FCA5A5] px-2.5 text-xs font-bold text-rose-700 transition hover:bg-rose-50" onClick={() => removeCard(code)} type="button">
                    <X className="h-3.5 w-3.5" /> Remove from this import
                  </button>
                </div>
              </div>
              <MonthlyUpload
                aiEnabled={aiEnabled}
                brickOptions={brickOptions}
                distributorCode={code}
                distributorName={distributor.name}
                hasDateColumn={summary?.hasDateColumn ?? true}
                hasProfile={Boolean(summary)}
                initialPeriod={period}
                onStatusChange={statusHandlers[code]}
                productOptions={productOptions}
                ref={(h) => { refsMap.current[code] = h; }}
              />
            </Card>
          </div>
        );
      })}

      {/* Strict validation — per distributor + consolidated — then Confirm & Import All */}
      {touchedCodes.length > 0 ? (
        <Card className="space-y-4 rounded-[6px] border border-phx-line bg-white p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-black tracking-tight text-slate-950">Confirm & Import All</h3>
            {blockingCodes.length > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-phx-warn-bg px-2.5 py-0.5 text-phx-xs font-bold text-phx-warn"><AlertTriangle className="h-3 w-3" /> {blockingCodes.length} distributor(s) not ready yet</span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-phx-ok-bg px-2.5 py-0.5 text-phx-xs font-bold text-phx-ok"><CheckCircle2 className="h-3 w-3" /> Every distributor here is validated</span>
            )}
          </div>

          {consolidated.length > 0 ? <BreakdownTable headLabel="Product" rows={consolidated} title="Consolidated — all distributors, by product" /> : null}

          {readyForTables.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {readyForTables.map((code) => {
                const distributor = monthly.find((d) => d.code === code);
                const rows = statuses[code]?.breakdowns?.byProduct ?? [];
                return <BreakdownTable headLabel="Product" key={code} rows={rows} title={`${distributor?.name ?? code} — by product`} />;
              })}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 border-t border-phx-line pt-4">
            <button
              className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-phx-accent px-5 text-sm font-black text-white transition hover:bg-[#EA6A0C] disabled:cursor-not-allowed disabled:bg-phx-line-strong"
              disabled={!canConfirmAll || confirmBusy}
              onClick={() => void confirmAll()}
              type="button"
            >
              {confirmBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {confirmBusy ? "Importing…" : `Confirm & Import All (${committableCodes.length})`}
            </button>
            {blockingCodes.length > 0 ? (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700"><XCircle className="h-3.5 w-3.5" /> Open and resolve, or remove: {blockingCodes.map((c) => monthly.find((d) => d.code === c)?.name ?? c).join(", ")}</span>
            ) : (
              <span className="text-xs font-medium text-phx-ink-soft">Each distributor imports through its own strict validation — this just confirms all of them at once.</span>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
