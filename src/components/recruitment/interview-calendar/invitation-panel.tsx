"use client";

// Send an interview's invitation — to the candidate and to the interviewer, each by WhatsApp or by
// e-mail — and, for the candidate, the company's location, website and LinkedIn on their own.
//
// WHAT "SENT" MEANS HERE, said on the screen so nobody is misled:
//   * E-mail is sent by Phoenix, and the history says "sent" or "failed" as the mail provider answered.
//   * WhatsApp opens the chat with the message already written; the person presses Send in WhatsApp.
//     Phoenix cannot see that press, so the history says "opened", never "sent".
//
// ONE WHATSAPP TAB PER PRESS. A browser lets a single press open a single new tab, so "Send to both"
// opens the first WhatsApp chat and holds the second behind a button of its own, instead of letting
// the browser block it silently.

import { Building2, Check, Loader2, Mail, MessageCircle, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import {
  INVITATION_CHANNEL_LABEL,
  invitationLogSentence,
  type InvitationChannel,
  type InvitationKind,
  type InvitationLogEntry,
  type InvitationPlan,
  type InvitationRecipient,
  type InvitationRecipientPlan,
} from "@/lib/recruitment/interview-invitation";
import { cn } from "@/lib/utils";

import { reasonText, type CalendarApi } from "./calendar-api";
import { ErrorLine } from "./calendar-dialog";

const RECIPIENT_LABEL: Record<InvitationRecipient, string> = { candidate: "Candidate", interviewer: "Interviewer" };

const CAIRO_STAMP = new Intl.DateTimeFormat("en-GB", { day: "numeric", hour: "numeric", hour12: true, minute: "2-digit", month: "short", timeZone: "Africa/Cairo" });

/** The chat opens through a real link click, which a browser always treats as the person's own action. */
function openChat(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function canUse(plan: InvitationRecipientPlan | null, channel: InvitationChannel, kind: InvitationKind): boolean {
  if (!plan) return false;
  if (kind === "invitation" && plan.problem) return false;
  return channel === "whatsapp" ? Boolean(plan.contact.whatsappDisplay) : Boolean(plan.contact.email);
}

export function InvitationPanel({ api, bookingId }: { api: CalendarApi; bookingId: string }) {
  const [plan, setPlan] = useState<InvitationPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [log, setLog] = useState<InvitationLogEntry[]>([]);
  const [channels, setChannels] = useState<Record<InvitationRecipient, InvitationChannel>>({ candidate: "whatsapp", interviewer: "whatsapp" });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [waiting, setWaiting] = useState<InvitationRecipient[]>([]);

  const path = `/bookings/${encodeURIComponent(bookingId)}/invitations`;

  const load = useCallback(async () => {
    try {
      const data = await api.get(path);
      const next = data.plan as InvitationPlan;
      setPlan(next);
      setLog(next.log);
      setLoadError(null);
      // Start each person on the channel they can actually be reached by — WhatsApp when there is a number.
      setChannels({
        candidate: next.candidate.contact.whatsappDisplay || !next.candidate.contact.email ? "whatsapp" : "email",
        interviewer: next.interviewer && !next.interviewer.contact.whatsappDisplay && next.interviewer.contact.email ? "email" : "whatsapp",
      });
    } catch (reason) {
      setLoadError(reasonText(reason, "The invitation could not be loaded."));
    }
  }, [api, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const planOf = (recipient: InvitationRecipient) => (recipient === "candidate" ? plan?.candidate ?? null : plan?.interviewer ?? null);

  async function logWhatsApp(recipient: InvitationRecipient, kind: InvitationKind) {
    try {
      const data = await api.post(path, { channel: "whatsapp", kind, recipient });
      setLog(data.log as InvitationLogEntry[]);
    } catch (reason) {
      setNotice({ text: reasonText(reason, "The chat opened, but Phoenix could not note it in the history."), tone: "bad" });
    }
  }

  function whatsapp(recipient: InvitationRecipient, kind: InvitationKind): boolean {
    const option = planOf(recipient)?.messages.find((message) => message.kind === kind);
    if (!option?.whatsappUrl) return false;
    openChat(option.whatsappUrl);
    void logWhatsApp(recipient, kind);
    return true;
  }

  async function email(recipient: InvitationRecipient, kind: InvitationKind): Promise<boolean> {
    setBusy(`${recipient}:${kind}:email`);
    try {
      const data = await api.post(path, { channel: "email", kind, recipient });
      setLog(data.log as InvitationLogEntry[]);
      const ok = data.status === "sent";
      setNotice({ text: String(data.message ?? (ok ? "E-mail sent." : "The e-mail was not sent.")), tone: ok ? "ok" : "bad" });
      return ok;
    } catch (reason) {
      setNotice({ text: reasonText(reason, "The e-mail could not be sent."), tone: "bad" });
      return false;
    } finally {
      setBusy(null);
    }
  }

  function send(recipient: InvitationRecipient, kind: InvitationKind, channel: InvitationChannel) {
    setNotice(null);
    setWaiting((current) => current.filter((entry) => entry !== recipient));
    if (channel === "whatsapp") {
      if (whatsapp(recipient, kind)) setNotice({ text: `WhatsApp is open with the message for ${planOf(recipient)?.name}. Press Send there.`, tone: "ok" });
      return;
    }
    void email(recipient, kind);
  }

  function sendBoth() {
    setNotice(null);
    const targets = (["candidate", "interviewer"] as const).filter((recipient) => canUse(planOf(recipient), channels[recipient], "invitation"));
    const chats = targets.filter((recipient) => channels[recipient] === "whatsapp");
    // The first chat opens inside this press; the rest wait behind their own button.
    const [first, ...rest] = chats;
    if (first) whatsapp(first, "invitation");
    setWaiting(rest);
    for (const recipient of targets.filter((entry) => channels[entry] === "email")) void email(recipient, "invitation");
    if (first) {
      setNotice({
        text: rest.length > 0 ? `WhatsApp is open for ${planOf(first)?.name}. Press Send there, then open ${planOf(rest[0])?.name}'s below.` : `WhatsApp is open for ${planOf(first)?.name}. Press Send there.`,
        tone: "ok",
      });
    }
  }

  if (loadError) return <ErrorLine>{loadError}</ErrorLine>;
  if (!plan) {
    return (
      <p className="flex items-center gap-2 text-[12px] text-slate-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Getting the invitation ready…
      </p>
    );
  }

  const both = (["candidate", "interviewer"] as const).filter((recipient) => canUse(planOf(recipient), channels[recipient], "invitation"));
  const problem = plan.candidate.problem;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-slate-700">Send the invitation</p>
        {plan.interviewer ? (
          <Action disabled={both.length < 2 || busy !== null} onClick={sendBoth} tone="primary">
            <Send className="h-3.5 w-3.5" />
            Send to both
          </Action>
        ) : null}
      </div>

      {problem ? <p className="border-l-[3px] border-l-amber-500 bg-amber-50 px-3 py-2 text-[12px] text-slate-700">{problem}</p> : null}
      {!plan.interviewer ? (
        <p className="text-[12px] text-slate-500">No interviewer is chosen for this interview. Move it and choose one to send them the invitation too.</p>
      ) : null}

      {waiting.map((recipient) => (
        <div className="flex flex-wrap items-center justify-between gap-2 border-l-[3px] border-l-sky-600 bg-sky-50 px-3 py-2" key={recipient}>
          <p className="min-w-0 break-words text-[12px] text-slate-800">Next: {planOf(recipient)?.name}&apos;s WhatsApp.</p>
          <Action onClick={() => send(recipient, "invitation", "whatsapp")} tone="primary">
            <MessageCircle className="h-3.5 w-3.5" />
            Open WhatsApp for {planOf(recipient)?.name}
          </Action>
        </div>
      ))}

      {notice ? (
        <p
          aria-live="polite"
          className={cn("border-l-[3px] px-3 py-2 text-[12px] break-words", notice.tone === "ok" ? "border-l-emerald-600 bg-emerald-50 text-slate-800" : "border-l-red-600 bg-red-50 font-semibold text-red-800")}
        >
          {notice.text}
        </p>
      ) : null}

      {(["candidate", "interviewer"] as const).map((recipient) => {
        const person = planOf(recipient);
        if (!person) return null;
        const channel = channels[recipient];
        return (
          <RecipientCard
            busy={busy}
            channel={channel}
            key={recipient}
            onChannel={(next) => setChannels((current) => ({ ...current, [recipient]: next }))}
            onSend={(kind, via) => send(recipient, kind, via)}
            person={person}
          />
        );
      })}

      {log.length > 0 ? (
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.06em] text-slate-500">Sent so far</p>
          <ul className="flex flex-col gap-1">
            {log.map((entry) => (
              <li className="flex items-start gap-1.5 break-words text-[12px] text-slate-700" key={entry.id}>
                <Check className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", entry.status === "failed" ? "text-red-600" : "text-emerald-600")} />
                <span className="min-w-0">
                  <span className="font-semibold">{RECIPIENT_LABEL[entry.recipient]}</span>
                  {entry.kind === "company_details" ? " · company details" : ""} — {invitationLogSentence(entry)}
                  <span className="text-slate-500">
                    {" "}
                    · {CAIRO_STAMP.format(new Date(entry.createdAt))}
                    {entry.sentByName ? ` · ${entry.sentByName}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-slate-500">WhatsApp says &ldquo;opened&rdquo;: Phoenix opens the chat, and the message goes when you press Send in WhatsApp.</p>
        </div>
      ) : null}
    </div>
  );
}

function RecipientCard({
  busy,
  channel,
  onChannel,
  onSend,
  person,
}: {
  busy: string | null;
  channel: InvitationChannel;
  onChannel: (channel: InvitationChannel) => void;
  onSend: (kind: InvitationKind, channel: InvitationChannel) => void;
  person: InvitationRecipientPlan;
}) {
  const invitation = person.messages.find((message) => message.kind === "invitation");
  const hasCompany = person.messages.some((message) => message.kind === "company_details");
  const working = busy?.startsWith(`${person.recipient}:`) ?? false;
  return (
    <section className="border border-slate-200 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-slate-500">{RECIPIENT_LABEL[person.recipient]}</p>
          <p className="break-words text-[14px] font-bold text-slate-900">{person.name}</p>
        </div>
        <div aria-label={`How to reach ${person.name}`} className="flex border border-slate-200" role="group">
          {(["whatsapp", "email"] as const).map((option) => (
            <button
              aria-pressed={channel === option}
              className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-bold", channel === option ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50")}
              key={option}
              onClick={() => onChannel(option)}
              type="button"
            >
              {option === "whatsapp" ? <MessageCircle className="h-3.5 w-3.5" /> : <Mail className="h-3.5 w-3.5" />}
              {INVITATION_CHANNEL_LABEL[option]}
            </button>
          ))}
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-1 gap-y-0.5 text-[12px] text-slate-700">
        <div className="break-words">
          <dt className="inline font-semibold">WhatsApp: </dt>
          <dd className="inline">
            {person.contact.whatsappDisplay ? (
              <>
                <span dir="ltr">{person.contact.whatsappDisplay}</span>
                <span className="text-slate-500"> — {person.contact.whatsappSource}</span>
              </>
            ) : (
              <span className="text-amber-800">no number on file</span>
            )}
          </dd>
        </div>
        <div className="break-all">
          <dt className="inline font-semibold">E-mail: </dt>
          <dd className="inline">{person.contact.email ?? <span className="text-amber-800">no address on file</span>}</dd>
        </div>
      </dl>

      {invitation ? (
        <details className="mt-2 text-[12px]">
          <summary className="cursor-pointer font-semibold text-sky-700">See the message</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words border-l-[3px] border-l-slate-300 bg-slate-50 px-3 py-2 font-sans text-[12px] text-slate-800">{invitation.text}</pre>
        </details>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Action disabled={!canUse(person, channel, "invitation") || busy !== null} onClick={() => onSend("invitation", channel)} tone="primary">
          {working && channel === "email" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : channel === "whatsapp" ? <MessageCircle className="h-3.5 w-3.5" /> : <Mail className="h-3.5 w-3.5" />}
          Send invitation by {INVITATION_CHANNEL_LABEL[channel]}
        </Action>
      </div>

      {hasCompany ? (
        <div className="mt-3 border-t border-slate-200 pt-3">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700">
            <Building2 className="h-3.5 w-3.5 text-slate-400" />
            Company location, website and LinkedIn
          </p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Action disabled={!canUse(person, "whatsapp", "company_details") || busy !== null} onClick={() => onSend("company_details", "whatsapp")} tone="quiet">
              <MessageCircle className="h-3.5 w-3.5" />
              By WhatsApp
            </Action>
            <Action disabled={!canUse(person, "email", "company_details") || busy !== null} onClick={() => onSend("company_details", "email")} tone="quiet">
              <Mail className="h-3.5 w-3.5" />
              By e-mail
            </Action>
          </div>
        </div>
      ) : null}
    </section>
  );
}
