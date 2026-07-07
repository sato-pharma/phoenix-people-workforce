export type SalesOrgRole = "MR" | "DSM" | "MR_DSM" | "NSM";

const salesRoleByHrId: Record<string, SalesOrgRole> = {
  "B-1": "MR_DSM",
  "B-116": "DSM",
  "B-117": "DSM",
  "B-118": "DSM",
  "B-119": "DSM",
  "B-120": "DSM",
  // Hany Saad Mohamed Omar — Regional Sales Manager for the Pedia line's AB/D1/D2
  // regions (his sales scope resolves from his reporting subtree, not a stored region
  // list — see resolveRegionalManagerRegionCodes in portal-sos-dashboard.ts), sitting
  // between the NSM and DSMs B-74/B-154/B-5. His job_title doesn't match the NSM
  // pattern, so the linkage validation flagged him "expected NSM, found Regional Sales
  // Manager" even though he's the correct, legitimate person above those three DSMs.
  "PD-0001": "NSM",
};

export function salesRoleOverrideForHrId(hrId: string | null | undefined) {
  const key = String(hrId ?? "").trim().toUpperCase();
  return salesRoleByHrId[key] ?? null;
}
