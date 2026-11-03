import { canAccess, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";

/**
 * May this viewer be offered a link into Customer 360 from a screen where a pharmacy's name is read
 * (owner, 2026-11-03)? Office roles only: it asks what the Customer 360 pages themselves ask, and they
 * redirect a portal reader away. Each page still scopes the customer to the viewer's own territory, so
 * a link can never reach a customer the list would not offer.
 */
export async function canOpenCustomer360(access: AccessContext): Promise<boolean> {
  if (resolveNavigationMode(access) === "employee-portal") return false;
  const canReadSales = await canAccess(access, "sales", "read");
  return canReadSales;
}
