"use client";

// The paper, on screen, editable where it is printed.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. The fill screen above collects values into labelled boxes and a separate tab
// prints the result, and on 2026-08-31 the owner said what is wrong with that: "what I want is that
// the form being printed appear to me and be as it will be printed, and in this screen I can edit
// any text I want — not only through fields but on the paper itself."
//
// Two complaints sit inside that, and they are the same complaint. A form field named "Qualification"
// does not tell you WHERE that word lands, so nobody can tell a filled document from a wrong one
// without printing it; and when a value did print wrongly, the only way back was to hunt for the box
// that fed it. Both go away if the document itself is the editing surface.
//
// THE PREVIEW IS THE PRINT, BYTE FOR BYTE. It is the same route, the same renderer, the same HTML —
// `preview=1` changes exactly one thing, whether the document is stamped as printed. A preview
// rendered by a second path would be a different document that happens to look similar, and
// "the screen disagreed with the paper" is the defect being fixed, not a detail.
//
// AND EVERY SAVE RELOADS FROM THE SERVER. Nothing is patched optimistically into the page. What
// appears after an edit is what the server would now print, fetched fresh — so the owner's original
// report, that he edited and saved and the print still showed the value from before, cannot be true
// of this screen without being visible on it immediately.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { AlertTriangle, Check, Loader2, Lock, PencilLine, Printer, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  buildPaperEditPatch,
  paperFieldBinding,
  paperFieldCurrentValue,
  paperStoreEndpoint,
  stripDirectionMarks,
  type PaperFieldBinding,
} from "@/lib/hiring-pack/paper-fields";
import {
  DEFAULT_ZOOM,
  fitZoomForWidth,
  PAGE_HEIGHT_PX,
  PAGE_WIDTH_PX,
} from "@/lib/hiring-pack/paper-zoom";
import type { HiringPackData, HiringPackDocument } from "@/lib/hiring-pack/types";

/**
 * Turn "type anywhere" on or off inside the framed document.
 *
 * Plain DOM work on a document this component owns, kept out of the component so it can be called
 * from both places that legitimately know about the change: the load handler, which re-applies it to
 * a freshly rendered page, and the toggle itself.
 */
function applyFreeEdit(doc: Document, on: boolean): void {
  if (!doc.body) return;
  doc.body.classList.toggle("hp-free-edit", on);
  if (on) {
    doc.body.contentEditable = "true";
    return;
  }
  // Setting it to "false" is not the same as removing it: the whole body still reads as one editable
  // region to the accessibility tree, announced to a screen reader as a text field the size of a
  // contract.
  doc.body.removeAttribute("contenteditable");
}


/**
 * What the page looks like while it is being worked on, and never on paper.
 *
 * Wrapped in `@media screen` throughout, so none of it can reach a printer. The document's own
 * stylesheet is untouched — this is appended to its head after load, which means an editing
 * affordance can never be the reason a printed page differs from the preview.
 */
const EDITOR_CSS = `
@media screen {
  /* The document's own print banner. This panel has its own controls, and two Print buttons on one
     screen is how somebody prints from the wrong one. */
  .print-banner { display: none !important; }

  [data-hp-live] {
    outline: 1px dashed rgba(37, 99, 235, 0.45);
    outline-offset: 2px;
    border-radius: 2px;
    cursor: text;
    transition: background-color 120ms ease, outline-color 120ms ease;
  }
  [data-hp-live]:hover { background-color: rgba(37, 99, 235, 0.12); }
  [data-hp-live]:focus {
    outline: 2px solid #2563eb;
    background-color: rgba(37, 99, 235, 0.16);
  }
  [data-hp-selected] {
    outline: 2px solid #2563eb !important;
    background-color: rgba(37, 99, 235, 0.2) !important;
  }
  [data-hp-saving] {
    outline: 2px solid #f59e0b !important;
    background-color: rgba(245, 158, 11, 0.2) !important;
  }
  /* A value the page prints but nothing can store — the company's own registry numbers, a figure
     derived from another one. Marked as locked rather than left looking ordinary, so it is obvious
     WHY it will not take a keystroke. */
  [data-hp-locked] { cursor: not-allowed; }
  [data-hp-locked]:hover { background-color: rgba(100, 116, 139, 0.16); }

  body.hp-free-edit [data-hp-locked] {
    outline: 1px dashed rgba(217, 119, 6, 0.6);
    outline-offset: 2px;
    cursor: text;
  }
  body.hp-free-edit { caret-color: #b45309; }
}
`;

