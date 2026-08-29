"use client";

import { Calculator, Check, ClipboardPaste, Copy, GripVertical, X } from "lucide-react";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { sanitizePastedNumber } from "@/lib/calculator/decimal";
import {
  calculatorActionForKey,
  calculatorDisplayText,
  calculatorReducer,
  createCalculatorState,
  type CalculatorAction,
} from "@/lib/calculator/engine";
import { cn } from "@/lib/utils";

/**
 * The topbar desk calculator.
 *
 * THREE THINGS MAKE THIS NON-BLOCKING, and each is deliberate — remove any one and it becomes an
 * ordinary modal that stops the owner working:
 *
 *  1. It renders through a PORTAL to `document.body`. The topbar sits inside a `sticky` wrapper
 *     that also carries `backdrop-blur-xl`, and a backdrop-filter establishes a containing block
 *     for `position: fixed` descendants — a panel left inside the header would be trapped by the
 *     chrome and clipped by its stacking context, not free over the page.
 *  2. There is NO backdrop element. Every pixel outside the panel belongs to the page, so a click
 *     anywhere lands where it always did.
 *  3. NOTHING listens on `document`. Keys are handled on the panel's own subtree only, so typing
 *     in a form behind the calculator is untouched — and the panel deliberately does NOT close on
 *     an outside click, because working outside it while it stays open is the entire point.
 */

const PANEL_WIDTH = 288;
const PANEL_MARGIN = 12;
/** Enough of the panel to always stay grabbable, however the viewport is resized. */
const MIN_VISIBLE_HEIGHT = 48;
const POSITION_STORAGE_KEY = "phoenix.calculator.position";

type PanelPosition = { left: number; top: number };

function clampPosition(position: PanelPosition, height: number): PanelPosition {
  const maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - PANEL_WIDTH - PANEL_MARGIN);
  const maxTop = Math.max(PANEL_MARGIN, window.innerHeight - Math.max(height, MIN_VISIBLE_HEIGHT) - PANEL_MARGIN);
  return {
    left: Math.min(Math.max(position.left, PANEL_MARGIN), maxLeft),
    top: Math.min(Math.max(position.top, PANEL_MARGIN), maxTop),
  };
}

/** Where it lands the very first time: under the topbar, on the right, clear of the page body. */
function defaultPosition(): PanelPosition {
  return clampPosition({ left: window.innerWidth - PANEL_WIDTH - 24, top: 96 }, 0);
}

function readStoredPosition(): PanelPosition | null {
  try {
    const raw = window.localStorage.getItem(POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { left, top } = parsed as { left?: unknown; top?: unknown };
    if (typeof left !== "number" || typeof top !== "number") return null;
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return clampPosition({ left, top }, 0);
  } catch {
    // A blocked or full localStorage must never cost the owner his calculator.
    return null;
  }
}

/**
 * Copies without depending on the async Clipboard API alone — that one needs a secure context, and
 * this app is reached over plain http on the LAN often enough to matter.
 */
async function copyPlainText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const carrier = document.createElement("textarea");
    carrier.value = value;
    carrier.setAttribute("readonly", "");
    carrier.style.position = "fixed";
    carrier.style.opacity = "0";
    document.body.appendChild(carrier);
    carrier.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(carrier);
    return copied;
  } catch {
    return false;
  }
}

type KeyKind = "accent" | "digit" | "operator" | "utility";

type KeypadKey = {
  action: CalculatorAction;
  kind: KeyKind;
  label: string;
  title?: string;
};

const KEYPAD: KeypadKey[] = [
  { action: { type: "clear-all" }, kind: "utility", label: "C", title: "Clear everything (C)" },
  { action: { type: "backspace" }, kind: "utility", label: "⌫", title: "Backspace" },
  { action: { type: "percent" }, kind: "utility", label: "%", title: "Percent" },
  { action: { operator: "÷", type: "operator" }, kind: "operator", label: "÷", title: "Divide (/)" },

  { action: { digit: "7", type: "digit" }, kind: "digit", label: "7" },
  { action: { digit: "8", type: "digit" }, kind: "digit", label: "8" },
  { action: { digit: "9", type: "digit" }, kind: "digit", label: "9" },
  { action: { operator: "×", type: "operator" }, kind: "operator", label: "×", title: "Multiply (*)" },

  { action: { digit: "4", type: "digit" }, kind: "digit", label: "4" },
  { action: { digit: "5", type: "digit" }, kind: "digit", label: "5" },
  { action: { digit: "6", type: "digit" }, kind: "digit", label: "6" },
  { action: { operator: "-", type: "operator" }, kind: "operator", label: "−", title: "Subtract (-)" },

  { action: { digit: "1", type: "digit" }, kind: "digit", label: "1" },
  { action: { digit: "2", type: "digit" }, kind: "digit", label: "2" },
  { action: { digit: "3", type: "digit" }, kind: "digit", label: "3" },
  { action: { operator: "+", type: "operator" }, kind: "operator", label: "+", title: "Add (+)" },

  { action: { type: "negate" }, kind: "utility", label: "±", title: "Change sign (F9)" },
  { action: { digit: "0", type: "digit" }, kind: "digit", label: "0" },
  { action: { type: "decimal-point" }, kind: "digit", label: ".", title: "Decimal point" },
  { action: { type: "equals" }, kind: "accent", label: "=", title: "Equals (Enter)" },
];

