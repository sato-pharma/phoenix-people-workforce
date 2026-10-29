"use client";

import { AlertTriangle, CheckCircle2, Loader2, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Badge } from "@/components/ui/badge";
import { CrmCard, CrmCardsOnPhone, CrmFacts, CrmTable } from "@/components/phoenix-crm/ui";
import { Button } from "@/components/ui/button";
import { customerKey, savedCustomerKeys } from "@/lib/sales/customer-key";
import type { BrickSuggestionView, UnmappedCustomer } from "@/lib/sales/brick-suggestions";
import type { ImportPreviewDiff } from "@/lib/sales/import-preview";
import type { ImportSplitPlan } from "@/lib/sales/import-split-preview";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import type { DistributorSalesValidationResult } from "@/lib/sales/monthly-distributor-import";

export type PreviewResult = DistributorSalesValidationResult & {
  previewDiff?: ImportPreviewDiff;
  splitPlan?: ImportSplitPlan;
  suggestions?: BrickSuggestionView[];
  unmappedCustomers?: UnmappedCustomer[];
};

type Props = {
  committing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  result: PreviewResult;
};

type AcceptResponse = {
  data?: { accepted: number; failed: number; results: { customerCode: string; distributorCode: string; error?: string; ok: boolean }[] };
  error?: string;
  message?: string;
  success: boolean;
};

