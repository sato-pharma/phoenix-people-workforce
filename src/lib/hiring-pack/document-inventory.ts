// EVERY FIELD ONE TEMPLATE CAN PRINT, with what it would print for this employee right now.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. The owner, 2026-09-03: "I want a table out of the template. In this table, the
// first column, it is showing every field needed for the template as a header. And in the second
// column, a suggestion at what will be added in each field."
//
// The obvious way to build that list is to read the rendered document and collect its
// `data-hp-key` attributes. That is exactly wrong for half the documents, and wrong in the
// direction that hides work: `renderPlacement` returns an EMPTY STRING for a value the employee
// does not have, so an unfilled field is not merely blank on a page document — it is not in the
// markup at all. A table built that way would silently omit precisely the fields somebody opened
// it to fill in, and would look complete while doing so.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE TWO SURFACES NEED TWO DIFFERENT SOURCES, and neither one covers the other.
//
//   PAGE documents (form1, form6, resignation, mutualTermination) place absolute coordinates over
//   fixed artwork, and drop an empty one. Their values builders return a `Record<string, string>`
//   whose keys are written out in full, empty or not, so the BUILDER is the complete list and the
//   markup is not.
//
//   FLOW documents (contract, worker data form, custody, clearance) are typeset, and their spans
//   are never dropped however empty — `render-contract.ts` says so in as many words, because the
//   blank rule has to be there for someone to write on. Their builders return a `Partial<Record<
//   Token, string>>` that omits absent keys, and two documents share one builder (laptop and mobile
//   custody; the two clearance halves), so the BUILDER over-reports and the MARKUP is the complete
//   list.
//
// Taking the union everywhere would list a mobile-custody token on the laptop receipt. Taking the
// markup everywhere would drop an empty government field. So each surface is asked the question it
// can actually answer, and the added rows of the field layer — which are markup on both surfaces —
// are picked up by the same pass either way.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE TWO KEY SPACES ARE NOT INTERCHANGEABLE. A page document places camelCase record keys
// (`employeeName`) that `PAPER_FIELD_BINDINGS` can name and write back to. A flow document fills
// UPPER_SNAKE tokens (`COMPANY_NAME`) that appear in no binding table anywhere. Both are legitimate
// placeholder keys inside their own document and neither is legitimate inside the other's, which is
// why `validateFieldTemplate` takes the allow-list as an argument rather than importing one.
// `binding` here is null for a flow token, and that is a description, not a defect: it means the
// value can be placed and merged but not edited back into the employee's record.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { documentSurfaceOf, type PrintableDocument } from "@/lib/hiring-pack/document-registry";
import { paperFieldBinding } from "@/lib/hiring-pack/paper-fields";
import { buildClearanceValues } from "@/lib/hiring-pack/render-clearance";
import { buildContractValues } from "@/lib/hiring-pack/render-contract";
import { buildCustodyValues } from "@/lib/hiring-pack/render-custody";
import { buildCustomTemplateValues } from "@/lib/hiring-pack/render-custom-template";
import { buildForm1Values } from "@/lib/hiring-pack/render-form1";
import { buildForm6Values } from "@/lib/hiring-pack/render-form6";
import { buildExitValues } from "@/lib/hiring-pack/render-labour-exit";
import { buildWorkerFormValues } from "@/lib/hiring-pack/render-worker-form";
import { isBuiltInDocument, isOfficialPackFormDocument } from "@/lib/hiring-pack/types";
import type { HiringPackData } from "@/lib/hiring-pack/types";

/** One row of the field table: what it is called, what it would print, and whether it is a record value. */
export type DocumentFieldInventoryEntry = {
  /** The placeholder key — `employeeName` on a page document, `COMPANY_NAME` on a flow one. */
  key: string;
  /** The English name from `PAPER_FIELD_BINDINGS`, or null for a flow token that has no binding. */
  labelEn: string | null;
  /** What this key resolves to for the employee whose pack was passed. Empty means it prints nothing. */
  value: string;
  /** Whether the value can be typed back into the employee's record, rather than only placed. */
  editable: boolean;
  /**
   * Whether this key actually reached the paper.
   *
   * FALSE HAS TWO CAUSES ON A PAGE DOCUMENT and the caller must not conflate them: the template may
   * have no box for this value at all, or it may have one and the employee's value is empty, in
   * which case `renderPlacement` drops it. Only the pair is conclusive — a NON-EMPTY value that is
   * not placed is a value the template cannot print, which is the case the owner asked for on
   * 2026-09-03: "Phoenix is not showing a field where a field should be populated so I can add the
   * field and put it here." An empty value says nothing either way and is left to be read as blank.
   */
  placed: boolean;
};

