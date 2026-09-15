"use client";

// WhatsApp Inbox — one chat: who it is, which number it is on, every message both ways, and the box.
//
// Three kinds of outbound message look alike on a phone and must not look alike here: one typed in
// this inbox (it names who sent it), one typed on the handset itself (arrives as an echo), and one
// Phoenix sent by itself (a CV acknowledgement, a document request). The line under each bubble says
// which, because "who told this applicant that?" is the question this screen gets asked.

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, FileText, Link2, Save, Unlink } from "lucide-react";

import { Action, ActionLink, Band, BandSays } from "@/components/recruitment/workstation/workstation-look";
import { patchJson, postJson } from "@/components/recruitment/recruitment-fetch";
import type { InboxMessageView, InboxPersonOption, InboxThread } from "@/lib/whatsapp-inbox/store";
import { cn } from "@/lib/utils";

import { InboxComposer } from "./inbox-composer";
import {
  conversationTitle,
  describeDeliveryStatus,
  formatByteSize,
  formatDayDivider,
  formatMessageTime,
  isNewCairoDay,
} from "./inbox-format";
import { InboxPeoplePicker } from "./inbox-people-picker";

type Panel = { kind: "none" } | { kind: "link" } | { kind: "save"; messageId: string };

function mediaUrl(messageId: string, download = false) {
  return `/api/whatsapp-inbox/media/${encodeURIComponent(messageId)}${download ? "?download=1" : ""}`;
}

function originLine(message: InboxMessageView): string | null {
  if (message.direction === "inbound") return null;
  if (message.origin === "handset") return "Typed on the phone";
  if (message.sentByName) return `Sent by ${message.sentByName}`;
  if (message.automated) return "Sent automatically by Phoenix";
  return "Sent from Phoenix";
}

function MessageMedia({ message }: { message: InboxMessageView }) {
  if (!message.hasMedia) return null;
  if (message.mediaProblem) {
    return <p className="text-[12px] leading-snug text-phx-warn">{message.mediaProblem}</p>;
  }
  const mime = (message.mediaMimeType ?? "").toLowerCase();
  const type = message.messageType;
  if (type === "image" || type === "sticker" || /^image\/(jpeg|png|webp|gif)/.test(mime)) {
    return (
      <a href={mediaUrl(message.id)} rel="noreferrer" target="_blank" title="Open the full photo">
        {/* eslint-disable-next-line @next/next/no-img-element -- a private, authenticated route; next/image cannot proxy it */}
        <img
          alt={message.body ?? "Photo"}
          className="block max-h-72 w-auto max-w-full border border-phx-line bg-phx-surface-2 object-contain"
          loading="lazy"
          src={mediaUrl(message.id)}
        />
      </a>
    );
  }
  if (type === "video" || mime.startsWith("video/")) {
    return <video className="block max-h-72 w-full max-w-full bg-phx-ink" controls preload="metadata" src={mediaUrl(message.id)} />;
  }
  if (type === "audio" || mime.startsWith("audio/")) {
    return <audio className="block w-full max-w-full" controls preload="none" src={mediaUrl(message.id)} />;
  }
  const size = formatByteSize(message.mediaByteSize);
  return (
    <div className="flex flex-wrap items-center gap-2 border border-phx-line bg-white px-2 py-1.5">
      <FileText aria-hidden className="h-4 w-4 shrink-0 text-phx-ink-soft" />
      <span className="min-w-0 flex-1 break-words text-[12px] font-semibold text-phx-ink" dir="auto">
        {message.mediaFileName ?? "File"}
        {size ? <span className="ml-1.5 font-normal text-phx-ink-soft">{size}</span> : null}
      </span>
      <ActionLink href={mediaUrl(message.id)} rel="noreferrer" target="_blank" tone="ghost">
        Open
      </ActionLink>
    </div>
  );
}

