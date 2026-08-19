import type { ReactNode } from "react";
import { AlertTriangle, Ban, CheckCircle2, Clock3, HelpCircle, Info } from "lucide-react";

import type { CaseFileBlock, MarketingCaseFileWarning } from "@/lib/marketing-requests/case-file-types";

/**
 * The Marketing Case File's OWN copy of the Direct Order detail-panel look
 * (src/components/approvals-hub/direct-order-detail-primitives.tsx).
 *
 * A separate, independent copy on purpose — the same reasoning that file states for not importing
 * Outstation's: it belongs to another module's internal file lifecycle, and a shared presentation
 * file quietly couples two modules' redesigns together. Names are kept identical where it costs
 * nothing (`PanelSection`, `Field`, `FieldGroup`, `FieldTable`, `HeroStat`, `ApprovalTracker`) so a
 * reader moving between the two modules recognises the vocabulary.
 *
 * Two deliberate DIVERGENCES from the copied original, both required here:
 *
 *  1. `ApprovalTracker` gains `returned` and `skipped` states. A marketing chain really has them
 *     (MarketingApprovalStepStatus), and folding them into `waiting` would render a rung that was
 *     sent back identically to one that has not been reached.
 *  2. Its step label no longer uses `truncate`. Tailwind's `truncate` IS an ellipsis, which the
 *     house rule forbids — so the label gets the same per-cell horizontal scroll `Field` already
 *     uses, for the same measured reason.
 *
 * Everything below `── the three states ──` is NEW, not copied: it is the entire point of this
 * screen. `CaseFileBlock` has three arms and they must never render alike — a read that FAILED,
 * a thing that legitimately does not exist yet, and a clean empty result are three different
 * facts, and the screen this replaces paints all three the same.
 *
 * Presentation only. No data, no decisions, no fetching.
 */

// ── copied primitives ────────────────────────────────────────────────────────

/** Dark block header with the orange accent bar — the module's premium section divider. */
export function PanelSection({
  children,
  title,
  subtitle,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="border border-slate-200 bg-white">
      <div className="flex items-center gap-2 bg-slate-900 px-4 py-2.5">
        <span aria-hidden className="h-4 w-1 bg-orange-500" />
        <span className="text-[11px] font-black uppercase tracking-wide text-white">{title}</span>
        {subtitle ? (
          <span className="ml-auto overflow-x-auto whitespace-nowrap text-[10px] font-bold uppercase tracking-wider text-slate-400">
            {subtitle}
          </span>
        ) : null}
      </div>
      <div className="space-y-4 p-4">{children}</div>
    </div>
  );
}

