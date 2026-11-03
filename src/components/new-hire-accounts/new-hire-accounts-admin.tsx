"use client";

/**
 * New Hire Accounts — one person per row, their details, and a button per way of sending (owner, 2026-11-03).
 *
 * 🔴 NO `router.refresh()`, AND THE ANSWER LIVES IN THIS COMPONENT'S STATE. The WhatsApp chat URL holds a live link that
 * is never stored or sent again, so a re-read must never be able to take it off the screen. The route's answer carries
 * the new "last sent" too, so nothing here needs a re-read.
 *
 * It fits the screen: a phone draws cards, the desktop a `table-fixed` table whose colgroup and header row come from ONE
 * array, so the two cannot disagree. No `overflow-x`, no ellipsis.
 */

import { useState } from "react";

import { WhatsAppGlyph } from "@/components/organogram/whatsapp-button";
import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { cairoClock24 } from "@/components/phoenix-crm/format";
import { CrmButton, CrmCard, CrmCardsOnPhone, CrmEmpty, CrmPill, CrmTable, crmTdClassName, crmThClassName } from "@/components/phoenix-crm/ui";
import { phxWhatsAppSendButtonClassName } from "@/components/ui/brand-tokens";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import {
  lastSendOutcomeText,
  NEW_HIRE_ACCOUNTS_EXPLAINER,
  NEW_HIRE_CHANNELS,
  newHireAddress,
  newHireChannelName,
  newHireMissingText,
  type NewHireAccountRow,
  type NewHireAccountsView,
  type NewHireChannel,
  type NewHireLastSend,
  type NewHireSendResult,
} from "@/lib/new-hire-accounts/rules";

const ACCOUNT_COLUMNS = [
  { head: "Person", width: "27%" },
  { head: "Contact details", width: "29%" },
  { head: "Last sent", width: "18%" },
  { head: "Send the account", width: "26%" },
] as const;

const NOT_ON_FILE = "Not on file";

function whenText(at: string): string {
  return `${formatPhoenixLongDate(at)}, ${cairoClock24(at)}`;
}

