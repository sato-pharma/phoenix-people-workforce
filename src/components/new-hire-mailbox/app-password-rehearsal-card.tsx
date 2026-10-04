"use client";

import { useState } from "react";
import { KeyRound, Loader2, TriangleAlert } from "lucide-react";

/**
 * The app-password rehearsal — the System Administrator's card, and the only trigger.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY IT IS A SEPARATE CARD FROM THE CAPTURE. That one promises, in its own words and in a green
 * panel, that nothing is changed. This one mints a real app password. Putting a mutation behind a
 * card whose reassurance is still on screen is how somebody presses the wrong one at 2am — so they
 * are two cards, two colours, and the promise on the other one stays true.
 *
 * WHAT IT IS FOR. `removeConfirm` is the last `__UNCALIBRATED__` placeholder and the only one that
 * cannot be read off an untouched page: it does not exist until Remove has been pressed. The live
 * capture of 2026-10-04 filled three of four and stopped there, and would have stopped there every
 * time. Minting something in order to remove it is the only way to see the fourth.
 *
 * 🔴 NO ADDRESS FIELD, and here that matters more than anywhere else in this module: the mailbox is
 * fixed server-side AND refused by the driver before a browser opens. It is Phoenix's own invite
 * inbox, which holds nobody's mail. The same sequence aimed at an employee would mint and revoke a
 * credential on the mailbox their phone is syncing.
 *
 * 🔴 THE DRY RUN GATES THE LIVE BUTTON, which is not decoration. On 2026-10-04 three clicks on the
 * capture's live button did nothing at all because it was disabled until the plan had been read —
 * the pattern works, and on a card that mints it is worth more.
 *
 * 🔴 AND THE RESULT IS NEVER REFRESHED AWAY. The readings ARE the deliverable, and a
 * `router.refresh()` here would remount the card with the only account of a run that minted.
 */

type StageReading = {
  controls: string[];
  observed: number;
  reached: boolean;
  redacted: number;
  why: string | null;
};

type RehearsalResult = {
  address: string;
  after?: StageReading;
  before?: StageReading;
  confirming?: StageReading;
  dryRun: boolean;
  listed?: StageReading;
  minted: boolean;
  outstanding: boolean;
  removed: boolean;
  why: string | null;
};

const STAGES: { key: "before" | "listed" | "confirming" | "after"; label: string; note: string }[] = [
  { key: "before", label: "Before minting", note: "the empty state, if the mailbox had none" },
  { key: "listed", label: "After minting", note: "the entry row and its remove control" },
  { key: "confirming", label: "At the confirm step", note: "the only place the confirm exists" },
  { key: "after", label: "After removing", note: "should read like the first stage again" },
];

export function AppPasswordRehearsalCard({ inviteInbox }: { inviteInbox: string }) {
  const [busy, setBusy] = useState<"plan" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RehearsalResult | null>(null);

  const planned = result?.dryRun === true;

  async function send(dryRun: boolean) {
    setBusy(dryRun ? "plan" : "run");
    setError(null);
    if (dryRun) setResult(null);
    try {
      const response = await fetch("/api/new-hire-mailboxes/app-password-rehearsal", {
        body: JSON.stringify(dryRun ? {} : { dryRun: false }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string; result?: RehearsalResult };
      if (!response.ok) {
        setError(payload.message ?? "The rehearsal could not be completed.");
        return;
      }
      setResult(payload.result ?? null);
    } catch {
      setError("The rehearsal could not be reached.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="border border-slate-200 bg-white px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound aria-hidden="true" className="h-4 w-4 shrink-0 text-amber-700" />
        <h2 className="text-xs font-black uppercase tracking-wider text-slate-500">
          Mint and remove one app password
        </h2>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-600">
        One control is still unknown: whatever answers the page when an app password is removed. It
        does not exist until Remove is pressed, so no amount of reading finds it. This signs in as{" "}
        <span className="font-semibold text-slate-900">{inviteInbox}</span>, mints one app password,
        reads the page at each stage, then removes it again.
      </p>

      <div className="mt-3 flex items-start gap-2 border border-amber-300 bg-amber-50 px-3 py-2">
        <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <p className="min-w-0 break-words text-xs font-medium leading-5 text-amber-900">
          This one does change something. It creates a real app password on Phoenix&rsquo;s own invite
          inbox and then deletes it. No other mailbox can be reached by it, and nobody&rsquo;s mail is
          touched &mdash; but if the confirm cannot be matched, a working app password is left behind
          and this card says so in plain words.
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
          className="inline-flex min-h-9 items-center gap-2 border border-amber-700 bg-amber-700 px-3 text-xs font-bold text-white disabled:opacity-50"
          disabled={busy !== null || !planned}
          onClick={() => void send(false)}
          type="button"
        >
          {busy === "run" ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : null}
          Mint and remove one now
        </button>
      </div>

      {error ? (
        <p className="mt-3 break-words border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium leading-5 text-rose-900">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="mt-3 border border-slate-200 bg-slate-50 px-3 py-2">
          {/* 🔴 The outstanding warning comes FIRST and in its own colour, because it is the one
              reading that needs an action today. */}
          {result.outstanding ? (
            <p className="mb-2 break-words border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-bold leading-5 text-rose-900">
              A working app password was created on {result.address} and could not be removed. Remove
              it by hand in the mailbox&rsquo;s App Passwords page.
            </p>
          ) : null}

          <p className="break-words text-xs font-semibold leading-5 text-slate-900">
            {result.dryRun
              ? "Nothing was touched."
              : result.removed
                ? `Minted one app password on ${result.address} and removed it again.`
                : result.minted
                  ? `Minted one app password on ${result.address}.`
                  : `Nothing was minted on ${result.address}.`}
          </p>
          {result.why ? (
            <p className="mt-1 break-words text-xs leading-5 text-slate-700">{result.why}</p>
          ) : null}

          {STAGES.map(({ key, label, note }) => {
            const stage = result[key];
            if (!stage || !stage.reached) return null;
            return (
              <div className="mt-3" key={key}>
                <p className="break-words text-xs font-bold leading-5 text-slate-900">
                  {label}{" "}
                  <span className="font-medium text-slate-500">&mdash; {note}</span>
                </p>
                <ul className="mt-1 space-y-1">
                  {stage.controls.map((control) => (
                    <li
                      className="break-words border border-slate-200 bg-white px-2 py-1 font-mono text-xs leading-5 text-slate-800"
                      key={`${key}:${control}`}
                    >
                      {control}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 break-words text-xs leading-5 text-slate-600">
                  {stage.observed} control(s) were read and {stage.redacted} were dropped as
                  credential-shaped.
                </p>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
