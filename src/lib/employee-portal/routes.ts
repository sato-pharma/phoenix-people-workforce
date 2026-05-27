export const employeePortalOwnedRoutePatterns = [
  "/employee-portals",
  "/employee-portals/*",
  "/leave-management/vacation-request",
  "/leave-management/vacation-report",
  "/leave-management/vacation-control",
  "/payslips",
] as const;

const exactEmployeePortalOwnedRoutes = new Set<string>([
  "/employee-portals",
  "/leave-management/vacation-request",
  "/leave-management/vacation-report",
  "/leave-management/vacation-control",
  "/payslips",
]);

export function isEmployeePortalOwnedRoute(pathname: string | null | undefined) {
  if (!pathname) return false;
  const normalizedPathname = pathname.split("?")[0].split("#")[0] || "/";

  return (
    exactEmployeePortalOwnedRoutes.has(normalizedPathname) ||
    normalizedPathname.startsWith("/employee-portals/")
  );
}
