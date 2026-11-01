import { resolveEmployeeIdentityId, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { canonicalizeRegionName, resolveSalesAccessScope } from "@/lib/sales/access-scope";
import {
  loadSalesNameMastersOncePerRender,
  MEDICAL_REP_AREA_UNRESOLVED_MESSAGE,
  resolveMedicalRepSosAreaCodes,
} from "@/lib/sales/medical-rep-area-scope";
import { resolveOfficialLineValue } from "@/lib/sales/official-lines";
import { resolveRegionalManagerRegionCodes } from "@/lib/sales/portal-sos-dashboard";
import { districtRegionCodesHeldBy, loadSalesSeatTree } from "@/lib/sales/seat-hierarchy";

import { TERRITORY_PICKER_LINES } from "./skeleton";
import type { TerritoryDiagnosticCode, TerritoryRootScope } from "./types";

const REGION_UNRESOLVED_MESSAGE = "We couldn't determine your region. Contact HR/your admin.";
const LINE_UNRESOLVED_MESSAGE = "We couldn't determine your product line. Contact HR/your admin.";

// Super Admin and CEO see EVERY product line, so deriveOfficialLine (which needs exactly one) can
// never resolve for them. By owner decision (2026-09-23) they instead PICK a line and drill it
// nationwide — the only two roles that read a caller-supplied line. Every business role's line is
// derived from their own scope and their selected-line argument is ignored.
export const TERRITORY_LINE_PICKER_ROLES = ["Super Admin", "CEO"] as const satisfies readonly PhoenixRole[];

const TERRITORY_LINE_PICKER_ROLE_SET = new Set<PhoenixRole>(TERRITORY_LINE_PICKER_ROLES);

export function isTerritoryLinePickerRole(role: PhoenixRole): boolean {
  return TERRITORY_LINE_PICKER_ROLE_SET.has(role);
}

/** Resolve a picker role's chosen line to a canonical, seat-carrying official line, defaulting to
 *  the first picker line when the argument is missing or not one of the three drillable lines. */
export function resolveTerritoryPickerLine(selectedLine: string | null | undefined): string {
  const canonical = selectedLine ? resolveOfficialLineValue(selectedLine) : null;
  if (canonical && (TERRITORY_PICKER_LINES as readonly string[]).some((line) => line.toLowerCase() === canonical.toLowerCase())) {
    return canonical;
  }
  return TERRITORY_PICKER_LINES[0];
}

function denied(code: TerritoryDiagnosticCode, message: string): TerritoryRootScope {
  return { level: "denied", diagnostic: { code, message } };
}

/**
 * Pure: pick the viewer's single official line out of resolveSalesAccessScope's
 * allowedLineNames. Medical Rep/District Manager/Regional Manager/National Sales Manager all
 * resolve to exactly one line (computeSalesAccessScope always builds a single-element set for
 * these business scopes) — more or fewer than one element means the line genuinely didn't
 * resolve, so this fails closed to null rather than guessing.
 */
export function deriveOfficialLine(allowedLineNames: Set<string> | null): string | null {
  if (!allowedLineNames || allowedLineNames.size !== 1) return null;
  return [...allowedLineNames][0];
}

async function resolveMedicalRepAreaScope(ctx: AccessContext, officialLine: string): Promise<TerritoryRootScope> {
  // The chain lives in medical-rep-area-scope.ts, shared with the portal Monthly Closing, so the
  // drilldown and the closing can never disagree about which areas are a rep's own.
  const sosAreaCodes = await resolveMedicalRepSosAreaCodes(ctx);
  if (!sosAreaCodes) return denied("area_unresolved", MEDICAL_REP_AREA_UNRESOLVED_MESSAGE);
  return { level: "area", sosAreaCodes, officialLine };
}

// The access scope the caller already resolved, passed down rather than read a second time.
type SalesAccessScope = Awaited<ReturnType<typeof resolveSalesAccessScope>>;

// The name masters are read through loadSalesNameMastersOncePerRender, the per-render cache the
// skeleton reads too — a cold uncached read here and another in the skeleton was the same ~6 tables
// twice on every first paint of the page (2026-10-26, "first paint takes >35 s").
async function resolveDistrictManagerRegionScope(
  salesScope: SalesAccessScope,
  officialLine: string,
): Promise<TerritoryRootScope> {

  // A DM's real geography is his organogram seat's areas, which can legitimately sit outside
  // his region label (CNS "Kafr El-Sheikh 1" / D16 belongs to the Alex-BHR DM while its rows
  // carry D1). The region-label path below both LOSES those areas and DRAGS IN the sibling
  // DM's areas that share the label's region — so when the seat answered, scope by area.
  const seatAreaCodes = [...(salesScope.allowedAreaCodes ?? [])]
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
  if (seatAreaCodes.length > 0) {
    const references = await loadSalesNameMastersOncePerRender();
    const knownAreaCodes = new Set((references.areas ?? []).map((area) => area.areaCode.toUpperCase()));
    const confirmedAreaCodes = seatAreaCodes.filter((code) => knownAreaCodes.has(code));
    if (confirmedAreaCodes.length > 0) {
      return { level: "area", sosAreaCodes: confirmedAreaCodes, officialLine };
    }
  }

  const regionName = salesScope.allowedRegionNames && salesScope.allowedRegionNames.size === 1
    ? [...salesScope.allowedRegionNames][0]
    : null;
  if (!regionName) return denied("region_unresolved", REGION_UNRESOLVED_MESSAGE);

  const references = await loadSalesNameMastersOncePerRender();
  const regionCode = references.regions.find(
    (region) => canonicalizeRegionName(region.regionName) === regionName,
  )?.regionCode;
  if (!regionCode) return denied("region_unresolved", REGION_UNRESOLVED_MESSAGE);

  return { level: "region", regionCodes: [regionCode.toUpperCase()], officialLine };
}

async function resolveRegionalManagerScope(
  ctx: AccessContext,
  salesScope: SalesAccessScope,
  officialLine: string,
): Promise<TerritoryRootScope> {
  const references = await loadSalesNameMastersOncePerRender();
  const [regionCodes, seats] = await Promise.all([
    resolveRegionalManagerRegionCodes(ctx, salesScope, references),
    loadSalesSeatTree(),
  ]);
  if (regionCodes.size === 0) return denied("region_unresolved", REGION_UNRESOLVED_MESSAGE);
  const held = districtRegionCodesHeldBy(resolveEmployeeIdentityId(ctx), seats);
  return {
    level: "region",
    regionCodes: [...new Set([...regionCodes].map((code) => code.toUpperCase()).concat(held))],
    officialLine,
  };
}

/**
 * The new, module-specific hard-lock resolution path for the Territory Drilldown module.
 * Runs ALONGSIDE resolveSalesAccessScope (reuses only its line resolution) — it never forks
 * or weakens resolveSalesAccessScope itself, which every other sales surface still depends on
 * at its existing (region-level) strictness.
 *
 * Re-run this on EVERY request that needs a scope decision (skeleton load AND every per-area
 * fetch) — never cache/trust a scope computed on a previous request.
 */
export async function resolveTerritoryRootScope(
  ctx: AccessContext,
  selectedLine?: string | null,
): Promise<TerritoryRootScope> {
  // Super Admin / CEO: no single line of their own, so they pick one and drill it nationwide. This
  // is the ONLY path that reads selectedLine; it bypasses the single-line deriveOfficialLine gate
  // below (which would fail closed for a viewer who sees every line).
  if (isTerritoryLinePickerRole(ctx.role as PhoenixRole)) {
    return { level: "nationwide", officialLine: resolveTerritoryPickerLine(selectedLine) };
  }

  const salesScope = await resolveSalesAccessScope(ctx);
  const officialLine = deriveOfficialLine(salesScope.allowedLineNames);
  if (!officialLine) return denied("line_unresolved", LINE_UNRESOLVED_MESSAGE);

  switch (ctx.role as PhoenixRole) {
    case "Medical Rep":
      return resolveMedicalRepAreaScope(ctx, officialLine);
    case "District Manager":
      return resolveDistrictManagerRegionScope(salesScope, officialLine);
    case "Regional Manager":
      return resolveRegionalManagerScope(ctx, salesScope, officialLine);
    case "National Sales Manager":
      return { level: "nationwide", officialLine };
    default:
      return denied("role_unsupported", "This role doesn't have a territory drilldown yet.");
  }
}
