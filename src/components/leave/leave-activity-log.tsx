"use client";

import { Activity, AlertTriangle, CheckCircle2, Link2, RefreshCw } from "lucide-react";

import type { LeaveAuditLog } from "@/lib/leave/types";

import {
  formatDate,
  Panel,
  PanelHeader,
} from "./leave-ui-primitives";

function iconForEvent(eventType: string) {
  if (eventType.includes("failed")) return <AlertTriangle className="h-4 w-4 text-rose-600" />;
  if (eventType.includes("accrual")) return <RefreshCw className="h-4 w-4 text-orange-600" />;
  if (eventType.includes("attachment")) return <Link2 className="h-4 w-4 text-sky-600" />;
  if (eventType.includes("approved") || eventType.includes("submitted")) return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
  return <Activity className="h-4 w-4 text-slate-500" />;
}

function eventLabel(value: string) {
  return value
    .replace(/^leave\./, "")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function metadataSummary(metadata: Record<string, unknown>) {
  const entries = Object.entries(metadata).filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (!entries.length) return "No extra metadata.";
  return entries
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(" | ");
}

export function LeaveActivityLog({ logs }: { logs?: LeaveAuditLog[] }) {
  return (
    <div data-testid="leave-activity-log">
      <Panel className="overflow-hidden">
        <PanelHeader
          description="Operational audit events for request lifecycle, approvals, accrual, adjustments, notifications, and attachment access."
          icon={<Activity className="h-5 w-5" />}
          title="Leave Activity & Audit Trail"
        />
        {logs?.length ? (
          <div className="divide-y divide-slate-200">
            {logs.slice(0, 80).map((log) => (
              <div className="grid gap-3 px-4 py-4 sm:grid-cols-[220px_1fr] sm:px-5" key={log.id}>
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-50 ring-1 ring-slate-200">
                    {iconForEvent(log.eventType)}
                  </span>
                  <div>
                    <p className="text-sm font-black text-slate-950">{eventLabel(log.eventType)}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">{formatDate(log.createdAt)}</p>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                  <div className="flex flex-wrap gap-2 text-xs font-black text-slate-500">
                    <span>Actor: {log.actorHrId ?? "System"}</span>
                    <span>Role: {log.actorRole ?? "N/A"}</span>
                    {log.employeeHrId ? <span>Employee: {log.employeeHrId}</span> : null}
                    {log.requestId ? <span>Request: {log.requestId.slice(0, 8)}</span> : null}
                  </div>
                  <p className="mt-2 text-sm font-semibold leading-6 text-slate-700">{metadataSummary(log.metadata)}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-5 py-12 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-600 ring-1 ring-orange-100">
              <Activity className="h-5 w-5" />
            </div>
            <p className="mt-4 text-base font-black text-slate-950">No leave activity yet.</p>
            <p className="mt-1 text-sm text-slate-500">Submit, approval, accrual, adjustment, notification, and attachment events will appear here.</p>
          </div>
        )}
      </Panel>
    </div>
  );
}
