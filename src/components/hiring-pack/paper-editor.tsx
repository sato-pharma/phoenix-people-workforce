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
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// LAYOUT MODE — 2026-09-03, the second half of the same request: "i want to be able to add anyfield
// wherever i want and edit text and drage drop fields and full control." Everything above this
// point edits a VALUE; layout mode edits WHERE a value sits, or adds one that never existed.
//
// It reuses the exact iframe this component already renders rather than opening a second surface,
// for the same reason free typing does: a layout edited somewhere else is a layout somebody has to
// trust matches what actually prints, and that trust is the thing this whole component exists to
// remove. Dragging a field moves the SAME element the page already renders, in the SAME points the
// server already measures in — a drop just writes back the number the pointer already arrived at.
//
// TWO SURFACES, ONE GESTURE. `field-layout.ts` explains why a page document places at an absolute
// point and a flow document anchors to a moving piece of prose; this component does not re-decide
// that; it reads `documentSurface(documentKey)` once and drags in whichever coordinate the field's
// own rendered position is already expressed in — `left`/`top` on a page field are already the page
// point, and on an added flow field they are already the offset from its anchor. The SAME pointer
// math (read the inline style the renderer wrote, add the pointer's own delta, write it back) works
// for both; only what a fresh ADD records as the anchor differs between them.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { AlertTriangle, Check, Eye, EyeOff, Loader2, Lock, Move, PencilLine, Plus, Printer, RotateCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  documentSurface,
  type DocumentFieldRow,
  type DocumentFieldSource,
} from "@/lib/hiring-pack/field-layout";
import {
  buildPaperEditPatch,
  PAPER_FIELD_BINDINGS,
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
import { currentTemplateVersion } from "@/lib/hiring-pack/template-registry";
import type { HiringPackData, HiringPackDocument } from "@/lib/hiring-pack/types";
import { cn } from "@/lib/utils";

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

/** Turn layout mode, and its "add a field" sub-mode, on or off inside the framed document. */
function applyLayoutClasses(doc: Document, layoutOn: boolean, addOn: boolean): void {
  if (!doc.body) return;
  doc.body.classList.toggle("hp-layout-edit", layoutOn);
  doc.body.classList.toggle("hp-adding-field", layoutOn && addOn);
}

/** 1pt is 4/3px in every browser at 96dpi. The iframe's own layout is never touched by the outer
 *  zoom transform — that scales the ELEMENT from outside, not the page rendered inside it — so this
 *  ratio is the whole conversion between a pointer delta and a point delta. No zoom factor belongs
 *  anywhere in it. */
const PT_PER_PX = 0.75;

/**
 * The CSS path from `root` down to `el`, as a chain of `tag:nth-of-type(n)` steps.
 *
 * Positional rather than by id or class, because the typeset documents carry neither on their prose
 * — a clause is a `<p>`, a cell is a `<td>`, nothing more. Position is exactly as stable as it needs
 * to be: a template VERSION's markup never changes (see `field-layout.ts`), so the same path
 * resolves to the same node in every copy of this render and in every future render of this same
 * version — the only lifetime a stored anchor has to survive.
 */
function cssPathWithin(root: Element, el: Element): string | null {
  if (el === root) return null;
  const steps: string[] = [];
  let node: Element | null = el;
  while (node && node !== root) {
    const parent: Element | null = node.parentElement;
    if (!parent) return null;
    const siblings = Array.from(parent.children).filter((child) => child.tagName === node!.tagName);
    steps.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
    node = parent;
  }
  return node === root ? steps.join(" > ") : null;
}

/** Which kind of placement a page-surface element renders as, read off its own class list. */
function placementKindOf(element: HTMLElement): "text" | "digits" | "tick" {
  if (element.classList.contains("tick")) return "tick";
  if (element.classList.contains("grid")) return "digits";
  return "text";
}

/**
 * A field's current geometry, read straight off the inline style the renderer already wrote.
 *
 * Not `getBoundingClientRect`: every placed value's `left`/`top`/`width`/`height` is already the
 * exact point value the server measured or computed, written as inline CSS by `renderPlacement` and
 * by `renderFlowField`. Reading it back is exact and needs no ancestor-rect subtraction and no zoom
 * correction — measuring the box on screen instead would reintroduce both. A `tick` carries no
 * inline font size and a `digits` grid carries no inline alignment, because the renderer never reads
 * either back for those kinds (`movedPlacement` in `field-layout.ts` copies neither), so both fall
 * back to a value that is merely valid for the table's own constraints, never one that changes
 * anything printed.
 */
function geometryFromElement(element: HTMLElement): {
  x: number;
  y: number;
  w: number;
  h: number;
  align: "right" | "center" | "left";
  size: number;
} {
  const kind = placementKindOf(element);
  const styledAlign = element.style.textAlign;
  const align: "right" | "center" | "left" =
    styledAlign === "right" || styledAlign === "center" || styledAlign === "left"
      ? styledAlign
      : kind === "tick"
        ? "center"
        : "left";
  const size = Number.parseFloat(element.style.fontSize) || (kind === "tick" ? 13 : 9);
  return {
    x: Number.parseFloat(element.style.left) || 0,
    y: Number.parseFloat(element.style.top) || 0,
    w: Number.parseFloat(element.style.width) || 100,
    h: Number.parseFloat(element.style.height) || 13,
    align,
    size,
  };
}

/** Which logical page (1-based, within ONE copy) an element sits on, whatever copy it is drawn in.
 *  Layout applies to every copy identically, so the copy an operator happened to click is never
 *  part of the answer — only its position among the document's own distinct pages is. */
function resolvePageFor(doc: Document, element: Element, copiesCount: number): number {
  const sheets = Array.from(doc.querySelectorAll(".sheet"));
  const sheetEl = element.closest(".sheet");
  const sheetIndex = sheetEl ? sheets.indexOf(sheetEl) : 0;
  const pagesPerCopy = Math.max(1, Math.round(sheets.length / Math.max(1, copiesCount)));
  return (Math.max(0, sheetIndex) % pagesPerCopy) + 1;
}

/** What a chip in the field list reads, for a stored row. */
function fieldLabel(row: DocumentFieldRow): string {
  if (row.defaultKey) return row.hidden ? `${row.defaultKey} — hidden` : `${row.defaultKey} — moved`;
  if (row.source.kind === "literal") return row.source.text ? `“${row.source.text}”` : "(blank fixed text)";
  return row.source.key || "(no key set)";
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

  /* An added flow field is inert to the pointer by design (field-layout.ts's flowFieldLayer) so it
     never steals a click from the prose it sits on top of, on the printed page or the ordinary
     preview. Inside the editor that is exactly backwards — it is the one thing on a flow document
     that can be selected, edited or dragged — so this reopens it, at a specificity nothing else in
     this stylesheet or the document's own can out-rank. */
  .hp-added { pointer-events: auto !important; }

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

  /* Layout mode replaces value-editing with position-editing: every dashed box becomes something to
     pick up rather than type into, and "add a field" turns the whole page into a drop target. */
  body.hp-layout-edit [data-hp-live] { cursor: move; }
  body.hp-layout-edit [data-hp-locked] { cursor: default; }
  body.hp-layout-edit.hp-adding-field,
  body.hp-layout-edit.hp-adding-field * { cursor: crosshair !important; }
  [data-hp-dragging] {
    z-index: 30;
    box-shadow: 0 0 0 2px #2563eb, 0 4px 10px rgba(37, 99, 235, 0.35);
    background-color: rgba(37, 99, 235, 0.14) !important;
  }
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

/**
 * One field layer row, in flight.
 *
 * The same shape whether it names an EXISTING row (`id` set) or one not yet saved (`id` undefined) —
 * a drag, a resize, a hide and a brand-new field are all "here is the row I want the table to hold
 * now," and the API's own POST treats them identically (see `document-fields/route.ts`).
 */
type PendingWrite = {
  id?: string;
  defaultKey: string | null;
  hidden: boolean;
  page: number | null;
  anchor: { selector: string; dx: number; dy: number } | null;
  x: number;
  y: number;
  w: number;
  h: number;
  align: "right" | "center" | "left";
  size: number;
  source: DocumentFieldSource;
};

/**
 * Read a dragged or clicked element back into a write payload.
 *
 * Returns null only for a flow field this component itself could never have produced — an added
 * flow field with no matching row and no anchor, which would mean the layout had not finished
 * loading when the drag started. The caller already guards against starting such a drag; this is
 * the belt to that braces.
 */
function buildSelectionFromElement(
  doc: Document,
  element: HTMLElement,
  copiesCount: number,
  surface: "page" | "flow",
  existing: DocumentFieldRow | null,
): PendingWrite | null {
  const geometry = geometryFromElement(element);

  if (surface === "flow") {
    if (!existing || !existing.anchor) return null;
    return {
      id: existing.id,
      defaultKey: null,
      hidden: false,
      page: null,
      // The element's own left/top ARE its dx/dy — see renderFlowField. The anchor it hangs off
      // does not change on a drag; only the offset from it does.
      anchor: { selector: existing.anchor.selector, dx: geometry.x, dy: geometry.y },
      x: 0,
      y: 0,
      w: geometry.w,
      h: geometry.h,
      align: geometry.align,
      size: geometry.size,
      source: existing.source,
    };
  }

  const page = resolvePageFor(doc, element, copiesCount);
  if (existing) {
    return {
      id: existing.id,
      defaultKey: existing.defaultKey,
      hidden: existing.hidden,
      page,
      anchor: null,
      source: existing.source,
      ...geometry,
    };
  }

  // A compiled default, dragged for the first time: this starts an OVERRIDE, keyed by the value it
  // already prints. That source is written but never READ for a page-surface override — see
  // field-layout.ts's movedPlacement, which keeps the compiled placement's own key — so pointing it
  // at its own key is the honest description even though rendering never consults it.
  const key = element.getAttribute("data-hp-key");
  return {
    defaultKey: key,
    hidden: false,
    page,
    anchor: null,
    source: key ? { kind: "value", key } : { kind: "literal", text: "" },
    ...geometry,
  };
}

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

  /** The template version this open document is actually printing — the one the field layer is
   *  scoped against. `versionId` is only ever set when a specific archived version is being viewed;
   *  otherwise this is the same version the print route itself falls back to. */
  const effectiveVersionId = useMemo(
    () => versionId ?? currentTemplateVersion(documentKey).id,
    [documentKey, versionId],
  );
  const surface = useMemo(() => documentSurface(documentKey), [documentKey]);

  const [layoutMode, setLayoutMode] = useState(false);
  const [addMode, setAddMode] = useState(false);
  const [fields, setFields] = useState<DocumentFieldRow[]>([]);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [layoutSelection, setLayoutSelection] = useState<PendingWrite | null>(null);
  const layoutModeRef = useRef(false);
  const addModeRef = useRef(false);
  const fieldsRef = useRef<DocumentFieldRow[]>([]);

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

  /** Where the field layer lives for this document at this version — one document, one version, one
   *  shared layout for every employee, matching `loadDocumentFieldLayout`'s own scope. */
  const fieldsUrl = `/api/hiring-pack/document-fields?document=${documentKey}&templateVersionId=${encodeURIComponent(effectiveVersionId)}`;

  const loadFields = useCallback(async () => {
    setFieldsLoading(true);
    setFieldsError(null);
    try {
      const response = await fetch(fieldsUrl);
      const body = (await response.json().catch(() => null)) as
        | { fields?: DocumentFieldRow[]; message?: string }
        | null;
      if (!response.ok) {
        throw new Error(body?.message ?? `Could not load the layout (${response.status}).`);
      }
      const rows = body?.fields ?? [];
      setFields(rows);
      fieldsRef.current = rows;
    } catch (cause) {
      setFieldsError(cause instanceof Error ? cause.message : "Could not load the layout.");
    } finally {
      setFieldsLoading(false);
    }
  }, [fieldsUrl]);

  useEffect(() => {
    if (layoutMode) void loadFields();
  }, [layoutMode, loadFields]);

  /**
   * Save one field-layer row — a move, a resize, a hide, or a brand-new field — then reload both the
   * layout and the printed page from the server, the same discipline `commit` above already follows
   * for a typed value: nothing here is ever patched onto the screen optimistically.
   */
  const commitLayoutField = useCallback(
    async (write: PendingWrite) => {
      setLayoutBusy(true);
      setFieldsError(null);
      try {
        const response = await fetch("/api/hiring-pack/document-fields", {
          body: JSON.stringify({
            document: documentKey,
            templateVersionId: effectiveVersionId,
            ...write,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        if (!response.ok) {
          throw new Error(body?.message ?? `Could not save the field (${response.status}).`);
        }
        setLayoutSelection(null);
        setNotice("Layout saved.");
        await loadFields();
        setReloadToken((token) => token + 1);
      } catch (cause) {
        setFieldsError(cause instanceof Error ? cause.message : "Could not save the field.");
      } finally {
        setLayoutBusy(false);
      }
    },
    [documentKey, effectiveVersionId, loadFields],
  );

  /** Delete one field-layer row. An added field goes; an override goes back to its compiled default. */
  const deleteLayoutField = useCallback(
    async (id: string) => {
      setLayoutBusy(true);
      setFieldsError(null);
      try {
        const response = await fetch(`/api/hiring-pack/document-fields?id=${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        if (!response.ok) {
          throw new Error(body?.message ?? `Could not delete the field (${response.status}).`);
        }
        setLayoutSelection(null);
        setNotice("Field removed.");
        await loadFields();
        setReloadToken((token) => token + 1);
      } catch (cause) {
        setFieldsError(cause instanceof Error ? cause.message : "Could not delete the field.");
      } finally {
        setLayoutBusy(false);
      }
    },
    [loadFields],
  );

  /** Delete every row for this document and version, back to exactly what the source measures. */
  const resetLayout = useCallback(async () => {
    const sure = window.confirm(
      `Reset ${documentLabel} to its default layout? Every moved, hidden or added field on this document is removed.`,
    );
    if (!sure) return;
    setLayoutBusy(true);
    setFieldsError(null);
    try {
      const response = await fetch("/api/hiring-pack/document-fields", {
        body: JSON.stringify({ document: documentKey, intent: "reset", templateVersionId: effectiveVersionId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as { message?: string; removed?: number } | null;
      if (!response.ok) {
        throw new Error(body?.message ?? `Could not reset the layout (${response.status}).`);
      }
      setLayoutSelection(null);
      setNotice(
        body?.removed
          ? `Layout reset — ${body.removed} change${body.removed === 1 ? "" : "s"} removed.`
          : "Already at the default layout.",
      );
      await loadFields();
      setReloadToken((token) => token + 1);
    } catch (cause) {
      setFieldsError(cause instanceof Error ? cause.message : "Could not reset the layout.");
    } finally {
      setLayoutBusy(false);
    }
  }, [documentKey, documentLabel, effectiveVersionId, loadFields]);

  const commitLayoutFieldRef = useRef(commitLayoutField);

  /**
   * Keep the latest-value refs current, after every render.
   *
   * They exist because the listeners attached to the framed document outlive the render that created
   * them, so a listener closing over one of these directly would act on whatever it was when the page
   * loaded. Written HERE rather than during render deliberately: assigning to a ref while rendering is
   * a lint error in this repository, and it is one because a render can be thrown away — a discarded
   * render that had already moved a ref leaves the ref describing a state that never existed. An
   * effect only runs for a render that was kept.
   *
   * No dependency array on purpose: every one of these changes identity on a render that matters, and
   * listing them would only re-state that.
   */
  useEffect(() => {
    packRef.current = pack;
    savingRef.current = saving;
    commitRef.current = commit;
    commitLayoutFieldRef.current = commitLayoutField;
  });

  /**
   * Pick up a pointer on a field and follow it until release.
   *
   * A click with no real movement selects the field instead of writing a no-op move — the same
   * pointer gesture opens the numeric editor below, which is how a field gets moved by a precise
   * number rather than a hand. A real drag writes on release, the same "commit on the way out"
   * discipline the typed-value fields already use on blur.
   */
  const beginDrag = useCallback(
    (doc: Document, element: HTMLElement, existing: DocumentFieldRow | null, event: PointerEvent) => {
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      const originLeft = Number.parseFloat(element.style.left) || 0;
      const originTop = Number.parseFloat(element.style.top) || 0;
      let moved = false;

      for (const other of doc.querySelectorAll("[data-hp-selected]")) other.removeAttribute("data-hp-selected");
      element.setAttribute("data-hp-selected", "true");
      element.setAttribute("data-hp-dragging", "true");

      const onMove = (moveEvent: PointerEvent) => {
        const dxPt = (moveEvent.clientX - startClientX) * PT_PER_PX;
        const dyPt = (moveEvent.clientY - startClientY) * PT_PER_PX;
        if (Math.abs(dxPt) > 1 || Math.abs(dyPt) > 1) moved = true;
        element.style.left = `${Math.max(0, originLeft + dxPt).toFixed(2)}pt`;
        element.style.top = `${Math.max(0, originTop + dyPt).toFixed(2)}pt`;
      };

      const onUp = () => {
        doc.removeEventListener("pointermove", onMove);
        doc.removeEventListener("pointerup", onUp);
        element.removeAttribute("data-hp-dragging");

        const write = buildSelectionFromElement(doc, element, copies, surface, existing);
        if (!write) return;
        if (!moved) {
          setLayoutSelection(write);
          return;
        }
        void commitLayoutFieldRef.current(write);
      };

      doc.addEventListener("pointermove", onMove);
      doc.addEventListener("pointerup", onUp, { once: true });
    },
    [copies, surface],
  );

  /**
   * The one delegated listener that turns layout mode on for a loaded page.
   *
   * Delegated on the document rather than per-field, and in the CAPTURE phase, so it runs — and can
   * cancel — before any of the per-element click/focus wiring `enhance` below attaches for ordinary
   * value editing. That is deliberate: the two modes read the same pointer gesture two different
   * ways, and running both on one click is how a drag would also open the old grid editor or focus a
   * contenteditable span underneath it.
   */
  const onLayoutPointerDown = useCallback(
    (event: PointerEvent) => {
      if (!layoutModeRef.current) return;
      const doc = event.currentTarget as Document | null;
      const target = event.target as HTMLElement | null;
      if (!doc || !target) return;

      event.preventDefault();
      event.stopPropagation();

      if (addModeRef.current) {
        if (surface === "page") {
          const sheetEl = target.closest(".sheet") as HTMLElement | null;
          if (!sheetEl) {
            setFieldsError("Click inside the page to add a field there.");
            return;
          }
          const rect = sheetEl.getBoundingClientRect();
          const xPt = (event.clientX - rect.left) * PT_PER_PX;
          const yPt = (event.clientY - rect.top) * PT_PER_PX;
          setLayoutSelection({
            align: "right",
            anchor: null,
            defaultKey: null,
            h: 14,
            hidden: false,
            page: resolvePageFor(doc, sheetEl, copies),
            size: 9,
            source: { kind: "literal", text: "" },
            w: 140,
            x: Math.max(0, xPt - 60),
            y: Math.max(0, yPt - 7),
          });
        } else {
          const copyRoot = target.closest(".copy") ?? doc.body;
          if (target === copyRoot) {
            setFieldsError("Click on some text or a cell to anchor the new field there.");
            addModeRef.current = false;
            setAddMode(false);
            return;
          }
          const selector = cssPathWithin(copyRoot, target);
          if (!selector) {
            setFieldsError("Could not place a field there — try a different spot.");
            addModeRef.current = false;
            setAddMode(false);
            return;
          }
          const anchorRect = target.getBoundingClientRect();
          setLayoutSelection({
            align: "right",
            anchor: {
              dx: Math.max(0, (event.clientX - anchorRect.left) * PT_PER_PX),
              dy: Math.max(0, (event.clientY - anchorRect.top) * PT_PER_PX),
              selector,
            },
            defaultKey: null,
            h: 14,
            hidden: false,
            page: null,
            size: 9,
            source: { kind: "literal", text: "" },
            w: 140,
            x: 0,
            y: 0,
          });
        }
        addModeRef.current = false;
        setAddMode(false);
        return;
      }

      const fieldTargetSelector = surface === "page" ? "[data-hp-key]" : ".hp-added";
      const element = target.closest<HTMLElement>(fieldTargetSelector);
      if (!element) return; // clicked the artwork or empty page — nothing to select or drag

      const fieldId = element.getAttribute("data-hp-field");
      const existing = fieldId ? (fieldsRef.current.find((row) => row.id === fieldId) ?? null) : null;
      if (surface === "flow" && !existing) {
        setFieldsError("The layout is still loading — try again in a moment.");
        return;
      }

      beginDrag(doc, element, existing, event);
    },
    [beginDrag, copies, surface],
  );

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

    // Attached once per document load, not per element — layout mode has to intercept a gesture
    // before it reaches any of the per-field listeners wired below, on a page that has not been
    // touched yet as much as one that has.
    if (!doc.body.dataset.hpLayoutWired) {
      doc.body.dataset.hpLayoutWired = "1";
      doc.addEventListener("pointerdown", onLayoutPointerDown, true);
      doc.addEventListener(
        "click",
        (event) => {
          if (layoutModeRef.current) {
            event.preventDefault();
            event.stopPropagation();
          }
        },
        true,
      );
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

    // Free typing and layout mode are properties of the loaded page, so both are re-applied here on
    // every load rather than from an effect. That is not a workaround: mutating an external system
    // belongs in the handler that learns about it — the load handler here, and the toggles below —
    // and an effect that reached into the frame for the same purpose was writing through a ref,
    // which the compiler rejects and which would re-run on renders that have nothing to do with the
    // document.
    applyFreeEdit(doc, freeEditRef.current);
    applyLayoutClasses(doc, layoutModeRef.current, addModeRef.current);

    setLoadedKey(frameKey);
  }, [frameKey, onLayoutPointerDown]);

  /** Turn free typing on or off, on the page and in the frame, in one action. */
  const toggleFreeEdit = useCallback(() => {
    const next = !freeEditRef.current;
    freeEditRef.current = next;
    setFreeEdit(next);
    // Free typing and layout mode both claim the pointer inside the frame; running both at once is
    // how a drag becomes a text selection. Turning one on turns the other off.
    if (next && layoutModeRef.current) {
      layoutModeRef.current = false;
      setLayoutMode(false);
      addModeRef.current = false;
      setAddMode(false);
      setLayoutSelection(null);
    }
    const doc = frameRef.current?.contentDocument;
    if (doc) {
      applyFreeEdit(doc, next);
      applyLayoutClasses(doc, layoutModeRef.current, addModeRef.current);
    }
  }, []);

  /** Turn layout mode on or off, on the page and in the frame, in one action. */
  const toggleLayoutMode = useCallback(() => {
    const next = !layoutModeRef.current;
    layoutModeRef.current = next;
    setLayoutMode(next);
    if (next && freeEditRef.current) {
      freeEditRef.current = false;
      setFreeEdit(false);
      const doc = frameRef.current?.contentDocument;
      if (doc) applyFreeEdit(doc, false);
    }
    if (!next) {
      addModeRef.current = false;
      setAddMode(false);
      setLayoutSelection(null);
    }
    const doc = frameRef.current?.contentDocument;
    if (doc) applyLayoutClasses(doc, next, addModeRef.current);
  }, []);

  /** Arm or disarm "click the page to add a field here." One placement per arming — see
   *  `onLayoutPointerDown`, which disarms it the moment a field is dropped. */
  const toggleAddMode = useCallback(() => {
    const next = !addModeRef.current;
    addModeRef.current = next;
    setAddMode(next);
    setLayoutSelection(null);
    const doc = frameRef.current?.contentDocument;
    if (doc) applyLayoutClasses(doc, layoutModeRef.current, next);
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
            onClick={toggleLayoutMode}
            size="sm"
            type="button"
            variant={layoutMode ? "default" : "outline"}
          >
            <Move className="h-4 w-4" />
            {layoutMode ? "Editing layout" : "Edit layout"}
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

        {layoutMode ? (
          <div className="space-y-3 rounded-2xl border border-phx-accent-line bg-phx-accent/5 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-phx-xs leading-relaxed text-phx-ink-soft">
                Drag any dashed box to move it — it saves the moment you let go. Click one without
                dragging to fine-tune its size, text or position below. Add a field, then click
                anywhere on the page to drop a new one there.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  className="gap-2"
                  onClick={toggleAddMode}
                  size="sm"
                  type="button"
                  variant={addMode ? "default" : "outline"}
                >
                  <Plus className="h-4 w-4" />
                  {addMode ? "Click the page…" : "Add field"}
                </Button>
                <Button
                  className="gap-2"
                  disabled={layoutBusy}
                  onClick={() => void resetLayout()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <RotateCw className="h-4 w-4" />
                  Reset to default
                </Button>
              </div>
            </div>

            {fieldsError ? (
              <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-phx-xs text-red-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{fieldsError}</span>
              </div>
            ) : null}

            {layoutSelection ? (
              <LayoutFieldEditor
                busy={layoutBusy}
                key={JSON.stringify([
                  layoutSelection.id,
                  layoutSelection.page,
                  layoutSelection.anchor?.selector,
                  layoutSelection.x,
                  layoutSelection.y,
                  layoutSelection.anchor?.dx,
                  layoutSelection.anchor?.dy,
                ])}
                onCancel={() => setLayoutSelection(null)}
                onDelete={
                  layoutSelection.id
                    ? () => {
                        const sure = window.confirm(
                          layoutSelection.defaultKey
                            ? "Remove this override? It returns to its default position."
                            : "Delete this field?",
                        );
                        if (sure) void deleteLayoutField(layoutSelection.id!);
                      }
                    : undefined
                }
                onSave={(write) => void commitLayoutField(write)}
                onToggleHidden={
                  layoutSelection.id && layoutSelection.defaultKey
                    ? () => void commitLayoutField({ ...layoutSelection, hidden: !layoutSelection.hidden })
                    : undefined
                }
                selection={layoutSelection}
              />
            ) : null}

            <div className="flex flex-wrap gap-1.5">
              {fieldsLoading ? (
                <span className="text-phx-2xs text-phx-ink-faint">Loading the layout…</span>
              ) : fields.length === 0 ? (
                <span className="text-phx-2xs text-phx-ink-faint">
                  Nothing moved, hidden or added yet — this document prints its default layout.
                </span>
              ) : (
                fields.map((row) => (
                  <button
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-phx-2xs font-semibold",
                      row.hidden
                        ? "border-slate-300 bg-slate-100 text-slate-400 line-through"
                        : "border-phx-accent-line bg-white text-phx-ink-soft hover:bg-phx-accent/10",
                    )}
                    key={row.id}
                    onClick={() =>
                      setLayoutSelection({
                        align: row.align,
                        anchor: row.anchor,
                        defaultKey: row.defaultKey,
                        h: row.h,
                        hidden: row.hidden,
                        id: row.id,
                        page: row.page,
                        size: row.size,
                        source: row.source,
                        w: row.w,
                        x: row.x,
                        y: row.y,
                      })
                    }
                    type="button"
                  >
                    {fieldLabel(row)}
                  </button>
                ))
              )}
            </div>
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

/** One numeric input in the layout editor's geometry grid, labelled above it. */
function NumberField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: number) => void;
  value: number;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
        {label}
      </label>
      <Input
        className="h-9 rounded-lg border-phx-line bg-white text-sm"
        onChange={(event) => {
          const parsed = Number.parseFloat(event.target.value);
          onChange(Number.isFinite(parsed) ? parsed : 0);
        }}
        type="number"
        value={Number.isFinite(value) ? value : 0}
      />
    </div>
  );
}

/**
 * The editor for one field-layer row: its source, its position and its size, plus hide/delete for a
 * row that already exists.
 *
 * A drag already writes position on its own — this is for everything a drag cannot express: which
 * value or fixed text a field prints, exact numbers rather than a hand, and the two actions (hide,
 * delete) that are not a position at all.
 */
function LayoutFieldEditor({
  busy,
  onCancel,
  onDelete,
  onSave,
  onToggleHidden,
  selection,
}: {
  busy: boolean;
  onCancel: () => void;
  onDelete?: () => void;
  onSave: (write: PendingWrite) => void;
  onToggleHidden?: () => void;
  selection: PendingWrite;
}) {
  const [draft, setDraft] = useState(selection);
  const setSource = (source: DocumentFieldSource) => setDraft((prev) => ({ ...prev, source }));

  return (
    <div className="space-y-3 rounded-xl border border-phx-accent-line bg-white px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-faint">
          {draft.id ? (draft.defaultKey ? "Moved field" : "Added field") : "New field"}
        </span>
        {draft.defaultKey ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-phx-2xs font-semibold text-phx-ink-soft">
            replaces {draft.defaultKey}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            setSource({ kind: "literal", text: draft.source.kind === "literal" ? draft.source.text : "" })
          }
          size="sm"
          type="button"
          variant={draft.source.kind === "literal" ? "default" : "outline"}
        >
          Fixed text
        </Button>
        <Button
          onClick={() => setSource({ kind: "value", key: draft.source.kind === "value" ? draft.source.key : "" })}
          size="sm"
          type="button"
          variant={draft.source.kind === "value" ? "default" : "outline"}
        >
          From the record
        </Button>
      </div>

      {draft.source.kind === "literal" ? (
        <Input
          className="h-9 rounded-lg border-phx-line bg-white text-sm"
          onChange={(event) => setSource({ kind: "literal", text: event.target.value })}
          placeholder="The exact text to print"
          value={draft.source.text}
        />
      ) : (
        <>
          <Input
            className="h-9 rounded-lg border-phx-line bg-white text-sm"
            list="hp-layout-value-keys"
            onChange={(event) => setSource({ kind: "value", key: event.target.value })}
            placeholder="e.g. insuredName — the same key another document already prints"
            value={draft.source.key}
          />
          <datalist id="hp-layout-value-keys">
            {Object.entries(PAPER_FIELD_BINDINGS).map(([key, binding]) => (
              <option key={key} label={binding.labelEn} value={key} />
            ))}
          </datalist>
        </>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <NumberField
          label={draft.anchor ? "Offset right (pt)" : "X (pt)"}
          onChange={(value) =>
            setDraft((prev) => (prev.anchor ? { ...prev, anchor: { ...prev.anchor, dx: value } } : { ...prev, x: value }))
          }
          value={draft.anchor ? draft.anchor.dx : draft.x}
        />
        <NumberField
          label={draft.anchor ? "Offset down (pt)" : "Y (pt)"}
          onChange={(value) =>
            setDraft((prev) => (prev.anchor ? { ...prev, anchor: { ...prev.anchor, dy: value } } : { ...prev, y: value }))
          }
          value={draft.anchor ? draft.anchor.dy : draft.y}
        />
        <NumberField label="Width (pt)" onChange={(value) => setDraft((prev) => ({ ...prev, w: value }))} value={draft.w} />
        <NumberField label="Height (pt)" onChange={(value) => setDraft((prev) => ({ ...prev, h: value }))} value={draft.h} />
        <NumberField
          label="Text size (pt)"
          onChange={(value) => setDraft((prev) => ({ ...prev, size: value }))}
          value={draft.size}
        />
        <div>
          <label className="mb-1.5 block text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
            Align
          </label>
          <select
            className="h-9 w-full rounded-lg border border-phx-line bg-white px-2 text-sm"
            onChange={(event) =>
              setDraft((prev) => ({ ...prev, align: event.target.value as "right" | "center" | "left" }))
            }
            value={draft.align}
          >
            <option value="right">Right</option>
            <option value="center">Center</option>
            <option value="left">Left</option>
          </select>
        </div>
      </div>

      {draft.anchor ? (
        // WRAPS, never truncates. A CSS path is long and has no redundant half — cutting it with an
        // ellipsis would hide exactly the part that says WHICH clause this field hangs on, and the
        // owner's rule bans that outright. `break-all` because the path is one unbroken token: a
        // normal word wrap has nowhere to break it and would push the panel sideways instead, which
        // is the horizontal scroll the fits-the-screen rule bans.
        <p className="break-all text-phx-2xs text-phx-ink-faint">
          Anchored to: <code>{draft.anchor.selector}</code>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button className="gap-2" disabled={busy} onClick={() => onSave(draft)} size="sm" type="button">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Save
        </Button>
        <Button disabled={busy} onClick={onCancel} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
        {onToggleHidden ? (
          <Button className="gap-2" disabled={busy} onClick={onToggleHidden} size="sm" type="button" variant="outline">
            {draft.hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            {draft.hidden ? "Show" : "Hide"}
          </Button>
        ) : null}
        {onDelete ? (
          <Button
            className="gap-2 text-red-600 hover:text-red-700"
            disabled={busy}
            onClick={onDelete}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        ) : null}
      </div>
    </div>
  );
}
