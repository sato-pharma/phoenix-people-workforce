export const employeePortalOwnedRoutePatterns = [
  "/employee-portals",
  "/employee-portals/*",
  "/leave-management/vacation-control",
] as const;

const exactEmployeePortalOwnedRoutes = new Set<string>([
  "/employee-portals",
  "/leave-management/vacation-control",
]);

export function isEmployeePortalOwnedRoute(pathname: string | null | undefined) {
  if (!pathname) return false;
  const normalizedPathname = pathname.split("?")[0].split("#")[0] || "/";

  return (
    exactEmployeePortalOwnedRoutes.has(normalizedPathname) ||
    normalizedPathname.startsWith("/employee-portals/")
  );
}
