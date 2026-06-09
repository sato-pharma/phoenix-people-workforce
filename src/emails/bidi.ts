/**
 * Wrap an already-escaped value in Unicode bidi isolation (FSI … PDI) so embedded RTL
 * text — e.g. an Arabic employee name or leave reason — renders in the correct order
 * without reordering the surrounding LTR template text. Apply AFTER HTML-escaping.
 *
 * In its own .ts module (not the .tsx layout) so it can be unit-tested directly.
 */
export function bidiIsolate(escaped: string) {
  return `⁨${escaped}⁩`;
}
