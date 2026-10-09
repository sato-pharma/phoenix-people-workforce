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
 * Take every masked distributor's rows OUT of a detail surface, unless this viewer may reveal them.
 *
 * 🔒 IT REMOVES THE ROW; IT DOES NOT BLANK IT. Owner, 2026-09-10, asked and answered —
 * "hide all customers related to el qema from the details sheet make them never reachable and hide
 * them from everywhere never anyone can reach except system admin", then "yes remove them
 * completely from details".
 *
 * ⚠ BLANKING WAS THE FIRST IMPLEMENTATION AND IT ANNOUNCED ITSELF. The row stayed on the
 * sheet with four empty columns and its area, product, quantity and value intact, so the reader
 * could see how much money had no owner even though they could not see whose it was. Worse, three
 * surfaces then DESCRIBED that money: the customer ranking footnoted "64 rows worth 2,367,360 EGP
 * carry no client code — the distributor reported the sale without naming the buyer", which both
 * sized the hidden total and invented an explanation the owner had already declined; and the
 * detail tab's own distributor dropdown still offered `QM` as a filter, because the option list is
 * built before the mask. An absent row is the only version of this rule with nothing left to read.
 *
 * Returns the SAME array when nothing is dropped, so the common path allocates nothing and a caller
 * can apply it unconditionally.
 *
 * 🔴 APPLY THIS AFTER EVERY COMPUTATION THAT NEEDS THE REAL ROWS. The store split keys on
 * `distributorCode` and the customer aggregation keys on `clientCode`; removing these rows before
 * either runs does not throw, it quietly produces a different distribution. That is why the export
 * route asks for the real rows with its reveal flag, computes, and only then drops — and why
 * anything running as `system` is revealed by scope rather than by remembering to pass one.
 *
 * ⚠ DO NOT SPELL THAT FLAG OUT IN PROSE ANYWHERE IN src/, app/ OR scripts/. `closing-source-mask
 * .test.ts` builds the list of surfaces allowed to see El Qema by grepping every file for the
 * literal `revealSource: true`, so a COMMENT mentioning it adds its own file to that list. This
 * paragraph was written that way once and put this module on it.
 */
