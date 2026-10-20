"use client";

// Recruitment workspace — the applicant's WhatsApp chat, read-only, inside the opened CV (owner's
// ticked item #22, 20 Oct 2026).
//
// THE CHAT IS THE INBOX'S OWN, NOT A COPY. It is found through the inbox's list route (the chat
// carries the candidate it is linked to, or the number it is on) and read through the inbox's thread
// route, so the Talent Acquisition fence and the inbox's role gate answer here exactly as they do on
// the inbox screen: a chat she may not open reads as "no chat", never as a refusal. Reading it here
// never marks it read — that stays the inbox's own act.
//
// Newest at the bottom, the last few on open and "Load earlier" for the rest of what the route sent
// (its newest 300). Every message is `dir="auto"`, so Arabic and English each sit on their own side.
// A photo or a file is a named link, opened in a new tab through the inbox's authenticated media route.

import { FileText, Image as ImageIcon, MessageCircle } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { formatByteSize } from "@/components/whatsapp-inbox/inbox-format";
import { inboxBubbleShadowClassName, inboxPaperClassName, LineChip } from "@/components/whatsapp-inbox/inbox-look";
import { adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { cairoStamp } from "@/components/recruitment/workspace/workspace-format";
import type { InboxConversationSummary, InboxMessageView, InboxThread } from "@/lib/whatsapp-inbox/store";
import { cn } from "@/lib/utils";

/** How many messages show on open, and how many more each "Load earlier" adds. */
const PAGE = 25;
/** The thread route sends a chat's newest 300; a chat that fills it has more in the inbox. */
const ROUTE_CEILING = 300;

type ChatState =
  | { phase: "loading" }
  | { phase: "none" }
  | { phase: "failed"; message: string }
  | { phase: "ready"; chats: InboxConversationSummary[]; thread: InboxThread };

function digitsOf(value: string | null | undefined): string {
  return (value ?? "").replace(/\D+/g, "");
}

/** The same number, written with or without the country code: compared on its last nine digits. */
function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = digitsOf(a);
  const right = digitsOf(b);
  return left.length >= 9 && right.length >= 9 && left.slice(-9) === right.slice(-9);
}

async function readJson(url: string): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(url);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { data, ok: res.ok, status: res.status };
}

function problemText(data: Record<string, unknown>, fallback: string): string {
  return typeof data.message === "string" && data.message.trim() ? data.message : fallback;
}

/** This applicant's chats, newest first: the ones linked to the record, else the ones on the same number. */
async function findChats(candidateId: string, name: string, phone: string | null): Promise<InboxConversationSummary[] | "refused"> {
  const digits = digitsOf(phone);
  const query = digits.length >= 9 ? digits.slice(-10) : name.trim();
  if (!query) return [];
  const { data, ok, status } = await readJson(`/api/whatsapp-inbox/conversations?q=${encodeURIComponent(query)}&limit=20`);
  if (!ok) {
    if (status === 403) return "refused";
    throw new Error(problemText(data, "The WhatsApp chat could not be loaded."));
  }
  const all = Array.isArray(data.conversations) ? (data.conversations as InboxConversationSummary[]) : [];
  const linked = all.filter((chat) => chat.candidate?.id === candidateId);
  if (linked.length > 0) return linked;
  // An unlinked chat on the same number is the same applicant; a name match alone is not.
  return digits.length >= 9 ? all.filter((chat) => !chat.candidate && samePhone(chat.contactPhone, phone)) : [];
}

function mediaUrl(messageId: string) {
  return `/api/whatsapp-inbox/media/${encodeURIComponent(messageId)}`;
}

function originLine(message: InboxMessageView): string | null {
  if (message.direction === "inbound") return message.messageType === "interactive" ? "Chosen from the menu" : null;
  if (message.origin === "handset") return "Typed on the phone";
  if (message.sentByName) return `Sent by ${message.sentByName}`;
  if (message.automated) return "Sent automatically by Phoenix";
  return "Sent from Phoenix";
}

function isImage(message: InboxMessageView): boolean {
  const mime = (message.mediaMimeType ?? "").toLowerCase();
  return message.messageType === "image" || message.messageType === "sticker" || mime.startsWith("image/");
}

function mediaName(message: InboxMessageView): string {
  if (message.mediaFileName) return message.mediaFileName;
  if (isImage(message)) return "Photo";
  if (message.messageType === "video") return "Video";
  if (message.messageType === "audio") return "Voice note";
  return "File";
}