const MEMORY_KEYS: Array<{ action: CalculatorAction; label: string; title: string }> = [
  { action: { op: "clear", type: "memory" }, label: "MC", title: "Memory clear" },
  { action: { op: "recall", type: "memory" }, label: "MR", title: "Memory recall" },
  { action: { op: "add", type: "memory" }, label: "M+", title: "Add the display to memory" },
  { action: { op: "subtract", type: "memory" }, label: "M−", title: "Subtract the display from memory" },
];

export function CalculatorWidget({ isAdminMode }: { isAdminMode: boolean }) {
  const [state, dispatch] = useReducer(calculatorReducer, undefined, createCalculatorState);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [showTape, setShowTape] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  /** Mirrors `position` so the drag handlers can persist it without a side effect in an updater. */
  const positionRef = useRef<PanelPosition | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const hintTimerRef = useRef<number | null>(null);

  // Position is resolved in the CLICK handler, never in an effect — reading `window` during render
  // or hydration is what makes a portal panel flash in the wrong corner on first open.
  const toggleOpen = useCallback(() => {
    if (open) {
      setOpen(false);
      return;
    }
    if (!positionRef.current) {
      const resolved = readStoredPosition() ?? defaultPosition();
      positionRef.current = resolved;
      setPosition(resolved);
    }
    setOpen(true);
  }, [open]);

  const focusOnMount = useCallback((node: HTMLInputElement | null) => {
    // Focus once, when the panel mounts — the owner just clicked the icon, so he wants to type.
    // It is never re-focused after that, so it cannot steal focus back from the page.
    node?.focus();
    node?.select();
  }, []);

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current);
  }, []);

  // Keeps the panel reachable when the window is resized under it. The listener is on `window`,
  // fires only on resize, and touches nothing the page does.
  useEffect(() => {
    if (!open) return;
    function handleResize() {
      const current = positionRef.current;
      if (!current) return;
      const next = clampPosition(current, panelRef.current?.offsetHeight ?? 0);
      positionRef.current = next;
      setPosition(next);
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [open]);

  const flashHint = useCallback((message: string) => {
    setHint(message);
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = window.setTimeout(() => setHint(null), 2200);
  }, []);

  const persistPosition = useCallback((next: PanelPosition) => {
    try {
      window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Not being able to remember where it sat is not worth an error.
    }
  }, []);

  const handleCopy = useCallback(async () => {
    if (state.error) {
      flashHint("Nothing to copy yet.");
      return;
    }
    // The RAW value, never the grouped one — "1,234.56" pasted into a numeric field is not a number.
    const ok = await copyPlainText(state.entry);
    if (!ok) {
      flashHint("Couldn't reach the clipboard.");
      return;
    }
    setCopied(true);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1300);
  }, [flashHint, state.entry, state.error]);

  const handlePasteButton = useCallback(async () => {
    try {
      const text = await navigator.clipboard?.readText?.();
      const clean = text ? sanitizePastedNumber(text) : null;
      if (!clean) {
        flashHint(text ? "That isn't a number I can read." : "Press Ctrl+V in the display.");
        return;
      }
      dispatch({ text: clean, type: "paste" });
    } catch {
      // Reading the clipboard needs a permission the browser may refuse. Ctrl+V always works.
      flashHint("Press Ctrl+V in the display.");
    }
  }, [flashHint]);

  const handleDragStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // The copy/paste/close buttons live INSIDE this header. setPointerCapture below retargets the
    // pointerup to the header, and the browser then fires `click` on the common ancestor of the
    // down and up targets — the header, not the button. So capturing a press that began on a
    // control silently eats that control's click: the button takes focus and nothing happens.
    // Measured in the browser on 2026-08-29 — copy, paste and close were all dead to a real mouse
    // while still working from a scripted .click(), which is exactly how this hid.
    if ((event.target as HTMLElement | null)?.closest("button")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  }, []);

  const handleDragMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const offset = dragOffsetRef.current;
    if (!offset) return;
    event.preventDefault();
    const next = clampPosition(
      { left: event.clientX - offset.x, top: event.clientY - offset.y },
      panelRef.current?.offsetHeight ?? 0,
    );
    positionRef.current = next;
    setPosition(next);
  }, []);

  const handleDragEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragOffsetRef.current) return;
    dragOffsetRef.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (positionRef.current) persistPosition(positionRef.current);
  }, [persistPosition]);

  /**
   * Every key press inside the panel is decided here and nowhere else. Copy, paste and select-all
   * are handed straight back to the browser; Tab still moves focus out; everything the calculator
   * does not claim is swallowed so the display can never hold something that is not a number.
   */
  const handleDisplayKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Tab") return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    const action = calculatorActionForKey(event.key);
    event.preventDefault();
    if (action) dispatch(action);
  }, []);

  const handleDisplayPaste = useCallback((event: ReactClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    const clean = sanitizePastedNumber(text);
    if (!clean) {
      flashHint("That isn't a number I can read.");
      return;
    }
    dispatch({ text: clean, type: "paste" });
  }, [flashHint]);

  const handleDisplayCopy = useCallback((event: ReactClipboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const wholeValue = input.selectionStart === null
      || (input.selectionStart === 0 && input.selectionEnd === input.value.length)
      || input.selectionStart === input.selectionEnd;
    if (!wholeValue || state.error) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", state.entry);
  }, [state.entry, state.error]);

  const tone = {
    accentKey: isAdminMode
      ? "bg-[#F8B56B] text-[#1a1200] hover:bg-[#ffc98c]"
      : "bg-phx-accent text-white hover:brightness-110",
    bg: isAdminMode ? "bg-[#050505]" : "bg-white",
    border: isAdminMode ? "border-[#333333]" : "border-phx-line",
    digitKey: isAdminMode
      ? "border-[#2a2a2a] bg-[#111111] text-white hover:bg-[#1c1c1c]"
      : "border-phx-line bg-white text-phx-ink hover:bg-phx-paper",
    handle: isAdminMode ? "bg-[#0B0B0B]" : "bg-[#FCFDFE]",
    muted: isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft",
    operatorKey: isAdminMode
      ? "border-[#3a2c1a] bg-[#181206] text-[#F8B56B] hover:bg-[#221808]"
      : "border-phx-accent-line bg-[#FFF7EE] text-phx-accent hover:bg-[#FFEFDF]",
    screen: isAdminMode ? "bg-[#0B0B0B]" : "bg-[#FCFDFE]",
    title: isAdminMode ? "text-white" : "text-phx-ink",
    utilityKey: isAdminMode
      ? "border-[#2a2a2a] bg-[#0d0d0d] text-phx-line-strong hover:bg-[#181818]"
      : "border-phx-line bg-phx-paper text-phx-ink-2 hover:bg-[#EEF2F7]",
  };

  const keyClassName = (kind: KeyKind) => {
    if (kind === "accent") return tone.accentKey;
    if (kind === "operator") return tone.operatorKey;
    if (kind === "utility") return tone.utilityKey;
    return tone.digitKey;
  };

  const panel = open && position ? createPortal(
    <div
      aria-label="Calculator"
      className={cn(
        "fixed z-50 w-72 select-none overflow-hidden rounded-xl border shadow-[0_24px_60px_rgba(0,0,0,0.35)]",
        tone.border,
        tone.bg,
      )}
      ref={panelRef}
      role="dialog"
      style={{ left: position.left, top: position.top }}
    >
      {/* Drag handle. `touch-none` so a finger drag moves the panel instead of scrolling the page. */}
      <div
        className={cn(
          "flex touch-none items-center gap-1.5 border-b px-2 py-1.5",
          tone.border,
          tone.handle,
          dragging ? "cursor-grabbing" : "cursor-grab",
        )}
        onPointerCancel={handleDragEnd}
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
      >
        <GripVertical className={cn("h-4 w-4 shrink-0", tone.muted)} />
        <p className={cn("text-[12px] font-black leading-none", tone.title)}>Calculator</p>
        {state.memory !== null ? (
          <span
            className={cn(
              "ml-1 shrink-0 rounded px-1 py-0.5 text-[10px] font-bold leading-none",
              isAdminMode ? "bg-[#181206] text-[#F8B56B]" : "bg-[#FFF7EE] text-phx-accent",
            )}
            title={`In memory: ${state.memory}`}
          >
            M
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 cursor-default items-center gap-1">
          <button
            aria-label="Paste a number into the calculator"
            className={cn("inline-flex h-6 w-6 items-center justify-center rounded", tone.muted, isAdminMode ? "hover:bg-[#1a1a1a]" : "hover:bg-phx-paper")}
            onClick={() => void handlePasteButton()}
            title="Paste (Ctrl+V also works in the display)"
            type="button"
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
          </button>
          <button
            aria-label="Copy the result"
            className={cn("inline-flex h-6 w-6 items-center justify-center rounded", tone.muted, isAdminMode ? "hover:bg-[#1a1a1a]" : "hover:bg-phx-paper")}
            onClick={() => void handleCopy()}
            title="Copy the result"
            type="button"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <button
            aria-label="Close the calculator"
            className={cn("inline-flex h-6 w-6 items-center justify-center rounded", tone.muted, isAdminMode ? "hover:bg-[#1a1a1a]" : "hover:bg-phx-paper")}
            onClick={() => setOpen(false)}
            title="Close"
            type="button"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className={cn("border-b px-2.5 py-2", tone.border, tone.screen)}>
        {/* No truncation and no wrapping anywhere on the display: a long number scrolls sideways,
            because an ellipsised or wrapped figure is a figure somebody misreads. */}
        <p className={cn("h-4 overflow-x-auto whitespace-nowrap text-right text-[11px] leading-4", tone.muted)}>
          {state.expression}
        </p>
        <input
          aria-label="Calculator display"
          className={cn(
            "w-full bg-transparent text-right text-[22px] font-black leading-tight outline-none",
            state.error ? "text-[13px] font-bold text-red-500" : tone.title,
          )}
          inputMode="decimal"
          onChange={(event) => {
            // Reached only by a drop or an IME commit — every keystroke and paste is intercepted
            // above. Sanitising here keeps the display from ever holding a non-number.
            const clean = sanitizePastedNumber(event.target.value);
            if (clean) dispatch({ text: clean, type: "paste" });
          }}
          onCopy={handleDisplayCopy}
          onKeyDown={handleDisplayKeyDown}
          onPaste={handleDisplayPaste}
          ref={focusOnMount}
          spellCheck={false}
          value={calculatorDisplayText(state)}
        />
      </div>

      <div className="px-2 pb-2 pt-2">
        <div className="mb-1.5 grid grid-cols-4 gap-1">
          {MEMORY_KEYS.map((key) => (
            <button
              className={cn(
                "h-6 rounded border text-[11px] font-bold leading-none transition",
                tone.utilityKey,
                key.label === "MR" && state.memory === null ? "opacity-40" : "",
              )}
              key={key.label}
              onClick={() => dispatch(key.action)}
              title={key.title}
              type="button"
            >
              {key.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-4 gap-1">
          {KEYPAD.map((key) => (
            <button
              className={cn(
                "h-9 rounded border text-[15px] font-bold leading-none transition active:translate-y-px",
                keyClassName(key.kind),
                key.kind === "accent" ? "border-transparent" : "",
              )}
              key={key.label}
              onClick={() => dispatch(key.action)}
              title={key.title}
              type="button"
            >
              {key.label}
            </button>
          ))}
        </div>

        <div className="mt-1.5 flex items-center gap-2">
          <button
            className={cn("text-[11px] font-semibold leading-none underline-offset-2 hover:underline", tone.muted)}
            onClick={() => setShowTape((current) => !current)}
            type="button"
          >
            {showTape ? "Hide tape" : `Tape (${state.history.length})`}
          </button>
          <p className={cn("ml-auto whitespace-nowrap text-[10px] leading-none", tone.muted)}>
            {hint ?? "Type here · Ctrl+C / Ctrl+V"}
          </p>
        </div>

        {showTape ? (
          <div className={cn("mt-1.5 max-h-32 overflow-y-auto rounded border", tone.border)}>
            {state.history.length === 0 ? (
              <p className={cn("px-2 py-2 text-[11px] leading-none", tone.muted)}>Nothing calculated yet.</p>
            ) : (
              state.history.map((item) => (
                <button
                  className={cn(
                    "flex w-full items-baseline gap-2 border-b px-2 py-1 text-left last:border-b-0",
                    tone.border,
                    isAdminMode ? "hover:bg-[#111111]" : "hover:bg-phx-paper",
                  )}
                  key={item.id}
                  onClick={() => dispatch({ type: "recall-history", value: item.result })}
                  title="Load this result into the display"
                  type="button"
                >
                  <span className={cn("overflow-x-auto whitespace-nowrap text-[10px] leading-4", tone.muted)}>
                    {item.expression}
                  </span>
                  <span className={cn("ml-auto whitespace-nowrap text-[12px] font-bold leading-4", tone.title)}>
                    {item.result}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  ) : null;

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
        onClick={toggleOpen}
        title="Calculator"
        type="button"
      >
        <Calculator className="h-[18px] w-[18px]" />
      </button>
      {panel}
    </>
  );
}
