"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { useDialogA11y } from "@/components/ui/use-dialog-a11y";

/**
 * Modal chrome shared by this module's dialogs. Follows the repo's established shape (a portal
 * onto document.body plus useDialogA11y for the focus trap, ESC-to-close and return-focus, the
 * same as CvPreviewModal) so there is exactly one copy of it here.
 */
export function ResignationDialog({
  ariaLabel,
  children,
  footer,
  onClose,
  subtitle,
  title,
  width = "max-w-lg",
}: {
  ariaLabel: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  subtitle?: ReactNode;
  title: string;
  width?: string;
}) {
  const dialogRef = useDialogA11y<HTMLDivElement>({ onClose, open: true });

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[#020617]/65 p-4 backdrop-blur-sm">
      <div
        aria-label={ariaLabel}
        aria-modal="true"
        className={`flex max-h-[85vh] w-full ${width} flex-col overflow-hidden border border-[#D8E0EA] bg-white shadow-[0_28px_90px_rgba(15,23,42,0.3)]`}
        ref={dialogRef}
        role="dialog"
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-[#E2E8F0] px-5 py-3">
          <div className="min-w-0">
            <p className="whitespace-nowrap text-sm font-black text-slate-900">{title}</p>
            {subtitle ? (
              <div className="mt-0.5 text-xs font-semibold text-slate-500">{subtitle}</div>
            ) : null}
          </div>
          <button
            aria-label="Close"
            className="shrink-0 text-slate-400 transition hover:text-[#F97316]"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-[#E2E8F0] px-5 py-3">
          {footer}
        </div>
      </div>
    </div>,
    document.body,
  );
}
