"use client";

import { Lock, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { systemIdentity } from "@/config/system-settings";
import { markSessionActivity } from "@/lib/auth/client-session";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { formatHrIdForDisplay } from "@/lib/hr-id";

type Props = {
  /**
   * Where the form posts when the page's scripts never ran (src/lib/auth/password-setup-no-script.ts) —
   * Safari before 16.4 cannot parse Next.js's runtime, so on an iOS 15 iPhone this is the only submit
   * there is. Built on the server, because the helper sits beside code the browser bundle must not load.
   */
  action: string;
  /**
   * ALREADY FORMATTED, by the server component that renders this form.
   *
   * It used to be the raw `expiresAt` instant, formatted here with
   * `Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" })`.
   * The zone was pinned, so this was NOT the UTC-vs-Cairo bug — it was a subtler one. `dateStyle`
   * and `timeStyle` are the most ICU-version-sensitive options `Intl` has: they resolve through
   * locale data that changes between CLDR releases, and en-GB's abbreviated September became
   * "Sept" in CLDR 42. The server (Node 24, ICU 78) rendered "1 Sept 2026, 20:01" while a reader
   * on Samsung Internet 20 (Chrome 106, ICU 71) rendered "1 Sep 2026, 20:01", and React threw
   * hydration error #418 over the one missing character.
   *
   * Formatting on the server and passing the finished string down removes the whole class of
   * failure rather than one instance of it: the browser no longer calls `Intl` here at all, so no
   * difference in ICU data, locale resolution or clock between the two engines can make the server
   * HTML and the hydrated render disagree. This page is the FIRST screen a new employee ever sees,
   * before they have a session, so it is the worst possible place to spend a flicker.
   *
   * `null` renders no expiry line at all — an unparseable timestamp must degrade to a missing
   * line, never to "Invalid Date" and never to a blank screen.
   */
  expiryLabel: string | null;
  hrId: string | null;
  /** A refusal carried back from a native form post, already turned into Phoenix's own words. */
  initialError?: string | null;
  loginId: string;
  name: string;
  purpose: "reset" | "setup";
  /**
   * True when the person arrived by signing in with the emailed TEMPORARY password (owner, 12 Nov 2026):
   * once their own password is saved they are signed in with it and taken inside their account. If that
   * sign-in does not go through, the ordinary "Password saved — go to sign in" screen is shown instead.
   */
  signInAfter?: boolean;
  token: string;
};

export function PasswordSetupForm({
  action,
  expiryLabel,
  hrId,
  initialError = null,
  loginId,
  name,
  purpose,
  signInAfter = false,
  token,
}: Props) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [isSaving, setIsSaving] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const displayLoginId = formatHrIdForDisplay(hrId) ?? loginId;

  // The full sign-in route, with the password the person just chose: every gate it applies still runs.
  async function signInWithNewPassword(newPassword: string): Promise<boolean> {
    try {
      const response = await fetch("/api/auth/login", {
        body: JSON.stringify({ loginId, password: newPassword }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) return false;
      const payload = (await response.json().catch(() => null)) as { user?: { role?: string | null } } | null;
      markSessionActivity();
      window.location.assign(resolveLandingPathForRole(payload?.user?.role));
      return true;
    } catch {
      return false;
    }
  }

  async function submitForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSaving(true);

    try {
      const response = await fetch(`/api/auth/password-setup/${encodeURIComponent(token)}`, {
        body: JSON.stringify({ confirmPassword, password }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "Password setup failed.");
      }

      if (signInAfter && (await signInWithNewPassword(password))) return;

      setIsComplete(true);
      setPassword("");
      setConfirmPassword("");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Password setup failed.");
    } finally {
      setIsSaving(false);
    }
  }

  if (isComplete) {
    return (
      <main className="min-h-screen bg-[#020202] px-4 py-10 text-white">
        <section className="mx-auto max-w-xl border border-white/10 bg-[linear-gradient(145deg,rgba(19,22,27,0.92),rgba(5,6,8,0.98))] p-8 shadow-[0_30px_70px_rgba(0,0,0,0.55)]">
          <p className="text-sm font-black uppercase tracking-[0.24em] text-[#ff7900]">{systemIdentity.appName}</p>
          <h1 className="mt-5 text-3xl font-black text-white">Password saved</h1>
          <p className="mt-3 text-base leading-7 text-white/72">
            Your password is ready. Sign in with <span className="font-semibold text-white">{displayLoginId}</span> and the password you just created.
          </p>
          <a
            className="mt-8 inline-flex h-12 items-center justify-center bg-gradient-to-b from-[#ff8a00] to-[#ff4d00] px-5 text-sm font-black text-white"
            href="/login"
          >
            Go to sign in
          </a>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#020202] px-4 py-10 text-white">
      <section className="mx-auto max-w-xl border border-white/10 bg-[linear-gradient(145deg,rgba(19,22,27,0.92),rgba(5,6,8,0.98))] p-8 shadow-[0_30px_70px_rgba(0,0,0,0.55)]">
        <p className="text-sm font-black uppercase tracking-[0.24em] text-[#ff7900]">{systemIdentity.appName}</p>
        <h1 className="mt-5 text-3xl font-black text-white">
          {signInAfter ? "Choose your own password" : purpose === "setup" ? "Create your password" : "Reset your password"}
        </h1>
        <p className="mt-3 text-base leading-7 text-white/72">
          {signInAfter ? (
            <>
              Welcome, {name}. You signed in with a temporary password. Choose your own password to open your account — the temporary one stops working once you save.
            </>
          ) : (
            <>
              {name} will sign in with <span className="font-semibold text-white">{displayLoginId}</span> after this step.
            </>
          )}
        </p>

        <div className="mt-6 border border-[#ff7900]/20 bg-[#ff7900]/8 p-4 text-sm text-white/80">
          <div className="flex items-center gap-2 font-semibold text-[#ffb366]">
            <ShieldCheck className="h-4 w-4" />
            One-time secure setup
          </div>
          {expiryLabel && !signInAfter ? <p className="mt-2">This link expires on {expiryLabel} Cairo time.</p> : null}
        </div>

        {/* A real method, action and field names: without them a press on a phone whose scripts never
            ran reloads this screen with nothing saved (src/lib/auth/password-setup-no-script.ts). */}
        <form action={action} className="mt-8 space-y-5" method="post" onSubmit={submitForm}>
          <label className="block">
            <span className="mb-3 block text-sm font-semibold text-white">New password</span>
            <input
              className="h-14 w-full border border-white/14 bg-white/[0.045] px-5 text-base text-white outline-none transition placeholder:text-white/34 focus:border-[#ff7900] focus:ring-4 focus:ring-[#ff6a00]/16"
              autoComplete="new-password"
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 8 characters"
              type="password"
              value={password}
            />
          </label>
          <label className="block">
            <span className="mb-3 block text-sm font-semibold text-white">Confirm password</span>
            <input
              className="h-14 w-full border border-white/14 bg-white/[0.045] px-5 text-base text-white outline-none transition placeholder:text-white/34 focus:border-[#ff7900] focus:ring-4 focus:ring-[#ff6a00]/16"
              autoComplete="new-password"
              name="confirmPassword"
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Repeat the same password"
              type="password"
              value={confirmPassword}
            />
          </label>

          {error ? (
            <div className="border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-100">
              {error}
            </div>
          ) : null}

          <button
            className="flex h-14 w-full items-center justify-center gap-3 bg-gradient-to-b from-[#ff8a00] to-[#ff4d00] text-lg font-black text-white shadow-[0_14px_38px_rgba(255,106,0,0.34)] transition disabled:cursor-not-allowed disabled:opacity-70"
            disabled={isSaving}
            type="submit"
          >
            {isSaving ? <span className="h-5 w-5 animate-spin border-2 border-white/35 border-t-white" /> : <Lock className="h-5 w-5" />}
            {isSaving ? "Saving..." : signInAfter ? "Save and open my account" : purpose === "setup" ? "Create password" : "Reset password"}
          </button>
        </form>
      </section>
    </main>
  );
}
