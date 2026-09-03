// The field layer: what an operator has moved, added, hidden or retyped on a printed document.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. The owner, 2026-09-03: "i want to be able to add anyfield wherever i want and
// edit text and drage drop fields and full control", across every document, saved live.
//
// Until now a printed document's field positions were compiled in. `form1-layout.ts` and its three
// siblings hold coordinate tables transcribed out of the government's own PDFs, and the six typeset
// documents place nothing at all — their values sit wherever the prose puts them. Changing where
// something printed meant editing TypeScript and shipping a deploy. This is the layer that lets it
// be done on the page, by the person looking at the page.
//
// THE COMPILED TABLES REMAIN THE DEFAULT, AND THEY REMAIN THE TRUTH. Nothing here edits them. A
// stored row is an OVERLAY: it moves a compiled placement, hides one, or adds a field that was
// never compiled. Reset deletes the overlay rows and the document returns to exactly what the
// source says — which matters most on the four government forms, whose coordinates are readings off
// the Authority's own artwork and whose default is therefore correct by construction. A layout
// somebody dragged is an opinion; the compiled table is a measurement, and the measurement has to
// survive the opinion being wrong.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TWO SURFACES, BECAUSE THE DOCUMENTS ARE GENUINELY TWO KINDS OF THING, AND A SINGLE COORDINATE
// MODEL ACROSS BOTH WOULD BE A LIE.
//
//   PAGE surfaces — form1, form6, resignation, mutualTermination. Official artwork at the source
//   PDF's exact size, one `<section class="sheet">` per printed side, values absolutely positioned
//   in points from the top-left. A field at (x, y) lands on the same millimetre of paper every
//   time, for every employee, because the page cannot reflow: its size is fixed and its content is
//   a picture. Absolute coordinates are not merely workable here, they are the only honest model.
//
//   FLOW surfaces — contract, workerDataForm, custodyLaptop, custodyMobile, clearanceEmployee,
//   clearanceCompany. These are typeset. Each is ONE `<table class="sheet">` that Chrome breaks
//   across as many A4 pages as the text needs, so there is no DOM node per printed page and no
//   stable page coordinate to store. A contract for an employee with a longer name, a longer job
//   title, or an extra line of address breaks in a different place — so a field stored as "page 2,
//   180pt down" lands mid-sentence on the next employee, or on page 3, with nothing to warn anyone.
//
//   So on a flow surface a field ANCHORS to a block of the document and carries an offset from it.
//   Drag and drop behaves identically for the operator; what differs is what the drop MEANS. A
//   field dropped beside مادة (7) stays beside مادة (7) — it travels with its clause across every
//   reflow, which is what someone dropping it there actually wants. The anchor is a CSS path, and
//   it is stable by construction rather than by luck: a field belongs to one template VERSION, and
//   a version's markup never changes. Replacing a document's text creates a new version — the
//   owner's rule of 2026-08-30, "any paper I replace, it goes to the archive" — so the markup a
//   path was recorded against is the markup it will be resolved against, permanently.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import type { Placement } from "@/lib/hiring-pack/render-placement";
import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import type { HiringPackDocument } from "@/lib/hiring-pack/types";

/** Whether a document places by page coordinate or by anchor in the flow. */
export type DocumentSurface = "page" | "flow";

/**
 * Which surface each document is, for all ten.
 *
 * Keyed by the document union with no index signature, so an eleventh document cannot be added
 * without deciding this — the same reason the print route keys its renderer table this way. There
 * is no sensible default to fall back on: guessing `page` for a typeset document produces fields
 * that drift silently as the text reflows, which is precisely the failure this file exists to
 * avoid, and guessing `flow` for a government form throws away the exact coordinates that are the
 * whole reason those forms print correctly.
 */
export const DOCUMENT_SURFACES: Readonly<Record<HiringPackDocument, DocumentSurface>> = {
  contract: "flow",
  form1: "page",
  workerDataForm: "flow",
  custodyLaptop: "flow",
  custodyMobile: "flow",
  form6: "page",
  resignation: "page",
  mutualTermination: "page",
  clearanceEmployee: "flow",
  clearanceCompany: "flow",
};

export function documentSurface(document: HiringPackDocument): DocumentSurface {
  return DOCUMENT_SURFACES[document];
}