export function withoutMaskedSourceRows<T extends MaskableSourceRow>(
  rows: readonly T[],
  access: Pick<AccessContext, "role" | "scope">,
): readonly T[] {
  if (canRevealClosingSource(access)) return rows;
  const kept = rows.filter(
    (row) => !MASKED_SOURCE_DISTRIBUTORS.has(String(row.distributorCode ?? "").trim().toUpperCase()),
  );
  return kept.length === rows.length ? rows : kept;
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

/** Who is reading. Every loader that can put a distributor's identity on a page takes one. */
export type SourceMaskViewer = Pick<AccessContext, "role" | "scope">;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The standard closing workbook's DISTRIBUTOR sheets — owner, 2026-09-14
//
// 🔒 KEEP THE MONEY, DROP THE NAME. Distributor Comparison, Rankings & Mix, Gaps & White-Space,
// Summary & Insights and the hidden Calc sheet under them are all built from the comparison's leaf
// rows, and those leaves reached every reader with El Qema's code on them. Measured on production
// data the same day, a CEO's Pedia August download read "El Qema leads the line with 69.9% of value
// (EGP 2,367,360)", and the Calc sheet — hidden, not protected — listed 84 rows starting `QM`. The
// Data sheet beside them was already clean, so the rule was broken one sheet over.
//
// Asked how it should disappear, he chose between removing El Qema from those sheets completely
// (their totals then fall short of the Closing Matrix by El Qema's value) and keeping its money
// under a blank distributor (totals and shares stay exact, but a reader sees an unnamed
// distributor holding most of Pedia). He chose KEEP THE MONEY, NO NAME.
//
// 🔴 THIS IS NOT THE DETAIL RULE, AND NEITHER IS A PRECEDENT FOR THE OTHER. A detail row is
// REMOVED (2026-09-10); a distributor breakdown keeps its money under `—`. Each was his own answer
// for its own surface — do not "align" one with the other.
//
// The label is `—` and NOT the empty string the portal dashboard uses: these sheets are live SUMIFS
// and COUNTIFS over Calc, and an empty criterion matches every BLANK cell in the range, including
// the padding row an empty block keeps. `—` matches El Qema's rows and nothing else.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The three leaf shapes a closing comparison is assembled from, structurally. */
type ComparisonLeaves = {
  brickRows: readonly { distributorCode: string }[];
  customerRows: readonly { clientCode: string; clientName: string; distributorCode: string }[];
  distProductRows: readonly { distributorCode: string }[];
};

/**
 * Relabel every masked distributor's comparison leaves as `—`, unless this viewer may reveal.
 *
 * Units and value are untouched, so every total, share, ranking and gap the comparison derives is
 * the same number it was. The customer's code and name go too — a customer of El Qema's is how a
 * reader would recognise whose book it is — which folds that distributor's customers into ONE `—`
 * customer carrying their combined value. That is the owner's choice working as intended, not a
 * lost row: the money is all there, and nothing on it says whose.
 *
 * 🔴 RUN IT AFTER `scopeComparisonInput` AND BEFORE `assembleComparison`. After the scope, because
 * a distributor filter compares against the REAL code; before the assembly, because the insight
 * sentences, the mix labels and the Calc blocks are all written inside it and cannot be relabelled
 * afterwards without re-deriving them.
 */
export function maskComparisonLeaves<T extends ComparisonLeaves>(leaves: T, viewer: SourceMaskViewer): T {
  if (canRevealClosingSource(viewer)) return leaves;
  const relabel = <R extends { distributorCode: string }>(row: R): R =>
    isMaskedCode(row.distributorCode) ? { ...row, distributorCode: MASKED_SOURCE_LABEL } : row;
  return {
    ...leaves,
    brickRows: leaves.brickRows.map(relabel),
    customerRows: leaves.customerRows.map((row) =>
      isMaskedCode(row.distributorCode)
        ? { ...row, clientCode: MASKED_SOURCE_LABEL, clientName: MASKED_SOURCE_LABEL, distributorCode: MASKED_SOURCE_LABEL }
        : row,
    ),
    distProductRows: leaves.distProductRows.map(relabel),
  } as T;
}

/** The distributor-keyed half of a month's source coverage, structurally. */
type SourceCoverageLike = {
  missingSources: readonly { key: string; name: string }[];
  sources: readonly { key: string; name: string }[];
};

/**
 * Relabel a masked distributor on the Source Coverage sheet and the closing screen's missing-files
 * banner, unless this viewer may reveal. Same owner decision as the comparison above: the row keeps
 * its units, value and status, so "is this month complete?" still reads true — only the name goes.
 * The Direct-channel regions carry no distributor and are left alone.
 */
export function maskSourceCoverage<T extends SourceCoverageLike>(coverage: T, viewer: SourceMaskViewer): T {
  if (canRevealClosingSource(viewer)) return coverage;
  const relabel = <R extends { key: string; name: string }>(entry: R): R =>
    isMaskedCode(entry.key) ? { ...entry, key: MASKED_SOURCE_LABEL, name: MASKED_SOURCE_LABEL } : entry;
  return {
    ...coverage,
    missingSources: coverage.missingSources.map(relabel),
    sources: coverage.sources.map(relabel),
  } as T;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The Source of Sales dashboard's BATCH COVERAGE banner — the fourth surface
//
// 🔴 `maskPortalSosDashboard` ABOVE NEVER SAW THIS ONE. It masks four fields; the coverage warning
// is a SENTENCE in `insights`, assembled from the batch-coverage report, and it names the single
// costliest gap by estimated value. Measured on production 2026-10-09: once EPDA-BULK's merged July
// and August stop counting as holes (sos-coverage.ts), the costliest remaining gap on Pedia is
// El Qema's — seven absent months at roughly 10.6M EGP — so the fix that stopped over-reporting one
// hole would have written "El Qema is missing from …" onto the one screen thirteen of the nineteen
// roles can open.
//
// Same owner decision as the closing workbook's distributor sheets: KEEP THE MONEY, DROP THE NAME.
// Every period list, estimate and count is untouched, so "is this month complete?" still reads true.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The distributor-bearing fields of a SoS batch-coverage report, structurally. */
type SosCoverageLike = {
  distributors: readonly {
    distributorCode: string;
    name: string;
    mergedInto: string | null;
    mergedIntoCode: string | null;
  }[];
  mergedSources: readonly { distributorCode: string; name: string; into: string; intoCode: string }[];
  periods: readonly { missingDistributors: readonly { code: string; name: string }[] }[];
};

/**
 * Relabel every masked distributor out of a SoS batch-coverage report, unless this viewer may reveal.
 *
 * 🔴 CALL IT BEFORE `buildInsights`, never after. The banner is free text by then — the name sits
 * inside a sentence beside a value and a month list that must stay exactly as they are, and there
 * is nothing structural left to recognise.
 *
 * Three fields carry identity, not one: the ranked gap rows, the merge explanations, and each
 * month's missing-distributor list. The absorbing source of a merge is relabelled too — it is named
 * in the sentence that explains the quiet months.
 */
export function maskSosCoverageReport<T extends SosCoverageLike>(coverage: T, viewer: SourceMaskViewer): T {
  if (canRevealClosingSource(viewer)) return coverage;
  return {
    ...coverage,
    distributors: coverage.distributors.map((row) => {
      const named = isMaskedCode(row.distributorCode)
        ? { ...row, distributorCode: MASKED_SOURCE_LABEL, name: MASKED_SOURCE_LABEL }
        : row;
      return isMaskedCode(named.mergedIntoCode)
        ? { ...named, mergedInto: MASKED_SOURCE_LABEL, mergedIntoCode: MASKED_SOURCE_LABEL }
        : named;
    }),
    mergedSources: coverage.mergedSources.map((row) => {
      const named = isMaskedCode(row.distributorCode)
        ? { ...row, distributorCode: MASKED_SOURCE_LABEL, name: MASKED_SOURCE_LABEL }
        : row;
      return isMaskedCode(named.intoCode)
        ? { ...named, into: MASKED_SOURCE_LABEL, intoCode: MASKED_SOURCE_LABEL }
        : named;
    }),
    periods: coverage.periods.map((period) => ({
      ...period,
      missingDistributors: period.missingDistributors.map((entry) =>
        isMaskedCode(entry.code) ? { ...entry, code: MASKED_SOURCE_LABEL, name: MASKED_SOURCE_LABEL } : entry,
      ),
    })),
  } as T;
}
