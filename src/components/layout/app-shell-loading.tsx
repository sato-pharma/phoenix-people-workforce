import type { ReactNode } from "react";

import { adminShellBackgroundClassName } from "@/components/admin/admin-design-tokens";

export function AppShellLoading({
  children,
  navigationMode = "admin",
}: {
  children: ReactNode;
  navigationMode?: "admin" | "employee-portal";
}) {
  const isAdminMode = navigationMode === "admin";

  return (
    <div className={`min-h-screen text-[#0F172A] ${isAdminMode ? `admin-shell ${adminShellBackgroundClassName}` : "bg-[#F8FAFC]"}`}>
      <div className="flex min-h-screen">
        <aside className="hidden w-[280px] shrink-0 border-r border-white/10 bg-slate-950 lg:block" aria-label="Loading navigation">
          <div className="h-full animate-pulse space-y-4 p-4">
            <div className="h-10 rounded bg-white/10" />
            <div className="h-8 rounded bg-white/10" />
            <div className="h-8 rounded bg-white/10" />
            <div className="h-8 rounded bg-white/10" />
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="min-h-16 border-b border-slate-200 bg-white/90 px-4 py-3">
            <div className="h-9 w-full max-w-md animate-pulse rounded bg-slate-200" />
          </header>
          <main className="min-w-0 flex-1 px-3 py-4 sm:px-4 sm:py-5 lg:px-6 lg:py-6 xl:px-8">
            <div className="mx-auto w-full max-w-[1480px]">
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
