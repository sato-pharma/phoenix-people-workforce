import assert from "node:assert/strict";

import {
  DIRECT_CHANNEL_CODE,
  DIRECT_CHANNEL_LABEL,
  canonicalDistributorKey,
  expandDirectChannelFilter,
  foldDirectDistributorCode,
  isDirectChannelCode,
} from "../src/lib/sales/direct-channel.ts";
import { canonicalSourceKey } from "../src/lib/sales/source-coverage.ts";

// The Direct channel changed SOURCE, not identity: uploaded under DIRECT to 2026-07, written by the
// Direct Request module under DirectReq from 2026-08. The SoS dashboard matched the literal "direct"
// alone, so every module-sourced direct sale was reported as a DISTRIBUTOR — 2026-08 showed
// 326,633.27 EGP under "Distributors" with the Direct channel reading zero, and a window spanning
// the cutover reported one channel as two rows.
export function runSosDirectChannelTests() {
  // ── Both vintages are the Direct channel; nothing else is ────────────────────────────────
  assert.equal(isDirectChannelCode("DIRECT"), true);
  assert.equal(isDirectChannelCode("DirectReq"), true, "DirectReq is the live direct vintage");
  // Case drift is real here: 35 July-2026 rows landed as 'Direct' instead of 'DIRECT'.
  assert.equal(isDirectChannelCode("direct"), true);
  assert.equal(isDirectChannelCode("  directreq  "), true);
  assert.equal(isDirectChannelCode("IbnSina"), false);
  assert.equal(isDirectChannelCode(""), false);
  assert.equal(isDirectChannelCode(null), false);
  assert.equal(isDirectChannelCode(undefined), false);
  // A code that merely STARTS with "direct" is a different distributor, not the channel.
  assert.equal(isDirectChannelCode("DirectPharma"), false);

  // ── Both vintages fold onto ONE grouping key ─────────────────────────────────────────────
  assert.equal(canonicalDistributorKey("DIRECT"), DIRECT_CHANNEL_CODE);
  assert.equal(canonicalDistributorKey("DirectReq"), DIRECT_CHANNEL_CODE);
  assert.equal(
    canonicalDistributorKey("DIRECT"),
    canonicalDistributorKey("DirectReq"),
    "a window spanning the 2026-07/08 cutover must report ONE Direct row, not two",
  );
  // A real distributor is untouched apart from the shared import normalization.
  assert.equal(canonicalDistributorKey("IbnSina"), "IBNSINA");
  assert.equal(canonicalDistributorKey(""), "");

  // ── The row code the board emits folds Direct but never re-cases anything else ───────────
  // The picker's options carry the master's own casing and the board marks a row selected by
  // comparing codes, so upper-casing a real distributor would leave a picked row looking unpicked.
  assert.equal(foldDirectDistributorCode("DIRECT"), DIRECT_CHANNEL_CODE);
  assert.equal(foldDirectDistributorCode("DirectReq"), DIRECT_CHANNEL_CODE);
  assert.equal(foldDirectDistributorCode("IbnSina"), "IbnSina", "a real distributor keeps its stored casing");
  assert.equal(foldDirectDistributorCode("  IbnSina  "), "IbnSina");
  assert.equal(foldDirectDistributorCode(""), "");

  // The coverage module now shares this definition — its behaviour must be unchanged, because the
  // closing's completeness warning keys on it.
  assert.equal(canonicalSourceKey("DIRECT"), DIRECT_CHANNEL_CODE);
  assert.equal(canonicalSourceKey("DirectReq"), DIRECT_CHANNEL_CODE);
  assert.equal(canonicalSourceKey("IbnSina"), "IBNSINA");
  assert.equal(canonicalSourceKey(""), "");

  // ── Picking Direct in the filter must reach BOTH codes ───────────────────────────────────
  // The phx_exec_* RPCs match the stored distributor_code, so an unexpanded selection drops one
  // side of the cutover — the months would simply be absent, with no marker.
  const expanded = expandDirectChannelFilter([DIRECT_CHANNEL_CODE]);
  assert.deepEqual([...expanded].sort(), ["DIRECT", "DIRECTREQ"]);
  assert.deepEqual([...expandDirectChannelFilter(["DIRECT"])].sort(), ["DIRECT", "DIRECTREQ"]);
  // A non-Direct selection is passed through untouched.
  assert.deepEqual(expandDirectChannelFilter(["IbnSina"]), ["IbnSina"]);
  // Mixed selection keeps the distributor AND widens Direct.
  assert.deepEqual(
    [...expandDirectChannelFilter(["IbnSina", "DirectReq"])].sort(),
    ["DIRECT", "DIRECTREQ", "IbnSina"],
  );
  // Empty stays empty — [] means "no restriction" to the RPCs, never "match nothing".
  assert.deepEqual(expandDirectChannelFilter([]), []);
  assert.deepEqual(expandDirectChannelFilter(undefined), []);

  // ── The channel split the dashboard reports ──────────────────────────────────────────────
  // Mirrors getSosDashboard's directValue / distributorValue split over a cutover-spanning window.
  const rows = [
    { distributorCode: "IbnSina", value: 1000 },
    { distributorCode: "DIRECT", value: 250 }, // uploaded vintage (≤ 2026-07)
    { distributorCode: "DirectReq", value: 400 }, // module vintage (2026-08 on)
  ];
  const totalValue = rows.reduce((sum, row) => sum + row.value, 0);
  const directValue = rows
    .filter((row) => isDirectChannelCode(row.distributorCode))
    .reduce((sum, row) => sum + row.value, 0);
  assert.equal(directValue, 650, "DirectReq must count as Direct, not as a distributor");
  assert.equal(totalValue - directValue, 1000, "only the real distributor is left in distributorValue");

  // Grouped by canonical key, the three rows are TWO channels — one of them Direct.
  const grouped = new Map<string, number>();
  for (const row of rows) {
    const key = foldDirectDistributorCode(row.distributorCode);
    grouped.set(key, (grouped.get(key) ?? 0) + row.value);
  }
  assert.equal(grouped.size, 2, "DIRECT and DirectReq are one row, so distributorCount is 2");
  assert.equal(grouped.get(DIRECT_CHANNEL_CODE), 650);

  // The owner-facing name is a name, never a raw code, and never the module's internal wording.
  assert.equal(DIRECT_CHANNEL_LABEL, "Direct (Company)");
}