type PaperEditorProps = {
  hrId: string;
  documentKey: HiringPackDocument;
  documentLabel: string;
  copies: number;
  versionId?: string | null;
  pack: HiringPackData;
  onPackChange: (pack: HiringPackData) => void;
  onClose: () => void;
};

/** The value the operator has clicked, when it is one that cannot be typed into in place. */
type Selection = {
  key: string;
  binding: PaperFieldBinding;
  value: string;
};

export function HiringPackPaperEditor({
  hrId,
  documentKey,
  documentLabel,
  copies,
  versionId,
  pack,
  onPackChange,
  onClose,
}: PaperEditorProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  /**
   * Which document the frame has actually finished loading, as `<url>#<token>`.
   *
   * Loading is DERIVED from this rather than held as its own flag. The flag version needed an effect
   * to raise it whenever the url or the reload token changed, and setting state from inside an
   * effect is a lint error in this repository for a good reason — it renders once with the stale
   * answer and then again with the right one. Comparing what is loaded against what is wanted gets
   * the right answer on the first render, with no effect at all.
   */
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [freeEdit, setFreeEdit] = useState(false);
  /**
   * The same flag, readable from the load handler.
   *
   * `enhance` runs on a document that has just replaced itself, and it has to re-apply free typing
   * to the new body. It cannot read `freeEdit` from a closure without re-creating itself on every
   * toggle, and it is the one callback in here that must not churn.
   */
  const freeEditRef = useRef(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  /**
   * Whether the operator has set the zoom by hand, which stops the fit below from moving it again.
   *
   * Without this the panel would fight the person using it: every resize — and on a phone that
   * includes the address bar sliding away — would throw away the zoom they had just chosen.
   */
  const [zoomPinned, setZoomPinned] = useState(false);
  /** Bumped after every save, to reload the document from the server rather than patch it here. */
  const [reloadToken, setReloadToken] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const previewUrl = useMemo(() => {
    const version = versionId ? `&version=${encodeURIComponent(versionId)}` : "";
    return `/api/hiring-pack/${encodeURIComponent(hrId)}/print?document=${documentKey}&copies=${copies}&preview=1${version}`;
  }, [copies, documentKey, hrId, versionId]);

  /** The document the frame is meant to be showing right now. */
  const frameKey = `${previewUrl}#${reloadToken}`;
  const loading = loadedKey !== frameKey;

  /**
   * The latest pack, readable from inside a DOM listener.
   *
   * The listeners attached to the document below outlive the render that created them, so closing
   * over `pack` directly would build every save payload from whatever the pack was when the page
   * loaded — and since each payload carries the WHOLE record (see `buildPaperEditPatch`), a stale
   * one would quietly write back old values for every field the operator had already corrected.
   */
  const packRef = useRef(pack);
  const savingRef = useRef(false);

  /**
   * Write one edited value, then reload the document from the server.
   *
   * The response is the whole re-read pack, which is what the fill screen above re-renders from, so
   * a correction made on the paper immediately shows up in the boxes too — they are two views of one
   * record and must never disagree.
   */
  const commit = useCallback(
    async (binding: PaperFieldBinding, typed: string, element?: HTMLElement) => {
      const patch = buildPaperEditPatch(packRef.current, binding, typed);
      if (!patch.ok) {
        setError(patch.message);
        setReloadToken((token) => token + 1);
        return;
      }

      setSaving(true);
      setError(null);
      setNotice(null);
      element?.setAttribute("data-hp-saving", "true");
      try {
        const response = await fetch(
          `/api/hiring-pack/${encodeURIComponent(hrId)}${paperStoreEndpoint(patch.store)}`,
          {
            body: JSON.stringify(patch.body),
            headers: { "Content-Type": "application/json" },
            method: "PUT",
          },
        );
        if (!response.ok) {
          let message = `Could not save (${response.status}).`;
          try {
            const body = (await response.json()) as { message?: string };
            if (body.message) message = body.message;
          } catch {
            // The status alone is the message.
          }
          setError(message);
          return;
        }
        const next = (await response.json()) as HiringPackData;
        onPackChange(next);
        packRef.current = next;
        setNotice(
          binding.alsoOn
            ? `${binding.labelEn} saved — it also updates ${binding.alsoOn}.`
            : `${binding.labelEn} saved.`,
        );
        setSelection(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not save.");
      } finally {
        setSaving(false);
        element?.removeAttribute("data-hp-saving");
        // Always reload, success or failure. On success it shows what the server will now print; on
        // failure it puts the rejected value back to what is actually stored, so the page never sits
        // showing text that was not saved.
        setReloadToken((token) => token + 1);
      }
    },
    [hrId, onPackChange],
  );

  const commitRef = useRef(commit);

  /**
   * Keep the three latest-value refs current, after every render.
   *
   * They exist because the listeners attached to the framed document outlive the render that created
   * them, so a listener closing over `pack` or `commit` directly would act on whatever they were
   * when the page loaded. Written HERE rather than during render deliberately: assigning to a ref
   * while rendering is a lint error in this repository, and it is one because a render can be thrown
   * away — a discarded render that had already moved a ref leaves the ref describing a state that
   * never existed. An effect only runs for a render that was kept.
   *
   * No dependency array on purpose: every one of these changes identity on a render that matters,
   * and listing them would only re-state that.
   */
  useEffect(() => {
    packRef.current = pack;
    savingRef.current = saving;
    commitRef.current = commit;
  });

  /**
   * Make the loaded document editable where it can be.
   *
   * Runs once per load. Every value the renderers marked with `data-hp-key` is looked up in the
   * binding table: one that maps to a stored field becomes editable, and one that does not is marked
   * locked rather than silently inert — a span that swallows a keystroke and discards it is the
   * whole defect being fixed here, so "cannot be edited" has to be visible.
   */
  const enhance = useCallback(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!doc || !doc.body) return;

    if (!doc.getElementById("hp-editor-css")) {
      const style = doc.createElement("style");
      style.id = "hp-editor-css";
      style.textContent = EDITOR_CSS;
      doc.head.appendChild(style);
    }

    const nodes = doc.querySelectorAll<HTMLElement>("[data-hp-key]");
    for (const element of nodes) {
      const key = element.getAttribute("data-hp-key");
      const binding = paperFieldBinding(key);
      if (!binding || !key) {
        element.setAttribute("data-hp-locked", "true");
        element.title =
          "This value is not stored against this employee — it comes from the company record or is worked out from another value.";
        continue;
      }

      element.title = `${binding.labelEn} — click to edit`;

      // A box grid writes one character per printed cell, so its text is a row of absolutely
      // positioned children. Typing into that directly would destroy the grid, so those are
      // selected here and edited in the bar above the page instead.
      const isGrid =
        element.classList.contains("grid") ||
        element.classList.contains("tick") ||
        element.classList.contains("wage");

      if (isGrid) {
        element.setAttribute("data-hp-live", "true");
        element.addEventListener("click", (event) => {
          event.preventDefault();
          for (const other of doc.querySelectorAll("[data-hp-selected]")) {
            other.removeAttribute("data-hp-selected");
          }
          element.setAttribute("data-hp-selected", "true");
          setSelection({
            key,
            binding,
            value: paperFieldCurrentValue(packRef.current, binding),
          });
        });
        continue;
      }

      element.setAttribute("data-hp-live", "true");
      element.setAttribute("contenteditable", "true");
      // Chrome inserts a <div> on Enter inside a contenteditable span, which would break the layout
      // of a legal document. Enter commits instead, and Escape abandons the edit.
      element.addEventListener("keydown", (event) => {
        const keyboard = event as KeyboardEvent;
        if (keyboard.key === "Enter") {
          event.preventDefault();
          element.blur();
        } else if (keyboard.key === "Escape") {
          event.preventDefault();
          element.textContent = element.getAttribute("data-hp-original") ?? element.textContent;
          element.blur();
        }
      });
      element.addEventListener("focus", () => {
        element.setAttribute("data-hp-original", element.textContent ?? "");
      });
      element.addEventListener("blur", () => {
        if (savingRef.current) return;
        const before = element.getAttribute("data-hp-original") ?? "";
        const after = element.textContent ?? "";
        if (stripDirectionMarks(before).trim() === stripDirectionMarks(after).trim()) return;
        void commitRef.current(binding, after, element);
      });
    }

    // Free typing is a property of the loaded page, so it is re-applied here on every load rather
    // than from an effect. That is not a workaround: mutating an external system belongs in the
    // handler that learns about it — the load handler here, and the toggle's own onClick below —
    // and an effect that reached into the frame for the same purpose was writing through a ref,
    // which the compiler rejects and which would re-run on renders that have nothing to do with
    // the document.
    applyFreeEdit(doc, freeEditRef.current);

    setLoadedKey(frameKey);
  }, [frameKey]);

  /** Turn free typing on or off, on the page and in the frame, in one action. */
  const toggleFreeEdit = useCallback(() => {
    const next = !freeEditRef.current;
    freeEditRef.current = next;
    setFreeEdit(next);
    const doc = frameRef.current?.contentDocument;
    if (doc) applyFreeEdit(doc, next);
  }, []);

  /**
   * Open at a zoom that shows the whole width of the page, whenever the panel is narrower than it.
   *
   * A fixed 85% is right on a desk and wrong on a phone: measured at 375px on 2026-08-31, the page
   * rendered 650px wide inside a 343px panel, so it opened cut in half. The panel scrolls, so
   * nothing was unreachable — but these documents are Arabic and therefore right-to-left, and a
   * horizontal scroller starts at the LEFT, which on an RTL page is the END of every line. What the
   * operator saw first was the far side of a form, with no indication that the side carrying the
   * names and numbers was off-screen behind it.
   *
   * Fitting only ever shrinks: a panel wider than the page keeps the 85% default rather than
   * blowing the paper up to fill it. It stops the moment the zoom is set by hand — the buttons are
   * the override, and they are how someone magnifies one box to read a digit on a phone.
   */
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || zoomPinned) return;

    const fit = () => {
      // The padding is on this element, so the paper's usable width is the client box less both
      // sides of it — reading `clientWidth` alone overshoots and leaves the page clipped again.
      const style = window.getComputedStyle(box);
      const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const next = fitZoomForWidth(box.clientWidth - padding);
      // Re-setting the same number would still re-render, and this runs on every resize frame.
      setZoom((current) => (Math.abs(next - current) < 0.005 ? current : next));
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [zoomPinned]);

  const print = useCallback(() => {
    const frame = frameRef.current;
    if (!frame?.contentWindow) return;
    frame.contentWindow.focus();
    frame.contentWindow.print();
  }, []);

  const saveSelection = useCallback(
    (typed: string) => {
      if (!selection) return;
      void commitRef.current(selection.binding, typed);
    },
    [selection],
  );

  return (
    <div className="rounded-[26px] border border-phx-line bg-white/80 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-phx-line px-5 py-4">
        <div className="min-w-0">
          <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-faint">
            On the paper
          </p>
          <p className="text-sm font-semibold text-phx-ink">{documentLabel}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-xl border border-phx-line bg-white px-2 py-1">
            <button
              className="px-2 text-sm font-bold text-phx-ink-soft hover:text-phx-ink"
              onClick={() => {
                setZoomPinned(true);
                setZoom((value) => Math.max(0.3, Number((value - 0.1).toFixed(2))));
              }}
              type="button"
            >
              −
            </button>
            <span className="w-12 text-center text-phx-xs font-bold text-phx-ink-soft">
              {Math.round(zoom * 100)}%
            </span>
            <button
              className="px-2 text-sm font-bold text-phx-ink-soft hover:text-phx-ink"
              onClick={() => {
                setZoomPinned(true);
                setZoom((value) => Math.min(1.6, Number((value + 0.1).toFixed(2))));
              }}
              type="button"
            >
              +
            </button>
          </div>
          <Button
            className="gap-2"
            onClick={toggleFreeEdit}
            size="sm"
            type="button"
            variant={freeEdit ? "default" : "outline"}
          >
            <PencilLine className="h-4 w-4" />
            {freeEdit ? "Free typing on" : "Type anywhere"}
          </Button>
          <Button
            className="gap-2"
            onClick={() => setReloadToken((token) => token + 1)}
            size="sm"
            type="button"
            variant="outline"
          >
            <RotateCw className="h-4 w-4" />
            Reload
          </Button>
          <Button className="gap-2" onClick={print} size="sm" type="button">
            <Printer className="h-4 w-4" />
            Print
          </Button>
          <Button
            aria-label="Close the preview"
            onClick={onClose}
            size="sm"
            type="button"
            variant="ghost"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="space-y-3 px-5 py-4">
        <p className="text-phx-xs leading-relaxed text-phx-ink-soft">
          This is the document itself, not a picture of it — the same page the Print button sends to
          the printer. Click any value with a dashed outline and type over it; it saves to the
          employee record and every other document that prints the same value changes with it.
        </p>

        {freeEdit ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-phx-xs text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Free typing is on, so you can change any word on the page — including the standing
              legal text. Those changes print, but they are <strong>not saved</strong>: they last
              until this page reloads, and they do not become the template. Anything you type over a
              dashed-outline value is still saved normally.
            </span>
          </div>
        ) : null}

        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-phx-xs text-red-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
        {notice && !error ? (
          <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-phx-xs text-emerald-800">
            <Check className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{notice}</span>
          </div>
        ) : null}

        {selection ? (
          <SelectionEditor
            key={selection.key}
            busy={saving}
            onCancel={() => setSelection(null)}
            onSave={saveSelection}
            selection={selection}
          />
        ) : null}

        <div
          className="relative overflow-auto rounded-2xl border border-phx-line bg-slate-200/70 p-4"
          ref={scrollRef}
        >
          {loading ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-200/70">
              <span className="flex items-center gap-2 text-phx-xs font-bold text-phx-ink-soft">
                <Loader2 className="h-4 w-4 animate-spin" />
                Building the page…
              </span>
            </div>
          ) : null}
          {/*
            The iframe is scaled by a CSS transform on the ELEMENT, never by anything inside the
            document. The page keeps its true measurements — US Legal for the insurance forms, A4 for
            the contract — so `contentWindow.print()` still prints at exactly 100%, which is what
            keeps a placed value on its printed box.
          */}
          <div
            style={{
              height: `${PAGE_HEIGHT_PX * zoom}px`,
              width: `${PAGE_WIDTH_PX * zoom}px`,
            }}
          >
            <iframe
              className="block border-0 bg-white shadow-lg"
              // The SAME key the load handler reports back, so "which document is showing" and
              // "which document has loaded" can never be answered from two different strings.
              key={frameKey}
              onLoad={enhance}
              ref={frameRef}
              src={previewUrl}
              style={{
                height: `${PAGE_HEIGHT_PX}px`,
                // The wrapper is deliberately the SCALED size, so it reserves the right amount of
                // room in the scroller — which makes it narrower than the page whenever the zoom is
                // below 100%. The base stylesheet's `max-width: 100%` on an iframe then clamps the
                // page to that wrapper, and the result is not a smaller page but a NARROWER one:
                // measured at 1440px on 2026-08-31, the 900px frame laid out at 765px, its viewport
                // came back 750px, and the A4 sheet inside — 794px at 96dpi — was squeezed to 717px
                // and scrolling behind its own edge. The preview was quietly reflowing the document
                // it exists to reproduce faithfully, and every zoom level reflowed it differently.
                maxWidth: "none",
                transform: `scale(${zoom})`,
                transformOrigin: "top left",
                width: `${PAGE_WIDTH_PX}px`,
              }}
              title={`${documentLabel} — editable preview`}
            />
          </div>
        </div>

        <p className="flex items-center gap-1.5 text-phx-2xs text-phx-ink-faint">
          <Lock className="h-3 w-3" />
          Values with no dashed outline come from the company record or are worked out from another
          value — the salary in words follows the salary figure, for instance.
        </p>
      </div>
    </div>
  );
}

