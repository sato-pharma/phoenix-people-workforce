"use client";

// The read-only list behind /admin/notification-types: every notification type the code sends,
// with how the notification policy delivers it. Nothing here changes a channel, a recipient or a
// send — the policy table and the senders stay the place for that.

import { useMemo, useState } from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { phxFieldClassName, phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";

export type NotificationTypeRow = {
  channels: string[];
  delivery: "engine" | "direct_email" | "both";
  eventType: string;
  fallbacks: string[];
  key: string;
  label: string;
  module: string;
  moduleLabel: string;
  priority: string;
  recipients: string[];
  telegramAllowed: boolean;
};

export type UntypedSendRow = { channel: string; file: string; label: string };

const thClassName = "px-3 py-4 text-left text-phx-sm font-black uppercase tracking-widest text-phx-ink-soft";
const tdClassName = "min-w-0 break-words px-3 py-4 align-top";
const secondaryClassName = "block break-all font-mono text-phx-xs text-phx-ink-soft";

function channelText(row: NotificationTypeRow) {
  if (row.delivery === "direct_email") return "Email, sent directly";
  return row.channels.join(", ");
}

function fallbackText(row: NotificationTypeRow) {
  if (row.delivery === "direct_email") return "Outside the notification policy";
  const parts: string[] = [];
  if (row.fallbacks.length > 0) parts.push(`If those fail: ${row.fallbacks.join(", ")}`);
  if (row.delivery === "both") parts.push("Also sent as a direct email");
  return parts.join(". ");
}

function priorityText(row: NotificationTypeRow) {
  return row.delivery === "direct_email" ? "Not used" : row.priority;
}

function telegramText(row: NotificationTypeRow) {
  if (row.delivery === "direct_email") return "Not used";
  return row.telegramAllowed ? "Allowed" : "Not allowed";
}

export function NotificationTypesRegistry({ rows, untyped }: { rows: NotificationTypeRow[]; untyped: UntypedSendRow[] }) {
  const [moduleFilter, setModuleFilter] = useState("");
  const [query, setQuery] = useState("");

  const modules = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of rows) seen.set(row.module, row.moduleLabel);
    return Array.from(seen, ([value, label]) => ({ label, value })).sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (moduleFilter && row.module !== moduleFilter) return false;
      if (!needle) return true;
      return [row.label, row.eventType, row.moduleLabel, ...row.recipients, ...row.channels].some((text) => text.toLowerCase().includes(needle));
    });
  }, [rows, moduleFilter, query]);

  return (
    <div className="space-y-6">
      <AdminTableShell
        description="Every notice the system sends with a type. Channels, fallbacks, recipients, priority and Telegram are read from the notification policy, so this list always matches what is sent."
        title={`Notification types (${visible.length} of ${rows.length})`}
      >
        <div className="grid grid-cols-1 gap-4 border-b border-phx-line px-4 py-4 sm:grid-cols-2">
          <label className="block min-w-0">
            <span className={phxLabelClassName}>Module</span>
            <select className={phxSelectClassName} onChange={(event) => setModuleFilter(event.target.value)} value={moduleFilter}>
              <option value="">All modules</option>
              {modules.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-0">
            <span className={phxLabelClassName}>Search</span>
            <input
              className={phxFieldClassName}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="A notice, a module or a recipient"
              type="search"
              value={query}
            />
          </label>
        </div>

        {visible.length === 0 ? (
          <p className="px-4 py-6 text-sm text-phx-ink-soft">No notification type matches this filter.</p>
        ) : (
          <>
            <div className="hidden md:block">
              <table className="w-full table-fixed border-collapse">
                <colgroup>
                  <col className="w-[30%]" />
                  <col className="w-[13%]" />
                  <col className="w-[19%]" />
                  <col className="w-[20%]" />
                  <col className="w-[9%]" />
                  <col className="w-[9%]" />
                </colgroup>
                <thead className="border-b border-phx-line bg-phx-paper-2/60">
                  <tr>
                    <th className={thClassName}>Notification</th>
                    <th className={thClassName}>Module</th>
                    <th className={thClassName}>Channels</th>
                    <th className={thClassName}>Recipients</th>
                    <th className={thClassName}>Priority</th>
                    <th className={thClassName}>Telegram</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-phx-paper-2">
                  {visible.map((row) => (
                    <tr key={row.key}>
                      <td className={tdClassName}>
                        <span className="block text-sm font-semibold text-phx-ink">{row.label}</span>
                        <span className={secondaryClassName}>{row.eventType}</span>
                      </td>
                      <td className={`${tdClassName} text-sm text-phx-ink`}>{row.moduleLabel}</td>
                      <td className={tdClassName}>
                        <span className="block text-sm text-phx-ink">{channelText(row)}</span>
                        {fallbackText(row) ? <span className="block text-phx-xs text-phx-ink-soft">{fallbackText(row)}</span> : null}
                      </td>
                      <td className={`${tdClassName} text-sm text-phx-ink`}>{row.recipients.join(", ")}</td>
                      <td className={`${tdClassName} text-sm text-phx-ink`}>{priorityText(row)}</td>
                      <td className={`${tdClassName} text-sm text-phx-ink`}>{telegramText(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-phx-paper-2 md:hidden">
              {visible.map((row) => (
                <div className="min-w-0 space-y-1 px-4 py-3" key={row.key}>
                  <p className="break-words text-sm font-semibold text-phx-ink">{row.label}</p>
                  <p className="break-words text-phx-xs font-bold uppercase tracking-wide text-phx-ink-soft">{row.moduleLabel}</p>
                  <p className="break-words text-sm text-phx-ink">
                    <span className="font-semibold">Channels: </span>
                    {channelText(row)}
                  </p>
                  {fallbackText(row) ? <p className="break-words text-phx-xs text-phx-ink-soft">{fallbackText(row)}</p> : null}
                  <p className="break-words text-sm text-phx-ink">
                    <span className="font-semibold">Recipients: </span>
                    {row.recipients.join(", ")}
                  </p>
                  <p className="break-words text-sm text-phx-ink">
                    <span className="font-semibold">Priority: </span>
                    {priorityText(row)}
                    <span className="font-semibold"> · Telegram: </span>
                    {telegramText(row)}
                  </p>
                  <span className={secondaryClassName}>{row.eventType}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </AdminTableShell>

      <AdminTableShell
        description="Messages that carry no notification type: a person writing an email, the Telegram bot answering, a copy of something else. They do not go through the notification policy."
        title={`Sends with no type (${untyped.length})`}
      >
        <ul className="divide-y divide-phx-paper-2">
          {untyped.map((send) => (
            <li className="min-w-0 space-y-1 px-4 py-3" key={send.file}>
              <p className="break-words text-sm font-semibold text-phx-ink">{send.label}</p>
              <p className="break-words text-phx-xs font-bold uppercase tracking-wide text-phx-ink-soft">{send.channel}</p>
            </li>
          ))}
        </ul>
      </AdminTableShell>
    </div>
  );
}