function MessageBubble({
  busy,
  message,
  onSave,
}: {
  busy: boolean;
  message: InboxMessageView;
  onSave: (messageId: string) => void;
}) {
  const outbound = message.direction === "outbound";
  const text = message.body;
  const status = outbound ? describeDeliveryStatus(message.status) : "";
  const origin = originLine(message);

  return (
    <div className={cn("flex w-full", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "flex min-w-0 max-w-[85%] flex-col gap-1.5 border px-2.5 py-2 sm:max-w-[70%]",
          outbound ? "border-phx-accent-line bg-phx-accent-soft" : "border-phx-line bg-white",
          message.status === "failed" ? "border-phx-danger" : null,
        )}
      >
        <MessageMedia message={message} />
        {text
          ? text.split("\n").map((line, index) => (
              <p className="min-h-[1em] whitespace-pre-wrap break-words text-[13px] leading-relaxed text-phx-ink" dir="auto" key={index}>
                {line}
              </p>
            ))
          : null}
        {message.status === "failed" ? (
          <p className="text-[12px] leading-snug text-phx-danger">Not delivered{message.failureDetail ? `: ${message.failureDetail}` : "."}</p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-[11px] text-phx-ink-soft">
          {message.historical ? <span>From the phone&apos;s history</span> : null}
          {origin ? <span>{origin}</span> : null}
          {status && message.status !== "failed" ? <span>{status}</span> : null}
          <span className="tabular-nums">{formatMessageTime(message.sentAt)}</span>
        </div>
        {message.hasMedia && !message.mediaProblem ? (
          <div className="flex flex-wrap items-center justify-end gap-1">
            {message.savedToCandidate ? (
              <ActionLink href={`/recruitment?candidate=${encodeURIComponent(message.savedToCandidate.id)}`} tone="ghost">
                Saved to {message.savedToCandidate.name}
              </ActionLink>
            ) : message.direction === "inbound" ? (
              <Action disabled={busy} onClick={() => onSave(message.id)} title="Save this file to a candidate's record" tone="ghost">
                <Save aria-hidden className="h-3.5 w-3.5" />
                Save to candidate
              </Action>
            ) : null}
            <ActionLink href={mediaUrl(message.id, true)} title="Download this file" tone="ghost">
              <Download aria-hidden className="h-3.5 w-3.5" />
              Download
            </ActionLink>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function InboxThreadView({
  onBack,
  onChanged,
  thread,
}: {
  onBack: () => void;
  /** Re-read the thread and the list after anything here changed them. */
  onChanged: () => Promise<void>;
  thread: InboxThread;
}) {
  const [panel, setPanel] = useState<Panel>({ kind: "none" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "accent" | "warn"; text: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const { conversation, messages } = thread;
  const lastMessageId = messages[messages.length - 1]?.id ?? null;

  // Scroll to the newest message when the chat opens and when a new one arrives. DOM only — no state.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [conversation.id, lastMessageId]);

  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setPanel({ kind: "none" });
      setNotice({ text: success, tone: "accent" });
      await onChanged();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "That did not work.", tone: "warn" });
    } finally {
      setBusy(false);
    }
  }

  function link(person: InboxPersonOption) {
    const body = person.kind === "candidate" ? { candidateId: person.id } : { employeeHrId: person.id };
    void act(() => patchJson(`/api/whatsapp-inbox/conversations/${conversation.id}/link`, body), `Linked this chat to ${person.name}.`);
  }

  function unlink() {
    void act(() => patchJson(`/api/whatsapp-inbox/conversations/${conversation.id}/link`, {}), "This chat is no longer linked to anyone.");
  }

  function save(messageId: string, person: InboxPersonOption, kind: "cv" | "other") {
    void act(
      () => postJson(`/api/whatsapp-inbox/messages/${messageId}/save-to-candidate`, { candidateId: person.id, kind }),
      `Saved the file to ${person.name}'s record${kind === "cv" ? " as their CV" : ""}.`,
    );
  }

  const title = conversationTitle(conversation);
  const linked = conversation.candidate ?? conversation.employee;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-phx-line bg-white px-3 py-2 sm:px-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Action className="lg:hidden" onClick={onBack} title="Back to the chat list" tone="ghost">
            <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
            Chats
          </Action>
          <div className="min-w-0 flex-1">
            <p className="break-words text-[15px] font-black leading-tight text-phx-ink" dir="auto">
              {title}
            </p>
            <p className="break-words text-[11px] text-phx-ink-soft">
              {[conversation.contactName ? conversation.contactPhone : null, conversation.contactUsername ? `@${conversation.contactUsername}` : null, `On the ${conversation.lineLabel}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {conversation.candidate ? (
            <ActionLink href={`/recruitment?candidate=${encodeURIComponent(conversation.candidate.id)}`} title="Open this candidate" tone="quiet">
              <Link2 aria-hidden className="h-3.5 w-3.5" />
              Candidate: {conversation.candidate.name}
            </ActionLink>
          ) : null}
          {conversation.employee ? (
            <span className="inline-flex items-center gap-1.5 border border-phx-line bg-white px-2 py-1.5 text-[12px] font-bold leading-none text-phx-ink-2">
              <Link2 aria-hidden className="h-3.5 w-3.5" />
              Employee: {conversation.employee.name}
            </span>
          ) : null}
          <Action disabled={busy} onClick={() => setPanel(panel.kind === "link" ? { kind: "none" } : { kind: "link" })} tone="ghost">
            <Link2 aria-hidden className="h-3.5 w-3.5" />
            {linked ? "Link to someone else" : "Link to a candidate or employee"}
          </Action>
          {linked ? (
            <Action disabled={busy} onClick={unlink} tone="ghost">
              <Unlink aria-hidden className="h-3.5 w-3.5" />
              Unlink
            </Action>
          ) : null}
        </div>
      </div>

      {notice ? (
        <Band tone={notice.tone}>
          <BandSays>{notice.text}</BandSays>
          <Action onClick={() => setNotice(null)} tone="ghost">
            Dismiss
          </Action>
        </Band>
      ) : null}

      {panel.kind === "link" ? (
        <div className="shrink-0 border-b border-phx-line bg-phx-surface-2 p-2 sm:p-3">
          <InboxPeoplePicker
            busy={busy}
            conversationId={conversation.id}
            heading="Who is this chat with?"
            onCancel={() => setPanel({ kind: "none" })}
            onPick={link}
          />
        </div>
      ) : null}

      {panel.kind === "save" ? (
        <SaveToCandidatePanel
          busy={busy}
          conversationId={conversation.id}
          onCancel={() => setPanel({ kind: "none" })}
          onSave={(person, kind) => save(panel.messageId, person, kind)}
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-phx-paper px-3 py-3 sm:px-4">
        {messages.length === 0 ? <p className="text-[12px] text-phx-ink-soft">No messages in this chat yet.</p> : null}
        <div className="flex flex-col gap-2">
          {messages.map((message, index) => (
            <div className="flex flex-col gap-2" key={message.id}>
              {isNewCairoDay(messages[index - 1]?.sentAt ?? null, message.sentAt) ? (
                <p className="py-1 text-center text-[10px] font-bold uppercase tracking-[0.12em] text-phx-ink-faint">
                  {formatDayDivider(message.sentAt)}
                </p>
              ) : null}
              <MessageBubble busy={busy} message={message} onSave={(messageId) => setPanel({ kind: "save", messageId })} />
            </div>
          ))}
        </div>
        <div ref={bottom} />
      </div>

      <InboxComposer
        canSend={thread.canSend}
        cannotSendReason={thread.cannotSendReason}
        conversationId={conversation.id}
        key={conversation.id}
        lineId={conversation.phoneNumberId}
        onSent={onChanged}
        windowClosesAt={thread.replyWindowClosesAt}
      />
    </div>
  );
}

function SaveToCandidatePanel({
  busy,
  conversationId,
  onCancel,
  onSave,
}: {
  busy: boolean;
  conversationId: string;
  onCancel: () => void;
  onSave: (person: InboxPersonOption, kind: "cv" | "other") => void;
}) {
  const [kind, setKind] = useState<"cv" | "other">("cv");
  return (
    <div className="shrink-0 border-b border-phx-line bg-phx-surface-2 p-2 sm:p-3">
      <fieldset className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-phx-ink-2">
        <legend className="sr-only">Save the file as</legend>
        <label className="inline-flex items-center gap-1.5">
          <input checked={kind === "cv"} disabled={busy} name="save-kind" onChange={() => setKind("cv")} type="radio" />
          Their CV
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input checked={kind === "other"} disabled={busy} name="save-kind" onChange={() => setKind("other")} type="radio" />
          Another document
        </label>
      </fieldset>
      <InboxPeoplePicker
        busy={busy}
        candidatesOnly
        conversationId={conversationId}
        heading="Save this file to which candidate?"
        onCancel={onCancel}
        onPick={(person) => onSave(person, kind)}
      />
    </div>
  );
}
