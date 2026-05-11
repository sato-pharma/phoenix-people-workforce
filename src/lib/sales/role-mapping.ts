export type SalesOrgRole = "MR" | "DSM" | "MR_DSM" | "NSM";

const salesRoleByHrId: Record<string, SalesOrgRole> = {
  "B-1": "MR_DSM",
  "B-116": "DSM",
  "B-117": "DSM",
  "B-118": "DSM",
  "B-119": "DSM",
  "B-120": "DSM",
};

export function salesRoleOverrideForHrId(hrId: string | null | undefined) {
  const key = String(hrId ?? "").trim().toUpperCase();
  return salesRoleByHrId[key] ?? null;
}
