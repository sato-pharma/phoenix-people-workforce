"use client";

import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, CircleOff, Mail, PlugZap, RefreshCw, Rocket, Send, ShieldCheck, Unplug } from "lucide-react";

import type {
  TelegramAdminAuditLog,
  TelegramAdminConnection,
  TelegramAdminDelivery,
  TelegramAdminSummary,
  TelegramPilotHealth,
} from "@/lib/notifications/telegram-admin";
import type { TelegramModulePolicy } from "@/lib/notifications/telegram-governance";

type TelegramAdminData = {
  auditLogs: TelegramAdminAuditLog[];
  connections: TelegramAdminConnection[];
  deliveries: TelegramAdminDelivery[];
  globalEnabled: boolean;
  pilotHealth: TelegramPilotHealth;
  policies: TelegramModulePolicy[];
  summary: TelegramAdminSummary;
};

type Props = {
  canUpdate: boolean;
  initialData: TelegramAdminData;
};

function badgeClass(status: string) {
  if (status === "connected" || status === "sent") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "failed" || status === "disabled") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status === "retrying" || status === "pending") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function statusTextClass(status: string) {
  if (status === "connected" || status === "sent") return "text-emerald-700";
  if (status === "failed" || status === "disabled") return "text-rose-700";
  if (status === "retrying" || status === "pending" || status === "skipped") return "text-amber-700";
  return "text-slate-950";
}

