import { LoginSecurityPanel } from "@/components/admin/system-audit/login-security-panel";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadLoginSecurityOverview } from "@/lib/security/login-security";
import { recordSystemAuditRead } from "@/lib/system-audit/read-audit";

/**
 * The Login security section of the System Audit page — moved here from the retired System Issues
 * and Monitoring pages on 23 Oct 2026.
 *
 * An async server component, so the page mounts it inside its own <Suspense> with no props: it
 * reads the first view on the server and hands it to the client panel, which owns the search, the
 * pager and the Block / Unblock buttons. `loadLoginSecurityOverview` never throws — a source that
 * could not be read is named in `unavailable` and its figure is null, which the panel shows as
 * "Unavailable", never as zero.
 */
export async function LoginSecuritySection() {
  const access = await resolveAccessContextFromPage();
  const overview = await loadLoginSecurityOverview();
  // The first paint hands over people's sign-in addresses like the refresh route does, so it writes the same
  // system_audit_view row, awaited before the page renders. The page's Super Admin guard has already run.
  await recordSystemAuditRead(
    { hrId: access.hrId ?? null, loginId: access.loginId ?? null },
    {
      kind: "login_security",
      page: overview.recentActivity?.page ?? 1,
      search: overview.recentActivity?.search || null,
      addresses: overview.signals.bruteForceIps.length,
    },
  );
  return <LoginSecurityPanel overview={overview} />;
}
