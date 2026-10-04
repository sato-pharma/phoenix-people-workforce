"use client";

import { useState } from "react";
import { Eye, Loader2, ShieldCheck } from "lucide-react";

/**
 * Read the App Passwords page — the System Administrator's card, and the only trigger.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY IT EXISTS AS A CARD AND NOT A SCRIPT. The route it calls refuses a cross-origin request, so
 * nothing outside the app can reach it — and a route with no caller reads exactly like a shipped
 * feature in every status report while doing nothing at all. That has already happened once in this
 * module: `invitation.ts` was written, documented, tested and merged while nothing called it, and
 * every mailbox the robot created stayed `Pending` with its password unread.
 *
 * WHAT IT IS FOR. Four controls in the offboarding robot — the list of a mailbox's existing app
 * passwords, the control that removes one, its confirm, and the empty state — are `__UNCALIBRATED__`
 * placeholders, and until they hold text read off the live page a leaver's phone and Outlook keep
 * syncing mail after their password is reset. This reads that page so they can be replaced.
 *
 * 🔴 IT CHANGES NOTHING, AND THAT IS THE WHOLE DESIGN. It signs in with the password Phoenix already
 * holds, so it resets nothing; it never presses Generate, so it mints nothing; and it never presses
 * a remove control, because identifying those is the point. Pinned by
 * `tests/new-hire-mailbox-app-password-capture.test.ts`, 7 of 7 breaks fired.
 *
 * 🔴 NO ADDRESS FIELD, for the reason every card here has none: the mailbox is fixed server-side and
 * compared against TURBIFY_INVITE_RECIPIENT, because the same chain pointed at an employee signs
 * into their mail.
 *
 * 🔴 AND NO `router.refresh()` AFTER THE RUN. The controls ARE the deliverable, and a refresh
 * remounts this card with `result` back at null — which on 2026-10-03 erased a failed run's only
 * account before anyone read it. There is nothing on this screen worth one click of freshness.
 */

type CaptureResult = {
  address: string;
  controls: string[];
  dryRun: boolean;
  observed: number;
  reached: boolean;
  redacted: number;
  why: string | null;
};

export function AppPasswordControlsCard({ inviteInbox }: { inviteInbox: string }) {
  const [busy, setBusy] = useState<"plan" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CaptureResult | null>(null);

  const planned = result?.dryRun === true;

  async function send(dryRun: boolean) {
    setBusy(dryRun ? "plan" : "run");
    setError(null);
    if (dryRun) setResult(null);
    try {
      const response = await fetch("/api/new-hire-mailboxes/app-password-controls", {
        body: JSON.stringify(dryRun ? {} : { dryRun: false }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string; result?: CaptureResult };
      if (!response.ok) {
        setError(payload.message ?? "The App Passwords page could not be read.");
        return;
      }
      setResult(payload.result ?? null);
    } catch {
      setError("The App Passwords page could not be reached.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="border border-slate-200 bg-white px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <Eye aria-hidden="true" className="h-4 w-4 shrink-0 text-emerald-700" />
        <h2 className="text-xs font-black uppercase tracking-wider text-slate-500">
          Read the App Passwords page
        </h2>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-600">
        Clearing a leaver&rsquo;s app passwords is the one step that actually cuts off the phone in
        their pocket, and it cannot be switched on until the controls that list and remove one have
        been read off the real page. This signs in as{" "}
        <span className="font-semibold text-slate-900">{inviteInbox}</span> with the password Phoenix
        already holds and reports what is on that page.
      </p>

      <div className="mt-3 flex items-start gap-2 border border-emerald-200 bg-emerald-50 px-3 py-2">
        <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
        <p className="min-w-0 break-words text-xs font-medium leading-5 text-emerald-900">
          Nothing is changed by this. No password is reset, no app password is created, and nothing is
          removed — it only reads the page and lists what it found.
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="inline-flex min-h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 disabled:opacity-50"
          disabled={busy !== null}
          onClick={() => void send(true)}
          type="button"
        >
          {busy === "plan" ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : null}
          Check what would happen
        </button>
        <button
          className="inline-flex min-h-9 items-center gap-2 border border-emerald-700 bg-emerald-700 px-3 text-xs font-bold text-white disabled:opacity-50"
          disabled={busy !== null || !planned}
          onClick={() => void send(false)}
          type="button"
        >
          {busy === "run" ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : null}
          Read the page now
        </button>
      </div>

      {error ? (
        <p className="mt-3 break-words border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium leading-5 text-rose-900">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="mt-3 border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="break-words text-xs font-semibold leading-5 text-slate-900">
            {result.dryRun
              ? "Nothing was touched."
              : result.reached
                ? `Read ${result.controls.length} control(s) on the App Passwords page of ${result.address}.`
                : `The App Passwords page of ${result.address} was not reached.`}
          </p>
          {result.why ? (
            <p className="mt-1 break-words text-xs leading-5 text-slate-700">{result.why}</p>
          ) : null}
          {result.controls.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {result.controls.map((control) => (
                <li
                  className="break-words border border-slate-200 bg-white px-2 py-1 font-mono text-xs leading-5 text-slate-800"
                  key={control}
                >
                  {control}
                </li>
              ))}
            </ul>
          ) : null}
          {result.reached ? (
            <p className="mt-2 break-words text-xs leading-5 text-slate-600">
              {result.observed} control(s) were read and {result.redacted} were dropped as
              credential-shaped, so a silent drop shows up here rather than being guessed at.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
