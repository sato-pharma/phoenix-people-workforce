"use client";

import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { Card } from "@/components/ui/card";
import { FormError, FormField } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonDangerClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFieldClassName,
} from "@/components/ui/form-tokens";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

/**
 * THE SECOND SIGN-IN STEP, on a Super Admin's own profile (src/lib/auth/second-step.ts; the route is
 * /api/auth/second-step). Set it up without waiting for the next password sign-in, make new recovery
 * codes, forget the remembered browsers, move to a new phone, and reset another Super Admin's step.
 *
 * Every key and code this card shows comes back from the server once and lives only in this card's
 * memory: nothing is written to the browser's storage.
 */

type Status = { recoveryCodesLeft: number; setUp: boolean; setUpAt: string | null; trustedDevices: number };
type OtherAccount = { loginId: string; name: string; setUp: boolean };
type Setup = { account: string; otpauthUri: string; secret: string; secretForTyping: string };
/** A change waiting for the person's password. */
type PasswordAsk =
  | { action: "begin_setup"; title: string }
  | { action: "new_recovery_codes"; title: string }
  | { action: "reset"; title: string }
  | { action: "reset_other"; loginId: string; title: string };

// Owner rule: every time shown to a person is Africa/Cairo local, never raw UTC.
const cairoDate = stableEnGbFormatter({ day: "2-digit", month: "short", timeZone: "Africa/Cairo", year: "numeric" });

function formatCairoDate(value: string | null) {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : cairoDate.format(parsed);
}

async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/auth/second-step", {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: response.ok, payload };
}

function messageOf(payload: Record<string, unknown> | null, fallback: string) {
  return typeof payload?.message === "string" ? payload.message : fallback;
}

