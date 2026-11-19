"use client";

import { Calculator } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { preloadPanel, preloadWhenIdle, TopbarPanelLoadFailed } from "@/components/layout/lazy-topbar-panel";
import { cn } from "@/lib/utils";

/**
 * The topbar desk calculator's BUTTON. The panel itself — the keypad, the arithmetic engine, the
 * drag and the clipboard handling — is calculator-panel.tsx, loaded the first time it is needed
 * and never with the page (lazy-topbar-panel.tsx says why and how). Everything that keeps it
 * non-blocking is written there, beside the code it describes.
 */

const loadCalculatorPanel = () => import("@/components/layout/calculator-panel");

type CalculatorPanelProps = { isAdminMode: boolean; onClose: () => void; open: boolean };

/** A failed load (a tab left open across a deploy) shows where the panel would have, never as a page error. */
function CalculatorLoadFailed({ isAdminMode, open }: CalculatorPanelProps) {
  if (!open) return null;
  return createPortal(
    <div
      aria-label="Calculator"
      className={cn(
        "fixed right-6 top-24 z-50 w-72 overflow-hidden rounded-xl border shadow-[0_24px_60px_rgba(0,0,0,0.35)]",
        isAdminMode ? "border-[#333333] bg-[#050505]" : "border-phx-line bg-white",
      )}
      role="dialog"
    >
      <TopbarPanelLoadFailed isAdminMode={isAdminMode} />
    </div>,
    document.body,
  );
}

const CalculatorPanel = dynamic<CalculatorPanelProps>(
  () =>
    loadCalculatorPanel()
      .then((mod) => mod.CalculatorPanel)
      .catch(() => CalculatorLoadFailed),
  // Nothing while it loads: the button is already drawn pressed, and the idle preload means the
  // code is almost always there before the click.
  { loading: () => null, ssr: false },
);

export function CalculatorWidget({ isAdminMode }: { isAdminMode: boolean }) {
  const [open, setOpen] = useState(false);
  // The panel mounts on the first open and then STAYS mounted, rendering nothing while closed, so
  // what was on the display is still there next time, exactly as when the whole calculator lived
  // in this component.
  const [opened, setOpened] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => preloadWhenIdle(loadCalculatorPanel), []);

  return (
    <>
      <button
        aria-expanded={open}
        aria-label="Calculator"
        className={cn(
          "relative inline-flex h-9 w-9 items-center justify-center rounded",
          isAdminMode
            ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]"
            : "text-phx-ink-soft hover:bg-phx-paper hover:text-phx-ink",
          open ? (isAdminMode ? "bg-[#1a1a1a] text-[#F8B56B]" : "bg-phx-paper text-phx-ink") : "",
        )}
        onClick={() => {
          setOpened(true);
          setOpen((current) => !current);
        }}
        onFocus={() => preloadPanel(loadCalculatorPanel)}
        onPointerEnter={() => preloadPanel(loadCalculatorPanel)}
        title="Calculator"
        type="button"
      >
        <Calculator className="h-[18px] w-[18px]" />
      </button>
      {opened ? <CalculatorPanel isAdminMode={isAdminMode} onClose={close} open={open} /> : null}
    </>
  );
}
