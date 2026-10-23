import { LoginSecurityPanel } from "@/components/admin/system-audit/login-security-panel";
import { loadLoginSecurityOverview } from "@/lib/security/login-security";

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
  const overview = await loadLoginSecurityOverview();
  return <LoginSecurityPanel overview={overview} />;
}
