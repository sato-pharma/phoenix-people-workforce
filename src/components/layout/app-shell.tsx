import type { ReactNode } from "react";

import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";

export function AppShell({
  children,
  showTopbar = true,
}: {
  children?: ReactNode;
  showTopbar?: boolean;
}) {
  return (
    <div className="min-h-screen bg-bg-soft text-text">
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          {showTopbar && <Topbar />}
          <main className="flex-1 px-3 py-6 sm:px-4 lg:px-5 xl:px-6">
            <div className="w-full max-w-none">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
