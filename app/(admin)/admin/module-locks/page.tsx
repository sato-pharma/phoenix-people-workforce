import { ModuleLocksManager } from "@/components/admin/module-locks-manager";
import { listLockableAccounts, type LockableAccount } from "@/lib/auth/module-lock-accounts";
import { listModuleLocks, type ModuleLock } from "@/lib/auth/module-locks";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { assertPermission } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

export default async function ModuleLocksPage() {
  let accounts: LockableAccount[] = [];
  let active: ModuleLock[] = [];
  let history: ModuleLock[] = [];
  let initialError: string | null = null;

  try {
    const access = await resolveAuthenticatedPageAccess();
    // `admin:update` — the Super Admin alone. Asserted here as well as in the route behind it,
    // because a page that renders the picker and then fails on save is worse than one that never
    // renders it.
    await assertPermission(access, "admin", "update");
    const [accountRows, locks] = await Promise.all([listLockableAccounts(), listModuleLocks()]);
    accounts = accountRows;
    active = locks.active;
    history = locks.history;
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Module locks failed to load.";
  }

  return (
    <ModuleLocksManager
      initialAccounts={accounts}
      initialActive={active}
      initialError={initialError}
      initialHistory={history}
    />
  );
}
