import type { ReactNode } from "react";

import type { DirectOrderPricingBreakdown } from "@/lib/direct-orders/approval-fields";

/**
 * Direct Order's own copy of the Expense-Approvals detail-panel look (owner request, 2026-08-08:
 * restyle the Direct Order approval window to the same standard as Outstation's Expense Approvals
 * — src/components/outstation/approval-detail-primitives.tsx).
 *
 * A SEPARATE, independent copy on purpose, not an import of Outstation's file: that file has two
 * importers today, both inside src/components/outstation/, and Direct Orders is a money/compliance-
 * critical module — coupling it to another module's internal file lifecycle is the wrong kind of
 * reuse. Names are kept close to Outstation's for cross-codebase legibility where it costs nothing
 * (`PanelSection`); `Field` keeps its existing name rather than becoming `Fact`, since
 * `buildDirectOrderDetailFields`/`DirectOrderDetailField` already establish that vocabulary in this
 * module.
 *
 * Presentation only. Neither screen's data or decisions live here.
 */

/** Dark block header with the orange accent bar — the module's premium section divider. */
export function PanelSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="border border-slate-200">
      <div className="flex items-center gap-2 bg-slate-900 px-4 py-2.5">
        <span aria-hidden className="h-4 w-1 bg-orange-500" />
        <span className="text-[11px] font-black uppercase tracking-wide text-white">{title}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

/**
 * One label/value cell of the fact grid — moved from direct-order-request-detail.tsx, and fixed
 * while moving it (found live on production, 2026-08-08): `md:grid-cols-4` gives each column a
 * fixed `minmax(0, 1fr)` track, which never grows to fit content — so a value wider than its own
 * ~206px column (a full request-id UUID, "Name · HR-ID · Role") painted straight over the NEXT
 * column instead of scrolling, because the ancestor's `overflow-x-auto` only lets the whole grid
 * scroll, never an individual track. Giving the value its OWN horizontal scroll — the same fix
 * Outstation's `RouteFact` already uses for its long from→to line — keeps the owner's "never wrap"
 * rule while containing the scroll to the one cell that needs it.
 */
export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className="-mx-0.5 mt-0.5 overflow-x-auto whitespace-nowrap px-0.5 text-sm font-semibold text-slate-900">
        {value}
      </dd>
    </div>
  );
}

/**
 * One headline number the approver's eye should land on first — sales value, quantity, the
 * bonus/discount — pulled OUT of the plain fact grid into its own bigger tile. The flat 24-field
 * grid gave every fact equal visual weight, which buried the three numbers a decision actually
 * turns on among things like "Geography check" and "Pharmacy status".
 */
export function HeroStat({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: ReactNode;
  tone?: "slate" | "orange";
}) {
  return (
    <div className={`border px-4 py-3 ${tone === "orange" ? "border-orange-200 bg-orange-50" : "border-slate-200 bg-slate-50"}`}>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className={`mt-1 whitespace-nowrap text-xl font-black ${tone === "orange" ? "text-orange-700" : "text-slate-900"}`}>
        {value}
      </p>
    </div>
  );
}

/**
 * A named cluster of Fields within one PanelSection — "Product & deal," "Pharmacy & geography,"
 * "Request & timeline" — so 24 facts read as three short, scannable lists instead of one wall.
 * Deliberately a LIGHTER header than PanelSection's own (a thin rule, not a dark bar): this marks
 * a subdivision of one section, not a new section.
 */
export function FieldGroup({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div>
      <p className="mb-2 border-b border-slate-100 pb-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-orange-600">
        {title}
      </p>
      <div className="overflow-x-auto">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">{children}</dl>
      </div>
    </div>
  );
}

/**
 * A named cluster rendered as a real two-column table (owner request, 2026-08-08: "every Product &
 * deal / Pharmacy & geography / Request & timeline must be a premium polished table").
 *
 * Label column is fixed and quiet; value column carries the weight and scrolls within its own cell
 * for the long values (a full request-id UUID, "Name · HR-ID · Role") rather than colliding with the
 * next column — the same per-cell scroll `Field` uses, for the same measured reason.
 */