/**
 * One label/value cell of the fact grid.
 *
 * Keeps the copied per-cell `overflow-x-auto`: a fixed `minmax(0, 1fr)` grid track never grows to
 * fit content, so a value wider than its own column (a full request-id UUID, "Name · HR-ID · Role")
 * painted straight over the NEXT column instead of scrolling. Giving the value its own horizontal
 * scroll keeps the never-wrap, never-ellipsis rule while containing the scroll to the one cell.
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

/** One headline number the reader's eye should land on first, pulled out of the flat fact grid. */
export function HeroStat({
  label,
  value,
  note,
  tone = "slate",
}: {
  label: string;
  value: ReactNode;
  note?: string;
  tone?: "slate" | "orange" | "emerald" | "rose" | "amber" | "sky";
}) {
  const tones = {
    amber: { box: "border-amber-200 bg-amber-50", text: "text-amber-800" },
    emerald: { box: "border-emerald-200 bg-emerald-50", text: "text-emerald-800" },
    orange: { box: "border-orange-200 bg-orange-50", text: "text-orange-700" },
    rose: { box: "border-rose-200 bg-rose-50", text: "text-rose-700" },
    sky: { box: "border-sky-200 bg-sky-50", text: "text-sky-800" },
    slate: { box: "border-slate-200 bg-slate-50", text: "text-slate-900" },
  }[tone];

  return (
    <div className={`border px-4 py-3 ${tones.box}`}>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className={`-mx-0.5 mt-1 overflow-x-auto whitespace-nowrap px-0.5 text-xl font-black ${tones.text}`}>
        {value}
      </p>
      {note ? (
        <p className="-mx-0.5 mt-1 overflow-x-auto whitespace-nowrap px-0.5 text-[11px] font-semibold text-slate-500">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/** A named cluster of Fields within one PanelSection — a subdivision, so a lighter header. */
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
 * A named cluster rendered as a real two-column table.
 *
 * Label column fixed and quiet; value column carries the weight and scrolls within its own cell for
 * the long values rather than colliding with the next column.
 */
export function FieldTable({
  rows,
  title,
}: {
  rows: Array<{ label: string; value: ReactNode }>;
  title: string;
}) {
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

export type ApprovalTrackerState = "done" | "current" | "waiting" | "rejected" | "returned" | "skipped";

/**
 * The approval chain as a progress bar.
 *
 * `emptyNote` is a SENTENCE, not a fallback string: zero steps is a legitimate state (a draft has
 * never been submitted, so it has no chain at all), and a bar with no segments reads as broken.
 */
export function ApprovalTracker({
  steps,
  emptyNote,
}: {
  steps: Array<{ order: number; label: string; state: ApprovalTrackerState }>;
  emptyNote: string | null;
}) {
  if (emptyNote || steps.length === 0) {
    return (
      <div className="border border-slate-200 bg-slate-50 px-3 py-2.5">
        <p className="text-[12px] font-semibold leading-5 text-slate-600">
          {emptyNote ?? "No approval steps have been recorded for this request yet."}
        </p>
      </div>
    );
  }

  const tone: Record<ApprovalTrackerState, { bar: string; text: string }> = {
    current: { bar: "bg-amber-400", text: "font-black text-amber-800" },
    done: { bar: "bg-emerald-500", text: "text-emerald-700" },
    rejected: { bar: "bg-rose-500", text: "font-black text-rose-700" },
    returned: { bar: "bg-orange-400", text: "font-black text-orange-700" },
    skipped: { bar: "bg-slate-300", text: "text-slate-500 line-through" },
    waiting: { bar: "bg-slate-200", text: "text-slate-400" },
  };

  return (
    <div className="flex gap-2">
      {steps.map((step) => (
        <div key={step.order} className="min-w-0 flex-1">
          <div className={`h-1.5 w-full ${tone[step.state].bar}`} />
          <p
            className={`-mx-0.5 mt-1.5 overflow-x-auto whitespace-nowrap px-0.5 text-[10px] uppercase tracking-wide ${tone[step.state].text}`}
          >
            {step.label}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── the three states ─────────────────────────────────────────────────────────
//
// NEW here, and the reason this screen exists. Each arm of CaseFileBlock gets its own colour, its
// own icon, its own headline word, and its own border treatment. "unavailable" is deliberately the
// only one that is DASHED — a reader can tell at a glance, without reading a word, that the screen
// is admitting it does not know rather than reporting a result.

/** The eyebrow word for a non-ok block. Never a code, never blank. */
const BLOCK_HEADLINE = {
  not_applicable: "Not applicable yet",
  unavailable: "Could not be read",
} as const;

/**
 * The `unavailable` / `not_applicable` arms of a block, rendered as prose.
 *
 * `reason` is written by the service and is always a full sentence, so it is rendered verbatim
 * rather than being summarised into a dash, a zero, or an empty list.
 */
export function BlockNotice({
  reason,
  state,
}: {
  reason: string;
  state: "unavailable" | "not_applicable";
}) {
  const unavailable = state === "unavailable";
  return (
    <div
      className={
        unavailable
          ? "border-2 border-dashed border-amber-400 bg-amber-50 px-4 py-3"
          : "border-l-4 border-y border-r border-y-sky-200 border-r-sky-200 border-l-sky-500 bg-sky-50 px-4 py-3"
      }
      data-case-file-block-state={state}
    >
      <p
        className={`flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.16em] ${
          unavailable ? "text-amber-800" : "text-sky-800"
        }`}
      >
        {unavailable ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <Clock3 className="h-3.5 w-3.5 shrink-0" />}
        {BLOCK_HEADLINE[state]}
      </p>
      <p className={`mt-1.5 text-[13px] font-semibold leading-6 ${unavailable ? "text-amber-900" : "text-sky-900"}`}>
        {reason}
      </p>
    </div>
  );
}

/**
 * Render a block by its state, and only its state.
 *
 * The one gate every section passes through, so no section can accidentally fold `unavailable` into
 * an empty `ok`. `children` is only ever called on the `ok` arm — there is no `value` to read on the
 * other two, by construction.
 */
export function CaseFileBlockView<T>({
  block,
  children,
}: {
  block: CaseFileBlock<T>;
  children: (value: T) => ReactNode;
}) {
  if (block.state === "ok") return <>{children(block.value)}</>;
  return <BlockNotice reason={block.reason} state={block.state} />;
}

/** A value that is simply absent. A sentence-shaped label, never a bare dash. */
export function NotProvided({ what = "Not provided" }: { what?: string }) {
  return <span className="font-semibold italic text-slate-400">{what}</span>;
}

// ── warnings ─────────────────────────────────────────────────────────────────

/**
 * One check, in one of three states.
 *
 * `unavailable` is emphatically NOT `clear`: it gets amber, a dashed rule, a question mark and the
 * word UNKNOWN. The defect being fixed is the approval screen's `.catch(() => [])`, where a
 * double-spend check that fell over renders identically to one that passed.
 */
export function WarningRow({ warning }: { warning: MarketingCaseFileWarning }) {
  const look =
    warning.state === "unavailable"
      ? {
        Icon: HelpCircle,
        box: "border-2 border-dashed border-amber-400 bg-amber-50",
        chip: "bg-amber-500 text-white",
        chipText: "Unknown",
        icon: "text-amber-700",
        text: "text-amber-900",
      }
      : warning.state === "clear"
        ? {
          Icon: CheckCircle2,
          box: "border border-emerald-200 bg-emerald-50",
          chip: "bg-emerald-600 text-white",
          chipText: "Clear",
          icon: "text-emerald-600",
          text: "text-emerald-900",
        }
        : warning.severity === "block"
          ? {
            Icon: Ban,
            box: "border border-rose-300 bg-rose-50",
            chip: "bg-rose-600 text-white",
            chipText: "Blocking",
            icon: "text-rose-600",
            text: "text-rose-900",
          }
          : warning.severity === "warn"
            ? {
              Icon: AlertTriangle,
              box: "border border-orange-300 bg-orange-50",
              chip: "bg-orange-600 text-white",
              chipText: "Flagged",
              icon: "text-orange-600",
              text: "text-orange-900",
            }
            : {
              Icon: Info,
              box: "border border-sky-200 bg-sky-50",
              chip: "bg-sky-600 text-white",
              chipText: "Noted",
              icon: "text-sky-600",
              text: "text-sky-900",
            };

  const { Icon } = look;
  return (
    <div className={`flex items-start gap-2.5 px-3 py-2.5 ${look.box}`} data-case-file-warning-state={warning.state}>
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${look.icon}`} />
      <div className="min-w-0 flex-1">
        <span
          className={`inline-block px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.16em] ${look.chip}`}
        >
          {look.chipText}
        </span>
        <p className={`mt-1.5 text-[12.5px] font-semibold leading-6 ${look.text}`}>{warning.sentence}</p>
      </div>
    </div>
  );
}

// ── chips ────────────────────────────────────────────────────────────────────

/** A small human-readable label chip. Never renders a raw enum — the caller resolves the word. */
export function Chip({
  label,
  tone = "slate",
}: {
  label: string;
  tone?: "slate" | "orange" | "emerald" | "rose" | "amber" | "sky" | "dark";
}) {
  const tones = {
    amber: "border-amber-300 bg-amber-50 text-amber-800",
    dark: "border-slate-900 bg-slate-900 text-white",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    orange: "border-orange-300 bg-orange-50 text-orange-800",
    rose: "border-rose-300 bg-rose-50 text-rose-800",
    sky: "border-sky-200 bg-sky-50 text-sky-800",
    slate: "border-slate-200 bg-slate-50 text-slate-700",
  }[tone];
  return (
    <span
      className={`inline-flex max-w-full items-center overflow-x-auto whitespace-nowrap border px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] ${tones}`}
    >
      {label}
    </span>
  );
}

/**
 * The banner a rejected / returned request leads with.
 *
 * These are the lifecycle stages with NO surface at all today: a rejected request vanishes from the
 * requester's workspace, so who refused it and why has never been readable anywhere.
 */
export function LeadBanner({
  children,
  headline,
  tone,
}: {
  children: ReactNode;
  headline: string;
  tone: "rose" | "orange";
}) {
  const tones =
    tone === "rose"
      ? { box: "border-rose-300 bg-rose-50", head: "text-rose-900", rule: "bg-rose-600" }
      : { box: "border-orange-300 bg-orange-50", head: "text-orange-900", rule: "bg-orange-600" };
  return (
    <div className={`border ${tones.box}`}>
      <div className="flex items-stretch">
        <span aria-hidden className={`w-1.5 shrink-0 ${tones.rule}`} />
        <div className="min-w-0 flex-1 px-4 py-3">
          <p className={`text-[11px] font-black uppercase tracking-[0.16em] ${tones.head}`}>{headline}</p>
          <div className="mt-2 space-y-1.5">{children}</div>
        </div>
      </div>
    </div>
  );
}
