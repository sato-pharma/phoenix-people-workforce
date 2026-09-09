import type { AccessContext } from "@/lib/auth/permissions";

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 🔒 EL QEMA LEAVES NO TRACE IN ANY CLOSING DETAIL — owner, 2026-09-09.
 *
 *   "I want the El Qema to be shown in the achievements only, never show in details, never show in
 *    details… at the end of the day they should never appear, never anyone know that these sales
 *    are from Al Qimma, but they appear in their total and achievements but not in the details.
 *    No any traces for Al Qimma detail. Never anyone know."
 *
 * The totals and the achievement figures are untouched: they read the distribution, not the source.
 * What this removes is the ability to look at a detail row and see who supplied it.
 *
 * 🔴 HE OFFERED TO RELABEL THEM AS ANOTHER REAL DISTRIBUTOR AND THAT WAS DECLINED — "you can mix
 * them between distributors and change the distributors and sign them by any sign". Writing Ibn Sina
 * or EGD onto El Qema's invoice lines puts false records into the monthly closing, which is the
 * auditor's file by his own standing rule: a supplier reconciling their own invoices would find
 * quantities that do not exist, and the discrepancy would land on the wrong company. Asked to choose
 * between a neutral code and blank columns, he chose BLANK. Never invent a source here.
 *
 * 🔴 IT IS A MASK, NOT AN ERASE. The import batch and the raw rows keep the truth; only the read is
 * blanked, and only for viewers who are not Super Admin. Asked whether the trace should survive for
 * him, he chose to keep it — stripping it at import would end any reconciliation against El Qema's
 * own invoices and would stop a future El Qema rule from ever being applied to a past month.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Distributors whose identity never reaches a detail surface. El Qema alone, owner 2026-09-09. */
export const MASKED_SOURCE_DISTRIBUTORS: ReadonlySet<string> = new Set(["QM"]);

/**
 * May this viewer see who supplied a row?
 *
 * `system` is here for the same reason Super Admin is: every computation path — the split, the
 * attribution net, the backfill — runs as the system context and MUST see the real distributor, or
 * El Qema's own rules stop applying and the numbers change silently. That is the one failure mode
 * of this whole module, so the reveal is granted by scope rather than remembered per call site.
 */
export function canRevealClosingSource(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.role === "Super Admin" || access.scope === "system";
}

/** The minimum shape the mask touches. Structural, so both detail rows and split rows satisfy it. */
export type MaskableSourceRow = {
  distributorCode?: string | null;
  clientCode?: string | null;
  clientName?: string | null;
  clientAddress?: string | null;
};

/**
 * Blank the source columns on every masked distributor's rows, unless this viewer may reveal them.
 *
 * Returns the SAME array when nothing is masked, so the common path allocates nothing and a caller
 * can apply it unconditionally.
 *
 * 🔴 APPLY THIS LAST, AFTER EVERY COMPUTATION. The split keys on `distributorCode` and the customer
 * aggregation keys on `clientCode`; masking before either of those runs does not throw, it quietly
 * produces a different distribution. That is why the loader reveals for `system` and why the export
 * masks only on the way into the workbook.
 */
export function maskClosingSourceRows<T extends MaskableSourceRow>(
  rows: readonly T[],
  access: Pick<AccessContext, "role" | "scope">,
): readonly T[] {
  if (canRevealClosingSource(access)) return rows;
  let touched = false;
  const masked = rows.map((row) => {
    const code = String(row.distributorCode ?? "").trim().toUpperCase();
    if (!MASKED_SOURCE_DISTRIBUTORS.has(code)) return row;
    touched = true;
    return { ...row, distributorCode: "", clientCode: "", clientName: "", clientAddress: "" };
  });
  return touched ? masked : rows;
}

/**
 * The customer codes whose identity this viewer may not see, taken from UNMASKED rows.
 *
 * 🔴 THE STORE SPLIT SHEET NEEDS THIS BECAUSE ITS ENTRIES CARRY NO DISTRIBUTOR. They are grouped
 * per customer and product, so by the time the sheet has them there is nothing on the entry that
 * says who supplied it — masking the rows first would instead fold every El Qema customer into one
 * blank-coded entry AND stop El Qema's own split rule from applying, changing the numbers. So the
 * split is computed from the real rows and the ANSWER is masked, keyed on this set.
 *
 * Empty when the viewer may reveal, so a caller can hand it straight through.
 */
