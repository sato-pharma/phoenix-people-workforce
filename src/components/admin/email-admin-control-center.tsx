"use client";

import { humanizeCode } from "@/lib/format/code-label";
import { useMemo, useState } from "react";

import type { EmailAdminControlCenter, EmailAdminDelivery } from "@/lib/notifications/email-admin";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";

type Props = {
  initialData: EmailAdminControlCenter;
};

const STATUS_FILTERS = ["all", "sent", "pending", "retrying", "failed", "skipped"] as const;

function badgeClass(status: string) {
  if (status === "sent") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "failed") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status === "retrying" || status === "pending") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-GB", { timeZone: PHOENIX_BUSINESS_TIME_ZONE });
}

function moduleLabel(value: string | null) {
  if (!value) return "Unknown";
  return humanizeCode(value);
}

export function EmailAdminControlCenterView({ initialData }: Props) {
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");

  const filteredDeliveries = useMemo(() => {
    if (statusFilter === "all") return initialData.deliveries;
    return initialData.deliveries.filter((delivery: EmailAdminDelivery) => delivery.status === statusFilter);
  }, [initialData.deliveries, statusFilter]);

  const { summary } = initialData;

  return (
    <div className="space-y-5">
      {initialData.hasMoreDeliveries ? (
        <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-600">
          Showing the latest {initialData.deliveries.length} email deliveries. Older records exist beyond this page — narrow
          your review period or export from the database for full history.
        </div>
      ) : null}

      <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
        <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Sent</p>
          <p className="mt-2 text-2xl font-black text-emerald-700">{summary.sentCount}</p>
        </div>
        <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Pending</p>
          <p className="mt-2 text-2xl font-black text-amber-700">{summary.pendingCount}</p>
        </div>
        <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Retrying</p>
          <p className="mt-2 text-2xl font-black text-amber-700">{summary.retryingCount}</p>
        </div>
        <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Failed</p>
          <p className="mt-2 text-2xl font-black text-rose-700">{summary.failedCount}</p>
        </div>
        <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Skipped</p>
          <p className="mt-2 text-2xl font-black text-slate-700">{summary.skippedCount}</p>
        </div>
      </section>

      <section className="rounded border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-black text-slate-950">Email Deliveries</h2>
            <p className="mt-1 text-sm text-slate-600">
              Every notification email attempt, most recent first. Not sent = pending, retrying, failed, or skipped.
            </p>
          </div>
          <SearchableSelect
            className="h-9 w-full px-3 sm:w-48"
            onChange={(event) => setStatusFilter(event.target.value as (typeof STATUS_FILTERS)[number])}
            value={statusFilter}
          >
            {STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {status === "all" ? "All statuses" : status[0].toUpperCase() + status.slice(1)}
              </option>
            ))}
          </SearchableSelect>
        </div>
        <div className="mt-4">
          <table className="hidden w-full table-fixed border-collapse text-left text-sm md:table">
            <colgroup>
              <col className="w-[16%]" />
              <col className="w-[18%]" />
              <col className="w-[22%]" />
              <col className="w-[12%]" />
              <col className="w-[16%]" />
              <col className="w-[16%]" />
            </colgroup>
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="px-3 py-2">Module</th>
                <th className="px-3 py-2">Recipient</th>
                <th className="px-3 py-2">Subject</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Sent / Next Retry</th>
                <th className="px-3 py-2">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredDeliveries.map((delivery) => (
                <tr className="align-top" key={delivery.id}>
                  <td className="min-w-0 break-words px-3 py-3">
                    <p className="font-bold text-slate-900">{moduleLabel(delivery.module)}</p>
                    {delivery.eventType ? <p className="text-xs text-slate-500">{humanizeCode(delivery.eventType)}</p> : null}
                  </td>
                  <td className="min-w-0 break-words px-3 py-3 text-xs text-slate-600">{delivery.recipient ?? "—"}</td>
                  <td className="min-w-0 break-words px-3 py-3 text-xs text-slate-600">{delivery.subject ?? "—"}</td>
                  <td className="min-w-0 break-words px-3 py-3">
                    <span className={`border px-2 py-1 text-xs font-bold ${badgeClass(delivery.status)}`}>{humanizeCode(delivery.status)}</span>
                    <p className="mt-1 text-xs text-slate-600">{delivery.attempts} {delivery.attempts === 1 ? "attempt" : "attempts"}</p>
                  </td>
                  <td className="min-w-0 break-words px-3 py-3 text-xs text-slate-600">
                    {delivery.status === "sent" ? formatDate(delivery.sentAt) : formatDate(delivery.nextAttemptAt)}
                  </td>
                  <td className="min-w-0 break-words px-3 py-3 text-xs text-slate-600">{delivery.lastError ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="divide-y divide-slate-100 md:hidden">
            {filteredDeliveries.map((delivery) => (
              <div className="min-w-0 space-y-1 py-3" key={delivery.id}>
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <p className="min-w-0 break-words text-sm font-bold text-slate-900">{moduleLabel(delivery.module)}</p>
                  <span className={`shrink-0 border px-2 py-1 text-xs font-bold ${badgeClass(delivery.status)}`}>{humanizeCode(delivery.status)}</span>
                </div>
                {delivery.eventType ? <p className="text-xs text-slate-500">{humanizeCode(delivery.eventType)}</p> : null}
                {delivery.recipient ? <p className="break-words text-xs text-slate-600">{delivery.recipient}</p> : null}
                {delivery.subject ? <p className="break-words text-xs text-slate-600">{delivery.subject}</p> : null}
                <p className="text-xs text-slate-600">
                  {delivery.attempts} {delivery.attempts === 1 ? "attempt" : "attempts"} · {delivery.status === "sent" ? formatDate(delivery.sentAt) : formatDate(delivery.nextAttemptAt)}
                </p>
                {delivery.lastError ? <p className="break-words text-xs text-slate-600">{delivery.lastError}</p> : null}
              </div>
            ))}
          </div>
          {filteredDeliveries.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm font-semibold text-slate-500">No email deliveries match this filter.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
