import { describeDirectOrderStatus } from "@/lib/direct-orders/status-labels";
import { showsAwaitingFinanceMonth, type DirectOrderStatus } from "@/lib/direct-orders/types";

// ─────────────────────────────────────────────────────────────────────────────
// The one status pill for direct orders (spec C2).
//
// WHY THIS EXISTS AT ALL: `approved` on its own is misleading, and it was misleading on four
// screens at once. CEO approval never injects sales — the GOLDEN RULE is that injection happens
// only when the Finance Manager books the order into a month. An order can therefore sit
// "Approved" for days with its value in nobody's numbers, and every list rendered exactly that
// word with nothing to say so. On 2026-08-05 two orders were approved with a null month and
// nothing had been injected; no screen said so.
//
// The detail page had carried the full sentence since C2 was built. The four LIST surfaces never
// did, because each had its own copy-pasted StatusPill and the fix would have had to be made four
// times. That is precisely how the four copies drifted in the first place, so this replaces them
// rather than adding a fifth.
//
// Two visual families are preserved on purpose. Admin tables use square solid pills; the portal
// uses rounded ring pills. The owner's standing rule is that a module's pages match their siblings
// exactly, so unifying the LOOK here would break four screens to tidy one file.
// ─────────────────────────────────────────────────────────────────────────────

/** Square solid — the admin tables. */
const SOLID_TONE: Record<DirectOrderStatus, string> = {
  pending_approval: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-rose-100 text-rose-800",
  returned: "bg-slate-200 text-slate-700",
  reversed: "bg-slate-200 text-slate-700",
  draft: "bg-slate-100 text-slate-600",
  held: "bg-orange-100 text-orange-800",
  expired: "bg-slate-300 text-slate-600",
  cancelled: "bg-zinc-200 text-zinc-700",
};

/** Rounded ring — the employee portal. */
const RING_TONE: Record<DirectOrderStatus, string> = {
  pending_approval: "bg-amber-50 text-amber-700 ring-amber-200",
  approved: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  rejected: "bg-rose-50 text-rose-700 ring-rose-200",
  returned: "bg-sky-50 text-sky-700 ring-sky-200",
  reversed: "bg-slate-100 text-slate-600 ring-slate-200",
  draft: "bg-slate-50 text-slate-500 ring-slate-200",
  held: "bg-orange-50 text-orange-700 ring-orange-200",
  expired: "bg-slate-200 text-slate-500 ring-slate-300",
  cancelled: "bg-zinc-100 text-zinc-600 ring-zinc-300",
};

/**
 * Approved but not yet booked into a month.
 *
 * Amber rather than emerald, deliberately: emerald says "done", and this order's value is in no
 * month's numbers. It is the same fact the detail page states in a full sentence
 * (direct-order-request-detail.tsx) — this is its short form, for a cell.
 */
const AWAITING_FINANCE_SOLID = "bg-amber-100 text-amber-900";
const AWAITING_FINANCE_RING = "bg-amber-50 text-amber-800 ring-amber-300";

type Props = {
  status: DirectOrderStatus | string;
  /**
   * The month Finance booked it into, or null. REQUIRED rather than optional: an optional prop
   * would let a caller omit it and silently get the plain "Approved" this component exists to
   * prevent — the omission would look like a decision and read like a fact.
   */
  salesMonth: string | null;
  variant?: "solid" | "ring";
  /**
   * Let the label wrap instead of forcing one line. Off everywhere by default — nowrap is right
   * for the wide badge columns this was built for. Needed by direct-order-submit-form.tsx's
   * "My direct orders" table, where the FITS-THE-SCREEN GOLDEN RULE (AGENTS.md §4) rules out a
   * column wide enough for "Customer Verification Required" (206px) on every row just for the
   * rare row that needs it — and shrinking the label's type is the one fix the rule forbids.
   */
  wrap?: boolean;
  /**
   * True only when the person reading raised this order. A `returned` order says "Needs Your
   * Correction" to its raiser and "Returned for correction" to everyone else — optional and
   * defaulting to the neutral wording, because the personal one is a claim about the reader.
   */
  viewerIsRequester?: boolean;
};

export function DirectOrderStatusPill({
  status,
  salesMonth,
  variant = "solid",
  wrap = false,
  viewerIsRequester = false,
}: Props) {
  const key = String(status) as DirectOrderStatus;
  const awaitingFinance = showsAwaitingFinanceMonth(key, salesMonth);

  const base =
    variant === "ring"
      ? "inline-flex items-center rounded-full px-2 py-0.5 text-phx-2xs font-black uppercase tracking-wide ring-1"
      : "inline-block px-2 py-0.5 text-phx-2xs font-black uppercase tracking-wider";

  const fallback = variant === "ring" ? "bg-slate-50 text-slate-500 ring-slate-200" : "bg-slate-100 text-slate-600";
  const tone = awaitingFinance
    ? variant === "ring"
      ? AWAITING_FINANCE_RING
      : AWAITING_FINANCE_SOLID
    : (variant === "ring" ? RING_TONE : SOLID_TONE)[key] ?? fallback;

  // The WORDS now come from the shared vocabulary (status-labels.ts) instead of
  // `String(status).replace(/_/g, " ")`, which printed the database value: "pending
  // approval", "held", "expired". Those describe the row, not the reader's
  // situation — "held" in particular reads as "an approver paused this" when the
  // truth is that no approver has seen it at all.
  //
  // The awaiting-Finance TITLE stays a literal here rather than delegating, and
  // that is deliberate: this one sentence names the GOLDEN RULE (CEO approval
  // injects nothing; only the Finance booking does), it is the most important
  // sentence in the module, and tests/direct-orders-finance-month-badge.test.ts
  // asserts the wording lives in the file that renders it.
  const presentation = describeDirectOrderStatus(key, salesMonth, { isRequester: viewerIsRequester });
  const label = presentation.label;
  const title = awaitingFinance
    ? "Approved — awaiting Finance month. The sales are NOT in any month's numbers yet: they inject only when the Finance Manager books this order into a month."
    : presentation.explanation;

  return (
    <span className={`${base} ${wrap ? "whitespace-normal break-words" : "whitespace-nowrap"} ${tone}`} title={title}>
      {label}
    </span>
  );
}