/**
 * The editor for a value printed across a box grid.
 *
 * Those are one character per printed cell — a national ID is fourteen separate boxes — so the value
 * is typed here as one string and redistributed by the renderer when the page reloads. Typing into
 * the boxes themselves would mean typing into fourteen absolutely positioned elements, and the first
 * keystroke would take the grid apart.
 */
function SelectionEditor({
  busy,
  onCancel,
  onSave,
  selection,
}: {
  busy: boolean;
  onCancel: () => void;
  onSave: (value: string) => void;
  selection: Selection;
}) {
  const [value, setValue] = useState(selection.value);

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-phx-accent-line bg-phx-accent/5 px-3 py-3">
      <div className="min-w-[220px] flex-1">
        <label
          className="mb-1.5 block text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-soft"
          htmlFor="hp-selected-value"
        >
          {selection.binding.labelEn}
        </label>
        <Input
          autoFocus
          className="h-9 rounded-lg border-phx-line bg-white text-sm"
          disabled={busy}
          id="hp-selected-value"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSave(value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          value={value}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button
          className="gap-2"
          disabled={busy}
          onClick={() => onSave(value)}
          size="sm"
          type="button"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Save
        </Button>
        <Button disabled={busy} onClick={onCancel} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
      </div>
      {selection.binding.alsoOn ? (
        <p className="w-full text-phx-2xs text-phx-ink-faint">
          Also prints on {selection.binding.alsoOn}.
        </p>
      ) : null}
    </div>
  );
}