export function SecondStepCard() {
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [others, setOthers] = useState<OtherAccount[]>([]);
  const [password, setPassword] = useState("");
  const [passwordAsk, setPasswordAsk] = useState<PasswordAsk | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/second-step", { credentials: "same-origin" });
      if (!response.ok) return;
      const payload = (await response.json()) as { others?: OtherAccount[]; status?: Status };
      setStatus(payload.status ?? null);
      setOthers(payload.others ?? []);
    } catch {
      // A failed read leaves the card as it was; every button still answers for itself.
    } finally {
      setLoaded(true);
    }
  }, []);

  // The first read, as a promise chain so every setState lands inside a callback (the same shape as
  // BiometricDevicesCard beside it).
  useEffect(() => {
    let active = true;
    fetch("/api/auth/second-step", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { others?: OtherAccount[]; status?: Status };
        if (!active) return;
        setStatus(payload.status ?? null);
        setOthers(payload.others ?? []);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  function copy(text: string) {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  }

  async function run(work: () => Promise<void>) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await work();
    } catch {
      setError("A network error occurred. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // The key is handed over only against the password: a browser left signed in cannot start a set-up.
  async function beginSetup(currentPassword: string) {
    const { ok, payload } = await post({ action: "begin_setup", password: currentPassword });
    if (!ok || !payload?.setup) {
      setError(messageOf(payload, "Could not start the set-up."));
      return;
    }
    setCode("");
    setSetup(payload.setup as Setup);
  }

  async function finishSetup(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const { ok, payload } = await post({ action: "finish_setup", code: code.trim() });
      if (!ok || !Array.isArray(payload?.recoveryCodes)) {
        setError(messageOf(payload, "That code is not right. Try the next one."));
        return;
      }
      setSetup(null);
      setCode("");
      setRecoveryCodes(payload.recoveryCodes as string[]);
      await refresh();
    });
  }

  async function confirmWithPassword(event: FormEvent) {
    event.preventDefault();
    const ask = passwordAsk;
    if (!ask) return;
    await run(async () => {
      const typedPassword = password;
      const { ok, payload } = await post({
        action: ask.action,
        password: typedPassword,
        ...(ask.action === "reset_other" ? { loginId: ask.loginId } : {}),
      });
      if (!ok) {
        setError(messageOf(payload, "That change could not be made."));
        return;
      }
      setPassword("");
      setPasswordAsk(null);
      if (ask.action === "begin_setup") {
        if (payload?.setup) {
          setCode("");
          setSetup(payload.setup as Setup);
        } else {
          setError("Could not start the set-up.");
        }
      }
      if (ask.action === "new_recovery_codes" && Array.isArray(payload?.recoveryCodes)) {
        setRecoveryCodes(payload.recoveryCodes as string[]);
      }
      if (ask.action === "reset") {
        // Straight into a new set-up, so the account is not left without its second step.
        await beginSetup(typedPassword);
      }
      if (ask.action === "reset_other") {
        setNotice("Done. That account will be asked to set up again at its next password sign-in.");
      }
      await refresh();
    });
  }

  async function forgetDevices() {
    await run(async () => {
      const { ok, payload } = await post({ action: "forget_devices" });
      if (!ok) {
        setError(messageOf(payload, "Could not forget the remembered browsers."));
        return;
      }
      setNotice("Done. Every browser will be asked for a code at its next password sign-in.");
      await refresh();
    });
  }

  return (
    <Card className="mt-6 border border-gray-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <span className="inline-flex border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-phx-xs font-semibold uppercase tracking-wider text-orange-600">
          Security
        </span>
        <span className="text-phx-xs font-medium text-slate-400">Second sign-in step</span>
      </div>

      <p className="text-sm text-slate-600">
        A Super Admin account needs a code from an authenticator app as well as its password. A browser that
        gave a code is not asked again for 30 days. Signing in with a passkey is not asked for a code.
      </p>

      {!loaded && (
        <p className="mt-4 flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading
        </p>
      )}

      {loaded && status && !status.setUp && !setup && !recoveryCodes && (
        <div className="mt-4 border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          Not set up yet. Your next password sign-in will ask you to set it up, or you can do it now.
          <div className="mt-3">
            <button
              className={phxButtonPrimaryClassName}
              disabled={busy}
              onClick={() => setPasswordAsk({ action: "begin_setup", title: "Set up your second sign-in step" })}
              type="button"
            >
              <KeyRound className="h-4 w-4" /> Set it up now
            </button>
          </div>
        </div>
      )}

      {setup && (
        <form className="mt-4 space-y-4 border border-slate-200 bg-slate-50 p-4" onSubmit={finishSetup}>
          <ol className="space-y-3 text-sm leading-6 text-slate-700">
            <li>
              <span className="font-bold text-slate-900">1. Open an authenticator app on your phone.</span> Google
              Authenticator and Microsoft Authenticator both work. Choose to add an account.
            </li>
            <li>
              <span className="font-bold text-slate-900">2. Give it this key.</span>
              <span className="mt-2 block break-words border border-slate-300 bg-white px-3 py-2 font-mono text-base font-bold tracking-[0.08em] text-slate-900">
                {setup.secretForTyping}
              </span>
              <span className="mt-1 block text-slate-500">Account name, if the app asks: {setup.account}</span>
              <span className="mt-2 flex flex-wrap gap-2">
                <button className={phxButtonGhostClassName} onClick={() => copy(setup.secret)} type="button">
                  {copied ? "Copied" : "Copy the key"}
                </button>
                <a className={phxButtonGhostClassName} href={setup.otpauthUri}>
                  Open in the app
                </a>
              </span>
            </li>
          </ol>
          <FormField htmlFor="second-step-card-code" label="3. The 6-digit code the app now shows" required>
            <input
              autoComplete="one-time-code"
              className={phxFieldClassName}
              id="second-step-card-code"
              inputMode="numeric"
              maxLength={12}
              onChange={(event) => setCode(event.target.value)}
              value={code}
            />
          </FormField>
          <div className="flex flex-wrap gap-2">
            <button className={phxButtonAccentClassName} disabled={busy || !code.trim()} type="submit">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Finish the set-up
            </button>
            <button className={phxButtonGhostClassName} disabled={busy} onClick={() => setSetup(null)} type="button">
              Not now
            </button>
          </div>
        </form>
      )}

      {recoveryCodes && (
        <div className="mt-4 space-y-3 border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-bold text-slate-900">Save your ten recovery codes</p>
          <p className="text-sm text-slate-600">
            Each one signs you in once when you do not have your phone. Keep them on paper or in a password
            manager. They are shown only now, and any older codes have stopped working.
          </p>
          <ul className="grid grid-cols-2 gap-2 border border-slate-300 bg-white p-3">
            {recoveryCodes.map((recoveryCode) => (
              <li className="break-all font-mono text-sm font-bold text-slate-900" key={recoveryCode}>
                {recoveryCode}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button className={phxButtonGhostClassName} onClick={() => copy(recoveryCodes.join("\n"))} type="button">
              {copied ? "Copied" : "Copy the codes"}
            </button>
            <button className={phxButtonPrimaryClassName} onClick={() => setRecoveryCodes(null)} type="button">
              I saved them
            </button>
          </div>
        </div>
      )}

      {loaded && status?.setUp && !setup && (
        <>
          <ul className="mt-4 space-y-1 border border-gray-200 bg-slate-50/70 px-3 py-2.5 text-sm text-slate-700">
            <li className="flex items-center gap-2 font-semibold text-slate-800">
              <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" /> Set up
              {formatCairoDate(status.setUpAt) ? ` on ${formatCairoDate(status.setUpAt)}` : ""}
            </li>
            <li>Recovery codes left: {status.recoveryCodesLeft} of 10</li>
            <li>Browsers remembered: {status.trustedDevices}</li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className={phxButtonGhostClassName}
              disabled={busy}
              onClick={() => setPasswordAsk({ action: "new_recovery_codes", title: "Make ten new recovery codes" })}
              type="button"
            >
              Make new recovery codes
            </button>
            <button className={phxButtonGhostClassName} disabled={busy || status.trustedDevices === 0} onClick={forgetDevices} type="button">
              Forget remembered browsers
            </button>
            <button
              className={phxButtonGhostClassName}
              disabled={busy}
              onClick={() => setPasswordAsk({ action: "reset", title: "Move to a new phone" })}
              type="button"
            >
              Move to a new phone
            </button>
          </div>
        </>
      )}

      {loaded && others.length > 0 && (
        <div className="mt-5">
          <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">Other Super Admin accounts</p>
          <ul className="mt-2 space-y-2">
            {others.map((other) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3 border border-gray-200 bg-slate-50/70 px-3 py-2.5"
                key={other.loginId}
              >
                <span className="text-sm">
                  <span className="block font-semibold text-slate-800">{other.name}</span>
                  <span className="block text-phx-xs text-slate-500">{other.setUp ? "Set up" : "Not set up yet"}</span>
                </span>
                {other.setUp && (
                  <button
                    className={phxButtonGhostClassName}
                    disabled={busy}
                    onClick={() =>
                      setPasswordAsk({ action: "reset_other", loginId: other.loginId, title: `Reset the second step of ${other.name}` })
                    }
                    type="button"
                  >
                    Reset, their phone is lost
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {passwordAsk && (
        <form className="mt-4 space-y-3 border border-slate-200 bg-slate-50 p-4" onSubmit={confirmWithPassword}>
          <p className="text-sm font-bold text-slate-900">{passwordAsk.title}</p>
          {passwordAsk.action === "begin_setup" && (
            <p className="text-sm text-slate-600">
              Your password first, so nobody else at this browser can put their own phone on your account. The
              key for your authenticator app is on the next screen.
            </p>
          )}
          {passwordAsk.action === "reset" && (
            <p className="text-sm text-slate-600">
              The key in your old phone stops working, and so do your recovery codes and remembered browsers.
              You set up the new phone on the next screen.
            </p>
          )}
          {passwordAsk.action === "reset_other" && (
            <p className="text-sm text-slate-600">
              Their authenticator key, recovery codes and remembered browsers are removed. Their next password
              sign-in asks them to set up again.
            </p>
          )}
          <FormField htmlFor="second-step-card-password" label="Your password" required>
            <input
              autoComplete="current-password"
              className={phxFieldClassName}
              id="second-step-card-password"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </FormField>
          <div className="flex flex-wrap gap-2">
            <button
              className={
                passwordAsk.action === "new_recovery_codes" || passwordAsk.action === "begin_setup"
                  ? phxButtonPrimaryClassName
                  : phxButtonDangerClassName
              }
              disabled={busy || !password}
              type="submit"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Confirm
            </button>
            <button
              className={phxButtonGhostClassName}
              disabled={busy}
              onClick={() => {
                setPassword("");
                setPasswordAsk(null);
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <FormError className="mt-4">{error}</FormError>
      {notice && <p className="mt-4 border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
    </Card>
  );
}
