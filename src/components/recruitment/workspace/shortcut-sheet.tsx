"use client";

// Recruitment workspace — the "?" sheet: every key the workspace answers to, on one card.
//
// The keys only act when the focus is NOT in a field, so typing a name in the search box never
// shortlists anybody. Esc closes this sheet, then the opened CV.

import { Keyboard, X } from "lucide-react";
import { createPortal } from "react-dom";

import { adminPanelDepthClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import { cn } from "@/lib/utils";

export const WORKSPACE_SHORTCUTS: ReadonlyArray<{ keys: string[]; does: string }> = [
  { does: "Open the next CV", keys: ["↓", "J"] },
  { does: "Open the previous CV", keys: ["↑", "K"] },
  { does: "Close the opened CV", keys: ["Esc"] },
  { does: "Tick or untick the opened CV", keys: ["X"] },
  { does: "Shortlist the opened CV", keys: ["S"] },
  { does: "Move the opened CV to Back-up", keys: ["B"] },
  { does: "Reject the opened CV (asks why)", keys: ["R"] },
  { does: "Send the opened CV to a manager", keys: ["M"] },
  { does: "Undo the last decision", keys: ["U"] },
  { does: "Search every tab", keys: ["/"] },
  { does: "Show this sheet", keys: ["?"] },
];

function Key({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-7 items-center justify-center border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-xs font-bold text-slate-800 shadow-[0_1px_0_rgba(15,23,42,0.12)]">
      {children}
    </kbd>
  );
}

export function ShortcutSheet({ onClose, open }: { onClose: () => void; open: boolean }) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      aria-labelledby="ws-shortcuts-title"
      aria-modal="true"
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-slate-950/40 p-4 pt-[10vh]"
      onClick={onClose}
      role="dialog"
    >
      <div
        className={`w-full max-w-md border border-slate-200 bg-white ${adminPanelDepthClassName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={cn("flex items-center justify-between gap-3 px-4 py-3 text-white", adminPanelHeaderClassName)}>
          <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.12em]" id="ws-shortcuts-title">
            <Keyboard aria-hidden className="h-4 w-4 text-orange-300" />
            Keyboard shortcuts
          </h2>
          <button aria-label="Close" className="p-1 text-slate-300 transition hover:text-white" onClick={onClose} type="button">
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
        <ul className="divide-y divide-slate-100 px-4 py-2">
          {WORKSPACE_SHORTCUTS.map((shortcut) => (
            <li className="flex items-center justify-between gap-3 py-2" key={shortcut.does}>
              <span className="text-sm font-semibold text-slate-700">{shortcut.does}</span>
              <span className="flex shrink-0 items-center gap-1">
                {shortcut.keys.map((key) => (
                  <Key key={key}>{key}</Key>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <p className="border-t border-slate-100 px-4 py-2.5 text-xs font-medium text-slate-500">
          The keys work when you are not typing in a field.
        </p>
      </div>
    </div>,
    document.body,
  );
}
