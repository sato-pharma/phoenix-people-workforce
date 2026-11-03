"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useTransition } from "react";
import { Radar, ClipboardList, Scale } from "lucide-react";

import { cn } from "@/lib/utils";

type TabKey = "intelligence" | "queue" | "reconcile";

const TAB_DEFS: ReadonlyArray<{ key: TabKey; label: string; icon: typeof Radar; description: string }> = [
  { key: "intelligence", label: "Intelligence", icon: Radar, description: "KPIs, map, charts, ledger" },
  { key: "queue", label: "Queue", icon: ClipboardList, description: "Per-request review & approval" },
  { key: "reconcile", label: "Against payslips", icon: Scale, description: "Approved beside what was paid" },
];

/**
 * Tab bar at the top of /admin/outstation/expense-command. Switches the URL's
 * `?tab=` param (Intelligence is the default). Other query params (filters,
 * requestId, action) are preserved across tab switches so email deep-links and
 * shared filter URLs keep working.
 *
 * Queue tab is hidden when the caller can't approve. The server page enforces the
 * same gate — this is defense-in-depth, never the primary guard.
 */
export function ExpenseCommandTabs({
  active,
  canApprove,
  children,
}: {
  active: TabKey;
  canApprove: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const visibleTabs = useMemo(
    () => TAB_DEFS.filter((tab) => tab.key !== "queue" || canApprove),
    [canApprove],
  );

  function switchTab(next: TabKey) {
    if (next === active) return;
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === "intelligence") params.delete("tab");
    else params.set("tab", next);
    if (next !== "reconcile") params.delete("reconcileMonth");
    const query = params.toString();
    startTransition(() => {
      router.replace(query ? `/admin/outstation/expense-command?${query}` : "/admin/outstation/expense-command", {
        scroll: false,
      });
    });
  }

  // Only one tab visible (read-only role) → render the child directly, no chrome.
  if (visibleTabs.length <= 1) return <>{children}</>;

  return (
    <div className="space-y-5">
      <div
        className="inline-flex w-full flex-wrap rounded-[14px] border border-phx-line bg-white p-1 shadow-[0_8px_22px_rgba(15,23,42,0.04)] sm:w-auto"
        role="tablist"
      >
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.key === active;
          return (
            <button
              key={tab.key}
              aria-selected={isActive}
              className={cn(
                "inline-flex items-center gap-2 rounded-[10px] px-4 py-2 text-sm font-bold transition-colors",
                isActive
                  ? "bg-phx-ink text-white shadow-[0_4px_12px_rgba(15,23,42,0.18)]"
                  : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                isPending && "opacity-70",
              )}
              onClick={() => switchTab(tab.key)}
              role="tab"
              type="button"
            >
              <Icon className="h-4 w-4" />
              <span>{tab.label}</span>
              <span className="hidden text-phx-xs font-medium text-slate-400 sm:inline">{tab.description}</span>
            </button>
          );
        })}
      </div>
      {children}
    </div>
  );
}