/** A photo or a file, as its name: one press opens it in a new tab. */
function MediaLink({ message }: { message: InboxMessageView }) {
  if (!message.hasMedia) return null;
  if (message.mediaProblem) {
    return <p className="text-xs font-semibold leading-snug text-amber-800">{message.mediaProblem}</p>;
  }
  const Icon = isImage(message) ? ImageIcon : FileText;
  const size = formatByteSize(message.mediaByteSize);
  return (
    <a
      className="inline-flex w-fit max-w-full items-start gap-1.5 border border-slate-200 bg-white/80 px-2 py-1 text-xs font-bold text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition hover:border-orange-300 hover:text-orange-800"
      href={mediaUrl(message.id)}
      rel="noreferrer"
      target="_blank"
    >
      <Icon aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-slate-500" />
      <span className="min-w-0 break-words" dir="auto">
        {mediaName(message)}
        {size ? <span className="font-medium text-slate-500">{` · ${size}`}</span> : null}
      </span>
    </a>
  );
}

function Bubble({ message, today }: { message: InboxMessageView; today: string }) {
  const outbound = message.direction === "outbound";
  const failed = message.status === "failed";
  const origin = originLine(message);
  return (
    <li className={cn("flex w-full", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "relative flex min-w-0 max-w-[88%] flex-col gap-1 border px-2.5 py-1.5 sm:max-w-[78%]",
          inboxBubbleShadowClassName,
          outbound ? "border-orange-200/90 bg-[linear-gradient(180deg,#FFF6EE_0%,#FFEEDF_100%)]" : "border-slate-200/90 bg-white",
          failed ? "border-red-300 bg-[linear-gradient(180deg,#FFF5F5_0%,#FEECEC_100%)]" : null,
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute top-[-1px] h-[2px] w-5",
            outbound ? "right-[-1px]" : "left-[-1px]",
            failed ? "bg-red-400" : outbound ? "bg-orange-400" : "bg-slate-400",
          )}
        />
        <MediaLink message={message} />
        {message.templateName ? (
          <span className="w-fit border border-orange-200 bg-white/70 px-1.5 py-0.5 text-phx-xs font-bold uppercase leading-none tracking-[0.08em] text-orange-700">
            Template
          </span>
        ) : null}
        {message.body
          ? message.body.split("\n").map((line, index) => (
              <p className="min-h-[1em] whitespace-pre-wrap break-words text-[13px] leading-relaxed text-slate-900" dir="auto" key={index}>
                {line}
              </p>
            ))
          : null}
        {failed ? (
          <p className="break-words text-xs font-semibold text-red-700">{`Not delivered${message.failureDetail ? `: ${message.failureDetail}` : "."}`}</p>
        ) : null}
        <p className="flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-phx-xs text-slate-500">
          {origin ? <span className="font-semibold">{origin}</span> : null}
          <span className="tabular-nums">{cairoStamp(message.sentAt, today)}</span>
        </p>
      </div>
    </li>
  );
}

