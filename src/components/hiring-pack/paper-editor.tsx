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

import { AlertTriangle, Check, Eye, EyeOff, History, Loader2, Lock, MapPin, Move, PencilLine, Plus, Printer, RotateCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FieldTable } from "@/components/hiring-pack/field-table";
import { Button } from "@/components/ui/button";
import { FieldHistoryPanel } from "@/components/hiring-pack/field-history-panel";
import { Input } from "@/components/ui/input";
import type { DocumentFieldInventoryEntry } from "@/lib/hiring-pack/document-inventory";
import {
  documentSurface,
  type DocumentFieldRow,
  type DocumentFieldSource,
} from "@/lib/hiring-pack/field-layout";
import type {
  CarryForwardOffer,
  FieldHistoryEntry,
  FieldHistorySummary,
} from "@/lib/hiring-pack/field-layout-store";
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
/**
 * How long the arrow keys must be still before a nudge is written.
 *
 * A held key repeats about thirty times a second. Long enough that walking a box across the page
 * writes once; short enough that letting go and reaching for the mouse does not outrun it.
 */
const NUDGE_SAVE_MS = 500;

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
  /* A RULE BEING TRIED, NOT ONE THAT IS SAVED. Green rather than the editor's blue, because blue
     already means "you can edit this" everywhere else on the page and a second blue would read as
     one more editable box. The dashed ring plus the tint says the words under it are not what the
     document would print if it were printed right now. */
  [data-hp-dry] {
    outline: 2px dashed #059669 !important;
    outline-offset: 2px;
    background-color: rgba(5, 150, 105, 0.14) !important;
  }
  /* A rule that resolves to nothing keeps its ring so the box does not simply vanish — an empty
     outline IS the warning, and a field that disappeared would read as the preview being broken. */
  [data-hp-dry][data-hp-dry-empty] {
    background-color: rgba(220, 38, 38, 0.12) !important;
    outline-color: #dc2626 !important;
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

/**
 * Read one document's field layer. Split out of the component so both readers share it: the effect
 * that loads when the panel opens, and the reload every mutation runs afterwards. It only fetches
 * and never touches state, which is what lets the effect keep each setState inside a callback.
 */
/**
 * The template's own field list, for the table.
 *
 * At module scope beside `fetchDocumentFields` and for the same reason: a function defined in the
 * component body is a new function on every render, so an effect depending on it re-runs on every
 * render, and the repair for that — setting state to break the loop — is the
 * `react-hooks/set-state-in-effect` error this repository treats as a real defect rather than a
 * style. Nothing here closes over a render.
 */
async function fetchDocumentInventory(url: string): Promise<DocumentFieldInventoryEntry[]> {
  const response = await fetch(url);
  const body = (await response.json().catch(() => null)) as
    | { fields?: DocumentFieldInventoryEntry[]; message?: string }
    | null;
  if (!response.ok) {
    throw new Error(body?.message ?? `Could not read this template's fields (${response.status}).`);
  }
  return body?.fields ?? [];
}

/** The layout, and — only when this version is untouched and an earlier one is not — the offer. */
type LayoutPayload = {
  rows: DocumentFieldRow[];
  carryForward: CarryForwardOffer | null;
  /** Per row id, when it was last rewritten — empty until the history migration is applied. */
  changed: Record<string, FieldHistorySummary>;
};

async function fetchDocumentFields(url: string): Promise<LayoutPayload> {
  const response = await fetch(url);
  const body = (await response.json().catch(() => null)) as
    | {
        fields?: DocumentFieldRow[];
        carryForward?: CarryForwardOffer | null;
        changed?: Record<string, FieldHistorySummary>;
        message?: string;
      }
    | null;
  if (!response.ok) {
    throw new Error(body?.message ?? `Could not load the layout (${response.status}).`);
  }
  return {
    rows: body?.fields ?? [],
    carryForward: body?.carryForward ?? null,
    changed: body?.changed ?? {},
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
  /** Null in the ordinary case — an offer exists only on a version nothing has been done to yet. */
  const [carryOffer, setCarryOffer] = useState<CarryForwardOffer | null>(null);

  /**
   * Which fields have been rewritten and when — and the one whose past states are open.
   *
   * `changed` arrives with the layout because it is two columns and one line of text per row.
   * `history` is fetched for the single row somebody opens, since the previous states are the whole
   * placement each and nobody reads thirty-three of them.
   */
  const [changed, setChanged] = useState<Record<string, FieldHistorySummary>>({});
  const [historyRow, setHistoryRow] = useState<DocumentFieldRow | null>(null);
  /**
   * The answer carries the id it is FOR, so a slow reply for a row the operator has moved on from
   * renders nothing instead of appearing under the new row's heading. A stamped answer is a smaller
   * and more honest guard than a cancellation flag: there is no window in which the wrong states are
   * on screen, because the panel only draws an answer whose id matches what it is showing.
   */
  const [history, setHistory] = useState<{ fieldId: string; entries: FieldHistoryEntry[] } | null>(
    null,
  );
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [layoutSelection, setLayoutSelection] = useState<PendingWrite | null>(null);
  const layoutModeRef = useRef(false);
  const addModeRef = useRef(false);
  const fieldsRef = useRef<DocumentFieldRow[]>([]);

  /**
   * Which half of the editor is showing: the page, for POSITION, or the table, for CONTENT.
   *
   * Two views of one field layer rather than two features — the owner's own division, put to him
   * directly on 2026-09-03 and chosen in those words. Both write the same rows, so a field moved on
   * the page and retyped in the table is still one field, and neither screen can hold a version of
   * it the other does not see.
   */
  const [layoutTab, setLayoutTab] = useState<"page" | "fields">("page");
  const [inventory, setInventory] = useState<DocumentFieldInventoryEntry[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);

  /**
   * The key a new field will carry when the operator next clicks the page, or null for fixed text.
   *
   * A ref as well as state because `onLayoutPointerDown` is attached to the framed document once and
   * outlives the render that armed it — the same reason `addModeRef` exists beside `addMode`. This
   * is what the table's "Add a box" arms: the owner, 2026-09-03, "Phoenix is not showing a field
   * where a field should be populated so I can add the field and put it here." Rather than invent
   * coordinates for him, the table arms the key and he clicks where it goes, which is the existing
   * add path and the one that has been used against real paper.
   */
  const pendingAddKeyRef = useRef<string | null>(null);
  const [pendingAddKey, setPendingAddKey] = useState<string | null>(null);



  const previewUrl = useMemo(() => {
    const version = versionId ? `&version=${encodeURIComponent(versionId)}` : "";
    return `/api/hiring-pack/${encodeURIComponent(hrId)}/print?document=${documentKey}&copies=${copies}&preview=1${version}`;
  }, [copies, documentKey, hrId, versionId]);

  /**
   * The same document, answered as its field list instead of its page.
   *
   * Built off `previewUrl` on purpose rather than assembled again: the inventory has to describe the
   * document in the panel, and two separately-built urls drift the first time a parameter is added
   * to one of them. `preview=1` is already on it, so opening the field table never stamps a document
   * as printed.
   */
  const inventoryUrl = `${previewUrl}&inventory=1`;

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

  /** The reload every mutation runs. Called from an event handler, so it may set state at once. */
  const loadFields = useCallback(async () => {
    setFieldsLoading(true);
    setFieldsError(null);
    try {
      const payload = await fetchDocumentFields(fieldsUrl);
      setFields(payload.rows);
      fieldsRef.current = payload.rows;
      setCarryOffer(payload.carryForward);
      setChanged(payload.changed);
    } catch (cause) {
      setFieldsError(cause instanceof Error ? cause.message : "Could not load the layout.");
    } finally {
      setFieldsLoading(false);
    }
  }, [fieldsUrl]);

  /**
   * Load the layer whenever the panel is open for a document and version.
   *
   * Every setState here sits inside the fetch's own callback rather than in the effect body. That is
   * the line `react-hooks/set-state-in-effect` draws: subscribing to an external system and setting
   * state when it answers is what an effect is for; setting state on the way in is the cascading
   * render it exists to stop. The spinner is therefore raised by the click, in `toggleLayoutMode`.
   *
   * `live` closes a real race the previous shape had. Changing document or version while the panel
   * is open starts a second read without cancelling the first, so a slow reply for the OLD url could
   * land last and paint the previous document's rows over this one — and nothing on screen says
   * which document answered, so they would read as this document's own layout.
   */
  useEffect(() => {
    if (!layoutMode) return;
    let live = true;
    void fetchDocumentFields(fieldsUrl).then(
      (payload) => {
        if (!live) return;
        setFields(payload.rows);
        fieldsRef.current = payload.rows;
        setCarryOffer(payload.carryForward);
        setChanged(payload.changed);
        setFieldsError(null);
        setFieldsLoading(false);
      },
      (cause: unknown) => {
        if (!live) return;
        setFieldsError(cause instanceof Error ? cause.message : "Could not load the layout.");
        setFieldsLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [fieldsUrl, layoutMode]);

  /**
   * Save one field-layer row — a move, a resize, a hide, or a brand-new field — then reload both the
   * layout and the printed page from the server, the same discipline `commit` above already follows
   * for a typed value: nothing here is ever patched onto the screen optimistically.
   */
  const commitLayoutField = useCallback(
    async (write: PendingWrite, options?: { keepPage?: boolean }): Promise<DocumentFieldRow | null> => {
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
        const body = (await response.json().catch(() => null)) as {
          message?: string;
          field?: DocumentFieldRow;
        } | null;
        if (!response.ok) {
          throw new Error(body?.message ?? `Could not save the field (${response.status}).`);
        }
        setNotice("Layout saved.");
        await loadFields();
        // `keepPage` leaves the document exactly as it stands. Only the arrow-key nudge asks for it,
        // and only because the reload is what breaks it: see `onLayoutKeyDown`. Every other caller
        // rebuilds, which is right for them — a drag has already been let go of, and hiding, adding
        // or deleting a field changes what the page contains rather than only where one box sits.
        if (!options?.keepPage) {
          setLayoutSelection(null);
          setReloadToken((token) => token + 1);
        }
        return body?.field ?? null;
      } catch (cause) {
        setFieldsError(cause instanceof Error ? cause.message : "Could not save the field.");
        return null;
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

  /**
   * Bring a previous version's layout onto this one.
   *
   * CONFIRMED IN PLAIN WORDS, and never automatic — the reason is in `field-layout-store.ts`, but
   * the short version is that a page document's coordinates are read off the authority's artwork.
   * If the artwork moved between versions, carrying a coordinate forward puts text in the wrong
   * place on a government form, and the only person who can see whether it moved is the one with
   * both versions in front of them.
   */
  const carryLayoutForward = useCallback(async () => {
    const offer = carryOffer;
    if (!offer) return;
    const sure = window.confirm(
      `Bring ${offer.fields} field${offer.fields === 1 ? "" : "s"} from ${offer.fromLabelEn} onto this version?

` +
        "Positions come across exactly as they were. If the artwork changed between the two " +
        "versions, check every box on the page afterwards — a coordinate that was right on the old " +
        "page can land somewhere else on the new one.",
    );
    if (!sure) return;
    setLayoutBusy(true);
    setFieldsError(null);
    try {
      const response = await fetch("/api/hiring-pack/document-fields", {
        body: JSON.stringify({
          document: documentKey,
          fromTemplateVersionId: offer.fromTemplateVersionId,
          intent: "carryForward",
          toTemplateVersionId: offer.intoTemplateVersionId,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as { carried?: number; message?: string } | null;
      if (!response.ok) {
        throw new Error(body?.message ?? `Could not carry the layout forward (${response.status}).`);
      }
      setNotice(
        `${body?.carried ?? 0} field${body?.carried === 1 ? "" : "s"} brought over from ${offer.fromLabelEn}. ` +
          "Check each one against the page.",
      );
      await loadFields();
      setReloadToken((token) => token + 1);
    } catch (cause) {
      setFieldsError(cause instanceof Error ? cause.message : "Could not carry the layout forward.");
    } finally {
      setLayoutBusy(false);
    }
  }, [carryOffer, documentKey, loadFields]);

  /**
   * Open what one field used to say.
   *
   * Fetched on demand rather than carried with the layout: a previous state is a whole placement,
   * and nobody opens thirty-three of them. The row is put on screen before the answer arrives so the
   * panel names the field it is loading — an empty panel that fills in later reads as a broken one.
   *
   * NOT RACE-GUARDED with a `live` flag like the layout reads. The answer is STAMPED with the id it
   * belongs to and the panel draws it only when that matches the row on screen, so a slow reply for
   * a row the operator has moved on from renders nothing rather than appearing under a new heading.
   */
  const openHistory = useCallback(async (row: DocumentFieldRow) => {
    setHistoryRow(row);
    setHistory(null);
    setHistoryError(null);
    try {
      const response = await fetch(
        `/api/hiring-pack/document-fields?historyFor=${encodeURIComponent(row.id)}`,
      );
      const body = (await response.json().catch(() => null)) as
        | { history?: FieldHistoryEntry[]; message?: string }
        | null;
      if (!response.ok) {
        throw new Error(body?.message ?? `Could not read the history (${response.status}).`);
      }
      setHistory({ entries: body?.history ?? [], fieldId: row.id });
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : "Could not read the history.");
    }
  }, []);

  /**
   * Read the template's field list whenever the table is the visible half.
   *
   * Same shape as the field-layer read above, and for the same two reasons: every setState sits
   * inside the promise's callback rather than in the effect body, and `live` guards the race where
   * changing document while the table is open lets a slow reply for the OLD one land last. That
   * failure is quiet — the rows would simply be another document's fields under this one's heading.
   *
   * `reloadToken` is a dependency deliberately. It is bumped after every save, and the inventory
   * carries each field's CURRENT value, so without it the table would keep showing what a field
   * printed before the rule that just changed it.
   */
  useEffect(() => {
    if (!layoutMode || layoutTab !== "fields") return;
    let live = true;
    void fetchDocumentInventory(inventoryUrl).then(
      (entries) => {
        if (!live) return;
        setInventory(entries);
        setInventoryLoading(false);
      },
      (cause: unknown) => {
        if (!live) return;
        setFieldsError(cause instanceof Error ? cause.message : "Could not read this template's fields.");
        setInventoryLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [inventoryUrl, layoutMode, layoutTab, reloadToken]);  /**
   * Put a rule ON THE PAPER before it is anybody's rule — the field table's dry run.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   * WRITTEN INTO THE IFRAME'S DOM, NOT RENDERED BY THE SERVER, and that is a deliberate trade.
   * Rendering it properly would mean threading a pending override through all ten renderers' value
   * maps, and it would put text nobody has saved onto the route that also PRINTS. Here it cannot:
   * this is a `preview=1` frame, the change lives only in this browser, and the next reload — which
   * every save triggers anyway — erases it.
   *
   * A CALLBACK, NOT AN EFFECT, and that had to change: reading `frameRef.current` inside an effect
   * makes every later write to the framed document a lint error, because the compiler then treats
   * the ref as effect state. A keystroke is what changes the paper, so the keystroke is what calls
   * this — which is also the more honest description of what happens.
   *
   * `text: null` means the rule resolves to NOTHING for this employee. That is a real answer rather
   * than an absence — a placeholder with no value blanks the whole field — so the box is emptied and
   * ringed in red instead of being left showing the old value.
   *
   * WHAT IT CANNOT SHOW, said plainly rather than papered over: a compiled field whose value is
   * empty is not in the markup at all, since `renderPlacement` drops an empty placement, so there is
   * no box to write into. The table disables the button in that case and says why; the repair there
   * is to add a box, which it already offers.
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   */
  const applyDryRun = (dry: { key: string; text: string | null } | null) => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;

    // THE UNDO LIVES ON THE NODE, not in a ref beside it. A reload replaces the whole document, so
    // a remembered element is a detached node the moment anything is saved — whereas markup parked
    // in the element's own dataset goes away with it, and the query below simply finds nothing.
    for (const marked of doc.querySelectorAll<HTMLElement>("[data-hp-dry]")) {
      const original = marked.dataset.hpDryOriginal;
      if (original !== undefined) marked.innerHTML = original;
      marked.removeAttribute("data-hp-dry");
      marked.removeAttribute("data-hp-dry-empty");
      marked.removeAttribute("data-hp-dry-original");
    }
    if (!dry) return;

    const element = doc.querySelector<HTMLElement>(`[data-hp-key="${CSS.escape(dry.key)}"]`);
    if (!element) return;

    // A box grid paints one character per printed cell as positioned children, so overwriting its
    // text would destroy the grid rather than preview anything. Those are left alone; the field
    // table still reports what the rule resolves to and how many people it fills for.
    if (
      element.classList.contains("grid") ||
      element.classList.contains("tick") ||
      element.classList.contains("wage")
    ) {
      return;
    }

    element.dataset.hpDryOriginal = element.innerHTML;
    element.textContent = dry.text ?? "";
    element.setAttribute("data-hp-dry", "true");
    if (dry.text === null || dry.text === "") {
      element.setAttribute("data-hp-dry-empty", "true");
    }
  };

  /**
   * The nudge handler, through a ref for the same reason `commitLayoutField` is: `enhance` attaches
   * it to the framed document ONCE per page load, and a listener captured then would otherwise be
   * the version of the function that existed at load — holding the copies count and surface the
   * document had before any of them could change.
   */
  const onLayoutKeyDownRef = useRef<(event: KeyboardEvent) => void>(() => {});

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
        // What the new field will PRINT. The table arms a key when the operator asked for a box for
        // a value the template does not place; a plain "Add field" arms nothing and gets empty text
        // to type into. Read from the ref rather than the state for the reason at its declaration —
        // this listener was attached once, long before the button was pressed.
        const armed = pendingAddKeyRef.current;
        const addedSource: DocumentFieldSource = armed
          ? { kind: "value", key: armed }
          : { kind: "literal", text: "" };
        pendingAddKeyRef.current = null;
        setPendingAddKey(null);

        // CLEARING THE STATE IS NOT ENOUGH — the crosshair lives on a CLASS on the framed body.
        // `applyLayoutClasses` is called from the toggles and from `enhance`, and from nowhere
        // else; no effect re-syncs it when `addMode` changes. So every exit here used to set
        // `addMode` false and leave `hp-adding-field` on the document, which left the page under
        // a crosshair, still LOOKING armed, after the box had already been placed. The next click
        // then selected a field instead of adding one, and the only tell was a cursor.
        const disarm = () => {
          addModeRef.current = false;
          setAddMode(false);
          applyLayoutClasses(doc, layoutModeRef.current, false);
        };

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
            source: addedSource,
            w: 140,
            x: Math.max(0, xPt - 60),
            y: Math.max(0, yPt - 7),
          });
        } else {
          const copyRoot = target.closest(".copy") ?? doc.body;
          if (target === copyRoot) {
            setFieldsError("Click on some text or a cell to anchor the new field there.");
            disarm();
            return;
          }
          const selector = cssPathWithin(copyRoot, target);
          if (!selector) {
            setFieldsError("Could not place a field there — try a different spot.");
            disarm();
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
            source: addedSource,
            w: 140,
            x: 0,
            y: 0,
          });
        }
        disarm();
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
      // Arrow-key nudging. On the FRAMED document because that is where focus sits after a box is
      // clicked — the parent gets its own listener below, for when focus has moved to the panel.
      //
      // THROUGH A WRAPPER, NOT `onLayoutKeyDownRef.current` DIRECTLY. This block runs once per page
      // load, and passing the ref's value would register whatever it held AT THAT MOMENT — the
      // do-nothing placeholder, since the effect that fills it has not run yet. Arrow keys would
      // then do nothing at all, on a page that looks entirely wired. Reading the ref inside the
      // wrapper defers the lookup to the keypress.
      doc.addEventListener("keydown", (event) => onLayoutKeyDownRef.current(event));
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


  /**
   * Arrow keys move the selected box: 1pt a press, 10pt with Shift.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   * SPEED RATHER THAN CAPABILITY, and worth saying so plainly: the fine-tune panel below already
   * takes exact X, Y, width and height in points, so nothing here is otherwise unreachable. But
   * nudging a point at a time while watching the paper is a different activity from typing a number
   * and re-reading the page, and on Form 1 — whose boxes are the government's own printed cells — a
   * single point is the difference between a digit sitting in its cell and sitting on the line.
   *
   * IT MOVES THE ELEMENT FIRST AND SAVES AFTERWARDS, exactly as a drag does. The box follows the key
   * immediately; `buildSelectionFromElement` then reads the geometry back off the live element, so a
   * nudge and a drag produce the identical write and neither can disagree with the other about where
   * a field ended up.
   *
   * THE SAVE IS DEBOUNCED, which is the whole reason this is not three lines. A held arrow key
   * repeats about thirty times a second; committing per press would be a round trip per repeat, and
   * they would land out of order — the field's final position decided by whichever POST the network
   * happened to deliver last. One write, after the movement stops.
   *
   * AND THE SAVE DOES NOT RELOAD THE PAGE — `keepPage`. This is the difference between the feature
   * working and appearing to work, and it was found by measuring rather than by reading: every
   * other save rebuilds the framed document, which discards `data-hp-selected` with the rest of the
   * DOM. Correct for a drag, where the hand has already let go. Fatal here, because the operator is
   * still tapping: the box moves, settles, saves, and then every further press is silently dropped
   * for the two or three seconds the rebuild takes, with nothing on screen to say the selection is
   * gone. Nothing needs rebuilding anyway — the element was the SOURCE of the write, so the page
   * already shows what was saved. The one thing the rebuild did carry is handled in `save` below.
   *
   * IT REFUSES TO ACT WHILE SOMETHING IS BEING TYPED INTO. The panel's own X/Y inputs are arrow-key
   * targets in their own right, and a search box is one screen away; stealing those presses would
   * make a number impossible to correct with the keyboard while a box happened to be selected.
   */
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The write a pending nudge would make, so closing the editor can run it rather than lose it. */
  const pendingNudgeRef = useRef<(() => void) | null>(null);
  /** The nudge save currently in flight, so a following one waits for the row id it will produce. */
  const nudgeSaveRef = useRef<Promise<void> | null>(null);

  const onLayoutKeyDown = useCallback((event: KeyboardEvent) => {
    if (!layoutModeRef.current) return;

    const step = event.key === "ArrowLeft" || event.key === "ArrowRight" ? 1 : 0;
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown" ? 1 : 0;
    if (step === 0 && vertical === 0) return;

    // Never while typing. `isContentEditable` covers the framed document's own free-edit spans,
    // which are the case a tag-name test alone would miss.
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) {
      return;
    }

    const doc = frameRef.current?.contentDocument;
    const element = doc?.querySelector<HTMLElement>("[data-hp-selected]");
    if (!doc || !element) return;

    event.preventDefault();

    const amount = event.shiftKey ? 10 : 1;
    const dx = event.key === "ArrowRight" ? amount : event.key === "ArrowLeft" ? -amount : 0;
    const dy = event.key === "ArrowDown" ? amount : event.key === "ArrowUp" ? -amount : 0;

    // Clamped at zero on the top and left, the same bound the drag applies. There is deliberately
    // no upper bound here either: the off-page WARNING is what names a box pushed past the right or
    // bottom edge, and a hard stop at the edge would make a box that is already outside impossible
    // to walk back into view.
    const left = Math.max(0, (Number.parseFloat(element.style.left) || 0) + dx);
    const top = Math.max(0, (Number.parseFloat(element.style.top) || 0) + dy);
    element.style.left = `${left.toFixed(2)}pt`;
    element.style.top = `${top.toFixed(2)}pt`;

    /** Read the box as it stands right now, including any row id a save has since stamped on it. */
    const readBox = () => {
      const rowId = element.getAttribute("data-hp-field");
      const existing = rowId ? (fieldsRef.current.find((row) => row.id === rowId) ?? null) : null;
      return buildSelectionFromElement(doc, element, copies, surface, existing);
    };

    const write = readBox();
    if (!write) return;

    // The panel below follows the box, so the numbers on screen are the numbers being saved.
    setLayoutSelection(write);

    const save = () => {
      pendingNudgeRef.current = null;
      // REBUILT AT FIRE TIME rather than reused from the press. Two things move in between, and
      // the second is the one that matters: the box has usually been nudged again, and a save that
      // was in flight may have just stamped this element with its new row id. `saveDocumentField`
      // INSERTS any write carrying no id, so a press-time write would try to create a second
      // override for a field that now has one — refused by the unique index, and presented to the
      // operator as an unexplained save failure. The press-time write survives only as the fallback
      // for the flush below, where the frame is being torn down and there is nothing left to read.
      const live = (element.isConnected ? readBox() : null) ?? write;
      const inFlight = commitLayoutFieldRef
        .current(live, { keepPage: true })
        .then((saved) => {
          if (nudgeSaveRef.current === inFlight) nudgeSaveRef.current = null;
          if (!saved || !element.isConnected) return;
          element.setAttribute("data-hp-field", saved.id);
        });
      nudgeSaveRef.current = inFlight;
    };
    pendingNudgeRef.current = save;
    if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
    nudgeTimerRef.current = setTimeout(() => {
      nudgeTimerRef.current = null;
      // NEVER TWO IN FLIGHT. The second would be built before the first had stamped its row id,
      // which is the same insert-twice problem one step earlier.
      const running = nudgeSaveRef.current;
      if (running) void running.then(save);
      else save();
    }, NUDGE_SAVE_MS);
  }, [copies, surface]);

  /**
   * Keep the nudge handler current, and let the arrow keys work from OUTSIDE the frame too.
   *
   * Two listeners for one gesture because there are two documents. Clicking a box puts focus in the
   * framed document; reaching for the fine-tune panel below puts it in this one. A single listener
   * on either would work until the operator touched the other half of the screen, and then stop
   * silently — which reads as the feature being unreliable rather than as a missing listener.
   *
   * THE PENDING NUDGE IS FLUSHED ON THE WAY OUT, not dropped. Closing the editor within half a
   * second of the last press would otherwise discard a move the operator watched happen on screen,
   * and nothing would say so — the box would simply be back where it started next time.
   */
  useEffect(() => {
    onLayoutKeyDownRef.current = onLayoutKeyDown;
  });

  useEffect(() => {
    if (!layoutMode) return;
    const handler = (event: KeyboardEvent) => onLayoutKeyDownRef.current(event);
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [layoutMode]);

  useEffect(() => {
    return () => {
      const pending = nudgeTimerRef.current;
      if (!pending) return;
      clearTimeout(pending);
      nudgeTimerRef.current = null;
      pendingNudgeRef.current?.();
    };
  }, []);

  /** Turn layout mode on or off, on the page and in the frame, in one action. */
  const toggleLayoutMode = useCallback(() => {
    const next = !layoutModeRef.current;
    layoutModeRef.current = next;
    setLayoutMode(next);
    // The effect above does the reading; the spinner belongs to the click that asked for it, since
    // an effect may not raise it synchronously.
    if (next) setFieldsLoading(true);
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
      pendingAddKeyRef.current = null;
      setPendingAddKey(null);
      setLayoutTab("page");
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
    // Turning add mode off by hand abandons whatever the table armed. Leaving the key behind would
    // put it on the NEXT field added, minutes later and for a different reason.
    pendingAddKeyRef.current = null;
    setPendingAddKey(null);
    const doc = frameRef.current?.contentDocument;
    if (doc) applyLayoutClasses(doc, layoutModeRef.current, next);
  }, []);

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // DECLARED AFTER `enhance`, AND THAT ORDER IS LOAD-BEARING. These three read the framed
  // document out of `frameRef`, and `enhance` writes a marker onto its body to record that the
  // layout listeners are already attached. The React compiler reads the component top to bottom:
  // with these ABOVE `enhance`, that write becomes "modifying a value previously passed as an
  // argument to a hook" and `react-hooks/immutability` fails the build — the same rule, and the
  // same position in the file, as the two toggles just above. Nothing else about them changes.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  /**
   * Build the write for a field the template already places, by reading the box itself.
   *
   * The geometry is read from the LIVE element rather than remembered, because the table and the
   * page are two views of one row: a field dragged a moment ago has coordinates the table never saw,
   * and writing remembered ones back would silently undo the drag. Returns null when the box is not
   * on the page — which on a page surface means its value is empty, since `renderPlacement` drops an
   * empty placement entirely. There is nothing to override in that case; the answer is to add a box,
   * which is what the table offers instead.
   */
  const writeForKey = useCallback(
    (key: string): PendingWrite | null => {
      const doc = frameRef.current?.contentDocument;
      if (!doc) return null;
      const element = doc.querySelector<HTMLElement>(`[data-hp-key="${CSS.escape(key)}"]`);
      if (!element) return null;
      const fieldId = element.getAttribute("data-hp-field");
      const existing = fieldId ? (fieldsRef.current.find((row) => row.id === fieldId) ?? null) : null;
      const write = buildSelectionFromElement(doc, element, copies, surface, existing);
      if (!write) return null;
      // A compiled default has no row yet, so the write that creates one must name the key it is
      // overriding. Without `defaultKey` the row would be stored as an ADDED field sitting on top of
      // the value it was meant to replace, and both would print.
      return { ...write, defaultKey: existing?.defaultKey ?? key };
    },
    [copies, surface],
  );

  /**
   * Save the rule for one of the template's own fields — or drop it and go back to the record.
   *
   * "Back to the record" restores the SOURCE and keeps everything else, rather than deleting the
   * row: an override may also be carrying a position the operator dragged, and throwing that away
   * because they changed their mind about the wording would move the field back under the artwork
   * they moved it off.
   */
  const saveFieldRule = useCallback(
    (entry: DocumentFieldInventoryEntry, text: string | null) => {
      const write = writeForKey(entry.key);
      if (!write) {
        setFieldsError(
          `"${entry.labelEn ?? entry.key}" prints nothing at the moment, so there is no box to change. Use "Add a box" and click where it belongs.`,
        );
        return;
      }
      void commitLayoutField({
        ...write,
        source: text === null ? { kind: "value", key: entry.key } : { kind: "literal", text },
      });
    },
    [commitLayoutField, writeForKey],
  );

  /** Retype a field the operator added. Its geometry is already on the row, so nothing is read back. */
  const saveRowText = useCallback(
    (row: DocumentFieldRow, text: string) => {
      void commitLayoutField({
        align: row.align,
        anchor: row.anchor,
        defaultKey: row.defaultKey,
        h: row.h,
        hidden: row.hidden,
        id: row.id,
        page: row.page,
        size: row.size,
        source: { kind: "literal", text },
        w: row.w,
        x: row.x,
        y: row.y,
      });
    },
    [commitLayoutField],
  );

  /**
   * Arm the page to receive a new box, carrying `key` or, for null, fixed text of its own.
   *
   * Switches to the page tab because the next act is a click on the paper — leaving the table up
   * would arm a mode with nothing visible to use it on, which reads as the button doing nothing.
   */
  const armAddBox = useCallback((key: string | null) => {
    pendingAddKeyRef.current = key;
    setPendingAddKey(key);
    addModeRef.current = true;
    setAddMode(true);
    setLayoutTab("page");
    setLayoutSelection(null);
    setFieldsError(null);
    const doc = frameRef.current?.contentDocument;
    if (doc) applyLayoutClasses(doc, layoutModeRef.current, true);
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
            {/* TABLE FOR CONTENT, PAGE FOR POSITION — the owner's own division of the two jobs,
                chosen on 2026-09-03. Both tabs write the same field-layer rows, so this is one
                editor seen two ways rather than two editors that have to be kept in step. */}
            <div className="flex w-full rounded-xl border border-phx-accent-line bg-white p-0.5">
              {(["page", "fields"] as const).map((tab) => (
                <button
                  className={cn(
                    "flex-1 rounded-lg px-3 py-1.5 text-phx-2xs font-semibold",
                    layoutTab === tab
                      ? "bg-phx-accent text-white"
                      : "text-phx-ink-soft hover:bg-phx-accent/10",
                  )}
                  key={tab}
                  onClick={() => {
                    setLayoutTab(tab);
                    if (tab === "fields") setInventoryLoading(true);
                  }}
                  type="button"
                >
                  {tab === "page" ? "Page — move things" : "Fields — what goes in them"}
                </button>
              ))}
            </div>

            {pendingAddKey ? (
              <div className="flex items-start gap-2 rounded-xl border border-phx-accent-line bg-white px-3 py-2 text-phx-xs text-phx-ink">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-phx-accent" />
                <span>
                  Now click the spot on the page where{" "}
                  <strong>{paperFieldBinding(pendingAddKey)?.labelEn ?? pendingAddKey}</strong>{" "}
                  should print.
                </span>
              </div>
            ) : null}

            {layoutTab === "fields" ? (
              <FieldTable
                busy={layoutBusy}
                changed={changed}
                document={documentKey}
                entries={inventory}
                error={fieldsError}
                loading={inventoryLoading}
                onAddBox={armAddBox}
                onDryRun={applyDryRun}
                onDeleteRow={(row) => {
                  const sure = window.confirm(
                    row.defaultKey
                      ? "Remove this override? It returns to its default position."
                      : "Delete this field?",
                  );
                  if (sure) void deleteLayoutField(row.id);
                }}
                onOpenHistory={(row) => void openHistory(row)}
                onSaveRule={saveFieldRule}
                onSaveRowText={saveRowText}
                onToggleHidden={(row) => void commitLayoutField({
                  align: row.align,
                  anchor: row.anchor,
                  defaultKey: row.defaultKey,
                  h: row.h,
                  hidden: !row.hidden,
                  id: row.id,
                  page: row.page,
                  size: row.size,
                  source: row.source,
                  w: row.w,
                  x: row.x,
                  y: row.y,
                })}
                rows={fields}
                surface={surface}
              />
            ) : (
              <>
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

            {/*
              WORK ON AN EARLIER VERSION OF THIS TEMPLATE, WHICH THIS VERSION CANNOT SEE.
              Field rows are scoped to a template version so an archived contract reprints as the
              document that was signed — which means the day a template is replaced, every change
              made to the old one silently stops appearing. This is the only place that says so.
              It offers; it never acts on its own. See `carryLayoutForward`.
            */}
            {carryOffer ? (
              <div className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-phx-xs text-amber-900 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-2">
                  <History className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    <strong>
                      {carryOffer.fromLabelEn} has {carryOffer.fields} field
                      {carryOffer.fields === 1 ? "" : "s"} you changed.
                    </strong>{" "}
                    This version starts from the built-in layout, so none of them appear here. Bring
                    them over, then check each one against the page — if the paper itself changed
                    between the two versions, a position that was right before can land elsewhere.
                  </span>
                </div>
                <Button
                  className="shrink-0 gap-1 self-start"
                  disabled={layoutBusy}
                  onClick={() => void carryLayoutForward()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <History className="h-3.5 w-3.5" />
                  Bring them over
                </Button>
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
              </>
            )}
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

      {/* WHAT A FIELD USED TO SAY. An overlay at the end of the tree rather than a card inside the
          table, so it sits above whichever tab is open and cannot be clipped by the table's own
          scrolling container. Opened today from a table row; anything else that learns to open it
          needs no change here. */}
      {historyRow ? (
        <FieldHistoryPanel
          entries={history?.fieldId === historyRow.id ? history.entries : null}
          error={historyError}
          onClose={() => {
            setHistoryRow(null);
            setHistory(null);
            setHistoryError(null);
          }}
          row={historyRow}
        />
      ) : null}
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
