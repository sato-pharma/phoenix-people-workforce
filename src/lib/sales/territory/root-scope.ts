import { type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { canonicalizeRegionName, resolveSalesAccessScope } from "@/lib/sales/access-scope";
import {
  MEDICAL_REP_AREA_UNRESOLVED_MESSAGE,
  resolveMedicalRepSosAreaCodes,
} from "@/lib/sales/medical-rep-area-scope";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { resolveRegionalManagerRegionCodes } from "@/lib/sales/portal-sos-dashboard";

import type { TerritoryDiagnosticCode, TerritoryRootScope } from "./types";

const REGION_UNRESOLVED_MESSAGE = "We couldn't determine your region. Contact HR/your admin.";
const LINE_UNRESOLVED_MESSAGE = "We couldn't determine your product line. Contact HR/your admin.";

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

async function resolveDistrictManagerRegionScope(
  ctx: AccessContext,
  officialLine: string,
): Promise<TerritoryRootScope> {
  const salesScope = await resolveSalesAccessScope(ctx);

  // A DM's real geography is his organogram seat's areas, which can legitimately sit outside
  // his region label (CNS "Kafr El-Sheikh 1" / D16 belongs to the Alex-BHR DM while its rows
  // carry D1). The region-label path below both LOSES those areas and DRAGS IN the sibling
  // DM's areas that share the label's region — so when the seat answered, scope by area.
  const seatAreaCodes = [...(salesScope.allowedAreaCodes ?? [])]
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
  if (seatAreaCodes.length > 0) {
    const references = await loadSalesReferenceData({ includeCustomerBricks: false });
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

  const references = await loadSalesReferenceData({ includeCustomerBricks: false });
  const regionCode = references.regions.find(
    (region) => canonicalizeRegionName(region.regionName) === regionName,
  )?.regionCode;
  if (!regionCode) return denied("region_unresolved", REGION_UNRESOLVED_MESSAGE);

  return { level: "region", regionCodes: [regionCode.toUpperCase()], officialLine };
}

async function resolveRegionalManagerScope(ctx: AccessContext, officialLine: string): Promise<TerritoryRootScope> {
  const salesScope = await resolveSalesAccessScope(ctx);
  const references = await loadSalesReferenceData({ includeCustomerBricks: false });
  const regionCodes = await resolveRegionalManagerRegionCodes(ctx, salesScope, references);
  if (regionCodes.size === 0) return denied("region_unresolved", REGION_UNRESOLVED_MESSAGE);
  return { level: "region", regionCodes: [...regionCodes].map((code) => code.toUpperCase()), officialLine };
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
export async function resolveTerritoryRootScope(ctx: AccessContext): Promise<TerritoryRootScope> {
  const salesScope = await resolveSalesAccessScope(ctx);
  const officialLine = deriveOfficialLine(salesScope.allowedLineNames);
  if (!officialLine) return denied("line_unresolved", LINE_UNRESOLVED_MESSAGE);

  switch (ctx.role as PhoenixRole) {
    case "Medical Rep":
      return resolveMedicalRepAreaScope(ctx, officialLine);
    case "District Manager":
      return resolveDistrictManagerRegionScope(ctx, officialLine);
    case "Regional Manager":
      return resolveRegionalManagerScope(ctx, officialLine);
    case "National Sales Manager":
      return { level: "nationwide", officialLine };
    default:
      return denied("role_unsupported", "This role doesn't have a territory drilldown yet.");
  }
}
