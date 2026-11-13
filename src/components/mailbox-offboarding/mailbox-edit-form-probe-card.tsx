"use client";

import { useState } from "react";
import { Eye, Loader2, ShieldCheck } from "lucide-react";

import { phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import type { MailboxEditFormField, MailboxEditFormReading } from "@/lib/new-hire-mailbox/robot/driver";

/**
 * Read one leaver's mailbox Edit form — the System Administrator's card on the leaver register.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY IT EXISTS (13 Nov 2026). Resetting a leaver's password leaves their app passwords working,
 * and clearing those from inside the mailbox is blocked for good by Yahoo's terms. The console's row
 * has no suspend button. The one place not yet looked at is inside the row's Edit form: does it hold
 * an on/off, status or access switch that would cut the leaver off? This reads it once and shows
 * every control on it.
 *
 * 🔴 IT CHANGES NOTHING. The route signs in as the console administrator, opens that one row's Edit
 * form, reads it, and closes it with Close or Cancel (or Escape) — never a control that keeps a
 * change. A text box comes back as a count of characters, never what it holds.
 *
 * Built exactly like the App Passwords capture card (`app-password-controls-card.tsx`): the same
 * section, the same green "nothing is changed" band, the same result block. The leaver is chosen by
 * NAME; the address travels in the request only because the route checks it against the register.
 *
 * 🔴 NO `router.refresh()` AFTER THE RUN — the reading IS the deliverable, and a refresh remounts this
 * card with `result` back at null, which on 2026-10-03 erased a failed run's only account.
 */

export type MailboxEditFormProbeLeaver = {
  taskId: string;
  name: string;
  address: string;
  /** Already formatted for display, e.g. "Left 03 Nov 2026", so two people of one name stay apart. */
  lastDay: string;
};

type ProbeResult = MailboxEditFormReading & { employeeName?: string };

function fieldTitle(field: MailboxEditFormField): string {
  if (field.label.length > 0) return field.label;
  return field.name.length > 0 ? `Unlabelled ${field.type} (field named ${field.name})` : `Unlabelled ${field.type}`;
}

function fieldState(field: MailboxEditFormField): string[] {
  const notes: string[] = [field.type];
  if (field.checked === true) notes.push("On / ticked");
  if (field.checked === false) notes.push("Off / unticked");
  if (field.selected !== null) notes.push(`Chosen: ${field.selected.length > 0 ? field.selected : "nothing"}`);
  if (field.filled !== null) notes.push(field.filled === 0 ? "Empty" : `Holds ${field.filled} character(s)`);
  if (field.required) notes.push("Required");
  if (field.disabled) notes.push("Disabled");
  if (field.hidden) notes.push("Hidden");
  return notes;
}

export function MailboxEditFormProbeCard({ leavers }: { leavers: MailboxEditFormProbeLeaver[] }) {
  const [chosen, setChosen] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProbeResult | null>(null);

  const leaver = leavers.find((candidate) => candidate.taskId === chosen) ?? null;

  async function read() {
    if (!leaver) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/mailbox-offboarding/edit-form-controls", {
        body: JSON.stringify({ address: leaver.address }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string; result?: ProbeResult };
      if (!response.ok) {
        setError(payload.message ?? "The Edit form could not be read.");
        return;
      }
      setResult(payload.result ?? null);
    } catch {
      setError("The Edit form could not be reached.");
    } finally {
      setBusy(false);
    }
  }

  const who = result?.employeeName || leaver?.name || "this leaver";

  return (
    <section className="mt-5 border border-slate-200 bg-white px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <Eye aria-hidden="true" className="h-4 w-4 shrink-0 text-emerald-700" />
        <h2 className="text-xs font-black uppercase tracking-wider text-slate-500">
          Read a leaver&rsquo;s mailbox Edit form
        </h2>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-600">
        The Turbify console has no suspend button for a mailbox, and a password reset leaves the
        leaver&rsquo;s phone and Outlook connected. This opens the mailbox&rsquo;s Edit form in the
        console once and lists every control on it, so you can see whether it holds an on/off, status
        or access switch that would cut the leaver off.
      </p>

      <div className="mt-3 flex items-start gap-2 border border-emerald-200 bg-emerald-50 px-3 py-2">
        <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
        <p className="min-w-0 break-words text-xs font-medium leading-5 text-emerald-900">
          Nothing is changed by this. Nothing is typed into the form, and it is closed with Close or
          Cancel — a box&rsquo;s contents come back as a count of characters, never what it holds.
        </p>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0">
          <label className={phxLabelClassName} htmlFor="mailbox-edit-form-probe-leaver">
            Leaver
          </label>
          <select
            className={phxSelectClassName}
            disabled={busy}
            id="mailbox-edit-form-probe-leaver"
            onChange={(event) => {
              setChosen(event.target.value);
              setResult(null);
              setError(null);
            }}
            value={chosen}
          >
            <option value="">Choose a leaver</option>
            {leavers.map((candidate) => (
              <option key={candidate.taskId} value={candidate.taskId}>
                {candidate.name} — {candidate.lastDay}
              </option>
            ))}
          </select>
        </div>
        <button
          className="inline-flex min-h-10 items-center justify-center gap-2 border border-emerald-700 bg-emerald-700 px-3 text-xs font-bold text-white disabled:opacity-50"
          disabled={busy || !leaver}
          onClick={() => void read()}
          type="button"
        >
          {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : null}
          Read the Edit form (changes nothing)
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
            {result.reached
              ? `Read ${result.fields.length} control(s) on the Edit form of ${who}.`
              : `The Edit form of ${who} was not read.`}
          </p>
          {result.reached ? (
            <p className="mt-1 break-words text-xs leading-5 text-slate-700">
              {result.closed === true
                ? `Closed again with ${result.leftWith ?? "a close control"} — nothing was kept.`
                : result.closed === false
                  ? "The form did not close on its own; the browser was shut without keeping anything."
                  : "No dialog opened, so there was nothing to close; the browser was shut without keeping anything."}
            </p>
          ) : null}
          {result.why ? (
            <p className="mt-1 break-words text-xs leading-5 text-slate-700">{result.why}</p>
          ) : null}

          {result.headings.length > 0 ? (
            <p className="mt-2 break-words text-xs leading-5 text-slate-700">
              <span className="font-semibold text-slate-900">Headings: </span>
              {result.headings.join(" · ")}
            </p>
          ) : null}
          {result.buttons.length > 0 ? (
            <p className="mt-1 break-words text-xs leading-5 text-slate-700">
              <span className="font-semibold text-slate-900">Buttons on the form (none pressed but the close): </span>
              {result.buttons.join(" · ")}
            </p>
          ) : null}

          {result.fields.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {result.fields.map((field, index) => (
                <li
                  className="break-words border border-slate-200 bg-white px-2 py-1 text-xs leading-5 text-slate-800"
                  key={`${field.name}-${field.label}-${index}`}
                >
                  <span className="font-semibold text-slate-900">{fieldTitle(field)}</span>
                  <span className="text-slate-600"> — {fieldState(field).join(" · ")}</span>
                  {field.options.length > 0 ? (
                    <span className="block text-slate-600">Choices: {field.options.join(" · ")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {result.controls.length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-semibold text-slate-700">
                Every control on the page ({result.controls.length})
              </summary>
              <ul className="mt-1 space-y-1">
                {result.controls.map((control) => (
                  <li
                    className="break-words border border-slate-200 bg-white px-2 py-1 font-mono text-xs leading-5 text-slate-800"
                    key={control}
                  >
                    {control}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
