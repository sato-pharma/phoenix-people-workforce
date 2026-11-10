// The Product picker on a Monthly Marketing Functions item (plan, 2026-11-10: "a picker from his own
// product scope, with free text allowed"). His own products first — the Employee 360 product master,
// pm_product_assignments — then every product, so a Product Manager with no assignment yet still has a
// list. The field stays free text: a name not on the list is kept as typed.

import type { AccessContext } from "@/lib/auth/permissions";
import { getPmProductCodes, listPmProductOptions } from "@/lib/employee-360/pm-products";

import { isMarketingFunctionsAuthor } from "./scope";

export async function listMarketingProductNames(access: AccessContext): Promise<string[]> {
  if (!isMarketingFunctionsAuthor(access) || !access.hrId) return [];
  const [own, all] = await Promise.all([getPmProductCodes(access.hrId), listPmProductOptions()]);
  const ownCodes = new Set(own.map((code) => code.toUpperCase()));
  const names = (codes: (code: string) => boolean) =>
    all
      .filter((product) => product.name && codes(product.code.toUpperCase()))
      .map((product) => product.name)
      .sort((left, right) => left.localeCompare(right));
  return [...new Set([...names((code) => ownCodes.has(code)), ...names((code) => !ownCodes.has(code))])];
}
