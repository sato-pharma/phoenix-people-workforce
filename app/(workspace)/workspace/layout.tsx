import type { ReactNode } from "react";

import { AppShell } from "@/components/layout/app-shell";
import { requireAdminShellEmployeeWorkspaceAccess } from "@/lib/workspace/admin-shell-employee";

export default async function AdminShellEmployeeWorkspaceLayout({ children }: { children: ReactNode }) {
  const access = await requireAdminShellEmployeeWorkspaceAccess();
  return (
    <AppShell accessContext={access} navigationMode="admin">
      {children}
    </AppShell>
  );
}
