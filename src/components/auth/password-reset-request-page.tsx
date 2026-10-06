"use client";

import { KeyRound, Mail, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { systemIdentity } from "@/config/system-settings";

type Step = "identifier" | "code";

const genericRequestMessage =
  "If that account exists, a 6-digit code has been sent to its Sato email. It expires in 15 minutes.";

export function PasswordResetRequestPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("identifier");
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function requestCode(forIdentifier: string): Promise<boolean> {
    const response = await fetch("/api/auth/password-reset/request-code", {
      body: JSON.stringify({ identifier: forIdentifier }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    if (response.status === 429) {
      setError(payload?.message ?? "Too many requests. Please wait a little and try again.");
      return false;
    }
    if (!response.ok) {
      setError(payload?.message ?? "Enter your HR ID or Sato email.");
      return false;
    }
    return true;
  }

  async function submitIdentifier(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = identifier.trim();
    if (!value) {
      setError("Enter your HR ID or Sato email.");
      return;
    }
    setError(null);
    setNotice(null);
    setIsSubmitting(true);
    try {
      if (await requestCode(value)) {
        setStep("code");
        setNotice(genericRequestMessage);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function resendCode() {
    setError(null);
    setNotice(null);
    setIsSubmitting(true);
    try {
      if (await requestCode(identifier.trim())) {
        setNotice("A new code has been sent. The previous one no longer works.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const digits = code.replace(/\D+/g, "");
    if (digits.length !== 6) {
      setError("Enter the 6-digit code from your email.");
      return;
    }
    setError(null);
    setNotice(null);
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/password-reset/verify-code", {
        body: JSON.stringify({ code: digits, identifier: identifier.trim() }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { message?: string; token?: string } | null;
      if (response.status === 429) {
        setError(payload?.message ?? "Too many attempts. Please wait a little and try again.");
        return;
      }
      if (!response.ok || !payload?.token) {
        setError(payload?.message ?? "That code is invalid or has expired. Request a new one.");
        return;
      }
      // The code proved the inbox — hand off to the existing set-password screen.
      router.push(`/password-setup/${encodeURIComponent(payload.token)}`);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const inputClass =
    "h-14 w-full border border-white/14 bg-white/[0.045] px-5 text-base text-white outline-none transition placeholder:text-white/34 focus:border-[#ff7900] focus:ring-4 focus:ring-[#ff6a00]/16";
  const buttonClass =
    "flex h-14 w-full items-center justify-center gap-3 bg-gradient-to-b from-[#ff8a00] to-[#ff4d00] text-lg font-black text-white shadow-[0_14px_38px_rgba(255,106,0,0.34)] transition disabled:cursor-not-allowed disabled:opacity-70";

  return (
    <main className="min-h-screen bg-[#020202] px-4 py-10 text-white">
      <section className="mx-auto max-w-xl border border-white/10 bg-[linear-gradient(145deg,rgba(19,22,27,0.92),rgba(5,6,8,0.98))] p-8 shadow-[0_30px_70px_rgba(0,0,0,0.55)]">
        <p className="text-sm font-black uppercase tracking-[0.24em] text-[#ff7900]">{systemIdentity.appName}</p>
        <h1 className="mt-5 text-3xl font-black text-white">
          {step === "identifier" ? "Set or reset your password" : "Enter your code"}
        </h1>
        <p className="mt-3 text-base leading-7 text-white/72">
          {step === "identifier"
            ? "Enter your Sato email or HR ID. We'll email a 6-digit code to your Sato mailbox so you can set a new password."
            : "We sent a 6-digit code to your Sato email. Enter it below to set your new password."}
        </p>

        <div className="mt-6 border border-[#ff7900]/20 bg-[#ff7900]/8 p-4 text-sm text-white/80">
          <div className="flex items-center gap-2 font-semibold text-[#ffb366]">
            <ShieldCheck className="h-4 w-4" />
            Secure self-service reset
          </div>
          <p className="mt-2">The code is valid for 15 minutes and can be used once.</p>
        </div>

        {step === "identifier" ? (
          <form className="mt-8 space-y-5" onSubmit={submitIdentifier}>
            <label className="block">
              <span className="mb-3 block text-sm font-semibold text-white">Sato email or HR ID</span>
              <input
                autoComplete="username"
                autoFocus
                className={inputClass}
                inputMode="email"
                maxLength={120}
                onChange={(event) => setIdentifier(event.target.value)}
                placeholder="name@satopharma.com"
                value={identifier}
              />
            </label>

            {error ? (
              <div className="border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-100">
                {error}
              </div>
            ) : null}

            <button className={buttonClass} disabled={isSubmitting} type="submit">
              {isSubmitting ? (
                <span className="h-5 w-5 animate-spin border-2 border-white/35 border-t-white" />
              ) : (
                <Mail className="h-5 w-5" />
              )}
              {isSubmitting ? "Sending..." : "Email me a code"}
            </button>
          </form>
        ) : (
          <form className="mt-8 space-y-5" onSubmit={submitCode}>
            {notice ? (
              <div className="border border-[#ff7900]/25 bg-[#ff7900]/8 px-4 py-3 text-sm text-white/85">
                {notice}
              </div>
            ) : null}

            <label className="block">
              <span className="mb-3 block text-sm font-semibold text-white">6-digit code</span>
              <input
                autoComplete="one-time-code"
                autoFocus
                className={`${inputClass} tracking-[0.6em]`}
                inputMode="numeric"
                maxLength={6}
                onChange={(event) => setCode(event.target.value.replace(/\D+/g, ""))}
                placeholder="123456"
                value={code}
              />
            </label>

            {error ? (
              <div className="border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-100">
                {error}
              </div>
            ) : null}

            <button className={buttonClass} disabled={isSubmitting} type="submit">
              {isSubmitting ? (
                <span className="h-5 w-5 animate-spin border-2 border-white/35 border-t-white" />
              ) : (
                <KeyRound className="h-5 w-5" />
              )}
              {isSubmitting ? "Checking..." : "Verify and continue"}
            </button>

            <div className="flex items-center justify-between pt-1 text-sm">
              <button
                className="font-semibold text-[#ffb366] underline-offset-4 hover:underline disabled:opacity-60"
                disabled={isSubmitting}
                onClick={resendCode}
                type="button"
              >
                Resend code
              </button>
              <button
                className="text-white/60 underline-offset-4 hover:underline"
                onClick={() => {
                  setStep("identifier");
                  setCode("");
                  setError(null);
                  setNotice(null);
                }}
                type="button"
              >
                Use a different email
              </button>
            </div>
          </form>
        )}

        <a className="mt-8 inline-flex text-sm font-semibold text-white/55 underline-offset-4 hover:underline" href="/login">
          Back to sign in
        </a>
      </section>
    </main>
  );
}
