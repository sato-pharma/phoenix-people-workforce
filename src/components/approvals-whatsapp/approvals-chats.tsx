"use client";

// Approvals WhatsApp — the Chats tab: every chat on the approvals line, the open chat beside it, and a new chat.
//
// The chat itself is the recruitment inbox's own thread, composer and wording form, drawn on this screen's API
// (`APPROVALS_INBOX_SURFACE`) — one set of components, two screens (owner, 19 Nov 2026: "parametrise them, don't fork
// them"). Names come from the employee master by number; times are Cairo; read ticks are WhatsApp's blue here.
//
// It refreshes every ten seconds while the tab is visible, and never while it is hidden.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, MessageCirclePlus, Search } from "lucide-react";

import { Action, Band, BandSays } from "@/components/recruitment/workstation/workstation-look";
import { getJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { phxFieldClassName, phxLabelClassName } from "@/components/ui/form-tokens";
import { APPROVALS_INBOX_SURFACE, conversationTitle, formatListTime } from "@/components/whatsapp-inbox/inbox-format";
import { InboxAvatar, InboxEmptyState, lineToneFor } from "@/components/whatsapp-inbox/inbox-look";
import { InboxTemplateForm, type TemplateSendInput } from "@/components/whatsapp-inbox/inbox-template-form";
import { InboxThreadView } from "@/components/whatsapp-inbox/inbox-thread";
import type { InboxConversationSummary, InboxThread } from "@/lib/whatsapp-inbox/store";
import { cn } from "@/lib/utils";

import { APPROVALS_API } from "./approvals-shared";

const POLL_MS = 10_000;

type ReadState = "all" | "unread";

export function ApprovalsChats({
  initialConversations,
  initialTotalUnread,
  lineId,
  onUnreadChange,
}: {
  initialConversations: InboxConversationSummary[];
  initialTotalUnread: number;
  /** The approvals line's phone number id, for the wording form. */
  lineId: string;
  onUnreadChange?: (unread: number) => void;
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [readState, setReadState] = useState<ReadState>("all");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [composingNew, setComposingNew] = useState(false);
  const filtersRef = useRef({ readState, search });
  const selectedRef = useRef<string | null>(null);

  useEffect(() => {
    onUnreadChange?.(initialTotalUnread);
  }, [initialTotalUnread, onUnreadChange]);

  const loadList = useCallback(async () => {
    const params = new URLSearchParams();
    if (filtersRef.current.search) params.set("q", filtersRef.current.search);
    if (filtersRef.current.readState === "unread") params.set("state", "unread");
    try {
      const query = params.toString();
      const data = await getJson(`${APPROVALS_API}/conversations${query ? `?${query}` : ""}`);
      setConversations(Array.isArray(data.conversations) ? (data.conversations as InboxConversationSummary[]) : []);
      if (typeof data.totalUnread === "number") onUnreadChange?.(data.totalUnread);
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Could not load the chats.");
    }
  }, [onUnreadChange]);

  const loadThread = useCallback(async (conversationId: string) => {
    try {
      const data = (await getJson(`${APPROVALS_API}/conversations/${conversationId}`)) as unknown as InboxThread;
      if (selectedRef.current !== conversationId) return;
      setThread(data);
      setThreadError(null);
      if (data.conversation.unreadCount > 0) {
        await postJson(`${APPROVALS_API}/conversations/${conversationId}/read`, {});
        setConversations((current) => current.map((item) => (item.id === conversationId ? { ...item, unreadCount: 0 } : item)));
      }
    } catch (error) {
      if (selectedRef.current === conversationId) setThreadError(error instanceof Error ? error.message : "Could not open the chat.");
    } finally {
      if (selectedRef.current === conversationId) setThreadLoading(false);
    }
  }, []);

  function applyFilters(next: { readState: ReadState; search: string }) {
    filtersRef.current = next;
    setReadState(next.readState);
    setAppliedSearch(next.search);
    void loadList();
  }

  function openConversation(conversationId: string) {
    selectedRef.current = conversationId;
    setComposingNew(false);
    setSelectedId(conversationId);
    setThread((current) => (current?.conversation.id === conversationId ? current : null));
    setThreadError(null);
    setThreadLoading(true);
    void loadThread(conversationId);
  }

  function closeConversation() {
    selectedRef.current = null;
    setSelectedId(null);
    setThread(null);
    setThreadError(null);
  }

  async function markUnread(conversationId: string) {
    closeConversation();
    try {
      await postJson(`${APPROVALS_API}/conversations/${conversationId}/read`, { unread: true });
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Could not mark the chat unread.");
    }
    await loadList();
  }

  const refreshAll = useCallback(async () => {
    const open = selectedRef.current;
    await Promise.all([loadList(), open ? loadThread(open) : Promise.resolve()]);
  }, [loadList, loadThread]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshAll();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshAll]);

  const paneOpen = Boolean(selectedId) || composingNew;

  return (
    <div className="grid h-[calc((100vh_-_14rem)_/_var(--phx-scale-applied,1))] min-h-[calc(30rem_/_var(--phx-scale-applied,1))] grid-cols-1 border border-phx-line bg-white lg:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
      <aside className={cn("min-h-0 flex-col border-phx-line lg:flex lg:border-r", paneOpen ? "hidden" : "flex")}>
        <div className="flex shrink-0 flex-col gap-2 border-b border-phx-line p-2.5">
          <form
            className="flex items-center gap-2 border border-phx-line bg-white px-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              applyFilters({ readState, search: search.trim() });
            }}
          >
            <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-phx-ink-faint" />
            <input
              aria-label="Search chats"
              className="min-w-0 flex-1 border-0 bg-transparent py-2 text-[13px] text-phx-ink outline-none placeholder:text-phx-ink-faint"
              dir="auto"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name or number"
              value={search}
            />
          </form>
          <div className="flex flex-wrap items-center gap-1.5">
            <Action onClick={() => applyFilters({ readState: "all", search: filtersRef.current.search })} tone={readState === "all" ? "quiet" : "ghost"}>
              All
            </Action>
            <Action onClick={() => applyFilters({ readState: "unread", search: filtersRef.current.search })} tone={readState === "unread" ? "quiet" : "ghost"}>
              Unread
            </Action>
            <Action
              className="ml-auto"
              onClick={() => {
                closeConversation();
                setComposingNew(true);
              }}
              tone="primary"
            >
              <MessageCirclePlus aria-hidden className="h-3.5 w-3.5" />
              New chat
            </Action>
          </div>
        </div>
        {listError ? (
          <Band tone="warn">
            <BandSays>{listError}</BandSays>
          </Band>
        ) : null}
        <ul className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {conversations.length === 0 ? (
            <li>
              <InboxEmptyState
                body={readState === "unread" || appliedSearch ? "Clear the search or choose All." : "Chats appear here when someone writes to the approvals number or a message is sent from it."}
                compact
                title={readState === "unread" || appliedSearch ? "No chats match" : "No chats yet"}
              />
            </li>
          ) : null}
          {conversations.map((item) => {
            const active = item.id === selectedId;
            const unread = item.unreadCount > 0;
            return (
              <li className="border-b border-phx-line" key={item.id}>
                <button
                  aria-current={active ? "true" : undefined}
                  className={cn("flex w-full gap-3 border-l-[3px] px-3 py-2.5 text-left", active ? "border-l-phx-accent bg-phx-surface-2" : "border-l-transparent hover:bg-phx-paper")}
                  onClick={() => openConversation(item.id)}
                  type="button"
                >
                  <InboxAvatar name={item.contactName} tone={lineToneFor(item.lineLabel)} />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex w-full items-baseline gap-2">
                      <span className={cn("min-w-0 flex-1 break-words text-[13px] leading-snug", unread ? "font-black text-phx-ink" : "font-bold text-phx-ink-2")} dir="auto">
                        {conversationTitle(item)}
                      </span>
                      <span className={cn("shrink-0 text-[11px] tabular-nums", unread ? "font-bold text-phx-accent" : "text-phx-ink-faint")}>{formatListTime(item.lastMessageAt)}</span>
                    </span>
                    <span className="flex w-full items-start gap-2">
                      <span className={cn("min-w-0 flex-1 break-words text-[12px] leading-snug", unread ? "text-phx-ink-2" : "text-phx-ink-soft")} dir="auto">
                        {item.lastDirection === "outbound" ? <span className="font-semibold text-phx-ink-faint">You: </span> : null}
                        {item.lastMessagePreview ?? ""}
                      </span>
                      {unread ? (
                        <span className="min-w-[1.375rem] shrink-0 bg-phx-accent px-1.5 py-[3px] text-center text-[11px] font-black leading-none tabular-nums text-white">{item.unreadCount}</span>
                      ) : null}
                    </span>
                    {item.employee && item.contactPhone ? (
                      <span className="text-[11px] tabular-nums text-phx-ink-faint" dir="ltr">
                        {item.contactPhone}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className={cn("min-h-0 flex-col", paneOpen ? "flex" : "hidden lg:flex")}>
        {composingNew ? (
          <NewApprovalsChat
            lineId={lineId}
            onCancel={() => setComposingNew(false)}
            onStarted={(conversationId) => {
              void loadList();
              openConversation(conversationId);
            }}
          />
        ) : selectedId ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {thread && thread.conversation.id === selectedId ? (
              <InboxThreadView
                onBack={closeConversation}
                onChanged={refreshAll}
                onMarkUnread={() => void markUnread(selectedId)}
                surface={APPROVALS_INBOX_SURFACE}
                thread={thread}
              />
            ) : null}
            {threadError ? (
              <Band tone="warn">
                <BandSays>{threadError}</BandSays>
                <Action onClick={closeConversation} tone="ghost">
                  Back to the chats
                </Action>
              </Band>
            ) : null}
            {threadLoading && !thread ? (
              <p className="flex flex-1 items-center justify-center gap-2 text-[13px] text-phx-ink-soft">
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                Opening the chat
              </p>
            ) : null}
          </div>
        ) : (
          <InboxEmptyState body="Choose a chat to read it and reply, or start a new one with an approved wording." title="Pick a chat" />
        )}
      </section>
    </div>
  );
}

function NewApprovalsChat({ lineId, onCancel, onStarted }: { lineId: string; onCancel: () => void; onStarted: (conversationId: string) => void }) {
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(input: TemplateSendInput) {
    if (!phone.trim()) {
      setError("Type the number to write to.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await postJson(`${APPROVALS_API}/conversations`, { ...input, phone: phone.trim() });
      if (typeof data.conversationId === "string") onStarted(data.conversationId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The chat was not started.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
      <div className="flex max-w-xl flex-col gap-3 border border-phx-line bg-white p-4">
        <div className="flex items-center gap-2">
          <Action className="lg:hidden" onClick={onCancel} tone="ghost">
            <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
            Chats
          </Action>
          <h2 className="text-[15px] font-black text-phx-ink">Start a new chat</h2>
        </div>
        <p className="text-[12px] leading-5 text-phx-ink-soft">
          WhatsApp lets a business write first only with an approved wording. Once they reply, you can write freely for 24 hours.
        </p>
        <label className="flex flex-col">
          <span className={phxLabelClassName}>Their WhatsApp number</span>
          <input
            className={phxFieldClassName}
            dir="ltr"
            disabled={busy}
            inputMode="tel"
            onChange={(event) => setPhone(event.target.value)}
            placeholder="01012345678 or +20 10 1234 5678"
            value={phone}
          />
        </label>
        <InboxTemplateForm apiBase={APPROVALS_API} busy={busy} line={lineId} onCancel={onCancel} onSend={(input) => void start(input)} submitLabel="Start chat" />
        {error ? (
          <Band tone="warn">
            <BandSays>{error}</BandSays>
          </Band>
        ) : null}
      </div>
    </div>
  );
}
