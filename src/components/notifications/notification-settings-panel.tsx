"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Bell, CheckCircle2, Link2, Mail, Send, Smartphone, Unplug } from "lucide-react";

type NotificationSettings = {
  preferences: {
    emailEnabled: boolean;
    inAppEnabled: boolean;
    preferredChannel: "in_app" | "email" | "telegram";
    quietHoursEnd: string | null;
    quietHoursStart: string | null;
    telegramEnabled: boolean;
  };
  telegram: {
    linkedAt: string | null;
    status: "pending" | "connected" | "disabled" | "failed" | null;
    username: string | null;
  } | null;
};

const emptySettings: NotificationSettings = {
  preferences: {
    emailEnabled: true,
    inAppEnabled: true,
    preferredChannel: "email",
    quietHoursEnd: null,
    quietHoursStart: null,
    telegramEnabled: false,
  },
  telegram: null,
};

function statusLabel(settings: NotificationSettings) {
  const status = settings.telegram?.status;
  if (status === "connected") return settings.telegram?.username ? `Connected as @${settings.telegram.username}` : "Connected";
  if (status === "pending") return "Connection pending";
  if (status === "failed") return "Connection failed";
  if (status === "disabled") return "Disabled";
  return "Not connected";
}

export function NotificationSettingsPanel() {
  const [settings, setSettings] = useState<NotificationSettings>(emptySettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectLink, setConnectLink] = useState<string | null>(null);

  async function loadSettings() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/notifications/settings", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Unable to load settings.");
      setSettings(payload.data ?? emptySettings);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load settings.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    fetch("/api/notifications/settings", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.message ?? "Unable to load settings.");
        if (active) setSettings(payload.data ?? emptySettings);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Unable to load settings.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function savePreferences(next: NotificationSettings["preferences"]) {
    setSaving(true);
    setError(null);
    setMessage(null);
    setSettings((current) => ({ ...current, preferences: next }));
    try {
      const response = await fetch("/api/notifications/settings", {
        body: JSON.stringify(next),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Unable to save settings.");
      setSettings(payload.data ?? settings);
      setMessage("Notification settings saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save settings.");
      void loadSettings();
    } finally {
      setSaving(false);
    }
  }

  async function connectTelegram() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/integrations/telegram/connect", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Unable to create Telegram link.");
      setConnectLink(payload.data?.link ?? null);
      if (payload.data?.link) window.open(payload.data.link, "_blank", "noopener,noreferrer");
      await loadSettings();
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Unable to create Telegram link.");
    } finally {
      setSaving(false);
    }
  }

  async function disconnectTelegram() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/integrations/telegram/disconnect", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Unable to disconnect Telegram.");
      setSettings(payload.data ?? emptySettings);
      setConnectLink(null);
      setMessage("Telegram disconnected.");
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : "Unable to disconnect Telegram.");
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/integrations/telegram/test", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Unable to send test notification.");
      const telegramDelivery = payload.data?.deliveries?.find((delivery: { channel: string }) => delivery.channel === "telegram");
      setMessage(telegramDelivery?.status === "sent" ? "Telegram test notification sent." : telegramDelivery?.reason ?? "Test notification was recorded.");
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "Unable to send test notification.");
    } finally {
      setSaving(false);
    }
  }

  const preferences = settings.preferences;
  const telegramConnected = settings.telegram?.status === "connected";

  return (
    <section className="rounded border border-slate-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-orange-600" />
            <h2 className="text-base font-bold text-slate-950">Notification Settings</h2>
          </div>
          <p className="mt-1 text-sm text-slate-600">Email, in-app, and Telegram delivery preferences.</p>
        </div>
        <span className="inline-flex items-center gap-2 self-start rounded border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">
          <Smartphone className="h-3.5 w-3.5" />
          {loading ? "Loading" : statusLabel(settings)}
        </span>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {[
          { checked: preferences.inAppEnabled, icon: Bell, key: "inAppEnabled", label: "In-app" },
          { checked: preferences.emailEnabled, icon: Mail, key: "emailEnabled", label: "Email" },
          { checked: preferences.telegramEnabled, icon: Smartphone, key: "telegramEnabled", label: "Telegram" },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <label className="flex items-center justify-between gap-3 rounded border border-slate-200 bg-slate-50 px-3 py-3" key={item.key}>
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Icon className="h-4 w-4 text-slate-500" />
                {item.label}
              </span>
              <input
                checked={item.checked}
                className="h-4 w-4 accent-orange-600"
                disabled={loading || saving}
                onChange={(event) => savePreferences({ ...preferences, [item.key]: event.target.checked })}
                type="checkbox"
              />
            </label>
          );
        })}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <label className="min-w-0 text-sm font-semibold text-slate-700">
          Preferred channel
          <select
            className="mt-1 w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
            disabled={loading || saving}
            onChange={(event) => savePreferences({ ...preferences, preferredChannel: event.target.value as NotificationSettings["preferences"]["preferredChannel"] })}
            value={preferences.preferredChannel}
          >
            <option value="email">Email</option>
            <option value="in_app">In-app</option>
            <option value="telegram">Telegram</option>
          </select>
        </label>
        <label className="min-w-0 text-sm font-semibold text-slate-700">
          Quiet hours start
          <input
            className="mt-1 w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
            disabled={loading || saving}
            onChange={(event) => savePreferences({ ...preferences, quietHoursStart: event.target.value || null })}
            type="time"
            value={preferences.quietHoursStart ?? ""}
          />
        </label>
        <label className="min-w-0 text-sm font-semibold text-slate-700">
          Quiet hours end
          <input
            className="mt-1 w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
            disabled={loading || saving}
            onChange={(event) => savePreferences({ ...preferences, quietHoursEnd: event.target.value || null })}
            type="time"
            value={preferences.quietHoursEnd ?? ""}
          />
        </label>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          className="inline-flex items-center gap-2 rounded border border-orange-200 bg-orange-600 px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60"
          disabled={loading || saving}
          onClick={connectTelegram}
          type="button"
        >
          <Link2 className="h-4 w-4" />
          Connect Telegram
        </button>
        <button
          className="inline-flex items-center gap-2 rounded border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 disabled:opacity-60"
          disabled={loading || saving || !telegramConnected}
          onClick={sendTest}
          type="button"
        >
          <Send className="h-4 w-4" />
          Test Telegram
        </button>
        <button
          className="inline-flex items-center gap-2 rounded border border-rose-200 bg-white px-3.5 py-2 text-sm font-semibold text-rose-700 disabled:opacity-60"
          disabled={loading || saving || !settings.telegram?.status}
          onClick={disconnectTelegram}
          type="button"
        >
          <Unplug className="h-4 w-4" />
          Disconnect
        </button>
      </div>

      {connectLink ? (
        <p className="mt-3 break-all rounded border border-orange-200 bg-orange-50 px-3 py-2 text-xs font-medium text-orange-800">
          Telegram link: {connectLink}
        </p>
      ) : null}
      {message ? (
        <p className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-emerald-700">
          <CheckCircle2 className="h-4 w-4" />
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-rose-700">
          <AlertCircle className="h-4 w-4" />
          {error}
        </p>
      ) : null}
    </section>
  );
}
