"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  ApprovalConfirmButtons,
  ApprovalResponsePanel,
  approvalActionClassName,
  approvalActionToneClassName,
  type ApprovalTone,
} from "@/components/approvals-hub/approval-action-kit";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

export type DecisionActionsProps = {
  // API endpoint that accepts { decision, [commentField] }.
  endpoint: string;
  // Field name for the reason/comment ("decisionComment" for leave, "comment" for excuse).
  commentField: "decisionComment" | "comment";
  // Which buttons are enabled for this viewer/step.
  actions: {
    approve?: boolean;
    reject?: boolean;
    return?: boolean;
    acknowledge?: boolean;
    overrideApprove?: boolean;
    overrideReject?: boolean;
  };
  /**
   * Offer a second, comment-free return beside the one that demands a comment. Vacation approvals
   * pass it (owner, 2026-10-08): "Return for edit" sends the request back with one click, and
   * "Return for edit with comment" makes the approver say what to fix. Everyone else keeps the one
   * return button whose comment is mandatory.
   */
  returnWithoutComment?: boolean;
  /**
   * Per-action label overrides. The vacation screen names the HR seat explicitly ("Reject as HR")
   * so the four buttons read as one set; excuses and weekly plans keep the plain verbs, because
   * their approvers are managers, not HR.
   */
  labelOverrides?: Partial<Record<Action, string>>;
  /**
   * Actions to keep VISIBLE while disabled, with the reason to print under them. The owner asked
   * to see all four vacation buttons at once (2026-09-10) rather than have one appear later:
   * an action with a reason here renders greyed instead of vanishing.
   */
  disabledReasons?: Partial<Record<Action, string | null>>;
  // Where to return after a successful decision.
  backHref: string;
  /** One line telling the admin what responding here does, before they commit to it. */
  overrideNotice?: string | null;
  /** Extra fields merged into the request body. Early Birds sends the candidate id so the server
   * can detect a stale tab and refuse, instead of deciding whichever rep happens to be current. */
  extraPayload?: Record<string, unknown>;
};

type Pending = "approve" | "reject" | "return" | "returnPlain" | "acknowledge" | "overrideApprove" | "overrideReject" | null;
type Action = Exclude<Pending, null>;

const LABEL: Record<Action, string> = {
  approve: "Approve",
  reject: "Reject",
  return: "Return with comment",
  returnPlain: "Return for edit",
  acknowledge: "Acknowledge (HR)",
  // The owner's wording, 2026-09-10: no button ever says "override", and none names the approver
  // who has not replied. The approval TRANSFERS; the System Administrator answers.
  overrideApprove: "Approve as System Administrator",
  overrideReject: "Reject as System Administrator",
};

const REASON_REQUIRED: Record<Action, boolean> = {
  approve: false,
  reject: true,
  return: true,
  returnPlain: false,
  acknowledge: false,
  // Approve stays one click by design — the server writes the override sentence itself. A
  // rejection still has to say why, because the employee reads it.
  overrideApprove: false,
  overrideReject: true,
};

// The API decision token for each action (acknowledge is an HR approve).
const DECISION_TOKEN: Record<Action, string> = {
  approve: "approve",
  reject: "reject",
  return: "return",
  returnPlain: "return",
  acknowledge: "approve",
  overrideApprove: "approve",
  overrideReject: "reject",
};

// The two that decide a stalled approver's step instead of the caller's own.
const IS_OVERRIDE: Record<Action, boolean> = {
  approve: false,
  reject: false,
  return: false,
  returnPlain: false,
  acknowledge: false,
  overrideApprove: true,
  overrideReject: true,
};

