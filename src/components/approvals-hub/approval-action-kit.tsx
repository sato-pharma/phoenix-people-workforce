import type { ReactNode, Ref } from "react";

import { adminPanelClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";

/**
 * ONE APPROVALS INTERFACE (enterprise audit REC-032, 14 Nov 2026).
 *
 * The look and the wording every approval decision wears, wherever it is decided: the request pages
 * (leave, excuse, direct order, Early Bird — `DecisionActions`), the weekly-plan and manager-plan
 * panels, the Action Center's inline row, and the Expense Approvals queue. Before this each screen
 * drew its own buttons — round corners on one, square on the next, a filled red Reject here and an
 * outlined one there — so the same decision looked different depending on where it was reached.
 *
 * Only the LOOK and the WORDS are shared. Who may decide, which buttons a step offers, and where the
 * decision is posted stay with each module: Expense Approvals keeps its batch save (owner, 14 Nov
 * 2026), and Marketing and Market Awareness keep their own inboxes.
 *
 * The rules it carries: square edges (no radius anywhere); a filled action lifts and drops the lift
 * when disabled (tests/approvals-hub-premium-depth.test.ts); 44px tall at the regular size; the
 * labels wrap, never truncate. Pinned by tests/approvals-one-interface.test.ts.
 */

/** What an action does, which decides how it looks. */
export type ApprovalTone =
  | "approve" // the decision that moves the request forward — filled green
  | "acknowledge" // HR's acknowledgement — filled ink
  | "return" // back to the requester to change — amber outline
  | "reject" // refuse — rose outline
  | "override" // the System Administrator answering for a stalled approver — ink outline
  | "overrideQuiet" // the second, quieter override
  | "confirm" // the "yes, do it" under an are-you-sure step — filled orange, whatever the act
  | "neutral"; // a step that is not a decision (send to review, ask for details, open, undo)

/** The 44px floor on the decision screens; `dense` sits inside a table row. */
export type ApprovalActionSize = "regular" | "dense";

const LIFT = "shadow-[0_1px_2px_rgba(15,23,42,0.2),0_8px_18px_rgba(15,23,42,0.16)] disabled:shadow-none";

export const approvalActionToneClassName: Record<ApprovalTone, string> = {
  approve: `border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 ${LIFT}`,
  acknowledge: `border border-slate-900 bg-slate-900 text-white hover:bg-black ${LIFT}`,
  return: "border border-amber-500 bg-white text-amber-700 hover:bg-amber-50",
  reject: "border border-rose-500 bg-white text-rose-700 hover:bg-rose-50",
  override: "border border-slate-900 bg-white text-slate-900 hover:bg-slate-100",
  overrideQuiet: "border border-slate-400 bg-white text-slate-600 hover:bg-slate-100",
  confirm: `border border-orange-500 bg-orange-500 text-white hover:bg-orange-600 ${LIFT}`,
  neutral: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
};

const SIZE: Record<ApprovalActionSize, string> = {
  regular: "h-11 px-4 text-sm",
  dense: "min-h-8 px-2.5 py-1 text-xs",
};

const BASE =
  "inline-flex items-center justify-center gap-1.5 text-center font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

/** The className of one approval action. Plain string joining — never `cn()`, which would strip the
 *  module's custom font sizes (tailwind-merge does not know `text-phx-*`). */
export function approvalActionClassName(tone: ApprovalTone, size: ApprovalActionSize = "regular", extra = ""): string {
  // A table row is flat: the dense size drops the lift (the expense queue's own rule is no shadow).
  const look = size === "dense" ? approvalActionToneClassName[tone].replace(` ${LIFT}`, "") : approvalActionToneClassName[tone];
  return [BASE, SIZE[size], look, extra].filter(Boolean).join(" ");
}

/** The words every approval screen uses for the same act. A module adds its own only where the act is
 *  its own ("Renew contract", "Approve for payroll"); the common verbs are these, everywhere. */
export const APPROVAL_ACTION_LABEL = {
  approve: "Approve",
  reject: "Reject",
  returnWithComment: "Return with comment",
  returnForEdit: "Return for edit",
  acknowledge: "Acknowledge (HR)",
  review: "Review",
  cancel: "Cancel",
  working: "Submitting…",
} as const;

/** The two buttons under every "are you sure" step. */
export function ApprovalConfirmButtons({
  busy,
  confirmLabel,
  disabled,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  confirmLabel: ReactNode;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy || disabled}
        className={approvalActionClassName("confirm", "regular", "flex-1 md:flex-none")}
      >
        {busy ? APPROVAL_ACTION_LABEL.working : confirmLabel}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className={approvalActionClassName("neutral", "regular", "flex-1 md:flex-none")}
      >
        {APPROVAL_ACTION_LABEL.cancel}
      </button>
    </div>
  );
}

/** The panel every decision sits in: the module's dark band titled "Your response", then the body. */
export function ApprovalResponsePanel({
  aside,
  children,
  panelRef,
  title = "Your response",
}: {
  aside?: ReactNode;
  children: ReactNode;
  panelRef?: Ref<HTMLElement>;
  title?: ReactNode;
}) {
  return (
    <section ref={panelRef} className={adminPanelClassName}>
      <header className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 ${adminPanelHeaderClassName}`}>
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}