export function FieldTable({ rows, title }: { rows: Array<{ label: string; value: ReactNode }>; title: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="border border-slate-200">
      <div className="border-b border-slate-200 bg-slate-50 px-3 py-1.5">
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-orange-600">{title}</p>
      </div>
      <table className="w-full border-collapse text-sm">
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.label} className={index % 2 ? "bg-slate-50/60" : "bg-white"}>
              <th
                scope="row"
                className="w-[38%] whitespace-nowrap border-b border-slate-100 px-3 py-2 text-left align-top text-[10px] font-black uppercase tracking-wider text-slate-400 sm:w-[30%]"
              >
                {row.label}
              </th>
              <td className="border-b border-slate-100 px-3 py-2 align-top">
                <div className="-mx-0.5 overflow-x-auto whitespace-nowrap px-0.5 font-semibold text-slate-900">
                  {row.value}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The approval workflow as a progress bar (owner request, 2026-08-08) — replacing a plain
 * "Status: pending approval" text field, which said where it was but never how far along.
 *
 * Reads the state machine `buildDirectOrderApprovalNarrative` already computes, so the tracker and
 * the narrative list below it can never disagree about which rung is current.
 */
export function ApprovalTracker({
  steps,
  emptyNote,
}: {
  steps: Array<{ order: number; label: string; state: "done" | "current" | "waiting" | "rejected" }>;
  emptyNote: string | null;
}) {
  // A held or expired request has NO chain at all — it enters one only after its pharmacy passes
  // validation. Saying that in words beats a bar with zero segments, which reads as broken.
  if (emptyNote || steps.length === 0) {
    return (
      <div className="border border-slate-200 bg-slate-50 px-3 py-2.5">
        <p className="text-[12px] font-semibold text-slate-600">{emptyNote ?? "No approval steps recorded yet."}</p>
      </div>
    );
  }

  const tone: Record<"done" | "current" | "waiting" | "rejected", { bar: string; text: string }> = {
    done: { bar: "bg-emerald-500", text: "text-emerald-700" },
    current: { bar: "bg-amber-400", text: "text-amber-800 font-black" },
    waiting: { bar: "bg-slate-200", text: "text-slate-400" },
    rejected: { bar: "bg-rose-500", text: "text-rose-700 font-black" },
  };

  return (
    <div className="flex gap-2">
      {steps.map((step) => (
        <div key={step.order} className="min-w-0 flex-1">
          <div className={`h-1.5 w-full ${tone[step.state].bar}`} />
          <p className={`mt-1.5 truncate text-[10px] uppercase tracking-wide ${tone[step.state].text}`} title={step.label}>
            {step.label}
          </p>
        </div>
      ))}
    </div>
  );
}

const money = (value: number | null): string =>
  value == null ? "—" : `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} EGP`;
const units = (value: number): string => value.toLocaleString("en-US");

/**
 * Pharmacy price / Public price, colour-coded instead of captioned. Replaces prose like "(on
 * file, not used — discount deal)" — the basis that priced this deal is what matters, and colour
 * says that in one glance instead of a sentence per field (owner rule, 2026-08-08).
 */
export function PriceUsageField({
  label,
  notSet,
  used,
  value,
  bare = false,
}: {
  label: string;
  notSet: boolean;
  used: boolean;
  value: number | null;
  /** Inside FieldTable the row header already carries the label, so render the value alone. */
  bare?: boolean;
}) {
  const rendered = notSet ? (
    <span className="text-slate-400">Not set</span>
  ) : used ? (
    // The basis that priced this deal: green, with a tick. No caption — the colour and the mark
    // say it faster than "(used for this deal)" ever did.
    <span className="inline-flex items-center gap-1 bg-emerald-50 px-1.5 py-0.5 font-black text-emerald-800">
      <span aria-hidden>✓</span>
      {money(value)}
    </span>
  ) : (
    // The basis that did NOT price it: red, struck through. Still shown, because "on file but not
    // used" and "never entered" are different facts and the approver needs both.
    <span className="inline-block bg-rose-50 px-1.5 py-0.5 font-semibold text-rose-700 line-through decoration-rose-400 decoration-1">
      {money(value)}
    </span>
  );

  return bare ? rendered : <Field label={label} value={rendered} />;
}

/**
 * "Show your working" for `request.salesValue` — qty × price (× discount), the approver reads the
 * arithmetic instead of a bare total with nothing to check it against.
 */
export function PricingBreakdownFact({ breakdown }: { breakdown: DirectOrderPricingBreakdown }) {
  return (
    <div className="border-t border-slate-200 pt-3">
      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">Pricing</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-sm text-slate-700">
        <span>{units(breakdown.qty)} units</span>
        <span className="text-slate-400">×</span>
        <span>{money(breakdown.unitPrice)}</span>
        {breakdown.basis === "discount" ? (
          <>
            <span className="text-slate-400">×</span>
            <span>(1 − {breakdown.discountPct ?? 0}%)</span>
          </>
        ) : null}
        <span className="text-slate-400">=</span>
        <span className="font-bold text-slate-900">{money(breakdown.computedValue)}</span>
        {breakdown.basis === "bonus" && breakdown.bonusUnits ? (
          <span className="text-[11px] font-semibold text-slate-500">
            (+{units(breakdown.bonusUnits)} bonus units, not counted in value)
          </span>
        ) : null}
      </p>
      {breakdown.computedValue == null ? (
        <p className="mt-1 text-[11px] font-semibold text-amber-700">
          Price not on file — the stored sales value is shown as entered, not re-derived.
        </p>
      ) : null}
    </div>
  );
}
