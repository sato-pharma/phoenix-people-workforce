"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { adminPanelClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  BUSINESS_CARD_REQUEST_STATUSES,
  type BusinessCardRequestRow,
  type BusinessCardRequestStatus,
} from "@/lib/business-cards/request-types";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";

// The consolidated queue every employee's business-card request lands on. HR reads what will print,
// prints the cards from the Business Cards generator, and moves each request through its statuses.
// Cards, not a table, so it reads the same on a phone and a desktop (fits-the-screen golden rule).

type StatusFilter = BusinessCardRequestStatus | "all";

const STATUS_VARIANT: Record<BusinessCardRequestStatus, "neutral" | "success" | "warning" | "danger"> = {
  Pending: "warning",
  "In Progress": "neutral",
  Printed: "success",
  Cancelled: "neutral",
};

function formatDate(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatStableEnGb(date, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
  });
}

export function BusinessCardRequestsQueue({
  canManage,
  initialItems,
}: {
  canManage: boolean;
  initialItems: BusinessCardRequestRow[];
}) {
  const [items, setItems] = useState<BusinessCardRequestRow[]>(initialItems);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const counts = useMemo(() => {
    const base: Record<StatusFilter, number> = {
      all: items.length,
      Pending: 0,
      "In Progress": 0,
      Printed: 0,
      Cancelled: 0,
    };
    for (const item of items) base[item.status] += 1;
    return base;
  }, [items]);

  const visible = useMemo(
    () => (statusFilter === "all" ? items : items.filter((item) => item.status === statusFilter)),
    [items, statusFilter],
  );

  async function changeStatus(id: string, status: BusinessCardRequestStatus) {
    setSavingId(id);
    setError(null);
    const previous = items;
    setItems((current) => current.map((item) => (item.id === id ? { ...item, status } : item)));
    try {
      const response = await fetch("/api/admin/business-card-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Failed to update the request status.");
      }
    } catch (caught) {
      setItems(previous);
      setError(caught instanceof Error ? caught.message : "Failed to update the request status.");
    } finally {
      setSavingId(null);
    }
  }

  const filters: StatusFilter[] = ["all", ...BUSINESS_CARD_REQUEST_STATUSES];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {filters.map((filter) => {
            const active = statusFilter === filter;
            return (
              <button
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                  active ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
                }`}
                key={filter}
                onClick={() => setStatusFilter(filter)}
                type="button"
              >
                {filter === "all" ? "All" : filter}
                <span className={`ml-1.5 ${active ? "text-slate-300" : "text-slate-400"}`}>{counts[filter]}</span>
              </button>
            );
          })}
        </div>
        <Link
          className="inline-flex items-center gap-1.5 text-phx-sm font-semibold text-phx-accent-press hover:underline"
          href="/business-cards"
        >
          <ExternalLink className="h-4 w-4" />
          Print cards
        </Link>
      </div>

      {error ? (
        <div
          aria-live="polite"
          className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-phx-sm font-semibold text-rose-700"
          role="status"
        >
          {error}
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className={`${adminSoftPanelClassName} p-10 text-center text-sm text-slate-500`}>
          No business card requests{statusFilter === "all" ? " yet" : ` with status “${statusFilter}”`}.
        </div>
      ) : (
        <div className={`${adminPanelClassName} divide-y divide-slate-100`}>
          {visible.map((item) => (
            <article className="flex flex-col gap-3 p-4 sm:p-5" key={item.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-bold text-slate-900">{item.cardName}</h3>
                    <Badge variant={STATUS_VARIANT[item.status]}>{item.status}</Badge>
                  </div>
                  <p className="mt-0.5 text-phx-sm text-slate-500">
                    {item.employeeName} ({item.hrId}) · {formatDate(item.createdAt)}
                  </p>
                </div>

                {canManage ? (
                  <label className="flex items-center gap-2 text-phx-xs font-semibold text-slate-500">
                    <span className="hidden sm:inline">Status</span>
                    <SearchableSelect
                      aria-label={`Status for ${item.cardName}`}
                      className="px-2 py-1 text-xs"
                      disabled={savingId === item.id}
                      onChange={(event) => changeStatus(item.id, event.target.value as BusinessCardRequestStatus)}
                      value={item.status}
                    >
                      {BUSINESS_CARD_REQUEST_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </SearchableSelect>
                  </label>
                ) : null}
              </div>

              <dl className="grid gap-x-6 gap-y-1.5 text-phx-sm text-slate-700 sm:grid-cols-2">
                <div className="flex flex-wrap gap-1.5">
                  <dt className="font-semibold text-slate-500">Mobile:</dt>
                  <dd className="min-w-0 break-words">{item.cardMobile || "—"}</dd>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <dt className="font-semibold text-slate-500">Email:</dt>
                  <dd className="min-w-0 break-words">{item.cardEmail || "—"}</dd>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <dt className="font-semibold text-slate-500">Job title:</dt>
                  <dd className="min-w-0 break-words">{item.cardTitle || "—"}</dd>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <dt className="font-semibold text-slate-500">Line · Area:</dt>
                  <dd className="min-w-0 break-words">{item.cardLineArea || "—"}</dd>
                </div>
              </dl>

              {item.note ? (
                <p className="whitespace-pre-wrap text-phx-sm leading-relaxed text-slate-700">
                  <span className="font-semibold text-slate-500">Note: </span>
                  {item.note}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
