// The portal roles are the SAME list the navigation mode reads — see portal-shell-roles.ts for
// the loop a second copy here would cause.
import { isPortalShellRole } from "@/lib/auth/portal-shell-roles";

export function resolveLandingPathForRole(role: string | null | undefined) {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "hr specialist" || normalized === "hr manager") return "/admin";
  // Admin-shell employee roles land in their personal /workspace home rather than the org-wide
  // /admin marketing module. Marketing Manager uses the employee portal alongside PM/GPM.
  // His own command center, peer to the CEO's and the SFE Manager's. He previously landed on
  // /admin/outstation/expense-command — one module of a job that spans payroll, direct orders,
  // marketing execution, expenses and leave. Outstation is still one click away in the sidebar.
  if (normalized === "finance manager") return "/admin/finance-command-center";
  if (normalized === "sfe manager") return "/admin/sfe-command-center";
  // Financial Advisor's job is executing the marketing finance step — land on its workspace inbox.
  if (normalized === "financial advisor") return "/workspace/marketing-requests/inbox";
  // The Training Manager lands on her coaching section again (owner, 2026-10-24, lifting the
  // 2026-09-29 portal hide). The portal home itself no longer bounces her, so the Command Center row
  // still opens the normal home.
  if (normalized === "training manager") return "/employee-portals/training-manager";
  // The two HR seats (owner, 2026-08-28). Admin-shell, so they must NOT be in the portal set
  // above — but /admin is the Super Admin home and shows them a shell of modules they do not
  // hold, so they get their own command centre, composed from the function bundle each seat
  // actually holds.
  //
  // The ADDRESS is what selects the HR shell, not the role (`resolveNavigationMode` never returns
  // "hr" — see its comment), so this must be the /hr spelling. Landing on the bare
  // /admin/hr-command-center would render the right page wearing the ADMIN sidebar for exactly one
  // paint, until AppShell's namespace redirect bounced it here anyway. Naming the /hr address
  // directly saves that round trip on every single sign-in.
  //
  // Until 2026-08-28 this returned "/workspace" — the personal admin-shell workspace — as a
  // placeholder while the namespace was being built.
  // The Talent Acquisition seat (HR Resourcing) joined them on 2026-10-08 — same namespace, same
  // command centre, composed from her own bundle.
  // "hr advisory" left this line when the owner retired the HR Business Partner seat on 2026-10-08: a retired key lands nowhere of its own.
  // The HR Operations Specialist seat (HR Administration) joined them on 2026-10-20.
  if (normalized === "hr operations" || normalized === "hr resourcing" || normalized === "hr administration") {
    return "/hr/admin/hr-command-center";
  }
  if (normalized === "ceo") return "/admin/ceo-command-center";
  return isPortalShellRole(normalized) ? "/employee-portals" : "/admin";
}
