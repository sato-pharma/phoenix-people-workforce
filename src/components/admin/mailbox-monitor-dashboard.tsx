"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Eye,
  Inbox,
  Loader2,
  Lock,
  Mail,
  Paperclip,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import { toast } from "sonner";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  ImportableMailbox,
  MailboxFolder,
  MailboxMessageDetail,
  MailboxMessageSummary,
  MailboxMonitor,
  MailboxMonitorStatus,
} from "@/lib/mailbox-monitor/types";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<MailboxMonitorStatus, { label: string; className: string }> = {
  active: { label: "Connected", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  failing: { label: "Connection failing", className: "border-amber-200 bg-amber-50 text-amber-800" },
  disabled: { label: "Disabled", className: "border-slate-200 bg-slate-50 text-slate-600" },
  revoked: { label: "App password revoked", className: "border-rose-200 bg-rose-50 text-rose-700" },
};

function StatusPill({ status }: { status: MailboxMonitorStatus }) {
  const style = STATUS_STYLE[status];
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold", style.className)}>
      {style.label}
    </span>
  );
}

// Africa/Cairo, human-readable — never raw UTC (owner standing rule).
function formatCairo(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function monitorTitle(monitor: MailboxMonitor): string {
  return monitor.displayLabel || monitor.employeeName || monitor.emailAddress;
}

type ReaderState = {
  monitor: MailboxMonitor;
  folders: MailboxFolder[];
  selectedFolder: string | null;
  messages: MailboxMessageSummary[];
  message: MailboxMessageDetail | null;
};

export function MailboxMonitorDashboard({
  initialImportable = [],
  initialMonitors,
}: {
  initialImportable?: ImportableMailbox[];
  initialMonitors: MailboxMonitor[];
}) {
  const [monitors, setMonitors] = useState<MailboxMonitor[]>(initialMonitors);

  // Company mailboxes Phoenix already holds a working credential for, not yet monitored.
  const [importable, setImportable] = useState<ImportableMailbox[]>(initialImportable);
  const [importing, setImporting] = useState(false);

  // Add form
  const [emailAddress, setEmailAddress] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [employeeHrId, setEmployeeHrId] = useState("");
  const [displayLabel, setDisplayLabel] = useState("");
  const [adding, setAdding] = useState(false);

  // Per-row busy state (re-check / remove)
  const [busyId, setBusyId] = useState<string | null>(null);

  // Reader
  const [reader, setReader] = useState<ReaderState | null>(null);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messageLoading, setMessageLoading] = useState(false);
  const [showHtml, setShowHtml] = useState(false);

  const upsertMonitor = useCallback((monitor: MailboxMonitor) => {
    setMonitors((prev) => {
      const next = prev.filter((row) => row.id !== monitor.id);
      next.push(monitor);
      next.sort((left, right) => monitorTitle(left).localeCompare(monitorTitle(right)));
      return next;
    });
  }, []);

  // One click: connect the company mailboxes Phoenix already has credentials for. No password is
  // typed or sent — the server reuses the one already in its own environment.
  async function handleImportConfigured() {
    setImporting(true);
    try {
      const res = await fetch("/api/admin/mailbox-monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importConfigured: true }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        imported?: MailboxMonitor[];
        skipped?: number;
        failures?: Array<{ emailAddress: string; error: string }>;
        message?: string;
      };
      if (!res.ok) {
        toast.error(data.message || "Could not import the configured mailboxes.");
        return;
      }
      const imported = data.imported ?? [];
      for (const monitor of imported) upsertMonitor(monitor);
      setImportable((prev) => prev.filter((row) => !imported.some((m) => m.emailAddress === row.emailAddress)));

      if (imported.length > 0) {
        toast.success(`Connected ${imported.length} mailbox${imported.length === 1 ? "" : "es"}.`);
      } else if ((data.skipped ?? 0) > 0) {
        toast.info("Those mailboxes are already being monitored.");
      }
      for (const failure of data.failures ?? []) {
        toast.error(`${failure.emailAddress}: ${failure.error}`);
      }
    } catch {
      toast.error("Could not reach the server. Try again.");
    } finally {
      setImporting(false);
    }
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    if (!emailAddress.trim() || !appPassword.trim()) {
      toast.error("Enter the mailbox address and its app password.");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch("/api/admin/mailbox-monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emailAddress: emailAddress.trim(),
          appPassword: appPassword.trim(),
          employeeHrId: employeeHrId.trim() || null,
          displayLabel: displayLabel.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { monitor?: MailboxMonitor; message?: string };
      if (!res.ok || !data.monitor) {
        toast.error(data.message || "Could not connect to that mailbox.");
        return;
      }
      upsertMonitor(data.monitor);
      setEmailAddress("");
      setAppPassword("");
      setEmployeeHrId("");
      setDisplayLabel("");
      toast.success(`Connected — ${monitorTitle(data.monitor)} is now monitored.`);
    } catch {
      toast.error("Could not reach the server. Try again.");
    } finally {
      setAdding(false);
    }
  }

  async function handleRecheck(monitor: MailboxMonitor) {
    setBusyId(monitor.id);
    try {
      const res = await fetch(`/api/admin/mailbox-monitor/${monitor.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
      });
      const data = (await res.json().catch(() => ({}))) as { monitor?: MailboxMonitor; message?: string };
      if (!res.ok || !data.monitor) {
        toast.error(data.message || "Re-check failed.");
        return;
      }
      upsertMonitor(data.monitor);
      toast.success(data.monitor.status === "active" ? "Connection is healthy." : `Status: ${STATUS_STYLE[data.monitor.status].label}.`);
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(monitor: MailboxMonitor) {
    if (!window.confirm(`Stop monitoring ${monitorTitle(monitor)}? The stored app password is deleted. The access log is kept.`)) {
      return;
    }
    setBusyId(monitor.id);
    try {
      const res = await fetch(`/api/admin/mailbox-monitor/${monitor.id}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        toast.error(data.message || "Could not remove the mailbox.");
        return;
      }
      setMonitors((prev) => prev.filter((row) => row.id !== monitor.id));
      if (reader?.monitor.id === monitor.id) setReader(null);
      toast.success("Removed.");
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setBusyId(null);
    }
  }

  const loadMessages = useCallback(async (monitor: MailboxMonitor, folders: MailboxFolder[], folderPath: string) => {
    setMessagesLoading(true);
    setShowHtml(false);
    try {
      const res = await fetch(`/api/admin/mailbox-monitor/${monitor.id}/messages?folder=${encodeURIComponent(folderPath)}&limit=50`);
      const data = (await res.json().catch(() => ({}))) as { messages?: MailboxMessageSummary[]; message?: string };
      if (!res.ok || !data.messages) {
        toast.error(data.message || "Could not list messages.");
        return;
      }
      setReader({ monitor, folders, selectedFolder: folderPath, messages: data.messages, message: null });
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  async function handleOpen(monitor: MailboxMonitor) {
    setReader({ monitor, folders: [], selectedFolder: null, messages: [], message: null });
    setShowHtml(false);
    setFoldersLoading(true);
    try {
      const res = await fetch(`/api/admin/mailbox-monitor/${monitor.id}`);
      const data = (await res.json().catch(() => ({}))) as { folders?: MailboxFolder[]; message?: string };
      if (!res.ok || !data.folders) {
        toast.error(data.message || "Could not open the mailbox.");
        setReader(null);
        return;
      }
      const folders = data.folders;
      setReader({ monitor, folders, selectedFolder: null, messages: [], message: null });
      const inbox = folders.find((folder) => folder.path.toUpperCase() === "INBOX") ?? folders[0];
      if (inbox) await loadMessages(monitor, folders, inbox.path);
    } catch {
      toast.error("Could not reach the server.");
      setReader(null);
    } finally {
      setFoldersLoading(false);
    }
  }

  async function handleOpenMessage(summary: MailboxMessageSummary) {
    if (!reader?.selectedFolder) return;
    const { monitor, folders, selectedFolder, messages } = reader;
    setMessageLoading(true);
    setShowHtml(false);
    try {
      const res = await fetch(
        `/api/admin/mailbox-monitor/${monitor.id}/message?folder=${encodeURIComponent(selectedFolder)}&uid=${summary.uid}`,
      );
      const data = (await res.json().catch(() => ({}))) as { message?: MailboxMessageDetail | string };
      if (!res.ok || !data.message || typeof data.message === "string") {
        toast.error(typeof data.message === "string" ? data.message : "Could not open the message.");
        return;
      }
      setReader({ monitor, folders, selectedFolder, messages, message: data.message });
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setMessageLoading(false);
    }
  }

  return (
    <div className="space-y-7">
      {/* Silence guarantee — the one thing the owner must trust. */}
      <AdminCallout tone="neutral">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
        <div className="space-y-1">
          <p className="font-semibold text-slate-800">Reading here is invisible to the mailbox owner.</p>
          <p className="text-slate-600">
            Every message is opened over a read-only connection, so it is never marked as read and the employee sees no
            change. Their own login and password are untouched — you connect with a separate app password only.
          </p>
        </div>
      </AdminCallout>

      {/* Company mailboxes Phoenix already has a key for — one click, no password to find. */}
      {importable.length > 0 ? (
        <AdminTableShell
          title="Company mailboxes ready to connect"
          description="Phoenix already holds a working app password for these — no password to find or type."
        >
          <div className="px-5 py-5 sm:px-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <ul className="space-y-2">
                {importable.map((row) => (
                  <li key={row.emailAddress} className="flex items-center gap-2.5">
                    <Mail className="h-4 w-4 shrink-0 text-slate-400" />
                    <span className="whitespace-nowrap text-sm font-semibold text-slate-800">{row.label}</span>
                    <span className="whitespace-nowrap text-sm text-slate-500">{row.emailAddress}</span>
                  </li>
                ))}
              </ul>
              <Button className="shrink-0" disabled={importing} onClick={handleImportConfigured} type="button">
                {importing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Connecting
                  </>
                ) : (
                  <>
                    <Inbox className="mr-2 h-4 w-4" />
                    Connect {importable.length} mailbox{importable.length === 1 ? "" : "es"}
                  </>
                )}
              </Button>
            </div>
          </div>
        </AdminTableShell>
      ) : null}

      {/* Add a mailbox */}
      <AdminTableShell
        title="Add a mailbox"
        description="Generate an app password for the employee's mailbox, then paste it here. Their normal login password keeps working — this is a second, separate key."
      >
        <div className="px-5 py-5 sm:px-6">
          <AdminCallout tone="warning">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div className="space-y-2">
              <p className="font-semibold">When you generate the app password, name it exactly:</p>
              <div className="flex items-center gap-3">
                <code className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-base font-black tracking-[0.3em] text-slate-900">
                  ___
                </code>
                <span className="text-sm text-amber-900">three underscores — nothing else, no other label.</span>
              </div>
              <p className="text-sm text-amber-900/90">
                Do this in the mailbox&apos;s own security settings under <span className="font-semibold">Manage app passwords</span>.
                The employee keeps signing in with their usual password; the app password is invisible to them in normal use.
              </p>
            </div>
          </AdminCallout>

          <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={handleAdd}>
            <label className="space-y-1.5">
              <span className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Mailbox address</span>
              <Input
                autoComplete="off"
                placeholder="name@satopharma.com"
                type="email"
                value={emailAddress}
                onChange={(event) => setEmailAddress(event.target.value)}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">App password</span>
              <Input
                autoComplete="off"
                placeholder="the generated app password"
                type="password"
                value={appPassword}
                onChange={(event) => setAppPassword(event.target.value)}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Employee ID (optional)</span>
              <Input
                autoComplete="off"
                placeholder="e.g. AI-0014"
                value={employeeHrId}
                onChange={(event) => setEmployeeHrId(event.target.value)}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Label (optional)</span>
              <Input
                autoComplete="off"
                placeholder="how it shows in this list"
                value={displayLabel}
                onChange={(event) => setDisplayLabel(event.target.value)}
              />
            </label>
            <div className="sm:col-span-2">
              <Button disabled={adding} size="lg" type="submit">
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                {adding ? "Testing the connection…" : "Connect mailbox"}
              </Button>
              <p className="mt-2 text-xs text-slate-500">
                The connection is tested before it is saved. The app password is encrypted at rest and never shown again.
              </p>
            </div>
          </form>
        </div>
      </AdminTableShell>

      {/* Monitored mailboxes */}
      <AdminTableShell
        title="Monitored mailboxes"
        description={monitors.length === 0 ? "No mailboxes are being monitored yet." : `${monitors.length} mailbox${monitors.length === 1 ? "" : "es"} under compliance monitoring.`}
      >
        {monitors.length === 0 ? (
          <div className="flex items-center gap-3 px-6 py-8 text-sm text-slate-500">
            <Inbox className="h-5 w-5 text-slate-400" />
            Add a mailbox above to begin.
          </div>
        ) : (
          <>
            {/* Desktop: table */}
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                    <th className="px-6 py-3 font-semibold">Mailbox</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Last read OK</th>
                    <th className="px-4 py-3 font-semibold">Last checked</th>
                    <th className="px-6 py-3 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {monitors.map((monitor) => (
                    <tr key={monitor.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70">
                      <td className="px-6 py-3">
                        <div className="whitespace-nowrap font-semibold text-slate-900">{monitorTitle(monitor)}</div>
                        <div className="whitespace-nowrap text-xs text-slate-500">{monitor.emailAddress}</div>
                        {monitor.status === "failing" || monitor.status === "revoked" ? (
                          <div className="whitespace-nowrap text-xs text-rose-600">{monitor.lastError || "Last connection failed."}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3"><StatusPill status={monitor.status} /></td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatCairo(monitor.lastOkAt)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatCairo(monitor.lastCheckedAt)}</td>
                      <td className="px-6 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <Button size="sm" variant="secondary" onClick={() => handleOpen(monitor)}>
                            <Eye className="h-3.5 w-3.5" />Open
                          </Button>
                          <Button disabled={busyId === monitor.id} size="sm" variant="outline" onClick={() => handleRecheck(monitor)}>
                            {busyId === monitor.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                            Re-check
                          </Button>
                          <Button disabled={busyId === monitor.id} size="sm" variant="destructive" onClick={() => handleRemove(monitor)}>
                            <Trash2 className="h-3.5 w-3.5" />Remove
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile: cards (owner rule — admin shell never shows tables on mobile) */}
            <div className="space-y-3 p-4 sm:hidden">
              {monitors.map((monitor) => (
                <div key={monitor.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-slate-900">{monitorTitle(monitor)}</div>
                      <div className="truncate text-xs text-slate-500">{monitor.emailAddress}</div>
                    </div>
                    <StatusPill status={monitor.status} />
                  </div>
                  <div className="mt-2 text-xs text-slate-500">Last read OK: {formatCairo(monitor.lastOkAt)}</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => handleOpen(monitor)}>
                      <Eye className="h-3.5 w-3.5" />Open
                    </Button>
                    <Button disabled={busyId === monitor.id} size="sm" variant="outline" onClick={() => handleRecheck(monitor)}>
                      {busyId === monitor.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      Re-check
                    </Button>
                    <Button disabled={busyId === monitor.id} size="sm" variant="destructive" onClick={() => handleRemove(monitor)}>
                      <Trash2 className="h-3.5 w-3.5" />Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </AdminTableShell>

      {/* Reader */}
      {reader ? (
        <AdminTableShell
          title={`Reading — ${monitorTitle(reader.monitor)}`}
          description="Read-only view. Opening a message here does not mark it read in the mailbox."
          action={
            <Button size="sm" variant="ghost" onClick={() => setReader(null)}>
              <ArrowLeft className="h-3.5 w-3.5" />Close
            </Button>
          }
        >
          <div className="grid gap-0 lg:grid-cols-[220px_320px_minmax(0,1fr)]">
            {/* Folders */}
            <div className="border-b border-slate-100 lg:border-b-0 lg:border-r">
              <div className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-400">Folders</div>
              {foldersLoading ? (
                <div className="flex items-center gap-2 px-4 py-3 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
              ) : (
                <ul className="max-h-[60vh] overflow-y-auto pb-3">
                  {reader.folders.map((folder) => (
                    <li key={folder.path}>
                      <button
                        className={cn(
                          "flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-slate-50",
                          reader.selectedFolder === folder.path ? "bg-orange-50 font-semibold text-orange-700" : "text-slate-700",
                        )}
                        type="button"
                        onClick={() => loadMessages(reader.monitor, reader.folders, folder.path)}
                      >
                        <Inbox className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{folder.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Message list */}
            <div className="border-b border-slate-100 lg:border-b-0 lg:border-r">
              <div className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-400">Messages</div>
              {messagesLoading ? (
                <div className="flex items-center gap-2 px-4 py-3 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
              ) : reader.messages.length === 0 ? (
                <div className="px-4 py-3 text-sm text-slate-500">{reader.selectedFolder ? "No messages." : "Pick a folder."}</div>
              ) : (
                <ul className="max-h-[60vh] overflow-y-auto pb-3">
                  {reader.messages.map((summary) => (
                    <li key={summary.uid}>
                      <button
                        className={cn(
                          "w-full border-b border-slate-100 px-4 py-2.5 text-left hover:bg-slate-50",
                          reader.message?.uid === summary.uid && "bg-orange-50",
                        )}
                        type="button"
                        onClick={() => handleOpenMessage(summary)}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className={cn("truncate text-sm", summary.seen ? "text-slate-600" : "font-semibold text-slate-900")}>
                            {summary.fromName || summary.fromAddress || "Unknown sender"}
                          </span>
                          <span className="shrink-0 text-phx-xs text-slate-400">{formatCairo(summary.date)}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {summary.hasAttachments ? <Paperclip className="h-3 w-3 shrink-0 text-slate-400" /> : null}
                          <span className="truncate text-sm text-slate-500">{summary.subject || "(no subject)"}</span>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Message body */}
            <div className="min-w-0">
              <div className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-400">Message</div>
              {messageLoading ? (
                <div className="flex items-center gap-2 px-4 py-3 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Opening…</div>
              ) : !reader.message ? (
                <div className="flex items-center gap-2 px-4 py-6 text-sm text-slate-500"><Mail className="h-4 w-4" />Select a message to read it.</div>
              ) : (
                <div className="space-y-3 px-4 py-3">
                  <div>
                    <div className="text-base font-bold text-slate-900">{reader.message.subject || "(no subject)"}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      From {reader.message.fromName || reader.message.fromAddress || "Unknown"} · {formatCairo(reader.message.date)}
                    </div>
                    <div className="text-xs text-slate-500">To {reader.message.toAddresses.join(", ") || "—"}</div>
                  </div>

                  {reader.message.attachments.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {reader.message.attachments.map((attachment, index) => (
                        <span key={`${attachment.filename ?? "file"}-${index}`} className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
                          <Paperclip className="h-3 w-3" />{attachment.filename || "attachment"}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {reader.message.html && showHtml ? (
                    <div className="space-y-2">
                      <Button size="xs" variant="outline" onClick={() => setShowHtml(false)}>Show plain text</Button>
                      {/* Untrusted email HTML — sandboxed with NO allow-scripts, so nothing in it can run. */}
                      <iframe
                        className="h-[50vh] w-full rounded-lg border border-slate-200 bg-white"
                        sandbox=""
                        srcDoc={reader.message.html}
                        title="Message content"
                      />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {reader.message.html ? (
                        <Button size="xs" variant="outline" onClick={() => setShowHtml(true)}>
                          Show original HTML (may load remote images)
                        </Button>
                      ) : null}
                      <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">
                        {reader.message.text || "(no plain-text body)"}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </AdminTableShell>
      ) : null}

      <div className="flex items-start gap-2 px-1 text-xs text-slate-400">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Every open, folder view and message read is written to the compliance access log with your name and the time.
        </span>
      </div>
    </div>
  );
}