export function NewHireAccountsAdmin({ view }: { view: NewHireAccountsView }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ loginId: string; channel: NewHireChannel } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, NewHireSendResult>>({});

  const locked = busy !== null;

  function lastSendOf(row: NewHireAccountRow): NewHireLastSend | null {
    return results[row.loginId]?.lastSend ?? row.lastSend;
  }

  async function send(row: NewHireAccountRow, channel: NewHireChannel) {
    if (locked) return;
    setBusy(`${row.loginId}:${channel}`);
    setConfirming(null);
    setErrors((current) => {
      const next = { ...current };
      delete next[row.loginId];
      return next;
    });
    try {
      const result = await crmPost<NewHireSendResult>("/api/new-hire-accounts", { loginId: row.loginId, channel }, "result");
      setResults((current) => ({ ...current, [row.loginId]: result }));
    } catch (failure) {
      setErrors((current) => ({ ...current, [row.loginId]: messageOf(failure) }));
    } finally {
      setBusy(null);
    }
  }

  /** A second link cancels the first, so a second press asks first. An unreadable record counts as "may have been sent". */
  function press(row: NewHireAccountRow, channel: NewHireChannel) {
    if (locked) return;
    if (lastSendOf(row) || view.lastSendUnavailable) {
      setConfirming({ loginId: row.loginId, channel });
      return;
    }
    void send(row, channel);
  }

  function personCell(row: NewHireAccountRow) {
    return (
      <div className="grid min-w-0 gap-1">
        <span className="break-words font-black text-slate-900" dir="auto">
          {row.name}
        </span>
        {row.jobTitle ? <span className="break-words text-xs font-semibold text-slate-600">{row.jobTitle}</span> : null}
        <span className="break-words text-xs font-semibold text-slate-600">{`${row.lineName} · ${row.areaName}`}</span>
        <span className="break-words text-xs font-semibold text-slate-500">{`Hire date ${formatPhoenixLongDate(row.hireDate)}`}</span>
      </div>
    );
  }

  function detail(label: string, value: string | null) {
    return (
      <div className="min-w-0">
        <p className="text-xs font-black text-slate-500">{label}</p>
        <p className={value ? "break-words text-sm font-semibold text-slate-800" : "break-words text-sm font-semibold text-slate-400"}>{value ?? NOT_ON_FILE}</p>
      </div>
    );
  }

  function contactCell(row: NewHireAccountRow) {
    return (
      <div className="grid min-w-0 gap-2">
        {detail("Sato email", row.satoEmail)}
        {detail("Private email", row.privateEmail)}
        {detail("WhatsApp", row.mobile)}
      </div>
    );
  }

  function lastSentCell(row: NewHireAccountRow) {
    const last = lastSendOf(row);
    if (!last) {
      return <p className="break-words text-sm font-semibold text-slate-500">{view.lastSendUnavailable ? "Could not be read" : "Not sent yet"}</p>;
    }
    return (
      <div className="grid min-w-0 justify-items-start gap-1">
        <CrmPill tone={last.outcome === "not_delivered" || last.outcome === "not_confirmed" ? "warn" : "info"}>{lastSendOutcomeText(last.outcome)}</CrmPill>
        <p className="break-words text-sm font-semibold text-slate-800">{last.how}</p>
        <p className="break-words text-xs font-semibold text-slate-500">{whenText(last.at)}</p>
        {last.byName ? <p className="break-words text-xs font-semibold text-slate-500" dir="auto">{`By ${last.byName}`}</p> : null}
      </div>
    );
  }

  function resultNote(row: NewHireAccountRow) {
    const result = results[row.loginId];
    const failure = errors[row.loginId];
    return (
      <>
        {failure ? <p className="break-words text-xs font-bold text-rose-800">{failure}</p> : null}
        {result ? (
          <div className="grid min-w-0 justify-items-start gap-2">
            <p className={result.delivered ? "break-words text-xs font-bold text-emerald-800" : "break-words text-xs font-bold text-rose-800"}>{result.message}</p>
            {result.whatsAppUrl ? (
              <a className={phxWhatsAppSendButtonClassName} href={result.whatsAppUrl} rel="noreferrer" target="_blank">
                <WhatsAppGlyph className="h-4 w-4 shrink-0" />
                Open the WhatsApp chat
              </a>
            ) : null}
          </div>
        ) : null}
      </>
    );
  }

  function sendCell(row: NewHireAccountRow) {
    const asking = confirming?.loginId === row.loginId ? confirming : null;
    if (asking) {
      return (
        <div className="grid min-w-0 gap-2">
          <p className="break-words text-xs font-bold text-rose-800">{`A new link cancels the one sent before. Send it by ${newHireChannelName(asking.channel)}?`}</p>
          <div className="flex min-w-0 flex-wrap gap-2">
            <CrmButton disabled={locked} onClick={() => void send(row, asking.channel)} size="sm" variant="primary">
              Send it
            </CrmButton>
            <CrmButton disabled={locked} onClick={() => setConfirming(null)} size="sm" variant="secondary">
              Keep the last one
            </CrmButton>
          </div>
        </div>
      );
    }
    return (
      <div className="grid min-w-0 gap-2">
        {NEW_HIRE_CHANNELS.map((channel) => {
          const missing = !newHireAddress(row, channel);
          return (
            <div className="grid min-w-0 justify-items-start gap-1" key={channel}>
              <CrmButton busy={busy === `${row.loginId}:${channel}`} disabled={locked || missing} onClick={() => press(row, channel)} size="sm" variant="secondary">
                {`Send by ${newHireChannelName(channel)}`}
              </CrmButton>
              {missing ? <p className="break-words text-xs font-semibold text-slate-500">{newHireMissingText(channel)}</p> : null}
            </div>
          );
        })}
        {resultNote(row)}
      </div>
    );
  }

  return (
    <section className="min-w-0 border border-slate-200 bg-white">
      <header className="min-w-0 border-b border-slate-200 px-4 py-3.5 sm:px-5">
        <h2 className="text-base font-black text-slate-950">Waiting for their account</h2>
        <p className="mt-1 break-words text-sm font-medium leading-6 text-slate-600">{NEW_HIRE_ACCOUNTS_EXPLAINER}</p>
      </header>

      {view.rows.length === 0 ? (
        <CrmEmpty message="A new rep or district manager appears here as soon as their login is made." title="Nobody is waiting" />
      ) : (
        <>
          <CrmCardsOnPhone>
            {view.rows.map((row) => (
              <CrmCard
                key={row.loginId}
                meta={`${row.lineName} · ${row.areaName}`}
                title={
                  <span className="break-words font-black text-slate-900" dir="auto">
                    {row.name}
                  </span>
                }
              >
                <div className="grid min-w-0 gap-3">
                  {row.jobTitle ? <p className="break-words text-xs font-semibold text-slate-600">{row.jobTitle}</p> : null}
                  <p className="break-words text-xs font-semibold text-slate-500">{`Hire date ${formatPhoenixLongDate(row.hireDate)}`}</p>
                  {contactCell(row)}
                  {lastSentCell(row)}
                  {sendCell(row)}
                </div>
              </CrmCard>
            ))}
          </CrmCardsOnPhone>

          <CrmTable columns={[...ACCOUNT_COLUMNS.map((column) => column.width)]}>
            <thead>
              <tr>
                {ACCOUNT_COLUMNS.map((column) => (
                  <th className={crmThClassName} key={column.head}>
                    {column.head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <tr key={row.loginId}>
                  <td className={crmTdClassName}>{personCell(row)}</td>
                  <td className={crmTdClassName}>{contactCell(row)}</td>
                  <td className={crmTdClassName}>{lastSentCell(row)}</td>
                  <td className={crmTdClassName}>{sendCell(row)}</td>
                </tr>
              ))}
            </tbody>
          </CrmTable>
        </>
      )}
    </section>
  );
}