export function maskedClosingClientCodes(
  rows: readonly MaskableSourceRow[],
  access: Pick<AccessContext, "role" | "scope">,
): ReadonlySet<string> {
  const codes = new Set<string>();
  if (canRevealClosingSource(access)) return codes;
  for (const row of rows) {
    const distributor = String(row.distributorCode ?? "").trim().toUpperCase();
    if (!MASKED_SOURCE_DISTRIBUTORS.has(distributor)) continue;
    const code = String(row.clientCode ?? "").trim();
    if (code) codes.add(code);
  }
  return codes;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The Source of Sales DASHBOARD
//
// 🔴 THE CLOSING DETAIL WAS ONLY HALF THE RULE. The owner's words were "never anyone know that
// these sales are from Al Qimma", and the closing detail is Super-Admin-adjacent — but the portal
// SoS dashboard renders a distributor filter and a ranked bar chart BY DISTRIBUTOR, and it is
// gated on `sales:read`, which THIRTEEN of the nineteen roles hold, Medical Rep and plain Employee
// among them. Measured against production: `phx_sos_distinct_distributors` returns `QM` for Pedia.
// So the identity was reaching the one screen almost everybody can open.
//
// FOUR FIELDS CARRY IT, not one, and masking a subset is the same defect in a smaller place:
//   • filters.distributors  — the selectable option list
//   • byDistributor         — the ranked bars
//   • topCustomers[].distributor — each customer row names its supplier
//   • comparison.distributor     — prior-period values KEYED BY distributor code
//
// The other distributor-bearing fields on the payload type (`momComparison`, `yoyComparison`,
// `detailRows`) are admin/BI only and the portal never requests them, so they are out of scope
// here rather than forgotten — see the comments on those fields.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a masked distributor is called on a chart that must still add up.
 *
 * NOT the real code and NOT a real distributor's name. The owner declined relabelling El Qema as
 * another supplier, so this says "somebody, not named" and nothing more. The row KEEPS ITS VALUE
 * on purpose: he asked for the sales to appear in totals, and a dropped bar makes the breakdown
 * stop reconciling with the total tile above it, which is its own kind of trace.
 */
export const MASKED_SOURCE_CODE = "" as const;
export const MASKED_SOURCE_LABEL = "—" as const;

function isMaskedCode(value: string | null | undefined): boolean {
  return MASKED_SOURCE_DISTRIBUTORS.has(String(value ?? "").trim().toUpperCase());
}

/**
 * Blank El Qema out of a portal SoS dashboard payload, unless this viewer may reveal it.
 *
 * 🔴 CALL THIS ON THE WAY OUT, at the single return, AFTER the comparison is computed. The
 * comparison keys prior values by distributor code; masking before it runs would leave the prior
 * map holding a code the current rows no longer carry, and every masked row would silently read as
 * "no comparable prior value" rather than as its real movement.
 *
 * The option list DROPS the masked distributor rather than blanking it: an option is identity and
 * nothing else, so there is no value to preserve, and a blank entry in a filter is an invitation to
 * click on the thing being hidden.
 */
export function maskPortalSosDashboard<
  T extends {
    byDistributor?: Array<{ code: string; label?: string; name?: string }> | null;
    filters?: { distributors?: Array<{ code: string }> | null } | null;
    topCustomers?: Array<{ distributor?: string | null }> | null;
  },
>(
  data: T,
  access: Pick<AccessContext, "role" | "scope">,
): T {
  if (canRevealClosingSource(access)) return data;

  const byDistributor = data.byDistributor?.map((row) =>
    isMaskedCode(row.code)
      ? { ...row, code: MASKED_SOURCE_CODE, ...(row.label === undefined ? {} : { label: MASKED_SOURCE_LABEL }), ...(row.name === undefined ? {} : { name: MASKED_SOURCE_LABEL }) }
      : row,
  );

  const distributors = data.filters?.distributors?.filter((option) => !isMaskedCode(option.code));

  const topCustomers = data.topCustomers?.map((row) =>
    isMaskedCode(row.distributor) ? { ...row, distributor: MASKED_SOURCE_LABEL } : row,
  );

  return {
    ...data,
    ...(byDistributor ? { byDistributor } : {}),
    ...(data.filters ? { filters: { ...data.filters, ...(distributors ? { distributors } : {}) } } : {}),
    ...(topCustomers ? { topCustomers } : {}),
  };
}

/** Drop every masked distributor's key from a code-keyed map (the comparison's prior values). */
export function maskCodeKeyedDistributorMap<V>(
  map: Readonly<Record<string, V>> | null | undefined,
  access: Pick<AccessContext, "role" | "scope">,
): Record<string, V> | null | undefined {
  if (!map || canRevealClosingSource(access)) return map;
  const kept: Record<string, V> = {};
  let touched = false;
  for (const [code, value] of Object.entries(map)) {
    if (isMaskedCode(code)) { touched = true; continue; }
    kept[code] = value;
  }
  return touched ? kept : map;
}
