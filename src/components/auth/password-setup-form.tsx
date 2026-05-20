"use client";

import { Lock, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { formatHrIdForDisplay } from "@/lib/hr-id";

type Props = {
  expiresAt: string;
  hrId: string | null;
  loginId: string;
  name: string;
  purpose: "reset" | "setup";
  token: string;
};

export function PasswordSetupForm({ expiresAt, hrId, loginId, name, purpose, token }: Props) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const displayLoginId = formatHrIdForDisplay(hrId) ?? loginId;

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
        <section className="mx-auto max-w-xl rounded-[32px] border border-white/10 bg-[linear-gradient(145deg,rgba(19,22,27,0.92),rgba(5,6,8,0.98))] p-8 shadow-[0_30px_70px_rgba(0,0,0,0.55)]">
          <p className="text-sm font-black uppercase tracking-[0.24em] text-[#ff7900]">Phoenix Workforce</p>
          <h1 className="mt-5 text-3xl font-black text-white">Password saved</h1>
          <p className="mt-3 text-base leading-7 text-white/72">
            Your password is ready. Sign in with <span className="font-semibold text-white">{displayLoginId}</span> and the password you just created.
          </p>
          <a
            className="mt-8 inline-flex h-12 items-center justify-center rounded-xl bg-gradient-to-b from-[#ff8a00] to-[#ff4d00] px-5 text-sm font-black text-white"
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
      <section className="mx-auto max-w-xl rounded-[32px] border border-white/10 bg-[linear-gradient(145deg,rgba(19,22,27,0.92),rgba(5,6,8,0.98))] p-8 shadow-[0_30px_70px_rgba(0,0,0,0.55)]">
        <p className="text-sm font-black uppercase tracking-[0.24em] text-[#ff7900]">Phoenix Workforce</p>
        <h1 className="mt-5 text-3xl font-black text-white">
          {purpose === "setup" ? "Create your password" : "Reset your password"}
        </h1>
        <p className="mt-3 text-base leading-7 text-white/72">
          {name} will sign in with <span className="font-semibold text-white">{displayLoginId}</span> after this step.
        </p>

        <div className="mt-6 rounded-2xl border border-[#ff7900]/20 bg-[#ff7900]/8 p-4 text-sm text-white/80">
          <div className="flex items-center gap-2 font-semibold text-[#ffb366]">
            <ShieldCheck className="h-4 w-4" />
            One-time secure setup
          </div>
          <p className="mt-2">This link expires on {new Date(expiresAt).toLocaleString("en-US")}.</p>
        </div>

        <form className="mt-8 space-y-5" onSubmit={submitForm}>
          <label className="block">
            <span className="mb-3 block text-sm font-semibold text-white">New password</span>
            <input
              className="h-14 w-full rounded-2xl border border-white/14 bg-white/[0.045] px-5 text-base text-white outline-none transition placeholder:text-white/34 focus:border-[#ff7900] focus:ring-4 focus:ring-[#ff6a00]/16"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 8 characters"
              type="password"
              value={password}
            />
          </label>
          <label className="block">
            <span className="mb-3 block text-sm font-semibold text-white">Confirm password</span>
            <input
              className="h-14 w-full rounded-2xl border border-white/14 bg-white/[0.045] px-5 text-base text-white outline-none transition placeholder:text-white/34 focus:border-[#ff7900] focus:ring-4 focus:ring-[#ff6a00]/16"
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Repeat the same password"
              type="password"
              value={confirmPassword}
            />
          </label>

          {error ? (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-100">
              {error}
            </div>
          ) : null}

          <button
            className="flex h-14 w-full items-center justify-center gap-3 rounded-[14px] bg-gradient-to-b from-[#ff8a00] to-[#ff4d00] text-lg font-black text-white shadow-[0_14px_38px_rgba(255,106,0,0.34)] transition disabled:cursor-not-allowed disabled:opacity-70"
            disabled={isSaving}
            type="submit"
          >
            {isSaving ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/35 border-t-white" /> : <Lock className="h-5 w-5" />}
            {isSaving ? "Saving..." : purpose === "setup" ? "Create password" : "Reset password"}
          </button>
        </form>
      </section>
    </main>
  );
}
