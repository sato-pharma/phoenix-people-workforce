"use client";

import { CheckCircle2, KeyRound, UserCog } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { formatHrIdForDisplay } from "@/lib/hr-id";

type Profile = {
  loginId: string;
  name: string | null;
  email: string | null;
  role: string | null;
  hrId: string | null;
  createdAt: string | null;
};

export function AdminProfileForm({ profile }: { profile: Profile }) {
  const [name, setName] = React.useState(profile.name ?? "");
  const [isSaving, setIsSaving] = React.useState(false);
  const [success, setSuccess] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setSuccess(false);
    setError(null);

    try {
      const response = await fetch("/api/admin/profile", {
        // The name only: the sign-in email is not editable here (the route ignores one).
        body: JSON.stringify({ name }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "Failed to save profile.");
      setSuccess(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save profile.");
    } finally {
      setIsSaving(false);
    }
  }

  // Pinned to Cairo via the shared formatter (never the runtime's own zone): this used to be
  // `new Intl.DateTimeFormat("en-US", {...}).format(...)` with no `timeZone`, which renders in
  // whichever zone the RUNTIME is in — UTC on the server (Railway), Cairo in the browser. React
  // saw two different text nodes for the same instant and threw hydration error #418 on every
  // profile page view for an account with a real `created_at`. Same root cause and same fix as
  // password-setup-form.tsx's EXPIRY_FORMAT.
  const formattedCreatedAt = cairoDateTime(profile.createdAt);

  return (
    <div className="mx-auto min-h-screen max-w-[900px] space-y-8 p-6 lg:p-8">
      <div>
        <p className="text-phx-xs font-black uppercase tracking-[0.24em] text-phx-accent">Admin / Profile</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-phx-ink">My Profile</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-phx-ink-soft">
          View your account details and update your display name. Your sign-in email is managed by HR.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        {/* Read-only account info */}
        <Card className="rounded-2xl border border-phx-line bg-white shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
          <div className="flex items-center gap-3 border-b border-phx-line pb-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-phx-accent/10">
              <UserCog className="h-5 w-5 text-phx-accent" />
            </div>
            <div>
              <h2 className="font-bold text-phx-ink">Account Details</h2>
              <p className="text-xs text-phx-ink-soft">Read-only system fields</p>
            </div>
          </div>
          <dl className="mt-4 space-y-4">
            {[
              { label: "Login ID", value: profile.loginId },
              { label: "Role", value: profile.role ?? "—" },
              { label: "Linked HR ID", value: formatHrIdForDisplay(profile.hrId) ?? "—" },
              { label: "Account created", value: formattedCreatedAt },
            ].map(({ label, value }) => (
              <div className="flex flex-col gap-0.5" key={label}>
                <dt className="text-phx-sm font-black uppercase tracking-[0.16em] text-phx-ink-soft">{label}</dt>
                <dd className="rounded-lg border border-phx-line bg-phx-paper px-3 py-2 font-mono text-sm font-semibold text-phx-ink">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </Card>

        {/* Editable fields */}
        <Card className="rounded-2xl border border-phx-line bg-white shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
          <div className="flex items-center gap-3 border-b border-phx-line pb-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-phx-accent/10">
              <KeyRound className="h-5 w-5 text-phx-accent" />
            </div>
            <div>
              <h2 className="font-bold text-phx-ink">Edit Profile</h2>
              <p className="text-xs text-phx-ink-soft">Update your display name</p>
            </div>
          </div>

          <form className="mt-4 space-y-4" onSubmit={handleSave}>
            <div className="space-y-1.5">
              <label className="text-phx-sm font-black uppercase tracking-[0.16em] text-phx-ink-soft" htmlFor="profile-name">
                Display name
              </label>
              <Input
                id="profile-name"
                onChange={(e) => { setName(e.target.value); setSuccess(false); }}
                placeholder="Your full name"
                value={name}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-phx-sm font-black uppercase tracking-[0.16em] text-phx-ink-soft" htmlFor="profile-email">
                Email address (not editable)
              </label>
              <Input
                aria-describedby="profile-email-note"
                className="cursor-default read-only:bg-slate-50 read-only:text-slate-600"
                id="profile-email"
                placeholder="No sign-in email on file"
                readOnly
                type="email"
                value={profile.email ?? ""}
              />
              <p className="text-xs text-phx-ink-soft" id="profile-email-note">
                Your sign-in email is managed by HR. Ask HR to change it.
              </p>
            </div>

            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}

            {success && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                Profile saved successfully.
              </div>
            )}

            <Button className="w-full gap-2" disabled={isSaving} type="submit">
              {isSaving ? <LoadingSpinner /> : <KeyRound className="h-4 w-4" />}
              Save changes
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
