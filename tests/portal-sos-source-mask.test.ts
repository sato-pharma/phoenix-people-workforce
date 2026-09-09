import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MASKED_SOURCE_DISTRIBUTORS,
  MASKED_SOURCE_LABEL,
  maskCodeKeyedDistributorMap,
  maskPortalSosDashboard,
} from "../src/lib/sales/closing-source-mask.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";

const ROOT = process.cwd();

function ctx(role: string, scope = "self"): Pick<AccessContext, "role" | "scope"> {
  return { role, scope } as Pick<AccessContext, "role" | "scope">;
}

/** A portal payload carrying El Qema in all three of its shapes. */
function payload() {
  return {
    summary: { totalValue: 1_000_000 },
    byDistributor: [
      { code: "IS-S", label: "Ibn Sina", value: 600_000 },
      { code: "QM", label: "El Qema", value: 300_000 },
      { code: "EP", label: "EPDA", value: 100_000 },
    ],
    filters: {
      distributors: [{ code: "IS-S" }, { code: "QM" }, { code: "EP" }],
      products: [{ code: "P1" }],
    },
    topCustomers: [
      { code: "C1", name: "Pharmacy One", distributor: "QM", value: 50_000 },
      { code: "C2", name: "Pharmacy Two", distributor: "IS-S", value: 40_000 },
    ],
  };
}

/**
 * El Qema must leave no trace on the Source of Sales DASHBOARD either — owner 2026-09-09,
 * *"never anyone know that these sales are from Al Qimma, but they appear in their total and
 * achievements"*.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE CLOSING MASK. The closing detail was masked first, and the
 * dashboard was left as a known gap. It is the WIDER surface of the two: the closing screens all
 * carry an explicit Super Admin check, while this dashboard is gated on `sales:read`, which
 * THIRTEEN of the nineteen roles hold — Medical Rep and plain Employee included. Measured against
 * production, `phx_sos_distinct_distributors` returns `QM` for Pedia, so the identity really was
 * reaching the one sales screen almost everybody can open.
 *
 * FOUR FIELDS CARRY IT and masking a subset is the same defect in a smaller place. Each rule below
 * is one of them.
 */
export function runPortalSosSourceMaskTests() {
  const viewer = ctx("Medical Rep");

  // ── 1. the totals are UNTOUCHED — the owner's explicit constraint ─────────────────────────
  const masked = maskPortalSosDashboard(payload(), viewer);
  assert.equal(masked.summary.totalValue, 1_000_000, "masking must never move a total");
  assert.equal(
    masked.byDistributor.reduce((sum, row) => sum + row.value, 0),
    1_000_000,
    "the breakdown must still reconcile with the total — a DROPPED bar is its own kind of trace",
  );

  // ── 2. the ranked bar keeps its VALUE and loses its NAME ─────────────────────────────────
  const qema = masked.byDistributor.find((row) => row.value === 300_000);
  assert.ok(qema, "El Qema's value must still be present");
  assert.equal(qema.label, MASKED_SOURCE_LABEL, "its label must not name it");
  assert.ok(!qema.code, "and its code must not carry QM into a URL or a filter selection");

  // ── 3. the filter option is DROPPED, not blanked ─────────────────────────────────────────
  // An option is identity and nothing else, so there is no value to preserve — and a blank entry
  // in a filter list is an invitation to click on the thing being hidden.
  assert.deepEqual(
    masked.filters.distributors.map((option) => option.code),
    ["IS-S", "EP"],
    "the masked distributor must not be selectable",
  );
  assert.deepEqual(masked.filters.products, [{ code: "P1" }], "other filters are untouched");

  // ── 4. a customer row must not name its supplier ─────────────────────────────────────────
  assert.equal(masked.topCustomers[0].distributor, MASKED_SOURCE_LABEL);
  assert.equal(masked.topCustomers[1].distributor, "IS-S", "and an unmasked one is left alone");

  // ── 5. the comparison map is keyed BY CODE, so the key itself leaks ──────────────────────
  const prior = { "IS-S": 500_000, QM: 250_000, EP: 90_000 };
  assert.deepEqual(
    maskCodeKeyedDistributorMap(prior, viewer),
    { "IS-S": 500_000, EP: 90_000 },
    "a code-keyed map leaks through its KEYS, not its values",
  );

  // ── 6. who may still see it ──────────────────────────────────────────────────────────────
  for (const revealer of [ctx("Super Admin"), ctx("Employee", "system")]) {
    const shown = maskPortalSosDashboard(payload(), revealer);
    assert.equal(shown.byDistributor[1].code, "QM", "Super Admin and the system context reveal");
    assert.equal(shown.filters.distributors.length, 3);
    assert.deepEqual(maskCodeKeyedDistributorMap(prior, revealer), prior);
  }

  // Every other role is masked. This is the assertion that fails if the reveal is ever widened —
  // and the reveal being wide is the whole risk, because the numbers look right either way.
  for (const role of ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "SFE Manager", "CEO", "Finance Manager", "Employee", "HR Operations"]) {
    const shown = maskPortalSosDashboard(payload(), ctx(role));
    assert.ok(
      !shown.filters.distributors.some((option) => MASKED_SOURCE_DISTRIBUTORS.has(option.code)),
      `${role} must not be offered El Qema as a filter`,
    );
  }

  // ── 7. the mask is applied at the dashboard's single RETURN, after the comparison ────────
  // Placing it earlier does not throw — it quietly changes the numbers, because the split keys on
  // the distributor and the comparison keys prior values by its code. Source-pinned for that
  // reason: there is no output that distinguishes "masked too early" from "correct".
  const dashboard = readFileSync(join(ROOT, "src/lib/sales/portal-sos-dashboard.ts"), "utf8");
  const maskAt = dashboard.indexOf("maskPortalSosDashboard(");
  const comparisonAt = dashboard.indexOf("computeComparison(");
  assert.ok(maskAt > 0, "the dashboard must apply the mask");
  assert.ok(comparisonAt > 0 && comparisonAt < maskAt, "the comparison must be computed BEFORE the mask");
  assert.match(
    dashboard,
    /return \{ data: masked, scope, comparison: maskedComparison, uploadStatus \};/,
    "the masked payload must be what is returned — an unmasked `data` here is the whole leak",
  );
}
