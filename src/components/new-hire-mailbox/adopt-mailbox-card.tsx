"use client";

import { useState } from "react";
import { KeyRound, Loader2, ShieldAlert } from "lucide-react";

import type { NewHireMailboxTask } from "@/lib/new-hire-mailbox/service";

/**
 * Adopt a mailbox that already exists — the System Administrator's card, and the only trigger.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 TWO STEPS, DELIBERATELY. "Check what would happen" is a dry run: it names the verdict for that
 * mailbox without touching it. Only the second button resets anything, and it says in its own label
 * what it does. A one-click version of this would reset a working employee's password on a misclick,
 * and the first they would know of it is their mail refusing their password.
 *
 * 🔴 THE PASSWORD IS NEVER IN THIS COMPONENT. The route seals it onto the task row and the existing
 * Super-Admin-only reveal path is where it is read. What comes back here is the hand-over SENTENCE —
 * what the employee has to be told — so the one thing on screen is the thing he has to pass on.
 *
 * Identity follows its parent panel: square corners, slate borders, orange primary, no ellipsis, and
 * nothing that can scroll sideways on a phone.
 */

type Outcome = {
  address: string;
  displayName: string;
  status: "adopted" | "locked_out" | "refused" | "failed";
  detail?: string;
  handover?: string;
};

type RunResult = {
  dryRun: boolean;
  considered: number;
  adopted: number;
  lockedOut: number;
  refused: number;
  failed: number;
  blocked: string | null;
  stoppedEarly: boolean;
  outcomes: Outcome[];
};

const STATUS_TONE: Record<Outcome["status"], string> = {
  adopted: "border-emerald-200 bg-emerald-50 text-emerald-900",
  failed: "border-rose-200 bg-rose-50 text-rose-900",
  locked_out: "border-rose-300 bg-rose-50 text-rose-900",
  refused: "border-amber-200 bg-amber-50 text-amber-900",
};

const STATUS_LABEL: Record<Outcome["status"], string> = {
  adopted: "Done — Phoenix now has this mailbox",
  failed: "Nothing was changed",
  locked_out: "Reset, but not finished — tell them now",
  refused: "Not adopted",
};

export function AdoptMailboxCard({ pending }: { pending: NewHireMailboxTask[] }) {
  const choices = pending.filter((task) => Boolean(task.subject.emailAddress));
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState<"plan" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  // A live run is offered only after a dry run on the SAME address said it would go ahead.
  const planned = result?.dryRun === true && result.adopted === 1 ? result : null;

  async function send(dryRun: boolean) {
    const wanted = address.trim().toLowerCase();
    if (!wanted) {
      setError("Choose the mailbox first.");
      return;
    }
    setBusy(dryRun ? "plan" : "run");
    setError(null);
    if (dryRun) setResult(null);
    try {
      const response = await fetch("/api/new-hire-mailboxes/adopt", {
        body: JSON.stringify(dryRun ? { addresses: [wanted] } : { addresses: [wanted], dryRun: false }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string; result?: RunResult };
      if (!response.ok) {
        setError(payload.message ?? "The adoption could not be run.");
        return;
      }
      setResult(payload.result ?? null);
      // 🔴 NO router.refresh() HERE — see the invite-inbox card for the measurement. The same line
      // there wiped a failed run's only account off the screen on 2026-10-03. On THIS card the
      // stake is higher: a successful run's `handover` is what the employee has to be told, and a
      // `locked_out` outcome means their password is already reset and the hand-over is the only
      // thing standing between them and a mailbox they cannot open. Refreshing a queue list is not
      // worth erasing either one. Pinned by `tests/new-hire-mailbox-result-survives.test.ts`.
    } catch {
      setError("The adoption could not be reached. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  if (choices.length === 0) return null;

  return (
    <section className="border border-slate-200 bg-white px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound aria-hidden="true" className="h-4 w-4 shrink-0 text-orange-600" />
        <h2 className="text-xs font-black uppercase tracking-wider text-slate-500">
          Adopt a mailbox that already exists
        </h2>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-600">
        For a mailbox that was made by hand, before the robot existed. Phoenix resets its password in
        Turbify, signs in, and takes the app password it needs — which is the only way to get one,
        because Turbify will not issue one from the admin console.
      </p>

      <div className="mt-3 flex items-start gap-2 border border-amber-200 bg-amber-50 px-3 py-2">
        <ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <p className="min-w-0 break-words text-xs font-medium leading-5 text-amber-900">
          This locks them out of webmail until you give them the new password. They can change it
          straight away afterwards — the app password keeps working.
        </p>
      </div>

      <label className="mt-3 flex min-w-0 flex-col gap-1">
        <span className="text-[11px] font-black uppercase tracking-wider text-slate-500">Whose mailbox</span>
        <select
          className="h-9 w-full border border-slate-300 bg-white px-2 text-sm text-slate-900"
          onChange={(event) => {
            setAddress(event.target.value);
            setResult(null);
            setError(null);
          }}
          value={address}
        >
          <option value="">Choose a new hire</option>
          {choices.map((task) => (
            <option key={task.subject.hrId} value={(task.subject.emailAddress ?? "").toLowerCase()}>
              {task.subject.displayName} — {task.subject.emailAddress}
            </option>
          ))}
        </select>
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 transition hover:border-slate-400 disabled:opacity-50"
          disabled={busy !== null || !address}
          onClick={() => send(true)}
          type="button"
        >
          {busy === "plan" && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
          Check what would happen
        </button>
        <button
          className="inline-flex h-9 items-center gap-2 border border-orange-600 bg-orange-600 px-3 text-xs font-bold text-white transition hover:bg-orange-700 disabled:opacity-50"
          disabled={busy !== null || planned === null}
          onClick={() => send(false)}
          type="button"
        >
          {busy === "run" && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
          Reset it and take the app password
        </button>
      </div>
      {planned === null && result?.dryRun === true ? (
        <p className="mt-2 break-words text-xs font-medium text-amber-700">
          This one would not be adopted, so there is nothing to run.
        </p>
      ) : null}

      {error && <p className="mt-2 break-words text-xs font-medium text-rose-600">{error}</p>}

      {result?.blocked ? (
        <p className="mt-3 break-words border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium leading-5 text-rose-900">
          {result.blocked}
        </p>
      ) : null}

      {result && result.outcomes.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {result.outcomes.map((outcome) => (
            <li
              className={`border px-3 py-2 text-xs leading-5 ${STATUS_TONE[outcome.status]}`}
              key={`${outcome.address}:${outcome.status}`}
            >
              <p className="min-w-0 break-words font-bold">
                {result.dryRun && outcome.status === "adopted"
                  ? `${outcome.displayName} — this would go ahead`
                  : `${outcome.displayName} — ${STATUS_LABEL[outcome.status]}`}
              </p>
              {outcome.detail ? <p className="mt-1 min-w-0 break-words">{outcome.detail}</p> : null}
              {outcome.handover && !result.dryRun ? (
                <p className="mt-1 min-w-0 break-words font-medium">{outcome.handover}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
