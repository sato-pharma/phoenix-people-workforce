"use client";

import { CheckCircle, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type FieldState = {
  show: boolean;
  value: string;
};

export function ChangePasswordForm() {
  const [current, setCurrent] = useState<FieldState>({ show: false, value: "" });
  const [next, setNext] = useState<FieldState>({ show: false, value: "" });
  const [confirm, setConfirm] = useState<FieldState>({ show: false, value: "" });
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function clientValidate(): string | null {
    if (!current.value) return "Please enter your current password.";
    if (!next.value) return "Please enter a new password.";
    if (next.value.length < 8) return "New password must be at least 8 characters.";
    if (next.value === current.value) return "New password must be different from your current password.";
    if (next.value !== confirm.value) return "New passwords do not match.";
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const validationError = clientValidate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          currentPassword: current.value,
          newPassword: next.value,
          confirmPassword: confirm.value,
        }),
      });

      const data = (await res.json()) as {
        error?: string;
        message?: string;
        requiresRelogin?: boolean;
        success?: boolean;
      };

      if (!res.ok) {
        setError(data.message ?? "Password change failed. Please try again.");
        return;
      }

      // Session could not be refreshed in-place; redirect to login so the user
      // authenticates fresh with the new password.
      if (data.requiresRelogin) {
        window.location.href = "/login?reason=password_changed";
        return;
      }

      setSuccess(true);
      setCurrent({ show: false, value: "" });
      setNext({ show: false, value: "" });
      setConfirm({ show: false, value: "" });
    } catch {
      setError("A network error occurred. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <Card className="rounded border border-emerald-200 bg-emerald-50/60 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
          <div>
            <p className="text-sm font-semibold text-emerald-800">Password changed successfully.</p>
            <p className="mt-0.5 text-xs text-emerald-700">
              Your new password is active. Other sessions on different devices will be signed out on their next activity.
            </p>
            <button
              className="mt-3 text-xs font-semibold text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
              onClick={() => setSuccess(false)}
              type="button"
            >
              Change again
            </button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="rounded border border-gray-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <span className="inline-flex rounded border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-orange-600">
          Security
        </span>
        <span className="text-[11px] font-medium text-slate-400">
          Change your password
        </span>
      </div>

      <form className="space-y-4" onSubmit={handleSubmit}>
        <PasswordField
          autoComplete="current-password"
          id="current-password"
          label="Current password"
          placeholder="Enter your current password"
          show={current.show}
          value={current.value}
          onToggleShow={() => setCurrent((s: FieldState) => ({ ...s, show: !s.show }))}
          onValueChange={(v: string) => setCurrent((s: FieldState) => ({ ...s, value: v }))}
        />

        <PasswordField
          autoComplete="new-password"
          id="new-password"
          label="New password"
          placeholder="At least 8 characters"
          show={next.show}
          value={next.value}
          onToggleShow={() => setNext((s: FieldState) => ({ ...s, show: !s.show }))}
          onValueChange={(v: string) => setNext((s: FieldState) => ({ ...s, value: v }))}
        />

        <PasswordField
          autoComplete="new-password"
          id="confirm-password"
          label="Confirm new password"
          placeholder="Repeat your new password"
          show={confirm.show}
          value={confirm.value}
          onToggleShow={() => setConfirm((s: FieldState) => ({ ...s, show: !s.show }))}
          onValueChange={(v: string) => setConfirm((s: FieldState) => ({ ...s, value: v }))}
        />

        {error && (
          <p className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Button className="gap-2" disabled={loading} type="submit">
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            {loading ? "Changing password…" : "Change password"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PasswordField(props: {
  autoComplete: string;
  id: string;
  label: string;
  placeholder: string;
  show: boolean;
  value: string;
  onToggleShow: () => void;
  onValueChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400" htmlFor={props.id}>
        {props.label}
      </label>
      <div className="relative">
        <Input
          autoComplete={props.autoComplete}
          id={props.id}
          placeholder={props.placeholder}
          type={props.show ? "text" : "password"}
          value={props.value}
          onChange={(e) => props.onValueChange(e.target.value)}
        />
        <button
          aria-label={props.show ? "Hide password" : "Show password"}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
          onClick={props.onToggleShow}
          tabIndex={-1}
          type="button"
        >
          {props.show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