export function DecisionActions({
  endpoint,
  commentField,
  actions,
  backHref,
  extraPayload,
  returnWithoutComment,
  labelOverrides,
  disabledReasons,
  overrideNotice,
}: DecisionActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The sticky mobile bar portals to document.body, so it must not render on the server.
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // The one legitimate use of this pattern: a portal target only exists in the browser, so the
    // flag must flip exactly once after hydration. (The portal twin that carried the same disable,
    // direct-order-portal-detail.tsx, was retired 2026-08-10 — this component is now the only
    // approval surface in either shell.)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  // Overrides sit last: they are the exception, and the ordinary buttons must stay where the
  // muscle memory expects them.
  const ordered = [
    ["approve", actions.approve],
    ["acknowledge", actions.acknowledge],
    ["returnPlain", actions.return && returnWithoutComment],
    ["return", actions.return],
    ["reject", actions.reject],
    ["overrideApprove", actions.overrideApprove],
    ["overrideReject", actions.overrideReject],
  ] as Array<[Action, boolean | undefined]>;

  const available = ordered.filter(([, on]) => on);
  // Shown but not clickable: the caller supplied a reason for an action that is off. Nothing is
  // greyed unless the caller asked for it, so excuses and weekly plans are untouched.
  const shownDisabled = ordered
    .filter(([action, on]) => !on && Boolean(disabledReasons?.[action]))
    .map(([action]) => [action, String(disabledReasons?.[action])] as [Action, string]);

  if (available.length === 0 && shownDisabled.length === 0) return null;

  const labelFor = (action: Action) => labelOverrides?.[action] ?? LABEL[action];

  function start(action: Exclude<Pending, null>) {
    setError(null);
    // Tapping the sticky bar must not strand the confirm prompt (and the mandatory reason box)
    // above the fold — the bar is pinned to the bottom, the panel is in the page.
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setReason("");
    setPending(action);
  }

  async function confirm() {
    if (!pending) return;
    if (REASON_REQUIRED[pending] && !reason.trim()) {
      setError("A reason is required for this action.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...extraPayload,
          decision: DECISION_TOKEN[pending],
          // Only ever sent by the two override buttons. The server re-checks Super Admin and the
          // elapsed wait, so this flag asks for the override — it does not grant it.
          ...(IS_OVERRIDE[pending] ? { override: true } : {}),
          [commentField]: reason.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "This request could not be updated. It may have already been decided.");
        setBusy(false);
        return;
      }
      // Success — leave the request and return to the list; the item moves to history.
      router.push(backHref);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      setBusy(false);
    }
  }

  // The look comes from the one approvals interface (REC-032), so this panel, the plan panels, the
  // Action Center row and the expense queue draw the same act the same way.
  const tone: Record<Action, ApprovalTone> = {
    approve: "approve",
    acknowledge: "acknowledge",
    return: "return",
    returnPlain: "return",
    reject: "reject",
    // Outlined, not filled: an override must never be the button a tired thumb reaches for first.
    overrideApprove: "override",
    overrideReject: "overrideQuiet",
  };

  return (
    <>
    <ApprovalResponsePanel panelRef={panelRef}>
      <div className="px-4 py-4">
        {pending === null ? (
          <div className="flex flex-wrap gap-2">
            {available.map(([action]) => (
              <button
                key={action}
                type="button"
                onClick={() => start(action)}
                // The regular size is h-11, the 44px accessibility floor. This is the screen where
                // money moves, reached after eight sections of evidence, often on a phone.
                className={approvalActionClassName(tone[action], "regular", "flex-1 md:flex-none")}
              >
                {labelFor(action)}
              </button>
            ))}
            {shownDisabled.map(([action, reason]) => (
              // Present, obviously off, and saying why. `title` is not enough — this is read on a
              // phone, where there is no hover.
              <div key={`off-${action}`} className="w-full md:w-auto">
                <button
                  type="button"
                  disabled
                  className={approvalActionClassName("neutral", "regular", "w-full md:w-auto")}
                >
                  {labelFor(action)}
                </button>
                <p className="mt-1 text-phx-xs font-semibold text-slate-500">{reason}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-bold text-slate-900">
              {REASON_REQUIRED[pending]
                ? `${labelFor(pending)} — provide a reason`
                : IS_OVERRIDE[pending] || pending === "returnPlain"
                  // "Approve as System Administrator this request?" does not parse — the label
                  // already carries the object, so the override heading drops the trailing noun.
                  // "Return for edit" is the same shape: it names the act, not the thing returned.
                  ? `Confirm: ${labelFor(pending)}?`
                  : `Confirm: ${labelFor(pending)} this request?`}
            </p>
            {IS_OVERRIDE[pending] && overrideNotice ? (
              <p className="border border-slate-900 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900 shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)]">
                {overrideNotice}
              </p>
            ) : null}
            {REASON_REQUIRED[pending] ? (
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Type the reason the employee will see…"
                // The shared textarea token plus the ONE override this screen keeps: 16px on
                // mobile, because iOS Safari zooms the whole viewport when it focuses a field
                // under 16px, and this is the screen where money moves. The token's own
                // `text-sm` is 14px, so `md:text-sm` hands the design back from the md breakpoint
                // up. It goes through `cn()`, never a template literal — a template would ship
                // both sizes and let the stylesheet decide.
                className={cn(phxTextareaClassName, "text-base md:text-sm")}
              />
            ) : null}
            {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
            <ApprovalConfirmButtons
              busy={busy}
              confirmLabel={`Confirm ${LABEL[pending].split(" ")[0]}`}
              onConfirm={confirm}
              onCancel={() => {
                setPending(null);
                setError(null);
              }}
            />
          </div>
        )}
        {error && pending === null ? <p className="mt-3 text-sm font-semibold text-rose-600">{error}</p> : null}
      </div>
    </ApprovalResponsePanel>

    {/* The thumb bar. A decision reached after eight sections of evidence should not require
        scrolling back to find the buttons. Hidden once a decision is pending, because the confirm
        prompt and its mandatory reason box live in the panel above.

        `bottom: env(safe-area-inset-bottom)` with NO extra offset: the portal twin adds 56px to
        clear the employee bottom nav, and the admin shell has no bottom nav — copying that number
        would float this bar above nothing. */}
    {mounted && pending === null
      ? createPortal(
          <div
            // flex-wrap, not a squashed single row: "Approve as System Administrator" beside two
            // more labels cannot fit 375px on one line, and the golden rule says WRAP rather than
            // shrink the type or let it scroll sideways. basis-[48%] puts them two per row.
            className="fixed inset-x-0 z-30 flex flex-wrap gap-2 border-t border-slate-200 bg-white/95 px-4 pb-3 pt-3 shadow-[0_-8px_24px_rgba(15,23,42,0.1)] backdrop-blur md:hidden"
            style={{ bottom: "env(safe-area-inset-bottom)" }}
          >
            {available.map(([action]) => (
              <button
                key={`bar-${action}`}
                type="button"
                onClick={() => start(action)}
                // Wrapping is driven by min-width, NOT flex-basis. `basis-*` and `flex-1` set the
                // same shorthand, so which one wins depends on Tailwind's rule order rather than
                // on anything written here — and the repo build need not order them like the CDN
                // one this was measured against. A min-width cannot conflict: two buttons fit a
                // 375px row, three cannot, so they wrap. It also keeps `h-12 flex-1` contiguous,
                // which tests/direct-orders-approval-window-mobile.test.ts pins as the thumb size.
                className={`inline-flex items-center justify-center h-12 flex-1 min-w-[9rem] px-2 text-center text-sm font-bold transition-colors ${approvalActionToneClassName[tone[action]]}`}
              >
                {labelFor(action)}
              </button>
            ))}
          </div>,
          document.body,
        )
      : null}
    </>
  );
}
