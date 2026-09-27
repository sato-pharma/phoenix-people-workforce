import { TestAccountsManager } from "@/components/admin/test-accounts-manager";
import { assertTestAccountAdmin, loadTestAccounts, type TestAccountsView } from "@/lib/admin/test-accounts";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";

export const dynamic = "force-dynamic";

export default async function TestAccountsPage() {
  let initial: TestAccountsView = { accounts: [], people: [] };
  let initialError: string | null = null;

  try {
    const access = await resolveAuthenticatedPageAccess();
    // The Super Admin alone — asserted here as well as in every route behind the screen.
    await assertTestAccountAdmin(access);
    initial = await loadTestAccounts();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Test accounts failed to load.";
  }

  return <TestAccountsManager initial={initial} initialError={initialError} />;
}
