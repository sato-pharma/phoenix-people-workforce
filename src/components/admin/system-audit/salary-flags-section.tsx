import { SalaryFlagsPanel } from "@/components/admin/system-audit/salary-flags-panel";
import { getSalaryFlags, type SalaryFlagsResult } from "@/lib/admin/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

/**
 * The Salary flags section of the System Audit page — moved here from the retired Data Health page
 * on 23 Oct 2026.
 *
 * An async server component, so the page mounts it inside its own <Suspense> with no props: it
 * reads every unresolved flag on the server (paged, never cut at a row limit) and hands the list to
 * the client panel, which owns the "Show resolved" toggle and the Resolve button. A failed read is
 * shown as unavailable with its reason, never as an empty list.
 */
export async function SalaryFlagsSection() {
  // Data fetch and JSX stay separated (react-hooks/error-boundaries: no JSX inside try/catch).
  let flags: SalaryFlagsResult | null = null;
  let loadError: string | null = null;
  try {
    flags = await getSalaryFlags(false, { withNames: true });
  } catch (error) {
    console.error("Failed to load salary flags for the System Audit:", error);
    loadError = clientSafeErrorMessage(error, "The salary flags could not be read.");
  }
  return <SalaryFlagsPanel initialFlags={flags} loadError={loadError} />;
}