export function CandidateChat({
  candidateId,
  name,
  phone,
  today,
}: {
  candidateId: string;
  name: string;
  phone: string | null;
  today: string;
}) {
  const [state, setState] = useState<ChatState>({ phase: "loading" });
  const [shown, setShown] = useState(PAGE);
  const scroller = useRef<HTMLDivElement | null>(null);
  /** The height before "Load earlier", so the message being read stays where it was. */
  const heightBefore = useRef<number | null>(null);
  /** The applicant on screen now, so a chat answering after Next was pressed is dropped. */
  const current = useRef(candidateId);
  useEffect(() => {
    current.current = candidateId;
  }, [candidateId]);

  const openChat = useCallback(async (chats: InboxConversationSummary[], chatId: string, active: () => boolean) => {
    const { data, ok, status } = await readJson(`/api/whatsapp-inbox/conversations/${encodeURIComponent(chatId)}`);
    if (!active()) return;
    if (!ok) {
      // A chat behind the fence answers as absent (404) — for her it is simply not there.
      if (status === 404 || status === 403) setState({ phase: "none" });
      else setState({ message: problemText(data, "The WhatsApp chat could not be loaded."), phase: "failed" });
      return;
    }
    setShown(PAGE);
    heightBefore.current = null;
    setState({ chats, phase: "ready", thread: data as unknown as InboxThread });
  }, []);

  useEffect(() => {
    let alive = true;
    const active = () => alive;
    // The caller keys this by candidate, so a new applicant mounts fresh and starts on "loading".
    findChats(candidateId, name, phone)
      .then(async (chats) => {
        if (!alive) return;
        if (chats === "refused" || chats.length === 0) {
          setState({ phase: "none" });
          return;
        }
        await openChat(chats, chats[0].id, active);
      })
      .catch((error: unknown) => {
        if (alive) setState({ message: error instanceof Error ? error.message : "The WhatsApp chat could not be loaded.", phase: "failed" });
      });
    return () => {
      alive = false;
    };
  }, [candidateId, name, openChat, phone]);

  const messages = state.phase === "ready" ? state.thread.messages : [];
  const visible = messages.slice(Math.max(0, messages.length - shown));

  // On open the newest message is in view; after "Load earlier" the one being read stays put.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    if (heightBefore.current !== null) {
      box.scrollTop = box.scrollHeight - heightBefore.current;
      heightBefore.current = null;
    } else {
      box.scrollTop = box.scrollHeight;
    }
  }, [state, shown]);

  if (state.phase === "loading") {
    return <div aria-busy="true" className="h-40 animate-pulse bg-slate-100" role="status" />;
  }
  if (state.phase === "failed") {
    return (
      <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800" dir="auto" role="alert">
        {state.message}
      </p>
    );
  }
  if (state.phase === "none" || messages.length === 0) {
    return (
      <p className="flex items-center gap-2 border border-dashed border-slate-300 px-3 py-3 text-sm font-medium text-slate-600">
        <MessageCircle aria-hidden className="h-4 w-4 shrink-0 text-slate-400" />
        No WhatsApp chat with this applicant yet.
      </p>
    );
  }

  const { chats, thread } = state;
  const hidden = messages.length - visible.length;
  return (
    <div className={cn("border border-slate-200", adminRecessedDepthClassName)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-2.5 py-1.5">
        <span className="text-phx-xs font-black uppercase tracking-wide text-slate-600">
          {`Chat · ${messages.length} message${messages.length === 1 ? "" : "s"}${messages.length >= ROUTE_CEILING ? " (the newest)" : ""}`}
        </span>
        {chats.length > 1 ? (
          <span className="flex flex-wrap items-center gap-1" role="group" aria-label="Which WhatsApp number">
            {chats.map((chat) => (
              <button
                aria-pressed={chat.id === thread.conversation.id}
                className={cn("border px-1.5 py-0.5 transition", chat.id === thread.conversation.id ? "border-orange-400 bg-orange-50" : "border-transparent hover:border-slate-300")}
                key={chat.id}
                onClick={() => {
                  if (chat.id === thread.conversation.id) return;
                  const forCandidate = candidateId;
                  setState({ phase: "loading" });
                  openChat(chats, chat.id, () => current.current === forCandidate).catch(() =>
                    setState({ message: "The WhatsApp chat could not be loaded.", phase: "failed" }),
                  );
                }}
                type="button"
              >
                <LineChip label={chat.lineLabel} />
              </button>
            ))}
          </span>
        ) : (
          <LineChip label={thread.conversation.lineLabel} />
        )}
      </div>
      <div className={cn("max-h-[26rem] overflow-y-auto px-2.5 py-2", inboxPaperClassName)} ref={scroller}>
        {hidden > 0 ? (
          <div className="flex justify-center pb-2">
            <button
              className="border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition hover:border-orange-300 hover:text-orange-800"
              onClick={() => {
                heightBefore.current = scroller.current?.scrollHeight ?? null;
                setShown((current) => current + PAGE);
              }}
              type="button"
            >
              {`Load earlier · ${hidden} more`}
            </button>
          </div>
        ) : messages.length >= ROUTE_CEILING ? (
          <p className="pb-2 text-center text-phx-xs font-semibold text-slate-500">
            Older messages are in the{" "}
            <a className="font-bold text-orange-700 underline-offset-2 hover:underline" href="/recruitment/whatsapp-inbox">
              WhatsApp Inbox
            </a>
            .
          </p>
        ) : null}
        <ol aria-label="WhatsApp messages, oldest first" className="space-y-1.5">
          {visible.map((message) => (
            <Bubble key={message.id} message={message} today={today} />
          ))}
        </ol>
      </div>
    </div>
  );
}