/**
 * The exact values map the renderer will use, so a preview cannot disagree with the paper.
 *
 * Keyed by the document union rather than by surface: an eleventh document cannot be added without
 * choosing its builder here, which is the same reason `RENDERERS` in the print route is exhaustive.
 */
export function documentValues(
  document: PrintableDocument,
  data: HiringPackData,
): Record<string, string> {
  // A COMPANY TEMPLATE GETS THE WHOLE CATALOGUE, and that is the honest answer rather than a
  // fallback. The ten below each have a builder because their placements are known: Form 1 asks
  // for exactly the values Form 1 prints. Nothing in this code has seen an uploaded paper, so
  // there is no shorter list that could be right — what it asks for is decided by whoever drops
  // the boxes. See buildCustomTemplateValues.
  if (!isBuiltInDocument(document)) return buildCustomTemplateValues(data);
  // The letters pack's government forms have no compiled placements either, for the same reason —
  // see official-pack-forms.ts — so they are offered the same whole catalogue.
  if (isOfficialPackFormDocument(document)) return buildCustomTemplateValues(data);

  const raw: Partial<Record<string, string>> =
    document === "form1"
      ? buildForm1Values(data)
      : document === "form6"
        ? buildForm6Values(data)
        : document === "resignation" || document === "mutualTermination"
          ? buildExitValues(data)
          : document === "contract"
            ? buildContractValues(data)
            : document === "workerDataForm"
              ? buildWorkerFormValues(data)
              : document === "custodyLaptop" || document === "custodyMobile"
                ? buildCustodyValues(data)
                : buildClearanceValues(data);

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    values[key] = value ?? "";
  }
  return values;
}

/**
 * Every `data-hp-key` the rendered document actually carries, in the order it appears on the page.
 *
 * A regex rather than a parser on purpose: the attribute is written by one function
 * (`renderPlacement`) and three small helpers, always double-quoted and always HTML-escaped, so
 * there is no markup here that a parser would read differently. Reading order matters — it is the
 * order the table lists its rows in, which is the order somebody reads the paper.
 */
const KEY_ATTRIBUTE = /data-hp-key="([^"]*)"/g;

export function keysInMarkup(html: string): string[] {
  const keys: string[] = [];
  for (const match of html.matchAll(KEY_ATTRIBUTE)) {
    // `&amp;` LAST: `escapeHtml` writes a key's own `&quot;` as `&amp;quot;`, which must come back as
    // the text `&quot;`, not as a quote.
    const key = (match[1] ?? "").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
    // A field the operator ADDED carries `hpLiteral:<rowId>` — a key manufactured by
    // `literalValueKey` so two fixed strings on one page cannot overwrite each other. It names no
    // value and belongs to no template, so it is not a row of the inventory: the editor already
    // holds those rows in the field layer and lists them from there, with their own text and their
    // own delete button. Listing them here as well would show each added field twice, once under a
    // key nobody typed.
    // A PLACED STAMP OR SIGNATURE carries `hpMark:<mark>`, and is dropped here for a stronger
    // reason than the literals above: it is not a value at all. There is no record behind it to
    // fill, no label in any template, and nothing the fill screen could ask anybody to type — so
    // listed here it would show as a field that is permanently empty, on every paper anyone
    // stamped. The editor lists marks separately, offering the one action they really have.
    if (!key || key.startsWith("hpLiteral:") || key.startsWith("hpMark:")) continue;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * Build the field table's rows for one document and one employee.
 *
 * `html` is the document as the print route just rendered it — passed in rather than re-rendered so
 * the inventory describes the bytes that were served, not a second render that might differ.
 */
export function documentFieldInventory(
  document: PrintableDocument,
  data: HiringPackData,
  html: string,
): DocumentFieldInventoryEntry[] {
  const values = documentValues(document, data);
  const placed = keysInMarkup(html);

  // See the header: the builder is complete for a page document and the markup is complete for a
  // flow one. The other half of each pair still contributes — an added field is markup on both
  // surfaces — so the page list is a union and the flow list is not.
  const keys =
    documentSurfaceOf(document) === "page"
      ? [...Object.keys(values), ...placed.filter((key) => !(key in values))]
      : placed;

  const placedKeys = new Set(placed);
  return keys.map((key) => {
    const binding = paperFieldBinding(key);
    return {
      key,
      labelEn: binding?.labelEn ?? null,
      value: values[key] ?? "",
      editable: binding !== null,
      placed: placedKeys.has(key),
    };
  });
}