/**
 * Where a field's printed text comes from.
 *
 * `value` prints whatever the employee's record says, through the same values map every compiled
 * placement reads — so a field added here behaves like one that was always there: it fills for
 * every employee, it stays correct when the record changes, and it is blank when the record is.
 *
 * `literal` prints a fixed string. It is the answer to "write the word مسلسل here", and it is the
 * one thing that must NEVER masquerade as data: a literal that looks like a value is how a stale
 * number gets printed on four hundred documents. The editor labels it as fixed text, and
 * `fieldPrintedValue` below is the only place either kind is resolved, so there is one answer.
 */
export type DocumentFieldSource =
  | { kind: "value"; key: string }
  | { kind: "literal"; text: string };

/** Where a flow-surface field hangs: a CSS path within its template version, plus an offset. */
export type FlowAnchor = {
  /** A CSS selector resolved against the rendered document. */
  selector: string;
  /** Offset from the anchor's top-left, in points. */
  dx: number;
  dy: number;
};

/**
 * One stored row of the field layer.
 *
 * A ROW IS EITHER AN OVERRIDE OR AN ADDITION, told apart by `defaultKey`. An override names the
 * compiled placement it replaces and may move it, resize it, or hide it; an addition has no
 * compiled counterpart and carries its own source. Keeping both in one table is deliberate: they
 * are the same thing to the person dragging them, they merge in the same pass, and "reset this
 * document" is one delete either way.
 */
export type DocumentFieldRow = {
  id: string;
  document: HiringPackDocument;
  /** The template version this layout belongs to. A version's markup never changes; see above. */
  templateVersionId: string;
  /** The compiled placement key this row replaces, or null when the row adds a new field. */
  defaultKey: string | null;
  /** A compiled default suppressed. Only ever true on an override — an addition is deleted, not hidden. */
  hidden: boolean;
  /** Which printed side, 1-based. Page surfaces only; null on a flow surface. */
  page: number | null;
  /** Where it hangs in the flow. Flow surfaces only; null on a page surface. */
  anchor: FlowAnchor | null;
  x: number;
  y: number;
  w: number;
  h: number;
  align: "right" | "center" | "left";
  size: number;
  source: DocumentFieldSource;
  updatedAt: string;
  updatedByHrId: string | null;
};

/**
 * The values-map key under which an added field's literal text is passed to the renderer.
 *
 * Prefixed and carrying the row id, for two reasons that both bite. It cannot collide with a real
 * data key — `insuredName` means one thing everywhere and a literal must never shadow it — and it
 * cannot collide with ANOTHER literal, which is what a shared key like `literal` would do the
 * moment two fixed strings are added to one page: the second would silently print the first's text.
 */
export function literalValueKey(rowId: string): string {
  return `hpLiteral:${rowId}`;
}

/** What a row actually prints, and under which values-map key it is looked up. */
export function fieldPrintedValue(row: DocumentFieldRow): { key: string; literal: string | null } {
  if (row.source.kind === "literal") {
    return { key: literalValueKey(row.id), literal: row.source.text };
  }
  return { key: row.source.key, literal: null };
}

/** The placement a row describes, in the shape the existing renderer already consumes. */
function rowPlacement(row: DocumentFieldRow): Placement {
  return {
    kind: "text",
    key: fieldPrintedValue(row).key,
    fieldId: row.id,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    align: row.align,
    size: row.size,
  };
}

/**
 * Move the geometry of a compiled placement without changing what it is.
 *
 * A `digits` grid stays a digits grid and a `tick` stays a tick — dragging a box grid must not
 * silently turn it into a run of text, because the grid's whole job is to put one digit in each of
 * the form's printed boxes. So a move rewrites position and size in the shape the placement already
 * has, and a `digits` placement's cell PITCH scales with the width the operator dragged, which is
 * what keeps its digits under the boxes when the grid is nudged or stretched.
 */
function movedPlacement(placement: Placement, row: DocumentFieldRow): Placement {
  // `fieldId` is the OVERRIDE row's own id, not a fact about the compiled default — it lets the
  // editor address "the row that moved this default" without a second lookup by `defaultKey`, the
  // same way an ADDED field is already addressed by `rowPlacement` above.
  if (placement.kind === "tick") {
    return { ...placement, fieldId: row.id, x: row.x, y: row.y, w: row.w, h: row.h };
  }
  if (placement.kind === "digits") {
    const width = placement.pitch * placement.cells;
    const scale = width > 0 ? row.w / width : 1;
    return {
      ...placement,
      fieldId: row.id,
      x: row.x,
      y: row.y,
      h: row.h,
      pitch: placement.pitch * scale,
      size: row.size,
    };
  }
  return {
    ...placement,
    fieldId: row.id,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    align: row.align,
    size: row.size,
  };
}

