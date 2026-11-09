import {
  normalizeHrId,
  resolveEmployeeIdentityId,
  type AccessContext,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { isSyntheticDirectArea } from "@/lib/sales/closing-direct-area";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import {
  bridgeEmployeeLineToOfficial,
  canonicalizeRegionName,
  isHeadOfficeLine,
  isRestrictedProductCode,
  normalizeLineKey,
  OFFICIAL_LINE_VALUES,
  resolveSalesAccessScope,
} from "@/lib/sales/access-scope";
import {
  MEDICAL_REP_AREA_UNRESOLVED_MESSAGE,
  resolveMedicalRepSosAreaCodes,
} from "@/lib/sales/medical-rep-area-scope";
import { areaCodesForMonth } from "@/lib/org/sales-only-seats";
import type { ComparisonScope } from "@/lib/sales/monthly-closing-comparison";
import { resolveWeeklyProductBound } from "@/lib/sales/weekly/access";
import {
  listMonthlyClosingPeriods,
  type MonthlyClosingCell,
  type MonthlyClosingGrandTotalRow,
  type MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";
import {
  loadMonthlyClosingPartsWithStoreSplit,
  loadMonthlyClosingWithStoreSplit,
} from "@/lib/sales/monthly-closing-with-store-split";
import { listPublishedPeriodsForLine } from "@/lib/sales/monthly-closing-publication";

// ─────────────────────────────────────────────────────────────────────────────
// Employee-portal Monthly Closing.
//
// A read-only, published-gated view of the monthly closing matrix for sales
// managers, product managers and medical reps. The viewer NEVER picks a line — it
// is resolved from their HR_ID. Three scoping tiers:
//
//  • own area   — Medical Rep: their line, narrowed to their OWN area(s) and nothing
//                 else. Never their region: that holds every sibling rep's area.
//  • territory  — District / Regional Manager: their line, narrowed to their own
//                 region (they only see their scope). National Sales Manager is
//                 line-scoped and sees the whole line.
//  • product    — Product / Group Product Manager: their line, filtered down to
//                 ONLY the products they own (weekly product-scope sheet).
//
// Region narrowing for DM/RM comes from the shared sales access-scope engine
// (resolveSalesAccessScope) so there is one source of truth for "who sees which
// region", matching the analytics dashboards.
//
// Visibility is gated by `monthly_closing_publications`: a month appears here
// only after the admin publishes that (line, period). Restricted products
// (Lacto Basic) are always stripped — a product manager only ever sees them if
// they were explicitly assigned, which the seed never does.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Roles that can open the portal Monthly Closing tab.
 */
export const PORTAL_CLOSING_ROLES: ReadonlySet<PhoenixRole> = new Set([
  // Medical Rep added 2026-09-16 (owner: "show monthly closing his scope in medical reps accounts").
  // They were left out as having "no line", which is no longer true: resolveSalesAccessScope resolves a
  // rep's own line, and their pharmacy action lists already read published closings through it.
  //
  // What they must NOT inherit is the bound that engine gives their SELF scope — their REGION, which holds
  // every sibling rep's area, and a sibling is at their own rank. So resolvePortalClosingScope narrows
  // them to their OWN area(s) with no region fallback (an empty region set, which applyRegionScope
  // honours as "no rows"), and loadMonthlyClosingDetails applies the same bound to the Details tab
  // and to their export. A rep with no area on file sees a message, never their region instead.
  "Medical Rep",

  "District Manager",
  // "Manager" WAS listed here as the legacy alias for District Manager (see scopeForRole in
  // permissions.ts and PORTAL_CORE_ANALYTICS_ROLES in analytics/portal-access.ts), on the reasoning
  // that a DM whose session role resolves to the alias must reach the same scoped closing.
  //
  // REMOVED 2026-09-29, with its sidebar row, at the owner's instruction. No live account on that
  // rung is a district seat — the two are Head Office (QPPV, R&D Manager) — and Head Office is
  // stripped from `allowedLines` for every viewer, so the page could only ever answer "we couldn't
  // resolve a product line". The gate and the nav flag move together on purpose: that pair is what
  // tests/marketing-manager-monthly-closing.test.ts exists to keep honest, because a gate admitting
  // a role whose row is hidden is a grant nobody can reach. Should a real District Manager ever
  // arrive on the alias, restore both halves in one change.
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  // Marketing Manager added 2026-08-12 (owner: a Monthly Closing tab, able to export any line's
  // full closing sheet). She asked for /sales/monthly-closing; that is the ADMIN upload/publish
  // workspace and it cannot be her door — she is a portal-navigation role, so its page redirects
  // her at `resolveNavigationMode(access) === "employee-portal"` before any permission check runs,
  // and past that it loads its matrix behind assertPermission(sales, "import"). `sales:import` is
  // the gate on the upload/publish workspace and ten other pages; granting it to reach an export
  // would let her PRODUCE the closing she is only meant to CONSUME. This tab is the same Closing
  // Matrix + Details in her own shell. Same call as the Finance Manager's in #2010.
  //
  // The old exclusion reason here ("sits on Head Office, so the portal can never resolve
  // meaningful published data") is no longer true and was already stale when this was written:
  // resolvePortalClosingScope below resolves her lines from resolveSalesAccessScope, which folds in
  // the fixed head-office oversight set (MARKETING_OVERSIGHT_LINE_ROLES → Anti Infective, Pedia,
  // CNS) instead of her own Head Office label, and then filters Head Office out by
  // the unconditional Head Office filter below. loadPortalMonthlyClosing was already built for her
  // — its published-lines read is commented "at most three (the Marketing oversight set)". Only
  // this gate was missing, so she held the scope with no page to use it on.
  //
  // Admitting her leaks nothing: Head Office is stripped from allowedLines for EVERY viewer (since
  // 2026-08-30 — it used to be every viewer except CEO / Super Admin), stripRestrictedColumns drops
  // LA003/LA004/SS001, and the three lines she can now open are exactly the three she already
  // oversees everywhere else in sales.
  "Marketing Manager",
]);

const PRODUCT_SCOPED_CLOSING_ROLES: ReadonlySet<PhoenixRole> = new Set([
  "Product Manager",
  "Group Product Manager",
]);

// Takes only the role it reads, so the published-closing email's destination resolver
// (closing-publish-destination.ts) can ask this one gate instead of keeping a second copy of
// PORTAL_CLOSING_ROLES. Every existing caller passes a whole AccessContext and is unaffected.
export function canAccessPortalClosing(access: Pick<AccessContext, "role">): boolean {
  return PORTAL_CLOSING_ROLES.has(access.role);
}

export type PortalClosingScope = {
  /** Display line resolved from the viewer's employee record (locked, never chosen). */
  line: string | null;
  /** Allowed product codes for product-scoped roles; null means "the whole line". */
  productCodes: Set<string> | null;
  /**
   * Canonical region names the viewer may see (from resolveSalesAccessScope). A set narrows the
   * matrix to those regions (District/Regional Manager); null means every region (National Sales
   * Manager, company roles, or a viewer whose own region could not be resolved — fail-open to the
   * whole line, never a blank sheet).
   *
   * ALWAYS an EMPTY set for a Medical Rep: their bound is `areaCodes` alone, and an empty region set is
   * what stops applyRegionScope widening them to their region when their areas match nothing.
   */
  regionNames: Set<string> | null;
  /**
   * Area codes from the viewer's organogram seat (see src/lib/sales/seat-area-scope.ts). Non-null for
   * a District / Regional Manager whose seat resolved, and then the AUTHORITATIVE bound — it takes
   * precedence over `regionNames` because an area's operational owner can differ from its geography.
   * null for every other role and whenever the seat map couldn't answer (region bound then stands).
   *
   * For a Medical Rep: their OWN area codes (see medical-rep-area-scope.ts), and the only bound they have.
   * Empty when their area is not on file.
   */
  areaCodes: Set<string> | null;
  /** Areas the viewer's seat answers for only in months before the one named (sales-only-seats.ts). */
  earlierMonthAreas?: Map<string, string>;
  /**
   * True only for a Medical Rep whose own area could not be resolved. Their bounds are then both empty,
   * so every loader shows them nothing — the page says why rather than rendering a blank closing.
   */
  areaUnresolved: boolean;
  /**
   * EVERY product line this viewer may open, in display order — normally just their own, but a
   * per-user `line_scope_override` (a Product Manager covering both Pedia and Anti Infective) or a
   * head-office oversight role (Marketing Manager) legitimately spans more than one.
   *
   * `line` above is the DEFAULT pick from this list, kept so single-line callers read unchanged.
   * Anything that loads figures must state which line it means rather than assuming `line`, or it
   * silently serves one line's matrix against another line's rows — see pickPortalClosingLine.
   */
  allowedLines: string[];
};

/**
 * Choose which line a portal closing read should load, and which lines the picker may offer.
 *
 * Pure — the whole point. The IO around it (who is allowed what, what is published) is resolved by
 * the callers; this function owns the one rule that matters and is therefore unit-tested directly:
 *
 *   A REQUESTED LINE IS NEVER SILENTLY SUBSTITUTED.
 *
 * That is not a style preference. `buildPortalClosingWorkbook` rebuilds the exported matrix with
 * `rebuildMatrixFromRows(matrix, rows, { preserveTargets: true })` — sales come from the rows but
 * the COLUMNS and the TARGETS come from the matrix skeleton. Hand it a Pedia skeleton next to Anti
 * Infective rows and the workbook comes out with Pedia's products, Pedia's targets, and the Anti
 * Infective sales dropped on the floor, with nothing anywhere on the sheet saying so. Refusing
 * (line: null) degrades the export to the rows-only workbook, which is honest; substituting does not.
 */
export type PortalClosingLineChoice = {
  /** The line to load. null when the viewer may not open the requested line at all. */
  line: string | null;
  /** Allowed lines that have at least one published month — what the line picker offers. */
  availableLines: string[];
  /** True when a line was requested and refused. Callers must not fall back to another line. */
  refused: boolean;
};

export function pickPortalClosingLine(input: {
  requestedLine?: string | null;
  allowedLines: readonly string[];
  /** Allowed lines with ≥1 published period. Publication is per (line, period). */
  publishedLines: readonly string[];
}): PortalClosingLineChoice {
  const allowed = input.allowedLines.map((value) => value.trim()).filter(Boolean);
  const publishedKeys = new Set(input.publishedLines.map(normalizeLineKey));
  // Intersection in ALLOWED order, so the picker lists lines the way the viewer's scope does.
  const availableLines = allowed.filter((value) => publishedKeys.has(normalizeLineKey(value)));

  const requested = String(input.requestedLine ?? "").trim();
  if (requested) {
    const match = allowed.find((value) => normalizeLineKey(value) === normalizeLineKey(requested));
    // Outside the viewer's scope ⇒ refuse. Never fall through to allowed[0].
    if (!match) return { line: null, availableLines, refused: true };
    // In scope but unpublished ⇒ still THIS line, so the caller reports "awaiting publish" for the
    // line that was actually asked for rather than for some other line the viewer also holds.
    return { line: match, availableLines, refused: false };
  }

  // Nothing requested: prefer a line that actually has something to show, else the first allowed
  // line so the caller can say which line is awaiting publication.
  return { line: availableLines[0] ?? allowed[0] ?? null, availableLines, refused: false };
}

/** Resolve the viewer's line from the employee directory (any role). */
async function resolveEmployeeLineName(access: AccessContext): Promise<string | null> {
  const hrId = resolveEmployeeIdentityId(access) ?? access.hrId ?? access.loginId;
  if (!hrId) return null;
  const target = normalizeHrId(hrId);

  const directory = await getEmployeeDirectory();
  const match = directory.employees.find(
    (employee) => normalizeHrId(employee.hrId) === target,
  );
  return match?.lineName?.trim() || null;
}

/** Line + optional product filter for the caller. */
export async function resolvePortalClosingScope(
  access: AccessContext,
): Promise<PortalClosingScope> {
  // "Everyone sees his scope only": the shared sales access-scope engine is the single source of
  // truth for which regions a viewer may see. District/Regional Managers come back region-bound
  // (a set = their region); National Sales Managers are line-scoped and company roles unrestricted
  // (null = the whole line). A region-scoped viewer with NO geography at all — no region label and
  // no seat areas — comes back as an EMPTY set, which applyRegionScope honours as "no rows" rather
  // than widening to the line (an empty set is truthy, so it must be checked explicitly).
  const isMedicalRep = access.role === "Medical Rep";
  const [line, salesScope, repAreaCodes] = await Promise.all([
    resolveEmployeeLineName(access),
    resolveSalesAccessScope(access),
    isMedicalRep ? resolveMedicalRepSosAreaCodes(access) : Promise.resolve(null),
  ]);
  const regionNames = salesScope.allowedRegionNames;
  // A District / Regional Manager's real geography is their seat's areas, which can sit outside their
  // own region label — so prefer it when the seat map answered.
  const areaCodes = salesScope.allowedAreaCodes;

  // WHICH LINES, from the same engine that decides it everywhere else in sales. It already folds in
  // the per-user `line_scope_override` (a PM covering Pedia + Anti Infective) and the fixed
  // head-office oversight set (Marketing Manager), and it returns SoS official line names — the
  // spelling `listPublishedPeriodsForLine` and the closing RPCs expect, which the raw employee
  // label is not guaranteed to be.
  //
  // `allowedLineNames === null` means COMPANY scope: every line. Materialising that as the official
  // line list is the faithful reading and widens nothing — the alternative, falling back to the
  // viewer's own employee line, is actively wrong for the one role that lands here that way. A
  // Marketing Manager carries sales_scope_override = COMPANY while sitting on the Head Office line,
  // so an own-line fallback resolves her to a line that is confidential, carries no product sales
  // and is never published — which is why her Line Sales Pacing card reported "not published yet
  // for Head Office" instead of the lines she actually oversees.
  const allowedLines = (
    salesScope.allowedLineNames ? [...salesScope.allowedLineNames] : [...OFFICIAL_LINE_VALUES]
  )
    // Head Office is NEVER a monthly closing line — for anyone, CEO and Super Admin included.
    // Owner, 2026-08-30: "The head office will not be used in the weekly sales or monthly sales",
    // then "now do the same for the monthly closing line filter".
    //
    // Until that date this read `|| canViewHeadOfficeLine(access.role)`, so the confidential-line
    // lock let those two roles through. That was the right rule while Head Office was merely
    // CONFIDENTIAL; it is the wrong rule now that it is out of monthly reporting altogether.
    //
    // This removes a door, not a room. The ADMIN closing surface has never been able to produce a
    // Head Office closing — listMonthlyClosingLines drops it in selectClosingLines, pinned by
    // tests/closing-excludes-head-office.test.ts — so no Head Office period has ever been
    // published: measured 0 rows in monthly_closing_publications on 2026-08-30, against 1 each for
    // CNS, Pedia and Anti Infective. What was reachable is the REQUEST: pickPortalClosingLine
    // accepts any line present in this list even with no published period, so `?line=Head Office`
    // resolved instead of being refused for a CEO or Super Admin.
    .filter((candidate) => !isHeadOfficeLine(candidate));

  // The viewer's own line stays the default when they hold it, so a single-line manager's every
  // existing read resolves to exactly the line it resolved to before.
  const ownLine = bridgeEmployeeLineToOfficial(line);
  const defaultLine =
    allowedLines.find((candidate) => normalizeLineKey(candidate) === normalizeLineKey(ownLine)) ??
    allowedLines[0] ??
    null;

  if (isMedicalRep) {
    // 🔴 THEIR OWN AREA, NEVER THEIR REGION — both engine bounds above are replaced, not narrowed. See
    // medicalRepClosingGeography.
    return { line: defaultLine, allowedLines, productCodes: null, ...medicalRepClosingGeography(repAreaCodes) };
  }

  if (PRODUCT_SCOPED_CLOSING_ROLES.has(access.role)) {
    const hrKey = canonicalHrIdKey(
      resolveEmployeeIdentityId(access) ?? access.hrId ?? access.loginId ?? null,
    );
    // No list → their whole line (null = no column filter), as on every other screen (owner, 2026-09-18).
    const productCodes = await resolveWeeklyProductBound(hrKey);
    return {
      line: defaultLine,
      allowedLines,
      productCodes,
      regionNames,
      areaCodes,
      areaUnresolved: false,
    };
  }

  // Territory roles: DM/RM are narrowed to their own areas (seat map) or, failing that, their own
  // region; NSM is line-scoped so both bounds are null ⇒ the whole line.
  return {
    line: defaultLine,
    allowedLines,
    productCodes: null,
    regionNames,
    areaCodes,
    ...(salesScope.allowedEarlierMonthAreas ? { earlierMonthAreas: salesScope.allowedEarlierMonthAreas } : {}),
    areaUnresolved: false,
  };
}

/**
 * A Medical Rep's geography bound for the portal closing, from their own area codes
 * (resolveMedicalRepSosAreaCodes; null = no area on file). Pure, so the bound itself is testable.
 *
 * 🔴 THEIR OWN AREA, NEVER THEIR REGION. The sales engine hands a rep's SELF scope their region label, and
 * a region holds every sibling rep's area — the same rank as them, which scope never reaches. So the
 * region set is EMPTIED rather than kept: applyRegionScope honours an empty set as "no rows" once their
 * areas match nothing, instead of falling back to the region or to the whole line. Unresolved ⇒ both
 * bounds empty ⇒ nothing, and `areaUnresolved` lets the page say why.
 */
export function medicalRepClosingGeography(
  repAreaCodes: readonly string[] | null,
): Pick<PortalClosingScope, "regionNames" | "areaCodes" | "areaUnresolved"> {
  const areaCodes = new Set((repAreaCodes ?? []).map((code) => code.trim().toUpperCase()).filter(Boolean));
  return { regionNames: new Set<string>(), areaCodes, areaUnresolved: areaCodes.size === 0 };
}

/**
 * The scope a Medical Rep's Export XLSX hands its comparison sheets (Distributor Comparison, Rankings
 * & Mix, Gaps & White-Space, Summary & Insights and the hidden Calc sheet). Null = no area on file,
 * and the export refuses rather than build anything.
 *
 * 🔴 A REP'S FILE ONLY — the owner's decision, 2026-09-16, asked because the old export is frozen.
 * Those sheets measure white space against MASTER lists of every area and brick in the company, so
 * with no scope a rep's file named every other area in the country — the sibling reps' areas among
 * them — as "zero sales". The leaves are already the rep's own rows, booked by closingAreaOf exactly
 * as scopeComparisonInput matches them, so this trims the masters and drops none of the rep's sales.
 * Every OTHER viewer still passes no scope, and their workbook stays byte-for-byte what it was.
 *
 * Unresolved is null, never `{ areaCodes: [] }`: scopeComparisonInput reads an empty list as "no
 * filter" and would fall open to the whole country.
 */
export function medicalRepComparisonScope(repAreaCodes: readonly string[] | null): ComparisonScope | null {
  const { areaCodes, areaUnresolved } = medicalRepClosingGeography(repAreaCodes);
  return areaUnresolved ? null : { areaCodes: [...(areaCodes ?? [])] };
}

function sumCells(cells: MonthlyClosingCell[]): MonthlyClosingCell {
  let salesUnits = 0;
  let salesValue = 0;
  let targetUnits = 0;
  let targetValue = 0;
  let hasTarget = false;
  for (const cell of cells) {
    salesUnits += cell.salesUnits;
    salesValue += cell.salesValue;
    if (cell.targetUnits != null) {
      targetUnits += cell.targetUnits;
      hasTarget = true;
    }
    if (cell.targetValue != null) {
      targetValue += cell.targetValue;
      hasTarget = true;
    }
  }
  const resolvedTargetValue = hasTarget ? targetValue : null;
  return {
    salesUnits,
    salesValue,
    targetUnits: hasTarget ? targetUnits : null,
    targetValue: resolvedTargetValue,
    achievement: resolvedTargetValue ? salesValue / resolvedTargetValue : null,
  };
}

/**
 * Filter a closing matrix down to a set of product codes, recomputing every
 * row total / subtotal / grand total from the surviving columns. Restricted
 * products are always dropped. Pure — no IO.
 */
export function scopeMatrixToProducts(
  matrix: MonthlyClosingMatrix,
  codes: Set<string>,
): MonthlyClosingMatrix {
  const allowed = new Set([...codes].map((code) => code.trim().toUpperCase()));
  const keep: number[] = [];
  matrix.columns.forEach((column, index) => {
    const code = column.productCode.trim().toUpperCase();
    if (allowed.has(code) && !isRestrictedProductCode(column.productCode)) {
      keep.push(index);
    }
  });

  const pick = (cells: MonthlyClosingCell[]) =>
    keep.map((index) => cells[index]).filter((cell): cell is MonthlyClosingCell => Boolean(cell));

  const scopeSubtotal = <T extends { cells: MonthlyClosingCell[]; rowTotal: MonthlyClosingCell }>(
    row: T,
  ): T => {
    const cells = pick(row.cells);
    return { ...row, cells, rowTotal: sumCells(cells) };
  };

  return {
    ...matrix,
    columns: keep.map((index) => matrix.columns[index]),
    regions: matrix.regions.map((region) => ({
      ...region,
      areas: region.areas.map(scopeSubtotal),
      subtotal: scopeSubtotal(region.subtotal),
    })),
    grandTotal: scopeSubtotal(matrix.grandTotal),
    directNational: matrix.directNational ? scopeSubtotal(matrix.directNational) : matrix.directNational,
    companyTotal: matrix.companyTotal ? scopeSubtotal(matrix.companyTotal) : matrix.companyTotal,
  };
}

/**
 * Drop the confidential product columns (LA003 / LA004) from a closing matrix, recomputing every
 * row total / subtotal / grand total from the surviving columns. Always applied in the portal:
 * no portal role (DM / RM / NSM / PM / GPM) may ever see these products. Territory roles get
 * `productCodes = null` and so skip `scopeMatrixToProducts`, which is why this guard is needed.
 * Pure — no IO.
 */
export function stripRestrictedColumns(matrix: MonthlyClosingMatrix): MonthlyClosingMatrix {
  const keep: number[] = [];
  matrix.columns.forEach((column, index) => {
    if (!isRestrictedProductCode(column.productCode)) keep.push(index);
  });
  if (keep.length === matrix.columns.length) return matrix;

  const pick = (cells: MonthlyClosingCell[]) =>
    keep.map((index) => cells[index]).filter((cell): cell is MonthlyClosingCell => Boolean(cell));
  const scopeSubtotal = <T extends { cells: MonthlyClosingCell[]; rowTotal: MonthlyClosingCell }>(
    row: T,
  ): T => {
    const cells = pick(row.cells);
    return { ...row, cells, rowTotal: sumCells(cells) };
  };

  return {
    ...matrix,
    columns: keep.map((index) => matrix.columns[index]),
    regions: matrix.regions.map((region) => ({
      ...region,
      areas: region.areas.map(scopeSubtotal),
      subtotal: scopeSubtotal(region.subtotal),
    })),
    grandTotal: scopeSubtotal(matrix.grandTotal),
    directNational: matrix.directNational ? scopeSubtotal(matrix.directNational) : matrix.directNational,
    companyTotal: matrix.companyTotal ? scopeSubtotal(matrix.companyTotal) : matrix.companyTotal,
  };
}

/**
 * Narrow a closing matrix to the SoS regions whose CANONICAL name is in `names`, recomputing the
 * grand total from the surviving regions and dropping the national-direct / company totals a
 * region-scoped viewer must not see. Matches by canonical region NAME because the sales access-scope
 * engine resolves a viewer's regions by name (resolveSalesAccessScope.allowedRegionNames, already
 * canonicalized). Pure — no IO.
 */
export function scopeMatrixToRegionNames(
  matrix: MonthlyClosingMatrix,
  names: Set<string>,
): MonthlyClosingMatrix {
  return scopeMatrixByRegion(matrix, (region) => names.has(canonicalizeRegionName(region)));
}

/**
 * Shared core of the two region scopers. Matching happens per AREA rather than per region, because
 * the closing now groups areas by the ORGANOGRAM: on Anti Infective there is no "Upper Egypt"
 * region at all, only "Upper Egypt 1" and "Upper Egypt 2".
 *
 * Every Upper Egypt employee is labelled "Upper Egypt" in the employee master (verified in
 * production: 26 of them, none labelled with a 1 or a 2), so a region-name bound would match no
 * region on that line — and applyRegionScope treats "matched nothing" as a data gap and hands back
 * the UN-narrowed matrix. A viewer scoped to one region would have seen the entire company.
 *
 * So an area is kept when its own group matches OR the region it sits in geographically matches.
 * That keeps UE1..UE8 visible to an Upper Egypt viewer wherever the organogram put them, without
 * handing them GZ6 — a Giza area that happens to sit under the same district manager.
 *
 * When nothing has been re-homed (no sourceRegion on any area) this is exactly the old whole-region
 * filter: every area of a matching region matches, and none of a non-matching one does.
 */
function scopeMatrixByRegion(
  matrix: MonthlyClosingMatrix,
  matches: (regionNameOrCode: string) => boolean,
  matchCode?: (code: string) => boolean,
): MonthlyClosingMatrix {
  const columnCount = matrix.columns.length;
  const cellsAt = (rows: Array<{ cells: MonthlyClosingCell[] }>) =>
    Array.from({ length: columnCount }, (_, index) =>
      sumCells(rows.map((row) => row.cells[index]).filter((cell): cell is MonthlyClosingCell => Boolean(cell))),
    );
  const hit = (name: string, code: string) => (matchCode ? matchCode(code) : matches(name));

  const regions = matrix.regions
    .map((region) => {
      const groupMatches = hit(region.regionName, region.regionCode);
      const areas = region.areas.filter((area) => {
        // The synthetic Direct row has no geography of its own — it belongs to whichever territory
        // survived, so it rides along rather than being matched on its own. A REAL area that
        // absorbed July's direct money is NOT that row: it has its own geography and must be matched
        // on it, or it rides into regions the viewer has no business seeing.
        if (isSyntheticDirectArea(area)) return true;
        if (groupMatches) return true;
        return area.sourceRegionName !== undefined
          ? hit(area.sourceRegionName, area.sourceRegionCode ?? "")
          : false;
      });
      // A group kept only by its Direct row would be a region the viewer has no areas in.
      if (areas.length === 0 || areas.every((area) => isSyntheticDirectArea(area))) return null;
      if (areas.length === region.areas.length && groupMatches) return region;
      const subtotalCells = cellsAt(areas);
      return {
        ...region,
        areas,
        subtotal: { ...region.subtotal, cells: subtotalCells, rowTotal: sumCells(subtotalCells) },
      };
    })
    .filter((region): region is (typeof matrix.regions)[number] => region !== null);

  const grandCells = cellsAt(regions.map((region) => region.subtotal));
  const grandTotal: MonthlyClosingGrandTotalRow = {
    kind: "grandTotal",
    cells: grandCells,
    rowTotal: sumCells(grandCells),
  };
  return { ...matrix, regions, grandTotal, directNational: null, companyTotal: null };
}

/**
 * Narrow a closing matrix to an explicit set of AREA codes — the seat-derived bound for a District /
 * Regional Manager (see src/lib/sales/seat-area-scope.ts). Unlike the region-name version above this
 * keeps an area whose region belongs to someone else (e.g. CNS Kafr El-Sheikh 1, owned by the
 * Alex-BHR DM but sitting in Delta (1)) while dropping that region's other areas, and it recomputes
 * every region subtotal from the surviving areas so the totals still tie out. A region left with no
 * areas is dropped entirely. Pure — no IO.
 */
export function scopeMatrixToAreaCodes(
  matrix: MonthlyClosingMatrix,
  areaCodes: Set<string>,
): MonthlyClosingMatrix {
  const allowed = new Set([...areaCodes].map((code) => code.trim().toUpperCase()));
  const columnCount = matrix.columns.length;
  const cellsAt = (rows: Array<{ cells: MonthlyClosingCell[] }>) =>
    Array.from({ length: columnCount }, (_, index) =>
      sumCells(rows.map((row) => row.cells[index]).filter((cell): cell is MonthlyClosingCell => Boolean(cell))),
    );

  const regions = matrix.regions
    .map((region) => {
      // The synthetic per-region "Direct" row carries no real area code; a region-scoped viewer never
      // saw national direct sales (scopeMatrixToRegionNames nulls directNational), so drop it here too.
      // ONLY that row: `area.isDirect` is also true for a real area that absorbed July 2026's direct
      // orders, and reading the raw flag dropped a District Manager's OWN area (Dakahlia 1, D21) out
      // of their seat scope — silently, and taking the region with it once every area carried direct.
      const areas = region.areas.filter(
        (area) => !isSyntheticDirectArea(area) && allowed.has(area.areaCode.trim().toUpperCase()),
      );
      if (areas.length === 0) return null;
      const subtotalCells = cellsAt(areas);
      return {
        ...region,
        areas,
        subtotal: { ...region.subtotal, cells: subtotalCells, rowTotal: sumCells(subtotalCells) },
      };
    })
    .filter((region): region is (typeof matrix.regions)[number] => region !== null);

  const grandCells = cellsAt(regions.map((region) => region.subtotal));
  const grandTotal: MonthlyClosingGrandTotalRow = {
    kind: "grandTotal",
    cells: grandCells,
    rowTotal: sumCells(grandCells),
  };
  return { ...matrix, regions, grandTotal, directNational: null, companyTotal: null };
}

/**
 * The ONE geography rule with no widening fallback (owner, 2026-10-26: a District Manager's closing
 * must never fall back to his region or the whole line). Shared by applyRegionScope below and the
 * Performance Review (closing-performance-review-scope.ts), so the two screens cannot drift apart.
 *
 *  • Seat AREA codes, when the seat resolved any, are authoritative — and if they match no row the
 *    answer is "no rows", never the region they sit in.
 *  • An EMPTY area set with no region label is "no geography at all" ⇒ no rows.
 *  • Otherwise the region names narrow it; an empty region set is the engine's own fail-closed answer,
 *    and a non-empty one that matches nothing yields zero regions.
 *  • Both null — a line-scoped or company viewer — is the whole (already line-locked) matrix.
 */
export function scopeMatrixToGeographyNoFallback(
  matrix: MonthlyClosingMatrix,
  regionNames: Set<string> | null,
  areaCodes: Set<string> | null | undefined,
): MonthlyClosingMatrix {
  if (areaCodes && areaCodes.size > 0) return scopeMatrixToAreaCodes(matrix, areaCodes);
  if (!regionNames) return areaCodes ? scopeMatrixToAreaCodes(matrix, new Set()) : matrix;
  return scopeMatrixToRegionNames(matrix, regionNames);
}

/**
 * Apply the viewer's geography scope to a matrix. A seat-scoped viewer (District / Regional Manager
 * whose organogram seat resolved) is narrowed to their own AREAS; otherwise a region-bound viewer is
 * narrowed to their region. The line filter still applies upstream, so nothing here can ever reach
 * outside the viewer's own line.
 *
 * It is scopeMatrixToGeographyNoFallback plus exactly ONE exception, and only where the scope really
 * is region-level — no area bound at all:
 *
 *  • A NON-empty region set that matches no region in THIS matrix is a data gap — e.g. a Regional
 *    Manager whose region label is the aggregate "Alexandria + Delta" rather than a single SoS
 *    region. There we still fall back to the un-narrowed matrix rather than show a blank sheet.
 *
 * Everything else that matches nothing is "no rows":
 *
 *  • Seat AREAS that match no row (a District Manager whose areas sold nothing this month, or whose
 *    seat map lags the closing). This used to drop to his REGION and then to the whole line — every
 *    sibling manager's areas under his own heading (fixed 2026-10-26). The page says so in words
 *    (PORTAL_CLOSING_AREAS_EMPTY_MESSAGE) instead.
 *  • An EMPTY `regionNames` set — the scope engine saying "this viewer has no geography at all" (see
 *    computeSalesAccessScope: no region label AND no seat areas ⇒ deliberate empty set). An empty Set
 *    is truthy, so it must never clear a null guard and reach the fallback.
 *
 * A Medical Rep arrives with their own area codes and an EMPTY region set (resolvePortalClosingScope).
 * That is what keeps the rep inside their areas: when those match no row the answer is "no rows",
 * where their region label would have handed them every sibling rep's area.
 */
export function applyRegionScope(
  matrix: MonthlyClosingMatrix,
  regionNames: Set<string> | null,
  areaCodes?: Set<string> | null,
): MonthlyClosingMatrix {
  const narrowed = scopeMatrixToGeographyNoFallback(matrix, regionNames, areaCodes);
  // The aggregate region label — region-level scope only, never once a seat gave us areas.
  const regionLevelOnly = areaCodes == null && regionNames != null && regionNames.size > 0;
  if (regionLevelOnly && narrowed.regions.length === 0) return matrix;
  return narrowed;
}

/**
 * Shown above the closing when an AREA-bound viewer's areas have no rows in the selected month. The
 * sheet stays (its month picker is how he reaches another month); it is simply empty, and says why.
 */
export const PORTAL_CLOSING_AREAS_EMPTY_MESSAGE =
  "Your areas have no rows in this month's closing, so there is nothing to show for it. Pick another month, or ask Sales Operations if your areas should be here.";

/** True when an area-bound viewer's narrowed matrix came back with no regions at all. */
export function isAreaBoundMatrixEmpty(
  matrix: MonthlyClosingMatrix,
  areaCodes: Set<string> | null | undefined,
): boolean {
  return areaCodes != null && matrix.regions.length === 0;
}

export type PortalClosingResult = {
  matrix: MonthlyClosingMatrix | null;
  /**
   * The Office slice of `matrix`, scoped identically. Optional so the early-return shapes above
   * (no line, nothing published) stay valid; null when the Office grid could not be read.
   */
  office?: MonthlyClosingMatrix | null;
  line: string | null;
  /**
   * Every line this viewer may open that has at least one published month — the line picker's
   * options. One entry (or none) for the ordinary single-line manager, so the picker stays hidden
   * for everyone it was hidden for before.
   */
  availableLines: string[];
  /** Published periods available to this viewer's line (newest first). */
  availablePeriods: string[];
  selectedPeriod: string | null;
  /** True when the viewer has a line but nothing has been published for it yet. */
  awaitingPublish: boolean;
  /**
   * Set only when the viewer's own scope cannot be resolved — today a Medical Rep with no area on
   * file. The plain-words reason there is nothing to show; `matrix` is null alongside it.
   */
  scopeMessage?: string | null;
  /**
   * Set when an AREA-bound viewer (District / Regional Manager on a seat, Medical Rep) has no rows in
   * the loaded month. Unlike `scopeMessage` the sheet still renders — empty, with its month picker.
   */
  areasEmptyMessage?: string | null;
  /** Live monthly only: distinct distributors uploaded this period + the fixed expected total (completion bar). */
  distributorsUploaded?: number;
  distributorsExpected?: number;
};

/**
 * Load the published, viewer-scoped closing for one month. Only published
 * periods are ever offered or loaded; an unpublished/blank request falls back to
 * the latest published month for the line.
 */
export async function loadPortalMonthlyClosing(input: {
  access: AccessContext;
  /**
   * Which of the viewer's allowed lines to load. Omit for their default line — the behaviour every
   * single-line caller had before this existed. A line OUTSIDE their scope is refused (null matrix),
   * never quietly swapped for one that is inside it: see pickPortalClosingLine for why a substituted
   * skeleton silently corrupts the exported workbook's products and targets.
   */
  line?: string | null;
  period?: string | null;
  /**
   * 🔴 OFF BY DEFAULT, AND THE CALLER MUST HAVE EARNED IT. True offers and loads the VALIDATED
   * months instead of the published ones — every other step of the chain below is untouched, which
   * is the entire reason this is an option here rather than a second loader: the confidential strip,
   * the product bound, the region/area narrowing and the identical pass over the Office grid all
   * still run, and a copy of that chain is how a workbook ends up leaking a restricted product's
   * Office units or showing a manager the national figure beside his own region's sales.
   *
   * It exists for the owner's admin download of the rep ranking workbook (2026-10-13): Super Admin,
   * SFE Manager, CEO and Finance Manager already read unpublished months everywhere else in the
   * closing, and on 13 Oct every Anti Infective month was unpublished, so a publish-gated builder
   * could produce nothing at all for them. ONLY pass it behind `readsUnpublishedClosings(access)` —
   * the same predicate the details gate uses — and never from a portal surface, where the publish
   * gate is what stops a rep reading figures the owner has not released.
   *
   * The month list is global (import batches carry no line), so a validated month with no rows for
   * this line comes back as a matrix with no regions. A caller trending over several months must
   * drop such a month rather than render it as zero — see buildScopedRepRankingExport.
   */
  includeUnpublished?: boolean;
}): Promise<PortalClosingResult> {
  const scope = await resolvePortalClosingScope(input.access);
  if (scope.allowedLines.length === 0) {
    return { matrix: null, line: null, availableLines: [], availablePeriods: [], selectedPeriod: null, awaitingPublish: false };
  }
  // A rep with no area on file: their bounds are empty, so a load would only render an empty closing.
  // Say why instead — and never reach for their region to fill the gap.
  if (scope.areaUnresolved) {
    return {
      matrix: null,
      line: scope.line,
      availableLines: [],
      availablePeriods: [],
      selectedPeriod: null,
      awaitingPublish: false,
      scopeMessage: MEDICAL_REP_AREA_UNRESOLVED_MESSAGE,
    };
  }

  // Publication is per (line, period), so "which lines can this viewer even open" is one read per
  // allowed line — at most three (the Marketing oversight set), one for everybody else.
  //
  // `includeUnpublished` swaps that question for the validated months, ONE read for every line,
  // because an import batch carries no line. Everything downstream reads this list and nothing
  // else, so the month selector, the refusal and the trend all move together.
  const validatedPeriods = input.includeUnpublished ? await listMonthlyClosingPeriods() : [];
  const publishedByLine = await Promise.all(
    scope.allowedLines.map(async (line) => ({
      line,
      periods: input.includeUnpublished ? validatedPeriods : await listPublishedPeriodsForLine(line),
    })),
  );
  const { availableLines, line: selectedLine, refused } = pickPortalClosingLine({
    allowedLines: scope.allowedLines,
    publishedLines: publishedByLine.filter((entry) => entry.periods.length > 0).map((entry) => entry.line),
    requestedLine: input.line,
  });
  if (refused || !selectedLine) {
    return { matrix: null, line: null, availableLines, availablePeriods: [], selectedPeriod: null, awaitingPublish: false };
  }

  const offeredPeriods = publishedByLine.find(
    (entry) => normalizeLineKey(entry.line) === normalizeLineKey(selectedLine),
  )?.periods ?? [];
  if (offeredPeriods.length === 0) {
    return {
      matrix: null,
      line: selectedLine,
      availableLines,
      availablePeriods: [],
      selectedPeriod: null,
      awaitingPublish: true,
    };
  }

  const requested = String(input.period ?? "").trim();
  const selectedPeriod = offeredPeriods.includes(requested) ? requested : offeredPeriods[0];

  const parts = await loadMonthlyClosingPartsWithStoreSplit({ line: selectedLine, period: selectedPeriod });
  const raw = parts.combined;
  // Lock the line and restrict the month selector to the months this caller is offered — published
  // months, or the validated ones when `includeUnpublished` was earned.
  const locked: MonthlyClosingMatrix = {
    ...raw,
    availableLines: [selectedLine],
    availablePeriods: offeredPeriods,
  };
  // Always strip confidential products first; territory roles (productCodes === null) would
  // otherwise see the raw matrix including LA003 / LA004.
  const safe = stripRestrictedColumns(locked);
  const productScoped = scope.productCodes ? scopeMatrixToProducts(safe, scope.productCodes) : safe;
  const matrix = applyRegionScope(productScoped, scope.regionNames, areaCodesForMonth(scope.areaCodes, scope.earlierMonthAreas, selectedPeriod));

  // The Office grid rides the IDENTICAL scoping chain. Skipping any step here would leak a
  // confidential product's Office units, or show a District Manager the national Office figure
  // beside his own region's sales.
  const office = parts.office
    ? applyRegionScope(
      scope.productCodes
        ? scopeMatrixToProducts(stripRestrictedColumns(parts.office), scope.productCodes)
        : stripRestrictedColumns(parts.office),
      scope.regionNames,
      areaCodesForMonth(scope.areaCodes, scope.earlierMonthAreas, selectedPeriod),
    )
    : null;

  return {
    matrix,
    office,
    line: selectedLine,
    availableLines,
    availablePeriods: offeredPeriods,
    selectedPeriod,
    awaitingPublish: false,
    areasEmptyMessage: isAreaBoundMatrixEmpty(matrix, scope.areaCodes) ? PORTAL_CLOSING_AREAS_EMPTY_MESSAGE : null,
  };
}

export type PortalClosingTrendPoint = {
  period: string;
  salesValue: number;
  salesUnits: number;
  /** The same published closing's target value for the viewer's scope; null when none is loaded. */
  targetValue: number | null;
};

/**
 * Month-over-month series for the viewer's line/products across the most recent
 * published months (oldest → newest for charting). Caps at `maxMonths`.
 */
export async function loadPortalClosingTrend(input: {
  access: AccessContext;
  maxMonths?: number;
}): Promise<PortalClosingTrendPoint[]> {
  const scope = await resolvePortalClosingScope(input.access);
  if (!scope.line) return [];

  const publishedPeriods = await listPublishedPeriodsForLine(scope.line);
  if (publishedPeriods.length === 0) return [];

  const periods = publishedPeriods.slice(0, Math.max(1, input.maxMonths ?? 6));

  const points = await Promise.all(
    periods.map(async (period) => {
      const raw = await loadMonthlyClosingWithStoreSplit({ line: scope.line as string, period });
      const safe = stripRestrictedColumns(raw);
      const productScoped = scope.productCodes ? scopeMatrixToProducts(safe, scope.productCodes) : safe;
      const matrix = applyRegionScope(productScoped, scope.regionNames, areaCodesForMonth(scope.areaCodes, scope.earlierMonthAreas, period));
      const salesUnits = matrix.grandTotal.cells.reduce((sum, cell) => sum + cell.salesUnits, 0);
      return { period, salesValue: matrix.grandTotal.rowTotal.salesValue, salesUnits, targetValue: matrix.grandTotal.rowTotal.targetValue ?? null };
    }),
  );

  return points.sort((left, right) => left.period.localeCompare(right.period));
}

// ── Backward-compat shims ─────────────────────────────────────────────────────
// Legacy callers (monthly-sales/page.tsx, monthly-closing-region-scope.test.ts)
// use the old region-scoped API. Keep these until all callers are migrated.

/**
 * Filter a closing matrix down to a set of SoS region codes, recomputing the grand total from the
 * surviving regions. National-direct and company totals are dropped.
 * @deprecated Use scopeMatrixToProducts for the new product-scoped API.
 */
export function scopeMatrixToRegions(
  matrix: MonthlyClosingMatrix,
  codes: Set<string>,
): MonthlyClosingMatrix {
  const allowed = new Set([...codes].map((code) => code.trim().toUpperCase()));
  return scopeMatrixByRegion(
    matrix,
    () => false,
    (code) => allowed.has((code ?? "").trim().toUpperCase()),
  );
}

/**
 * Live (non-publication-gated) monthly closing for the portal.
 * Unlike loadPortalMonthlyClosing, this reads directly from the raw SoS data so
 * territory roles (DM/RM/NSM) see their line's data as soon as it is uploaded,
 * without waiting for an admin to publish it. Product-scoped roles (PM/GPM/MM)
 * still require product codes in weekly_sales_product_scope to see columns.
 */
export async function loadPortalLiveMonthly(input: {
  access: AccessContext;
  /** Which allowed line to read. Omit for the viewer's default line. Refused if out of scope. */
  line?: string | null;
  period?: string | null;
}): Promise<PortalClosingResult> {
  const scope = await resolvePortalClosingScope(input.access);
  // Publication-free by design (that is this function's whole purpose), so every allowed line is
  // selectable — `publishedLines` is the allowed set itself, not a narrowing.
  const { availableLines, line: selectedLine, refused } = pickPortalClosingLine({
    allowedLines: scope.allowedLines,
    publishedLines: scope.allowedLines,
    requestedLine: input.line,
  });
  if (refused || !selectedLine) {
    return { matrix: null, line: null, availableLines, availablePeriods: [], selectedPeriod: null, awaitingPublish: false };
  }

  const raw = await loadMonthlyClosingWithStoreSplit({ line: selectedLine, period: input.period ?? null });
  const availablePeriods: string[] = raw.availablePeriods ?? [];

  if (availablePeriods.length === 0) {
    return { matrix: null, line: selectedLine, availableLines, availablePeriods: [], selectedPeriod: null, awaitingPublish: false };
  }

  const selectedPeriod =
    input.period && availablePeriods.includes(input.period)
      ? input.period
      : availablePeriods[0];

  const safe = stripRestrictedColumns(raw);
  const productScoped = scope.productCodes ? scopeMatrixToProducts(safe, scope.productCodes) : safe;
  const matrix = applyRegionScope(productScoped, scope.regionNames, areaCodesForMonth(scope.areaCodes, scope.earlierMonthAreas, selectedPeriod));

  return {
    matrix,
    line: selectedLine,
    availableLines,
    availablePeriods,
    selectedPeriod,
    awaitingPublish: false,
    areasEmptyMessage: isAreaBoundMatrixEmpty(matrix, scope.areaCodes) ? PORTAL_CLOSING_AREAS_EMPTY_MESSAGE : null,
  };
}
