"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { Fingerprint, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-kit";
import {
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFieldClassName,
} from "@/components/ui/form-tokens";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

type BiometricDevice = {
  backedUp: boolean;
  createdAt: string;
  deviceLabel: string;
  id: string;
  lastUsedAt: string | null;
};

// Owner rule: every time shown to a person is Africa/Cairo local, never raw UTC.
const cairoDateTime = stableEnGbFormatter({
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

function formatCairo(value: string | null) {
  if (!value) return "Not used yet";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Not used yet";
  return cairoDateTime.format(parsed);
}

export function BiometricDevicesCard() {
  const [devices, setDevices] = useState<BiometricDevice[]>([]);
  const [enrolling, setEnrolling] = useState(false);
  const [askPassword, setAskPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [password, setPassword] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);

  // Re-read the list after enrolling or removing a device. Safe to call from an event handler;
  // the initial load below deliberately does NOT go through here.
  const refreshDevices = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/biometric/credentials", {
        credentials: "same-origin",
      });
      if (!response.ok) return;
      const payload = (await response.json()) as { credentials?: BiometricDevice[] };
      setDevices(payload.credentials ?? []);
    } catch {
      // A failed list read is not worth an error banner — the enroll button still works.
    } finally {
      setLoaded(true);
    }
  }, []);

  // Initial load, written as a promise chain rather than `void refreshDevices()` so every setState
  // lands inside a callback. Calling an async loader straight from an effect body trips
  // react-hooks/set-state-in-effect. This mirrors NotificationSettingsPanel, which sits directly
  // beside this card on both profile pages and solves the same problem the same way.
  useEffect(() => {
    let active = true;

    fetch("/api/auth/biometric/credentials", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { credentials?: BiometricDevice[] };
        if (active) setDevices(payload.credentials ?? []);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoaded(true);
      });

    return () => {
      active = false;
    };
  }, []);

  // Whether THIS device has a usable sensor. The enrolled list is still shown when it does not,
  // so someone on a desktop without Hello can still see and remove the phone they enrolled.
  useEffect(() => {
    let cancelled = false;

    window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()
      .then((available) => {
        if (!cancelled) setSupported(Boolean(available));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  // A Super Admin's passkey counts as both sign-in steps, so the server asks that account's password
  // before it issues a challenge; it answers `password_required` and this card asks for it.
  async function handleEnroll(currentPassword?: string) {
    setError(null);
    setSuccess(null);
    setEnrolling(true);

    try {
      const optionsResponse = await fetch("/api/auth/biometric/register/options", {
        body: JSON.stringify(currentPassword ? { password: currentPassword } : {}),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!optionsResponse.ok) {
        const payload = (await optionsResponse.json().catch(() => null)) as { error?: string; message?: string } | null;
        if (payload?.error === "password_required") {
          setAskPassword(true);
          return;
        }
        setError(payload?.message ?? "Could not start biometric setup. Please try again.");
        return;
      }

      setAskPassword(false);
      setPassword("");

      const { options } = (await optionsResponse.json()) as {
        options: Parameters<typeof startRegistration>[0]["optionsJSON"];
      };
      const attestation = await startRegistration({ optionsJSON: options });

      const verifyResponse = await fetch("/api/auth/biometric/register/verify", {
        body: JSON.stringify({ response: attestation }),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!verifyResponse.ok) {
        const payload = (await verifyResponse.json().catch(() => null)) as { message?: string } | null;
        setError(payload?.message ?? "This device could not be verified. Please try again.");
        return;
      }

      const payload = (await verifyResponse.json()) as { deviceLabel?: string };
      setSuccess(
        `${payload.deviceLabel ?? "This device"} can now sign you in with biometrics.`,
      );
      await refreshDevices();
    } catch (cancellation) {
      // Dismissing the system prompt is a normal choice, not a failure to report.
      const name = (cancellation as { name?: string } | null)?.name ?? "";
      if (name === "InvalidStateError") {
        setError("This device is already set up for biometric sign-in.");
      } else if (name !== "NotAllowedError" && name !== "AbortError") {
        setError("Biometric setup failed. Please try again.");
      }
    } finally {
      setEnrolling(false);
    }
  }

  async function confirmWithPassword(event: FormEvent) {
    event.preventDefault();
    await handleEnroll(password);
  }

  async function handleRemove(device: BiometricDevice) {
    setError(null);
    setSuccess(null);
    setRemovingId(device.id);

    try {
      const response = await fetch("/api/auth/biometric/credentials", {
        body: JSON.stringify({ credentialId: device.id }),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        setError(payload?.message ?? "Could not remove that device.");
        return;
      }

      setSuccess(`${device.deviceLabel} can no longer sign you in.`);
      await refreshDevices();
    } catch {
      setError("A network error occurred. Please try again.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Card className="rounded border border-gray-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <span className="inline-flex rounded border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-phx-xs font-semibold uppercase tracking-wider text-orange-600">
          Security
        </span>
        <span className="text-phx-xs font-medium text-slate-400">Biometric sign-in</span>
      </div>

      <p className="text-sm text-slate-600">
        Sign in with Face ID, your fingerprint, or Windows Hello instead of typing your password.
        Your fingerprint never leaves this device — Phoenix only stores a key that proves it is you.
      </p>

      {loaded && devices.length > 0 && (
        <ul className="mt-4 space-y-2">
          {devices.map((device) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 rounded border border-gray-200 bg-slate-50/70 px-3 py-2.5"
              key={device.id}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-800">
                    {device.deviceLabel}
                  </span>
                  <span className="block text-phx-xs text-slate-500">
                    Added {formatCairo(device.createdAt)} · Last used {formatCairo(device.lastUsedAt)}
                  </span>
                </span>
              </span>
              <button
                className="inline-flex items-center gap-1.5 rounded border border-rose-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={removingId === device.id}
                onClick={() => handleRemove(device)}
                type="button"
              >
                {removingId === device.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {loaded && devices.length === 0 && (
        <p className="mt-4 rounded border border-gray-200 bg-slate-50/70 px-3 py-2.5 text-sm text-slate-500">
          No devices set up yet.
        </p>
      )}

      {error && (
        <p className="mt-4 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      )}

      {success && (
        <p className="mt-4 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {success}
        </p>
      )}

      {askPassword && (
        <form className="mt-4 space-y-3 border border-slate-200 bg-slate-50 p-4" onSubmit={confirmWithPassword}>
          <p className="text-sm font-bold text-slate-900">Add a device to your account</p>
          <p className="text-sm text-slate-600">
            Your password first, so nobody else at this browser can add their own device to your account.
            This device asks for your fingerprint, face or PIN next.
          </p>
          <FormField htmlFor="biometric-card-password" label="Your password" required>
            <input
              autoComplete="current-password"
              className={phxFieldClassName}
              id="biometric-card-password"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </FormField>
          <div className="flex flex-wrap gap-2">
            <button className={phxButtonPrimaryClassName} disabled={enrolling || !password} type="submit">
              {enrolling ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Confirm
            </button>
            <button
              className={phxButtonGhostClassName}
              disabled={enrolling}
              onClick={() => {
                setPassword("");
                setAskPassword(false);
                setError(null);
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="flex items-center gap-3 pt-4">
        {askPassword ? null : supported ? (
          <Button className="gap-2" disabled={enrolling} onClick={() => handleEnroll()} type="button">
            {enrolling ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Fingerprint className="h-4 w-4" />
            )}
            {enrolling ? "Waiting for you…" : "Set up on this device"}
          </Button>
        ) : (
          <p className="text-sm text-slate-500">
            This device has no fingerprint or face sensor Phoenix can use. Open Phoenix on your
            phone to set it up there.
          </p>
        )}
      </div>
    </Card>
  );
}
