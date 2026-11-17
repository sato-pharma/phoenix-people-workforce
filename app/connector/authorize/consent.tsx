"use client";

import { useState } from "react";

import {
  phxButtonApproveClassName,
  phxButtonDangerClassName,
  phxFormActionsClassName,
  phxFormErrorClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

type Props = { params: Record<string, string | undefined>; clientName: string; role: string };

/**
 * Allow / Cancel. Posts to /api/connector/oauth/approve and then navigates to the ChatGPT address it
 * answers — a script navigation, because the site's CSP (`form-action 'self'`) blocks a form that
 * redirects to another site.
 */
export function ConnectorConsent({ params, clientName, role }: Props) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "allow" | "deny") {
    setBusy(decision);
    setError(null);
    try {
      const response = await fetch("/api/connector/oauth/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, params }),
      });
      const body = (await response.json().catch(() => null)) as { redirectTo?: string; error_description?: string } | null;
      if (!response.ok || !body?.redirectTo) {
        setError(body?.error_description ?? "Phoenix could not complete this step. Try again.");
        setBusy(null);
        return;
      }
      window.location.assign(body.redirectTo);
    } catch {
      setError("Phoenix could not be reached. Check the connection and try again.");
      setBusy(null);
    }
  }

  return (
    <div>
      <h1 className="text-lg font-bold text-slate-900">Allow {clientName} to read Phoenix for you?</h1>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">
        ChatGPT will answer your questions from live Phoenix data and build Excel sheets and PDFs from it, seeing exactly
        what your {role} account sees — employees, pay, attendance, leave, sales, targets and the field CRM.
      </p>
      <ul className="mt-4 space-y-2 border-l-2 border-slate-200 pl-3 text-sm leading-relaxed text-slate-600">
        <li>It can only read. It cannot change, approve, send or publish anything.</li>
        <li>Every question it asks is written to the Phoenix audit log under your name.</li>
        <li>It stops working the moment you change your password, sign out everywhere, or remove it in ChatGPT.</li>
      </ul>
      {error ? <p className={cn(phxFormErrorClassName, "mt-4")}>{error}</p> : null}
      <div className={phxFormActionsClassName}>
        <button type="button" className={phxButtonDangerClassName} disabled={busy !== null} onClick={() => decide("deny")}>
          {busy === "deny" ? "Cancelling" : "Cancel"}
        </button>
        <button type="button" className={phxButtonApproveClassName} disabled={busy !== null} onClick={() => decide("allow")}>
          {busy === "allow" ? "Connecting" : "Allow"}
        </button>
      </div>
    </div>
  );
}
