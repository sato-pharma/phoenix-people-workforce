"use client";

import { phxButtonGhostClassName } from "@/components/ui/form-tokens";

/** The print page's one button; hidden on the paper itself. */
export function ReceiptPrintButton() {
  return (
    <button className={`${phxButtonGhostClassName} print:hidden`} onClick={() => window.print()} type="button">
      Print
    </button>
  );
}
