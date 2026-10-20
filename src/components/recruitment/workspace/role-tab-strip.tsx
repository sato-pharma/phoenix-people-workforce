"use client";

// Recruitment workspace — the role tabs the owner named on 20 Oct 2026, then Needs placing and
// Folders. Which role tabs appear is decided on the SERVER (`workspaceViewer`): the Talent
// Acquisition seat is simply never handed the two HR tabs, so there is nothing here to hide.
//
// The kit's tab bar prints its counts at 10px, under the owner's 11px floor, so this strip draws the
// same square segments with 11px counts. The segments wrap onto a second line on a phone.

import { FolderTree, Inbox } from "lucide-react";

import { adminChipDepthClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { FOLDERS_TAB, NEEDS_PLACING, workspaceTabLabels, type WorkspaceRoleTab, type WorkspaceTabKey } from "@/lib/recruitment/workspace/role-tabs";
import { cn } from "@/lib/utils";

const NUMBER = new Intl.NumberFormat("en-US");

export function RoleTabStrip({
  counts,
  onChange,
  roleTabs,
  seesNeedsPlacing,
  value,
}: {
  counts: Partial<Record<WorkspaceTabKey, number>> | null;
  onChange: (tab: WorkspaceTabKey) => void;
  roleTabs: readonly WorkspaceRoleTab[];
  seesNeedsPlacing: boolean;
  value: WorkspaceTabKey;
}) {
  const tabs: WorkspaceTabKey[] = [...roleTabs, ...(seesNeedsPlacing ? [NEEDS_PLACING] : []), FOLDERS_TAB];
  return (
    <div
      aria-label="Roles"
      className={`flex flex-wrap gap-1 border border-slate-200 bg-slate-100/80 p-1 ${adminRecessedDepthClassName}`}
      role="tablist"
    >
      {tabs.map((tab) => {
        const selected = tab === value;
        const count = tab === FOLDERS_TAB ? null : counts?.[tab] ?? null;
        const waiting = tab === NEEDS_PLACING && (count ?? 0) > 0;
        return (
          <button
            aria-selected={selected}
            className={cn(
              "relative inline-flex min-h-9 grow items-center justify-center gap-1.5 px-2.5 py-1.5 text-[13px] font-bold transition-colors sm:grow-0 sm:px-3.5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-1",
              selected ? cn("bg-white text-slate-950", adminChipDepthClassName) : "text-slate-600 hover:bg-white/70 hover:text-slate-900",
              tab === NEEDS_PLACING || tab === FOLDERS_TAB ? "sm:ml-1" : null,
            )}
            key={tab}
            onClick={() => onChange(tab)}
            role="tab"
            type="button"
          >
            {tab === NEEDS_PLACING ? (
              <Inbox aria-hidden className={cn("h-3.5 w-3.5", waiting ? "text-amber-600" : "text-slate-400")} />
            ) : tab === FOLDERS_TAB ? (
              <FolderTree aria-hidden className={cn("h-3.5 w-3.5", selected ? "text-orange-600" : "text-slate-400")} />
            ) : null}
            <span className="whitespace-nowrap">{workspaceTabLabels[tab]}</span>
            {count !== null ? (
              <span
                className={cn(
                  "border px-1.5 text-phx-xs font-black tabular-nums",
                  waiting
                    ? "border-amber-300 bg-amber-50 text-amber-800"
                    : selected
                      ? "border-orange-200 bg-orange-50 text-orange-700"
                      : "border-slate-200 bg-white/80 text-slate-500",
                )}
              >
                {NUMBER.format(count)}
              </span>
            ) : null}
            {selected ? <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 bg-orange-500" /> : null}
          </button>
        );
      })}
    </div>
  );
}
