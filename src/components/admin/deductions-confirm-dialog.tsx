"use client";

import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { adminPanelDepthClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import {
  phxButtonAccentClassName,
  phxButtonDangerClassName,
  phxButtonGhostClassName,
} from "@/components/ui/form-tokens";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { cn } from "@/lib/utils";

/**
 * The one "are you sure?" both deduction screens ask before an action that moves people's money or
 * tells them about it — Publish, Release, Withdraw. Until this, every one of those was a single click:
 * "Withdraw all" took a whole released snapshot back out of the employee portal with no prompt, and
 * "Release all" emailed every employee on the tally the moment it was pressed.
 *
 * The facts the action will commit are passed in as `facts` (the amount, the people, who is told), so
 * the prompt states the consequence in numbers rather than asking a bare "Continue?".
 */
export function DeductionsConfirmDialog({
  busy = false,
  children,
  confirmLabel,
  facts,
  onCancel,
  onConfirm,
  open,
  title,
  tone = "commit",
}: {
  busy?: boolean;
  children?: ReactNode;
  confirmLabel: string;
  facts?: Array<{ label: string; value: string }>;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
  /** "commit" for a release or a publish, "danger" for a withdraw. */
  tone?: "commit" | "danger";
}) {
  const dialogRef = useDialogA11y<HTMLDivElement>({ open, onClose: () => (busy ? undefined : onCancel()) });
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-4">
      <div
        aria-labelledby="deductions-confirm-title"
        aria-modal="true"
        className={cn("w-full max-w-lg border border-slate-200 bg-white", adminPanelDepthClassName)}
        ref={dialogRef}
        role="alertdialog"
      >
        <div className={cn("flex items-center gap-2 px-5 py-3", adminPanelHeaderClassName)}>
          <AlertTriangle className={cn("h-4 w-4 shrink-0", tone === "danger" ? "text-rose-300" : "text-orange-300")} />
          <h2 className="text-xs font-black uppercase tracking-[0.14em] text-white" id="deductions-confirm-title">
            {title}
          </h2>
        </div>
        <div className="space-y-3 px-5 py-4">
          {facts && facts.length > 0 ? (
            <dl className="grid grid-cols-1 gap-px border border-slate-200 bg-slate-200 sm:grid-cols-2">
              {facts.map((fact) => (
                <div className="bg-slate-50 px-3 py-2" key={fact.label}>
                  <dt className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-500">{fact.label}</dt>
                  <dd className="mt-0.5 break-words text-sm font-bold tabular-nums text-slate-900">{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {children ? <div className="space-y-2 text-sm leading-relaxed text-slate-700">{children}</div> : null}
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-3 sm:flex-row sm:justify-end">
          <button className={cn(phxButtonGhostClassName, "justify-center")} disabled={busy} onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className={cn(tone === "danger" ? phxButtonDangerClassName : phxButtonAccentClassName, "justify-center")}
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
