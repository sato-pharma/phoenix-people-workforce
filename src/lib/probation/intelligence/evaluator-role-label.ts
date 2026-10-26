// Human-readable evaluator role for the probation portal -- owner rule: names, never codes.
// One map for the scorecard launcher (server page) and the feedback inbox (client panel).
export const EVALUATOR_ROLE_LABEL: Record<string, string> = {
  dm: "District Manager",
  nsm: "National Sales Manager",
  tm: "Training Manager",
  pm_gpm: "Product Manager",
};

export function evaluatorRoleLabel(role: string | null | undefined): string {
  return role ? (EVALUATOR_ROLE_LABEL[role] ?? role) : "";
}
