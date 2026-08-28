"use client";

import { CheckCircle2, KeyRound, UserCog } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
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
  const [email, setEmail] = React.useState(profile.email ?? "");
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
        body: JSON.stringify({ name, email }),
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

  const formattedCreatedAt = profile.createdAt
    ? new Intl.DateTimeFormat("en-US", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(profile.createdAt))
    : "—";

  return (
    <div className="mx-auto min-h-screen max-w-[900px] space-y-8 p-6 lg:p-8">
      <div>
        <p className="text-[11px] font-black uppercase tracking-[0.24em] text-phx-accent">Admin / Profile</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-phx-ink">My Profile</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-phx-ink-soft">
          View your account details and update your display name or email address.
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
                <dt className="text-[10px] font-black uppercase tracking-[0.16em] text-phx-ink-soft">{label}</dt>
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
              <p className="text-xs text-phx-ink-soft">Update your name and email address</p>
            </div>
          </div>

          <form className="mt-4 space-y-4" onSubmit={handleSave}>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-[0.16em] text-phx-ink-soft" htmlFor="profile-name">
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
              <label className="text-[10px] font-black uppercase tracking-[0.16em] text-phx-ink-soft" htmlFor="profile-email">
                Email address
              </label>
              <Input
                id="profile-email"
                onChange={(e) => { setEmail(e.target.value); setSuccess(false); }}
                placeholder="your@email.com"
                type="email"
                value={email}
              />
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