function formatDate(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function moduleLabel(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const envLabels = {
  notificationWebhookSecret: ["NOTIFICATION", "WEBHOOK", "SECRET"].join("_"),
  phoenixAppUrl: ["PHOENIX", "APP", "URL"].join("_"),
  telegramBotToken: ["TELEGRAM", "BOT", "TOKEN"].join("_"),
  telegramBotUsername: ["TELEGRAM", "BOT", "USERNAME"].join("_"),
};

function healthBadge(ok: boolean | null, readyLabel = "Ready", blockedLabel = "Needs attention") {
  if (ok === null) return <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-bold text-slate-600">Unknown</span>;
  return (
    <span className={`rounded border px-2 py-1 text-xs font-bold ${ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
      {ok ? readyLabel : blockedLabel}
    </span>
  );
}

export function TelegramAdminControlCenter({ canUpdate, initialData }: Props) {
  const [data, setData] = useState(initialData);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [opsDetail, setOpsDetail] = useState<string[] | null>(null);
  // Holds the eligible-recipient count once previewed, so the admin must confirm
  // "email N people" before any mass send goes out.
  const [inviteConfirm, setInviteConfirm] = useState<{ count: number } | null>(null);

  const filteredConnections = useMemo(() => {
    if (statusFilter === "all") return data.connections;
    return data.connections.filter((connection) => connection.status === statusFilter);
  }, [data.connections, statusFilter]);

  async function request(method: "PATCH" | "POST", body: Record<string, unknown>, successMessage: string) {
    setBusy(String(body.action ?? body.type ?? "save"));
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/notifications/telegram", {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Telegram admin action failed.");
      setData(payload.data?.view ?? payload.data ?? initialData);
      setNotice(successMessage);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Telegram admin action failed.");
    } finally {
      setBusy(null);
    }
  }

  function updatePolicy(policy: TelegramModulePolicy, patch: Partial<TelegramModulePolicy>) {
    const next = { ...policy, ...patch };
    void request("PATCH", { ...next, type: "module_policy" }, `${moduleLabel(policy.module)} policy updated.`);
  }

  // Ops actions (provision bot, send invitations) return extra detail alongside the
  // refreshed view; render that detail in the rollout panel instead of discarding it.
  async function runOpsAction(
    body: Record<string, unknown>,
    successMessage: string,
    describe: (payload: Record<string, unknown> | undefined) => string[],
  ) {
    setBusy(String(body.action));
    setError(null);
    setNotice(null);
    setOpsDetail(null);
    try {
      const response = await fetch("/api/admin/notifications/telegram", {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Telegram admin action failed.");
      setData(payload.data?.view ?? initialData);
      setNotice(successMessage);
      setOpsDetail(describe(payload.data));
    } catch (opsError) {
      setError(opsError instanceof Error ? opsError.message : "Telegram admin action failed.");
    } finally {
      setBusy(null);
    }
  }

  function provisionBot() {
    void runOpsAction({ action: "provision_bot" }, "Bot provisioning completed.", (payload) => {
      const report = (payload?.report ?? {}) as {
        botUsername?: string | null;
        ok?: boolean;
        secretConfigured?: boolean;
        steps?: Array<{ detail: string; ok: boolean; step: string }>;
      };
      const lines = (report.steps ?? []).map((entry) => `${entry.ok ? "✓" : "✗"} ${entry.step} — ${entry.detail}`);
      lines.unshift(report.ok ? "Bot is provisioned and the webhook matches this deployment." : "Provisioning needs attention — review the steps below.");
      if (report.botUsername) lines.push(`Bot username: @${report.botUsername}`);
      if (report.secretConfigured === false) lines.push("⚠ NOTIFICATION_WEBHOOK_SECRET is not set — the webhook is unprotected.");
      return lines;
    });
  }

  // Step 1: preview the eligible count (read-only) and open the confirm panel.
  async function requestInviteConfirm() {
    setBusy("count_invitation_targets");
    setError(null);
    setNotice(null);
    setOpsDetail(null);
    try {
      const response = await fetch("/api/admin/notifications/telegram", {
        body: JSON.stringify({ action: "count_invitation_targets" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Could not count eligible employees.");
      setInviteConfirm({ count: Number(payload.data?.count ?? 0) });
    } catch (countError) {
      setError(countError instanceof Error ? countError.message : "Could not count eligible employees.");
    } finally {
      setBusy(null);
    }
  }

  // Step 2: only after explicit confirmation does the mass email actually send.
  function confirmSendInvitations() {
    setInviteConfirm(null);
    void runOpsAction({ action: "send_invitations" }, "Connect invitations processed.", (payload) => {
      const summary = (payload?.summary ?? {}) as {
        attempted?: number;
        available?: number;
        failed?: number;
        sent?: number;
        skipped?: number;
        truncated?: boolean;
      };
      const lines = [
        `${summary.sent ?? 0} sent · ${summary.skipped ?? 0} skipped · ${summary.failed ?? 0} failed (of ${summary.attempted ?? 0} attempted).`,
      ];
      if (summary.truncated) lines.push(`Batch limit reached — ${summary.available ?? 0} eligible employees in total. Run again to continue.`);
      else lines.push(`${summary.available ?? 0} eligible employees were targeted in this run.`);
      return lines;
    });
  }

  const lastTestLabel = data.summary.lastTestStatus === "none"
    ? "No test yet"
    : `${data.summary.lastTestStatus}${data.summary.lastTestRecipient ? ` · ${data.summary.lastTestRecipient}` : ""}`;

  return (
    <div className="space-y-5">
      {notice ? (
        <div className="flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
          <CheckCircle2 className="h-4 w-4" />
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="flex items-center gap-2 rounded border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      ) : null}
      {!data.globalEnabled ? (
        <div className="flex items-start gap-3 rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-black">Global Telegram is OFF.</p>
            <p className="mt-1 font-semibold">All Telegram deliveries are skipped while this switch is disabled. Email and in-app notification policies continue separately.</p>
          </div>
        </div>
      ) : null}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Global Status</p>
          <p className={`mt-2 text-2xl font-black ${data.globalEnabled ? "text-emerald-700" : "text-rose-700"}`}>{data.globalEnabled ? "ON" : "OFF"}</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">{data.globalEnabled ? "Telegram delivery may send if policy allows." : "Telegram delivery is blocked globally."}</p>
        </div>
        <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Connected Users</p>
          <p className="mt-2 text-2xl font-black text-slate-950">{data.summary.connectedCount}</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">Users with connected Telegram accounts.</p>
        </div>
        <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Pending Users</p>
          <p className="mt-2 text-2xl font-black text-slate-950">{data.summary.pendingCount}</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">Users who generated a token but did not finish linking.</p>
        </div>
        <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Last Telegram Test</p>
          <p className={`mt-2 text-lg font-black ${statusTextClass(data.summary.lastTestStatus)}`}>{lastTestLabel}</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">{data.summary.lastTestError ?? formatDate(data.summary.lastTestAt)}</p>
        </div>
      </section>

      <section className="rounded border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Production Pilot Health</p>
            <h2 className="mt-1 text-lg font-black text-slate-950">Admin-only readiness</h2>
            <p className="mt-1 text-sm text-slate-600">Read-only checks for the controlled Telegram pilot. Secrets and payload bodies are never shown.</p>
          </div>
          {healthBadge(data.pilotHealth.safeForAdminPilot, "Pilot ready", "Review required")}
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Required Env</p>
            <div className="mt-3 space-y-2 text-xs font-semibold text-slate-700">
              <p className="flex items-center justify-between gap-2"><span>{envLabels.telegramBotToken}</span>{healthBadge(data.pilotHealth.env.telegramBotToken, "Set", "Missing")}</p>
              <p className="flex items-center justify-between gap-2"><span>{envLabels.telegramBotUsername}</span>{healthBadge(data.pilotHealth.env.telegramBotUsername, "Set", "Missing")}</p>
              <p className="flex items-center justify-between gap-2"><span>{envLabels.phoenixAppUrl}</span>{healthBadge(data.pilotHealth.env.phoenixAppUrl, "Set", "Missing")}</p>
              <p className="flex items-center justify-between gap-2"><span>{envLabels.notificationWebhookSecret}</span>{healthBadge(data.pilotHealth.env.notificationWebhookSecret, "Set", "Missing")}</p>
            </div>
          </div>

          <div className="rounded border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Webhook</p>
            <div className="mt-3 space-y-2 text-xs font-semibold text-slate-700">
              <p className="flex items-center justify-between gap-2"><span>Status check</span>{healthBadge(data.pilotHealth.webhook.checked, "Checked", "Unavailable")}</p>
              <p className="flex items-center justify-between gap-2"><span>URL match</span>{healthBadge(data.pilotHealth.webhook.urlMatchesExpected, "Matches", "Mismatch")}</p>
              <p>Pending updates: {data.pilotHealth.webhook.pendingUpdateCount ?? "Unknown"}</p>
              <p className="break-all text-slate-500">Expected: {data.pilotHealth.webhook.expectedUrl ?? "Missing PHOENIX_APP_URL"}</p>
              <p className="break-all text-slate-500">Configured: {data.pilotHealth.webhook.configuredUrl ?? "Not configured"}</p>
              {data.pilotHealth.webhook.lastErrorMessage ? <p className="text-rose-700">Last error: {data.pilotHealth.webhook.lastErrorMessage}</p> : null}
              {data.pilotHealth.webhook.error ? <p className="text-rose-700">{data.pilotHealth.webhook.error}</p> : null}
            </div>
          </div>

          <div className="rounded border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Pilot Controls</p>
            <div className="mt-3 space-y-2 text-xs font-semibold text-slate-700">
              <p className="flex items-center justify-between gap-2"><span>Global default</span>{healthBadge(data.pilotHealth.globalCurrentlyOff, "OFF", "ON")}</p>
              <p className="flex items-center justify-between gap-2"><span>Admin connected</span>{healthBadge(data.pilotHealth.adminPilotConnected, "Connected", "Not connected")}</p>
              <p className="flex items-center justify-between gap-2"><span>Admin enabled</span>{healthBadge(data.pilotHealth.adminPilotEnabled, "Enabled", "Disabled")}</p>
              <p className="flex items-center justify-between gap-2"><span>Test template</span>{healthBadge(data.pilotHealth.generalAdminTestTemplateActive, "Active", "Inactive")}</p>
            </div>
          </div>

          <div className="rounded border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Pilot Scope</p>
            <p className="mt-3 text-2xl font-black text-slate-950">{data.pilotHealth.connectedEnabledUsersCount}</p>
            <p className="text-xs font-semibold text-slate-500">Connected users with Telegram enabled.</p>
            {data.pilotHealth.warnings.length > 0 ? (
              <ul className="mt-3 space-y-1 text-xs font-semibold text-amber-800">
                {data.pilotHealth.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            ) : (
              <p className="mt-3 text-xs font-bold text-emerald-700">No pilot blockers detected.</p>
            )}
          </div>
        </div>
      </section>

      <section className="rounded border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Bot Setup &amp; Rollout</p>
            <h2 className="mt-1 text-lg font-black text-slate-950">Provision once, then invite by email</h2>
            <p className="mt-1 text-sm text-slate-600">
              Provisioning validates the bot token, points the Telegram webhook at this deployment (secret-protected), and publishes the bot
              profile. Invitations email every active, not-yet-connected employee a personal one-click connect link from the Phoenix template.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="inline-flex items-center gap-2 rounded border border-slate-200 bg-slate-950 px-3.5 py-2 text-sm font-bold text-white disabled:opacity-50"
            disabled={!canUpdate || Boolean(busy)}
            onClick={provisionBot}
            type="button"
          >
            <Rocket className="h-4 w-4" />
            {busy === "provision_bot" ? "Provisioning…" : "Provision bot & webhook"}
          </button>
          <button
            className="inline-flex items-center gap-2 rounded border border-orange-200 bg-orange-600 px-3.5 py-2 text-sm font-bold text-white disabled:opacity-50"
            disabled={!canUpdate || Boolean(busy)}
            onClick={requestInviteConfirm}
            type="button"
          >
            <Mail className="h-4 w-4" />
            {busy === "count_invitation_targets" ? "Checking…" : busy === "send_invitations" ? "Sending…" : "Email connect invitations"}
          </button>
        </div>

        {inviteConfirm ? (
          <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-black text-amber-900">Confirm mass email</p>
            <p className="mt-1 text-sm font-semibold text-amber-800">
              You are about to email <span className="font-black">{inviteConfirm.count}</span> eligible employee{inviteConfirm.count === 1 ? "" : "s"} a personal one-click Telegram connect link. This sends real email.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="inline-flex items-center gap-2 rounded border border-orange-200 bg-orange-600 px-3.5 py-2 text-sm font-bold text-white disabled:opacity-50"
                disabled={!canUpdate || Boolean(busy) || inviteConfirm.count === 0}
                onClick={confirmSendInvitations}
                type="button"
              >
                <Mail className="h-4 w-4" />
                {`Send ${inviteConfirm.count} invitation${inviteConfirm.count === 1 ? "" : "s"}`}
              </button>
              <button
                className="inline-flex items-center gap-2 rounded border border-slate-200 bg-white px-3.5 py-2 text-sm font-bold text-slate-700"
                disabled={Boolean(busy)}
                onClick={() => setInviteConfirm(null)}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {opsDetail && opsDetail.length > 0 ? (
          <ul className="mt-4 space-y-1 rounded border border-slate-200 bg-slate-50 p-3 text-xs font-semibold text-slate-700">
            {opsDetail.map((line, index) => (
              <li className="break-words" key={`${index}-${line.slice(0, 24)}`}>{line}</li>
            ))}
          </ul>
        ) : null}

        <p className="mt-3 text-xs font-semibold text-slate-500">
          Invitations require email delivery to be enabled (RESEND_API_KEY + EMAIL_NOTIFICATIONS_ENABLED). Connect links are single-use and
          expire after 48 hours; employees can also reconnect any time from their portal Notification Settings.
        </p>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="rounded border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Global Kill Switch</p>
              <h2 className="mt-1 text-lg font-black text-slate-950">Telegram delivery</h2>
              <p className="mt-1 text-sm text-slate-600">When disabled, Telegram deliveries are skipped while email and in-app continue.</p>
            </div>
            <span className={`rounded border px-2.5 py-1 text-xs font-bold ${data.globalEnabled ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
              {data.globalEnabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <button
            className="mt-4 inline-flex items-center gap-2 rounded border border-slate-200 bg-slate-950 px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
            disabled={!canUpdate || Boolean(busy)}
            onClick={() => request("PATCH", { enabled: !data.globalEnabled, type: "global_switch" }, "Global Telegram switch updated.")}
            type="button"
          >
            <CircleOff className="h-4 w-4" />
            {data.globalEnabled ? "Disable Telegram" : "Enable Telegram"}
          </button>
          <button
            className="mt-3 inline-flex items-center gap-2 rounded border border-orange-200 bg-orange-50 px-3 py-2 text-sm font-bold text-orange-800 disabled:opacity-50"
            disabled={!canUpdate || Boolean(busy)}
            onClick={() => request("POST", { action: "send_test" }, "Admin-only Telegram test sent or skipped by policy.")}
            type="button"
          >
            <Send className="h-4 w-4" />
            Send Admin Test
          </button>
          <p className="mt-3 text-xs font-semibold text-slate-500">Tests from this page are restricted to the signed-in admin account. Employee-wide tests are not available.</p>
        </div>

        <div className="rounded border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-orange-600" />
            <h2 className="text-lg font-black text-slate-950">Module Policy</h2>
          </div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {data.policies.map((policy) => (
              <div className="rounded border border-slate-200 bg-slate-50 p-3" key={policy.module}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-black text-slate-900">{moduleLabel(policy.module)}</p>
                    <p className="mt-1 line-clamp-2 text-xs text-slate-500">{policy.notes ?? "Default Telegram policy."}</p>
                  </div>
                  <input
                    checked={policy.enabled}
                    className="h-4 w-4 accent-orange-600"
                    disabled={!canUpdate || Boolean(busy)}
                    onChange={(event) => updatePolicy(policy, { enabled: event.target.checked })}
                    type="checkbox"
                    title="Enable Telegram for this module"
                  />
                </div>
                <label className="mt-3 flex items-center gap-2 text-xs font-semibold text-slate-600">
                  <input
                    checked={policy.genericOnly}
                    className="h-4 w-4 accent-orange-600"
                    disabled={!canUpdate || Boolean(busy)}
                    onChange={(event) => updatePolicy(policy, { genericOnly: event.target.checked })}
                    type="checkbox"
                  />
                  Generic message only
                </label>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-black text-slate-950">Connections</h2>
            <p className="text-sm text-slate-600">Connected, pending, disabled, and failed Telegram user links.</p>
          </div>
          <select
            className="w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 sm:w-48"
            onChange={(event) => setStatusFilter(event.target.value)}
            value={statusFilter}
          >
            <option value="all">All statuses</option>
            <option value="connected">Connected</option>
            <option value="pending">Pending</option>
            <option value="disabled">Disabled</option>
            <option value="failed">Failed</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="adm-col-pin px-3 py-2">Employee</th>
                <th className="adm-col-hide-xl px-3 py-2">Org Scope</th>
                <th className="px-3 py-2">Status</th>
                <th className="adm-col-hide-lg px-3 py-2">Last Connected</th>
                <th className="adm-col-hide-lg px-3 py-2">Last Delivery</th>
                <th className="adm-col-hide-xl px-3 py-2">Chat</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredConnections.map((connection) => (
                <tr className="align-top" key={connection.userId}>
                  <td className="adm-col-pin px-3 py-3">
                    <p className="font-bold text-slate-900">{connection.employeeName ?? connection.userId}</p>
                    <p className="text-xs text-slate-500">{connection.hrId ?? "No HR ID"}</p>
                  </td>
                  <td className="adm-col-hide-xl px-3 py-3 text-xs text-slate-600">
                    <p>{connection.department ?? "No department"}</p>
                    <p>{connection.line ?? "No line"}</p>
                    <p>{connection.manager ?? "No manager"}</p>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`rounded border px-2 py-1 text-xs font-bold ${badgeClass(connection.status)}`}>{connection.status}</span>
                    <p className="mt-2 text-xs text-slate-500">{connection.telegramEnabled ? "User enabled" : "User disabled"}</p>
                  </td>
                  <td className="adm-col-hide-lg px-3 py-3 text-xs text-slate-600">{formatDate(connection.connectedAt)}</td>
                  <td className="adm-col-hide-lg px-3 py-3 text-xs text-slate-600">{formatDate(connection.lastDeliveryAt)}</td>
                  <td className="adm-col-hide-xl px-3 py-3 text-xs font-semibold text-slate-600">{connection.maskedChatId ?? "Not stored"}</td>
                  <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-2">
                      <button className="rounded border border-amber-200 px-2 py-1 text-xs font-bold text-amber-700 disabled:opacity-50" disabled={!canUpdate || Boolean(busy)} onClick={() => request("POST", { action: "disable_user", userId: connection.userId }, "Telegram disabled for user.")} type="button"><PlugZap className="inline h-3 w-3" /> Disable</button>
                      <button className="rounded border border-rose-200 px-2 py-1 text-xs font-bold text-rose-700 disabled:opacity-50" disabled={!canUpdate || Boolean(busy)} onClick={() => request("POST", { action: "disconnect_user", userId: connection.userId }, "Telegram disconnected for user.")} type="button"><Unplug className="inline h-3 w-3" /> Disconnect</button>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredConnections.length === 0 ? (
                <tr><td className="px-3 py-6 text-center text-sm font-semibold text-slate-500" colSpan={7}>No Telegram connections match this filter.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-black text-slate-950">Delivery Monitor</h2>
        <p className="mt-1 text-sm text-slate-600">Recent Telegram deliveries. Payload bodies are intentionally hidden.</p>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="adm-col-pin px-3 py-2">Module</th>
                <th className="px-3 py-2">Recipient</th>
                <th className="px-3 py-2">Status</th>
                <th className="adm-col-hide-xl px-3 py-2">Attempts</th>
                <th className="adm-col-hide-lg px-3 py-2">Next Retry</th>
                <th className="px-3 py-2">Provider Error</th>
                <th className="px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.deliveries.map((delivery) => (
                <tr className="align-top" key={delivery.id}>
                  <td className="adm-col-pin px-3 py-3">
                    <p className="font-bold text-slate-900">{delivery.module ?? "Unknown"}</p>
                    <p className="text-xs text-slate-500">{delivery.eventType ?? "Unknown event"}</p>
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-600">{delivery.recipient ?? delivery.recipientHrId ?? "Unknown"}</td>
                  <td className="px-3 py-3"><span className={`rounded border px-2 py-1 text-xs font-bold ${badgeClass(delivery.status)}`}>{delivery.status}</span></td>
                  <td className="adm-col-hide-xl px-3 py-3 text-xs font-semibold text-slate-700">{delivery.attempts}</td>
                  <td className="adm-col-hide-lg px-3 py-3 text-xs text-slate-600">{formatDate(delivery.nextAttemptAt)}</td>
                  <td className="max-w-md px-3 py-3 text-xs text-slate-600">{delivery.providerError ?? "None"}</td>
                  <td className="px-3 py-3">
                    <button
                      className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs font-bold text-slate-700 disabled:opacity-50"
                      disabled={!canUpdate || Boolean(busy) || delivery.status === "sent"}
                      onClick={() => request("POST", { action: "retry_delivery", deliveryId: delivery.id }, "Telegram retry processed.")}
                      type="button"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Retry
                    </button>
                  </td>
                </tr>
              ))}
              {data.deliveries.length === 0 ? (
                <tr><td className="px-3 py-6 text-center text-sm font-semibold text-slate-500" colSpan={7}>No Telegram deliveries recorded yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-black text-slate-950">Recent Telegram Audit Logs</h2>
        <p className="mt-1 text-sm text-slate-600">Recent governance actions for Telegram settings, connection, and test activity.</p>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="adm-col-pin px-3 py-2">Time</th>
                <th className="adm-col-hide-xl px-3 py-2">Actor</th>
                <th className="px-3 py-2">Event</th>
                <th className="adm-col-hide-lg px-3 py-2">Entity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.auditLogs.map((log) => (
                <tr className="align-top" key={log.id}>
                  <td className="adm-col-pin px-3 py-3 text-xs text-slate-600">{formatDate(log.createdAt)}</td>
                  <td className="adm-col-hide-xl px-3 py-3 text-xs font-semibold text-slate-700">{log.actorLoginId ?? "system"}</td>
                  <td className="px-3 py-3 text-sm font-bold text-slate-900">{log.summary}</td>
                  <td className="adm-col-hide-lg px-3 py-3 text-xs text-slate-600">{log.entityId ?? "telegram"}</td>
                </tr>
              ))}
              {data.auditLogs.length === 0 ? (
                <tr><td className="px-3 py-6 text-center text-sm font-semibold text-slate-500" colSpan={4}>No Telegram audit logs recorded yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