export type MergedPage = {
  /** What to render, compiled defaults and added fields together, in print order. */
  placements: Placement[];
  /** Literal text the added fields print, to be merged into the values map. */
  literals: Record<string, string>;
};

/**
 * The effective placements for ONE printed side of a page surface.
 *
 * Order matters and is not incidental: defaults keep their compiled order and added fields come
 * after them. Two absolutely positioned spans that overlap are resolved by document order, so a
 * field somebody added on top of a form's own value has to win — otherwise dragging a correction
 * over a wrong value would put the correction UNDERNEATH it, and the page would look unchanged.
 *
 * An override for a key the compiled table no longer has is IGNORED rather than promoted to a new
 * field. That case is real: a placement key removed in a later version leaves rows behind that name
 * it, and resurrecting them would print a value at coordinates nobody has checked since.
 */
export function mergePagePlacements(
  defaults: readonly Placement[],
  rows: readonly DocumentFieldRow[],
  page: number,
): MergedPage {
  const forPage = rows.filter((row) => row.page === page);
  const overrides = new Map<string, DocumentFieldRow>();
  for (const row of forPage) {
    if (row.defaultKey !== null) overrides.set(row.defaultKey, row);
  }

  const placements: Placement[] = [];
  for (const placement of defaults) {
    const override = overrides.get(placement.key);
    if (!override) {
      placements.push(placement);
      continue;
    }
    if (override.hidden) continue;
    placements.push(movedPlacement(placement, override));
  }

  const literals: Record<string, string> = {};
  for (const row of forPage) {
    if (row.defaultKey !== null || row.hidden) continue;
    placements.push(rowPlacement(row));
    const printed = fieldPrintedValue(row);
    if (printed.literal !== null) literals[printed.key] = printed.literal;
  }

  return { placements, literals };
}

/**
 * The overlay markup for a flow surface, as one absolutely positioned span per added field.
 *
 * Returned as HTML to be appended INSIDE the anchor rather than positioned against the page,
 * because on a flowing document the anchor is the only thing that keeps its meaning across a
 * reflow. The caller attaches it; this decides only what a field looks like, so that a field on a
 * contract and a field on Form 1 print identically — same font sizing, same alignment, same
 * escaping — which is the point of having one field layer rather than two.
 */
/**
 * A token-bound document's value map is `Partial<Record<SomeToken, string>>`, never a plain
 * `Record<string, string>` — a token can go unset (an offboarding field before an employee has
 * exited, say), and the six flow-surface renderers all type their maps that way. This accepts any
 * such map rather than asking each renderer to widen or cast its own.
 */
export function renderFlowField(
  row: DocumentFieldRow,
  values: Partial<Record<string, string>>,
): string {
  const printed = fieldPrintedValue(row);
  const text = printed.literal ?? values[printed.key] ?? "";
  if (!text) return "";
  const anchor = row.anchor;
  if (!anchor) return "";
  return (
    `<span class="f txt hp-added" data-hp-key="${escapeHtml(printed.key)}"` +
    ` data-hp-field="${escapeHtml(row.id)}" data-hp-anchor="${escapeHtml(anchor.selector)}"` +
    ` style="left:${anchor.dx}pt;top:${anchor.dy}pt;width:${row.w}pt;height:${row.h}pt;` +
    `line-height:${row.h}pt;text-align:${row.align};font-size:${row.size}pt">` +
    `<span class="ff">${escapeHtml(text)}</span></span>`
  );
}

/**
 * Every literal a document's rows print, ready to merge into the values map.
 *
 * Separate from the merge above because a flow surface never goes through `mergePagePlacements` and
 * still needs its literals resolved. One function, so a literal cannot print on a form and come out
 * blank on a contract.
 */
export function fieldLiterals(rows: readonly DocumentFieldRow[]): Record<string, string> {
  const literals: Record<string, string> = {};
  for (const row of rows) {
    if (row.hidden) continue;
    const printed = fieldPrintedValue(row);
    if (printed.literal !== null) literals[printed.key] = printed.literal;
  }
  return literals;
}

