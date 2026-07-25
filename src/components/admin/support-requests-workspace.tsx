"use client";

import { useMemo, useState } from "react";

import { adminPanelClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";
import { Badge } from "@/components/ui/badge";
import {
  SUPPORT_REQUEST_STATUSES,
  type SupportRequestRow,
  type SupportRequestStatus,
} from "@/lib/support-requests/types";
import { SearchableSelect } from "@/components/ui/searchable-select";


type StatusFilter = SupportRequestStatus | "all";

const STATUS_VARIANT: Record<SupportRequestStatus, "neutral" | "success" | "warning" | "danger"> = {
  Pending: "warning",
  "In Progress": "neutral",
  Resolved: "success",
  Closed: "neutral",
};

function formatDate(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SupportRequestsWorkspace({
  canManage,
  initialItems,
}: {
  canManage: boolean;
  initialItems: SupportRequestRow[];
}) {
  const [items, setItems] = useState<SupportRequestRow[]>(initialItems);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const counts = useMemo(() => {
    const base: Record<StatusFilter, number> = {
      all: items.length,
      Pending: 0,
      "In Progress": 0,
      Resolved: 0,
      Closed: 0,
    };
    for (const item of items) base[item.status] += 1;
    return base;
  }, [items]);

  const visible = useMemo(
    () => (statusFilter === "all" ? items : items.filter((item) => item.status === statusFilter)),
    [items, statusFilter],
  );

  async function changeStatus(id: string, status: SupportRequestStatus) {
    setSavingId(id);
    setError(null);
    const previous = items;
    // Optimistic update.
    setItems((current) => current.map((item) => (item.id === id ? { ...item, status } : item)));
    try {
      const response = await fetch("/api/admin/support-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Failed to update the ticket status.");
      }
    } catch (caught) {
      setItems(previous); // roll back
      setError(caught instanceof Error ? caught.message : "Failed to update the ticket status.");
    } finally {
      setSavingId(null);
    }
  }

  const filters: StatusFilter[] = ["all", ...SUPPORT_REQUEST_STATUSES];

  return (
    <div className="space-y-4">
      {/* Status filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        {filters.map((filter) => {
          const active = statusFilter === filter;
          return (
            <button
              key={filter}
              type="button"
              onClick={() => setStatusFilter(filter)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                active
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
              }`}
            >
              {filter === "all" ? "All" : filter}
              <span className={`ml-1.5 ${active ? "text-slate-300" : "text-slate-400"}`}>
                {counts[filter]}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <div
          aria-live="polite"
          className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700"
          role="status"
        >
          {error}
        </div>
      )}

      {visible.length === 0 ? (
        <div className={`${adminSoftPanelClassName} p-10 text-center text-sm text-slate-500`}>
          No support requests{statusFilter === "all" ? " yet" : ` with status “${statusFilter}”`}.
        </div>
      ) : (
        <div className={`${adminPanelClassName} divide-y divide-slate-100`}>
          {visible.map((item) => (
            <article key={item.id} className="flex flex-col gap-3 p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-bold text-slate-900">{item.subject}</h3>
                    <Badge variant={STATUS_VARIANT[item.status]}>{item.status}</Badge>
                  </div>
                  <p className="mt-0.5 text-[12px] text-slate-500">
                    {item.employeeName} ({item.hrId}) · {item.category}
                    {item.subcategory ? ` / ${item.subcategory}` : ""} · {formatDate(item.createdAt)}
                  </p>
                </div>

                {canManage ? (
                  <label className="flex items-center gap-2 text-[11px] font-semibold text-slate-500">
                    <span className="hidden sm:inline">Status</span>
                    <SearchableSelect
                      aria-label={`Status for ${item.subject}`}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 disabled:opacity-50"
                      disabled={savingId === item.id}
                      onChange={(event) => changeStatus(item.id, event.target.value as SupportRequestStatus)}
                      value={item.status}
                    >
                      {SUPPORT_REQUEST_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </SearchableSelect>
                  </label>
                ) : null}
              </div>

              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-700">
                {item.description}
              </p>

              {item.attachments.length > 0 && (
                <p className="text-[11px] text-slate-500">
                  {item.attachments.length} attachment{item.attachments.length === 1 ? "" : "s"}:{" "}
                  {item.attachments.map((file) => file.name).join(", ")}
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
