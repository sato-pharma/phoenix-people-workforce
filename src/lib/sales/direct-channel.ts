// The Direct channel changed SOURCE, not identity — so both distributor codes are ONE channel.
//
// Until 2026-07 direct sales arrived as an uploaded "Direct (Company)" sheet under distributor code
// DIRECT. From 2026-08 they come from the Direct Request module and land under DirectReq, written by
// phx_rebuild_direct_order_sos_batch into the same source_of_sales_fact_rollup the uploads feed.
// Owner, 2026-09-04: "no more direct that will be uploaded like this — the source of direct sales is
// the direct request module."
//
// This module exists because that knowledge had already drifted into three independent copies
// (source-coverage.ts, vs-target.ts, and the SQL predicate in
// 20260809224356_sos_direct_distributor_code_case_insensitive.sql) and a fourth consumer — the SoS
// dashboard — was still matching the literal "direct" alone. The rollup totals were right, but every
// DirectReq row was CLASSIFIED as a distributor: 2026-08 reported 326,633.27 EGP of direct sales
// under "Distributors" with the Direct channel reading zero, and a window spanning the cutover
// reported the one channel as two rows that each looked like a source that had appeared or vanished.
//
// Anything reporting a CHANNEL (direct vs distributor) or grouping BY distributor must fold through
// here. The `is_direct` boolean on the rollup is the SQL-layer equivalent and is what the monthly
// closing uses — which is why the closing survived the cutover untouched.

import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";

/** Every distributor code the Direct channel has ever been written under, normalized. */
export const DIRECT_CHANNEL_ALIASES: ReadonlySet<string> = new Set(["DIRECT", "DIRECTREQ"]);

/** The surviving code — the module, because that is what feeds every month from 2026-08 on. */
export const DIRECT_CHANNEL_CODE = "DIRECTREQ";

/** Owner-facing name for the folded channel (standing rule: names, never raw codes). */
export const DIRECT_CHANNEL_LABEL = "Direct (Company)";

/** True for either vintage of the Direct channel. */
export function isDirectChannelCode(distributorCode: unknown): boolean {
  const key = normalizeCodeKey(distributorCode);
  return key.length > 0 && DIRECT_CHANNEL_ALIASES.has(key);
}

/**
 * Group key for a distributor code: the import normalization, plus the Direct-channel fold.
 *
 * Both vintages collapse onto one key so a multi-month window reports a single continuous Direct
 * row instead of DIRECT ending and DirectReq beginning.
 */
export function canonicalDistributorKey(distributorCode: unknown): string {
  const key = normalizeCodeKey(distributorCode);
  if (!key) return "";
  return DIRECT_CHANNEL_ALIASES.has(key) ? DIRECT_CHANNEL_CODE : key;
}

/**
 * Grouping code for a dashboard row: the Direct vintages fold onto one code, every other
 * distributor keeps its code EXACTLY as stored.
 *
 * Case is load-bearing here, unlike in `canonicalDistributorKey`: the picker's options come from the
 * distributors master in its own casing ("IbnSina"), and the board marks a row selected by comparing
 * its code against the selection. Upper-casing every row's code would leave a distributor picked in
 * the dropdown looking unselected in the table.
 */
export function foldDirectDistributorCode(distributorCode: unknown): string {
  const raw = String(distributorCode ?? "").trim();
  return isDirectChannelCode(raw) ? DIRECT_CHANNEL_CODE : raw;
}

/**
 * Expand a distributor filter selection so picking the Direct channel returns BOTH vintages.
 *
 * The filter is pushed down into the phx_exec_* RPCs, which match the stored code verbatim: without
 * this, selecting Direct on a window covering 2026-07 and 2026-08 silently drops one of the two
 * months. Returns the input unchanged when no Direct alias was selected.
 */
export function expandDirectChannelFilter(codes: readonly string[] | undefined): string[] {
  if (!codes || codes.length === 0) return [];
  if (!codes.some((code) => isDirectChannelCode(code))) return [...codes];
  const expanded = codes.filter((code) => !isDirectChannelCode(code));
  expanded.push(...DIRECT_CHANNEL_ALIASES);
  return expanded;
}