export type LayeredPage = {
  svg: string;
  placements: Placement[];
  values: Record<string, string>;
};

/**
 * Every printed side of a page-surface document, with the field layer already merged in.
 *
 * MERGED ONCE, NOT ONCE PER COPY. Every one of these documents prints two, three or four copies of
 * itself, and the copies are the same paper — a set whose members differ is not a set of copies, it
 * is a mistake nobody will notice until two of them are signed. Doing the merge here, above the copy
 * loop, makes that structural rather than a thing each renderer has to remember.
 *
 * The page NUMBER is the position in this list, 1-based, which is the same number the editor shows
 * and the same one stored on a row. It is derived rather than passed so a renderer cannot number its
 * own sides differently from the screen that placed the fields — the two agreeing is the entire
 * reason a stored coordinate lands where the operator dropped it.
 */
export function layeredPages(
  pages: readonly { svg: string; placements: readonly Placement[] }[],
  values: Record<string, string>,
  fields: readonly DocumentFieldRow[],
): LayeredPage[] {
  return pages.map((page, index) => {
    const merged = mergePagePlacements(page.placements, fields, index + 1);
    return {
      svg: page.svg,
      placements: merged.placements,
      values: Object.keys(merged.literals).length > 0 ? { ...values, ...merged.literals } : values,
    };
  });
}

/**
 * The whole field layer for one FLOW document: its fields, the CSS that positions them, and the
 * script that hangs each on its anchor.
 *
 * WHY A SCRIPT AND NOT SERVER-RENDERED MARKUP. A flow document's body is a typeset template string
 * — six of them, each a few hundred lines of Arabic prose — and nothing outside those files knows
 * where inside them a given clause begins. Splicing a span into the right place server-side would
 * mean every one of the six growing its own injection point, and every future edit to that prose
 * silently moving it. The anchor is resolved at load instead, by the one thing that actually knows
 * the finished document's shape: the browser rendering it. `FIT_TO_BOX_SCRIPT` is already the
 * precedent — these documents already depend on a load-time pass, in print and in the PDF path
 * alike, because Puppeteer runs the page before it prints it.
 *
 * CLONED INTO EVERY COPY, NOT PLACED ONCE. A flow document prints two to four copies of itself,
 * each its own `.copy` element, and `querySelector` would find only the first one's anchor. A field
 * that appeared on the employee's copy and not on the company's is exactly the sort of difference
 * nobody notices until both are signed — so the fields are held inert in a `<template>` and cloned
 * per copy, which makes "every copy is the same paper" structural rather than remembered.
 */
export function flowFieldLayer(
  rows: readonly DocumentFieldRow[],
  values: Partial<Record<string, string>>,
): string {
  const fields = rows
    .filter((row) => !row.hidden && row.anchor !== null)
    .map((row) => renderFlowField(row, values))
    .join("");
  if (!fields) return "";

  return `<template id="hp-flow-fields">${fields}</template>
<style>
  .hp-flow-host { position: relative; }
  .hp-added {
    position: absolute;
    display: block;
    white-space: nowrap;
    overflow: hidden;
    pointer-events: none;
  }
  .hp-added > .ff { display: inline-block; }
</style>
<script>
(function () {
  var place = function () {
    var template = document.getElementById("hp-flow-fields");
    if (!template || !template.content) return;
    var protos = template.content.querySelectorAll("[data-hp-anchor]");
    if (!protos.length) return;
    // Every copy of the document, so all of them carry the same fields. A document that lays its
    // copies out some other way still gets the layer once, against the body.
    var copies = document.querySelectorAll(".copy");
    var scopes = copies.length ? copies : [document.body];
    for (var s = 0; s < scopes.length; s += 1) {
      for (var f = 0; f < protos.length; f += 1) {
        var selector = protos[f].getAttribute("data-hp-anchor");
        var host = null;
        try {
          host = scopes[s].querySelector(selector);
        } catch (err) {
          // A selector this browser cannot parse throws. Caught per field so one unusable row
          // cannot take the whole layer down with it — the others still print.
          host = null;
        }
        // No anchor, no field. Printing it at the document's origin would put a value somewhere
        // nobody placed it, on paper somebody then signs.
        if (!host) continue;
        host.classList.add("hp-flow-host");
        host.appendChild(protos[f].cloneNode(true));
      }
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", place);
  } else {
    place();
  }
})();
</script>`;
}
