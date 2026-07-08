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
        <aside
          aria-label="Loading navigation"
          className={`hidden w-[280px] shrink-0 border-r lg:block ${
            isAdminMode ? "border-[#1a1a1a] bg-[#000000]" : "border-[#E2E8F0] bg-white"
          }`}
        >
          <div className="h-full animate-pulse space-y-4 p-4">
            <div className={`h-10 rounded ${isAdminMode ? "bg-white/10" : "bg-slate-200"}`} />
            <div className={`h-8 rounded ${isAdminMode ? "bg-white/10" : "bg-slate-200"}`} />
            <div className={`h-8 rounded ${isAdminMode ? "bg-white/10" : "bg-slate-200"}`} />
            <div className={`h-8 rounded ${isAdminMode ? "bg-white/10" : "bg-slate-200"}`} />
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header
            className={`min-h-16 border-b px-4 py-3 ${
              isAdminMode ? "border-[#1a1a1a] bg-[#000000]" : "border-slate-200 bg-white/90"
            }`}
          >
            <div className={`h-9 w-full max-w-md animate-pulse rounded ${isAdminMode ? "bg-white/10" : "bg-slate-200"}`} />
          </header>
          <main className="min-w-0 flex-1 px-3 py-4 sm:px-4 sm:py-5 lg:px-6 lg:py-6 xl:px-8">
            <div className="mx-auto w-full max-w-[1760px]">
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