function StatCard({ label, tone = "neutral", value }: { label: string; tone?: "good" | "warn" | "bad" | "neutral"; value: string }) {
  const toneClass =
    tone === "good"
      ? "text-emerald-600"
      : tone === "warn"
        ? "text-orange-600"
        : tone === "bad"
          ? "text-red-600"
          : "text-slate-900";
  return (
    <div className="rounded-xl border border-phx-line bg-phx-paper px-4 py-3">
      <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">{label}</p>
      <p className={`mt-1 text-xl font-black tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}

function ChipList({ items, more }: { items: string[]; more: number }) {
  if (items.length === 0) return <p className="text-sm text-phx-ink-soft">None.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item} className="rounded-md border border-phx-line bg-white px-2 py-0.5 text-xs font-medium text-phx-ink">
          {item}
        </span>
      ))}
      {more > 0 ? <span className="rounded-md bg-phx-paper-2 px-2 py-0.5 text-xs font-semibold text-phx-ink-soft">+{formatNumber(more)} more</span> : null}
    </div>
  );
}

// Smart brick suggestions — each row is a customer with no mapping yet, matched (by name, or
// name+address) to an already-mapped twin (possibly another distributor). Accepting writes to the
// mapping sheet via /accept-mappings; the user then re-runs Preview to see the customers resolve.
function SuggestionsSection({ suggestions }: { suggestions: BrickSuggestionView[] }) {
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [busyAll, setBusyAll] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (suggestions.length === 0) return null;

  const pendingHigh = suggestions.filter((s) => s.confidence === "high" && !accepted.has(customerKey(s.distributorCode, s.customerCode)));
  const busy = busyAll || busyCode !== null;

  async function accept(items: BrickSuggestionView[]) {
    if (items.length === 0) return;
    const mappings = items.map((s) => ({
      address: s.address,
      brickId: s.suggestedBrickId,
      customerCode: s.customerCode,
      customerName: s.customerName,
      distributorCode: s.distributorCode,
    }));
    try {
      const response = await fetch("/api/sales/monthly-import/accept-mappings", {
        body: JSON.stringify({ mappings }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({ success: false }))) as AcceptResponse;
      const okKeys = savedCustomerKeys(payload.data?.results ?? []);
      if (okKeys.length > 0) setAccepted((prev) => new Set([...prev, ...okKeys]));
      setMessage(payload.message ?? payload.error ?? "Done.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to add mappings.");
    }
  }

  const acceptOne = (s: BrickSuggestionView) => {
    setBusyCode(customerKey(s.distributorCode, s.customerCode));
    void accept([s]).finally(() => setBusyCode(null));
  };
  const acceptAllHigh = () => {
    setBusyAll(true);
    void accept(pendingHigh).finally(() => setBusyAll(false));
  };

  const acceptControl = (s: BrickSuggestionView, rowKey: string) =>
    accepted.has(rowKey) ? (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
        <CheckCircle2 className="h-3.5 w-3.5" /> Added
      </span>
    ) : (
      <Button
        className="h-7 rounded-md px-3 text-xs font-bold"
        disabled={busy}
        onClick={() => acceptOne(s)}
        type="button"
        variant="secondary"
      >
        {busyCode === rowKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Accept"}
      </Button>
    );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
          <Sparkles className="h-3.5 w-3.5 text-phx-accent" />
          Suggested mappings ({formatNumber(suggestions.length)})
        </p>
        {pendingHigh.length > 0 ? (
          <Button
            className="h-8 gap-1.5 rounded-lg bg-[#0B0B0B] text-xs font-black text-white hover:bg-phx-accent"
            disabled={busy}
            onClick={acceptAllHigh}
            type="button"
          >
            {busyAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Accept all high ({pendingHigh.length})
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-phx-ink-soft">
        Matched to an already-mapped customer with the same name (or name + address). Accepting writes to the mapping sheet — re-run Preview to see them resolve.
      </p>
      <CrmTable columns={["30%", "28%", "20%", "22%"]}>
        <thead>
          <tr className="bg-phx-paper text-left text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
            <th className="break-words px-3 py-2">Customer</th>
            <th className="break-words px-3 py-2">Suggested brick</th>
            <th className="break-words px-3 py-2">Match</th>
            <th className="break-words px-3 py-2 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {suggestions.map((s) => {
            const rowKey = customerKey(s.distributorCode, s.customerCode);
            return (
              <tr key={rowKey} className="border-t border-[#EEF2F7] align-top">
                <td className="break-words px-3 py-1.5 font-semibold text-phx-ink">{s.customerName || s.customerCode}</td>
                <td className="break-words px-3 py-1.5">
                  <span className="font-medium text-phx-ink">{s.brickName}</span>
                  <span className="block text-xs text-phx-ink-faint">from {s.sourceDistributorCode}</span>
                </td>
                <td className="break-words px-3 py-1.5">
                  <Badge variant={s.confidence === "high" ? "success" : "neutral"}>
                    {s.confidence === "high" ? "name + address" : "name only"}
                  </Badge>
                </td>
                <td className="px-3 py-1.5 text-right">{acceptControl(s, rowKey)}</td>
              </tr>
            );
          })}
        </tbody>
      </CrmTable>
      <CrmCardsOnPhone>
        {suggestions.map((s) => {
          const rowKey = customerKey(s.distributorCode, s.customerCode);
          return (
            <CrmCard actions={acceptControl(s, rowKey)} key={rowKey} title={s.customerName || s.customerCode}>
              <CrmFacts
                facts={[
                  { label: "Suggested brick", value: `${s.brickName} (from ${s.sourceDistributorCode})` },
                  { label: "Match", value: s.confidence === "high" ? "name + address" : "name only" },
                ]}
              />
            </CrmCard>
          );
        })}
      </CrmCardsOnPhone>
      {message ? <p className="text-xs font-semibold text-emerald-700">{message}</p> : null}
    </div>
  );
}

/**
 * WHERE THIS FILE'S SALES WILL LAND — owner, 2026-09-07: "must in validation show the city and show
 * how it will be distributed."
 *
 * Everything above this in the modal answers "will the import work". This answers "what will it do",
 * which for a wholesaler file is the question that actually matters: one customer in Qalubeya reaches
 * seven areas, another in Sohag reaches two, a third reaches only itself.
 *
 * A customer that does NOT split shows the reason, because "stays whole" is usually correct — a
 * one-area governorate has nothing to divide across — and only the reason separates that from a
 * misclassification.
 *
 * `table-fixed` with a colgroup, never a min-width: the fits-the-screen golden rule forbids a
 * horizontal scroll, and long customer names wrap instead.
 */
function SplitPlanSection({ plan }: { plan: ImportSplitPlan | undefined }) {
  if (!plan) return null;

  if (!plan.splitActive) {
    return (
      <div className="space-y-1.5">
        <p className="text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">How it will be distributed</p>
        <p className="rounded-lg border border-phx-line bg-phx-paper px-4 py-3 text-sm text-phx-ink-soft">
          The city split does not apply to {plan.period || "this period"} — every customer&rsquo;s sales stay in
          the area the file gives them.
        </p>
      </div>
    );
  }

  const splitting = plan.customers.filter((c) => c.willSplit);
  const whole = plan.customers.filter((c) => !c.willSplit);

  return (
    <div className="space-y-2">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">How it will be distributed</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Customers that spread" value={formatNumber(plan.splittingCustomers)} />
        <StatCard label="Units that spread" value={formatNumber(Math.round(plan.splittingUnits))} />
        <StatCard label="Widest reach" value={plan.widestFanOut > 0 ? `${plan.widestFanOut} areas` : "—"} />
      </div>

      {plan.unlistedAreas.length > 0 ? (
        <div className="border border-phx-warn-line bg-phx-warn-bg px-4 py-3 text-sm text-phx-ink">
          <p className="font-black">
            {plan.unlistedAreas.length === 1 ? "One area in this file is" : `${plan.unlistedAreas.length} areas in this file are`}{" "}
            not on the city list: {plan.unlistedAreas.join(", ")}
          </p>
          <p className="mt-1 text-phx-ink-soft">
            Nothing in {plan.unlistedAreas.length === 1 ? "it" : "them"} will spread across its governorate, and neither
            will the areas already in that governorate — they still count as one-area cities. This normally means an area
            was added to the organogram and the city list has not caught up. Tell whoever maintains the sales rules
            before you publish the month.
          </p>
        </div>
      ) : null}

      {splitting.length > 0 ? (
        <>
          <CrmTable columns={["30%", "20%", "34%", "16%"]}>
            <thead>
              <tr className="bg-phx-paper text-left text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
                <th className="break-words px-3 py-2">Customer</th>
                <th className="break-words px-3 py-2">City</th>
                <th className="break-words px-3 py-2">Spreads across</th>
                <th className="break-words px-3 py-2 text-right">Units each</th>
              </tr>
            </thead>
            <tbody>
              {splitting.slice(0, 25).map((c) => (
                <tr className="border-t border-phx-line align-top" key={`${c.clientCode}-${c.originArea}`}>
                  <td className="break-words px-3 py-2">
                    <span className="block">{c.clientName || c.clientCode}</span>
                    <span className="text-phx-xs text-phx-ink-soft">{c.originArea}</span>
                  </td>
                  <td className="break-words px-3 py-2">{c.group ?? "—"}</td>
                  <td className="break-words px-3 py-2 text-phx-ink-soft">{c.targetAreas.join(", ")}</td>
                  <td className="break-words px-3 py-2 text-right tabular-nums">
                    {formatNumber(Math.round(c.unitsPerArea * 100) / 100)}
                  </td>
                </tr>
              ))}
            </tbody>
          </CrmTable>
          <CrmCardsOnPhone>
            {splitting.slice(0, 25).map((c) => (
              <CrmCard key={`${c.clientCode}-${c.originArea}`} meta={c.originArea} title={c.clientName || c.clientCode}>
                <CrmFacts
                  facts={[
                    { label: "City", value: c.group ?? "—" },
                    { label: "Units each", value: formatNumber(Math.round(c.unitsPerArea * 100) / 100) },
                    { label: "Spreads across", value: c.targetAreas.join(", ") },
                  ]}
                />
              </CrmCard>
            ))}
          </CrmCardsOnPhone>
        </>
      ) : null}

      {whole.length > 0 ? (
        <details className="rounded-lg border border-phx-line px-4 py-2 text-sm">
          <summary className="cursor-pointer text-phx-ink-soft">
            {formatNumber(plan.wholeCustomers)} customer{plan.wholeCustomers === 1 ? "" : "s"} stay whole
            ({formatNumber(Math.round(plan.wholeUnits))} units) — and why
          </summary>
          <ul className="mt-2 space-y-1">
            {whole.slice(0, 25).map((c) => (
              <li className="text-phx-ink-soft" key={`${c.clientCode}-${c.originArea}-w`}>
                <span className="text-slate-900">{c.clientName || c.clientCode}</span>
                {" — "}
                {c.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function ImportPreviewModal({ committing, onCancel, onConfirm, result }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on Escape (guard: don't close while a commit is in flight).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !committing) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [committing, onCancel]);

  // Move focus into the modal when it opens so Tab cycles within the portal content.
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  if (typeof document === "undefined") return null;

  const diff = result.previewDiff;
  const blocked = result.status === "blocked";
  const distributorLabel = result.distributor?.name ?? result.distributor?.code ?? "";
  const newMore = diff ? Math.max(0, diff.newCustomers - diff.newCustomerCodes.length) : 0;
  const productMore = diff ? Math.max(0, diff.unmappedProductsCount - diff.unmappedProducts.length) : 0;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-[#020617]/65 p-4 backdrop-blur-sm">
      <div
        aria-labelledby="preview-modal-title"
        aria-modal="true"
        className="my-6 w-full max-w-2xl rounded-lg border border-phx-line bg-white shadow-[0_28px_90px_rgba(15,23,42,0.3)]"
        ref={containerRef}
        role="dialog"
        tabIndex={-1}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-phx-line px-6 py-5">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-black tracking-tight text-slate-950" id="preview-modal-title">Review import</h2>
              <Badge variant={blocked ? "danger" : "success"}>{blocked ? "blocked" : "ready"}</Badge>
            </div>
            <p className="mt-1 text-sm text-phx-ink-soft">
              {distributorLabel}
              {result.period ? ` · ${result.period}` : ""} · {result.sheetName}
            </p>
          </div>
          <button
            aria-label="Close"
            className="rounded-md p-1 text-phx-ink-soft transition hover:bg-phx-paper-2 hover:text-slate-900"
            onClick={onCancel}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-5 px-6 py-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard
              label="Rows resolved"
              tone={blocked ? "bad" : "good"}
              value={`${diff?.resolvedRowsPct ?? 0}%`}
            />
            <StatCard label="Importable rows" value={`${formatNumber(result.importableRows)} / ${formatNumber(result.rowCount)}`} />
            <StatCard label="Importable value" value={formatCurrency(diff?.importableValue ?? result.totals.totalValue)} />
          </div>

          {blocked ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                <span className="font-semibold">Nothing will be imported.</span> {formatNumber(result.failedRows)} row
                {result.failedRows === 1 ? "" : "s"} are unmapped — map the unknowns below, then re-upload.
              </p>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="New customers" tone={diff && diff.newCustomers > 0 ? "warn" : "neutral"} value={formatNumber(diff?.newCustomers ?? 0)} />
            <StatCard label="Mapped customers" value={formatNumber(diff?.mappedCustomers ?? 0)} />
            <StatCard label="Unmapped products" tone={diff && diff.unmappedProductsCount > 0 ? "warn" : "neutral"} value={formatNumber(diff?.unmappedProductsCount ?? 0)} />
            <StatCard label="Brick drift" tone={diff && diff.brickDriftCount > 0 ? "bad" : "neutral"} value={formatNumber(diff?.brickDriftCount ?? 0)} />
          </div>

          <SplitPlanSection plan={result.splitPlan} />

          {diff && diff.newCustomers > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">New customers (need mapping)</p>
              <ChipList items={diff.newCustomerCodes} more={newMore} />
            </div>
          ) : null}

          <SuggestionsSection suggestions={result.suggestions ?? []} />

          {diff && diff.unmappedProductsCount > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Unmapped products</p>
              <ChipList items={diff.unmappedProducts} more={productMore} />
            </div>
          ) : null}

          {diff && diff.brickDriftSamples.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Brick drift — resolved brick ≠ stored mapping</p>
              <CrmTable columns={["34%", "33%", "33%"]}>
                <thead>
                  <tr className="bg-phx-paper text-left text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
                    <th className="break-words px-3 py-2">Customer</th>
                    <th className="break-words px-3 py-2">Stored brick</th>
                    <th className="break-words px-3 py-2">Resolved brick</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.brickDriftSamples.map((row) => (
                    <tr key={row.customerCode} className="border-t border-[#EEF2F7] align-top">
                      <td className="break-words px-3 py-1.5 font-medium text-phx-ink">{row.customerCode}</td>
                      <td className="break-words px-3 py-1.5 text-phx-ink-soft">{row.mappedBrickId}</td>
                      <td className="break-words px-3 py-1.5 text-orange-600">{row.resolvedBrickId}</td>
                    </tr>
                  ))}
                </tbody>
              </CrmTable>
              <CrmCardsOnPhone>
                {diff.brickDriftSamples.map((row) => (
                  <CrmCard key={row.customerCode} title={row.customerCode}>
                    <CrmFacts
                      facts={[
                        { label: "Stored brick", value: row.mappedBrickId },
                        { label: "Resolved brick", value: row.resolvedBrickId },
                      ]}
                    />
                  </CrmCard>
                ))}
              </CrmCardsOnPhone>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-phx-line px-6 py-4">
          <Button className="h-10 rounded-xl" disabled={committing} onClick={onCancel} type="button" variant="secondary">
            Cancel
          </Button>
          <Button
            className="h-10 gap-2 rounded-xl bg-[#0B0B0B] font-black text-white transition hover:bg-phx-accent disabled:opacity-50"
            disabled={blocked || committing}
            onClick={onConfirm}
            type="button"
          >
            {committing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Confirm import
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
