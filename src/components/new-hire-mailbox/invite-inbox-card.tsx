"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Inbox, Loader2, ShieldAlert } from "lucide-react";

/**
 * Adopt the INVITE INBOX — the System Administrator's card, and the only trigger.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY IT IS ITS OWN CARD rather than a row in the adopt card: that card returns null when there are
 * no pending new hires, and this action has nothing to do with the queue. It is done ONCE, and from
 * then on the robot finishes every mailbox it creates without anybody clicking anything.
 *
 * WHAT IT ACTUALLY DOES. Turbify's create hands back no password — it emails a `Temp Password:` line
 * to whatever the invite field held. So the robot can only finish a mailbox if it can READ the inbox
 * that email went to. This resets that inbox, takes an app password for it, and hands it to the
 * mailbox monitor, which proves the IMAP login before storing it.
 *
 * 🔴 TWO STEPS, DELIBERATELY, like the adopt card. The first button is a dry run that touches
 * nothing. Only the second resets anything, and its label says so.
 *
 * 🔴 NO ADDRESS FIELD. The mailbox is fixed server-side, compared against TURBIFY_INVITE_RECIPIENT
 * by identity, because the same chain pointed at an employee's address locks that person out of
 * their mail with nobody told. There is deliberately nothing here to type.
 */

type RunResult = {
  address: string | null;
  adopted: boolean;
  detail: string | null;
  dryRun: boolean;
  handover: string | null;
  refusal: string | null;
};

export function InviteInboxCard({ inviteInbox }: { inviteInbox: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"plan" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  const planned = result?.dryRun === true;

  async function send(dryRun: boolean) {
    setBusy(dryRun ? "plan" : "run");
    setError(null);
    if (dryRun) setResult(null);
    try {
      const response = await fetch("/api/new-hire-mailboxes/invite-inbox", {
        body: JSON.stringify(dryRun ? {} : { dryRun: false }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string; result?: RunResult };
      if (!response.ok) {
        setError(payload.message ?? "The invite inbox adoption could not be run.");
        return;
      }
      setResult(payload.result ?? null);
      if (!dryRun) router.refresh();
    } catch {
      setError("The invite inbox adoption could not be reached.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="border border-slate-200 bg-white px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <Inbox aria-hidden="true" className="h-4 w-4 shrink-0 text-sky-700" />
        <h2 className="text-xs font-black uppercase tracking-wider text-slate-500">
          Adopt the invite inbox
        </h2>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-600">
        Turbify never shows a new mailbox&rsquo;s password — it emails it. So the robot can only finish
        a mailbox it creates if Phoenix can read the inbox that email arrives in. This resets{" "}
        <span className="font-semibold text-slate-900">{inviteInbox}</span>, takes an app password for
        it, and proves the connection before storing it. Done once.
      </p>

      <div className="mt-3 flex items-start gap-2 border border-sky-200 bg-sky-50 px-3 py-2">
        <ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
        <p className="min-w-0 break-words text-xs font-medium leading-5 text-sky-900">
          Nobody is locked out by this. That mailbox belongs to Phoenix, not to a person, and there is
          nothing to hand to anybody afterwards.
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
          className="inline-flex min-h-9 items-center gap-2 border border-sky-700 bg-sky-700 px-3 text-xs font-bold text-white disabled:opacity-50"
          disabled={busy !== null || !planned}
          onClick={() => void send(false)}
          type="button"
        >
          {busy === "run" ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : null}
          Reset it and take the app password
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
            {result.adopted
              ? `${result.address} is adopted.`
              : result.dryRun
                ? "Nothing was touched."
                : "It did not finish."}
          </p>
          {result.handover ? (
            <p className="mt-1 break-words text-xs leading-5 text-slate-700">{result.handover}</p>
          ) : null}
          {result.detail ? (
            <p className="mt-1 break-words text-xs leading-5 text-slate-700">{result.detail}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
