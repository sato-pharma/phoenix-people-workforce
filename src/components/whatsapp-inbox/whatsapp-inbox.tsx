"use client";

// WhatsApp Inbox — both company numbers, in one screen, for the Super Admin.
//
// Two panes on a desktop (the chat list beside the open chat), one on a phone (the list, and the
// chat in its place once one is opened, with a way back). Everything it shows comes from Phoenix's
// own record of the messages, which the WhatsApp webhook writes as they arrive — so the screen reads
// our database, never Meta, and keeps working when Meta is slow.
//
// It refreshes itself every ten seconds while the tab is visible. A hidden tab does not poll: an
// inbox left open overnight in a background tab should not make eight thousand requests.

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCirclePlus, RefreshCw, Search, X } from "lucide-react";

import {
  Action,
  Band,
  BandSays,
  Figure,
  Tally,
  WorkHeader,
} from "@/components/recruitment/workstation/workstation-look";
import { getJson, postJson } from "@/components/recruitment/recruitment-fetch";
import type { InboxConversationSummary, InboxThread } from "@/lib/whatsapp-inbox/store";
import { cn } from "@/lib/utils";

import { conversationTitle, formatListTime } from "./inbox-format";
import { InboxTemplateForm, type TemplateSendInput } from "./inbox-template-form";
import { InboxThreadView } from "./inbox-thread";

export type InboxLineOption = { phoneNumberId: string; label: string; displayNumber: string };

type Filters = { line: string; search: string; unreadOnly: boolean };

const POLL_MS = 10_000;

function listUrl(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.line) params.set("line", filters.line);
  if (filters.search) params.set("q", filters.search);
  if (filters.unreadOnly) params.set("unread", "1");
  const query = params.toString();
  return `/api/whatsapp-inbox/conversations${query ? `?${query}` : ""}`;
}

export function WhatsAppInbox({
  initialConversations,
  initialTotalUnread,
  lines,
}: {
  initialConversations: InboxConversationSummary[];
  initialTotalUnread: number;
  lines: InboxLineOption[];
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [totalUnread, setTotalUnread] = useState(initialTotalUnread);
  const [filters, setFilters] = useState<Filters>({ line: "", search: "", unreadOnly: false });
  const [searchDraft, setSearchDraft] = useState("");
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [composingNew, setComposingNew] = useState(false);

  // The poll reads these through refs so the interval is set up once, not re-armed on every filter.
  const filtersRef = useRef(filters);
  const selectedRef = useRef<string | null>(null);

  const loadList = useCallback(async (next: Filters) => {
    try {
      const data = await getJson(listUrl(next));
      if (filtersRef.current !== next) return; // a newer filter was chosen while this was in flight
      setConversations(Array.isArray(data.conversations) ? (data.conversations as InboxConversationSummary[]) : []);
      setTotalUnread(typeof data.totalUnread === "number" ? data.totalUnread : 0);
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Could not load the chats.");
    }
  }, []);

  const loadThread = useCallback(async (conversationId: string, options?: { markRead?: boolean }) => {
    try {
      const data = (await getJson(`/api/whatsapp-inbox/conversations/${conversationId}`)) as unknown as InboxThread;
      if (selectedRef.current !== conversationId) return;
      setThread(data);
      setThreadError(null);
      if (options?.markRead !== false && data.conversation.unreadCount > 0) {
        await postJson(`/api/whatsapp-inbox/conversations/${conversationId}/read`, {});
        setConversations((current) => current.map((item) => (item.id === conversationId ? { ...item, unreadCount: 0 } : item)));
        setTotalUnread((current) => Math.max(0, current - data.conversation.unreadCount));
      }
    } catch (error) {
      if (selectedRef.current !== conversationId) return;
      setThreadError(error instanceof Error ? error.message : "Could not open the chat.");
    } finally {
      if (selectedRef.current === conversationId) setThreadLoading(false);
    }
  }, []);

  function applyFilters(next: Filters) {
    filtersRef.current = next;
    setFilters(next);
    void loadList(next);
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

  const refreshAll = useCallback(async () => {
    const open = selectedRef.current;
    await Promise.all([loadList(filtersRef.current), open ? loadThread(open) : Promise.resolve()]);
  }, [loadList, loadThread]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshAll();
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

  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-[32rem] flex-col border border-phx-line bg-white">
      <WorkHeader
        controls={
          <>
            <Action onClick={() => applyFilters({ ...filters, line: "" })} tone={filters.line === "" ? "primary" : "quiet"}>
              Both numbers
            </Action>
            {lines.map((line) => (
              <Action
                key={line.phoneNumberId}
                onClick={() => applyFilters({ ...filters, line: line.phoneNumberId })}
                title={line.displayNumber}
                tone={filters.line === line.phoneNumberId ? "primary" : "quiet"}
              >
                {line.label}
              </Action>
            ))}
            <Action
              onClick={() => applyFilters({ ...filters, unreadOnly: !filters.unreadOnly })}
              tone={filters.unreadOnly ? "primary" : "ghost"}
            >
              Unread only
            </Action>
            <Action onClick={() => void refreshAll()} title="Check for new messages now" tone="ghost">
              <RefreshCw aria-hidden className="h-3.5 w-3.5" />
              Refresh
            </Action>
            <Action
              onClick={() => {
                closeConversation();
                setComposingNew(true);
              }}
              tone="quiet"
            >
              <MessageCirclePlus aria-hidden className="h-3.5 w-3.5" />
              New chat
            </Action>
          </>
        }
        figures={
          <>
            <Figure label="unread" value={totalUnread} />
            <Figure label={conversations.length === 1 ? "chat" : "chats"} value={conversations.length} />
          </>
        }
        subtitle={lines.map((line) => `${line.label} ${line.displayNumber}`).join(" · ")}
        title="WhatsApp Inbox"
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
        {/* ── The chat list ── */}
        <aside className={cn("min-h-0 flex-col border-phx-line lg:flex lg:border-r", selectedId || composingNew ? "hidden" : "flex")}>
          <form
            className="flex shrink-0 items-center gap-1.5 border-b border-phx-line px-3 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              applyFilters({ ...filters, search: searchDraft.trim() });
            }}
          >
            <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-phx-ink-faint" />
            <input
              aria-label="Search chats"
              className="min-w-0 flex-1 border-0 bg-transparent py-1 text-[13px] text-phx-ink outline-none placeholder:text-phx-ink-faint"
              dir="auto"
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="Search by name or number"
              value={searchDraft}
            />
            {filters.search ? (
              <Action
                onClick={() => {
                  setSearchDraft("");
                  applyFilters({ ...filters, search: "" });
                }}
                title="Clear the search"
                tone="ghost"
              >
                <X aria-hidden className="h-3.5 w-3.5" />
              </Action>
            ) : null}
          </form>

          {listError ? (
            <Band tone="warn">
              <BandSays>{listError}</BandSays>
            </Band>
          ) : null}

          <ul className="min-h-0 flex-1 divide-y divide-phx-line overflow-y-auto overflow-x-hidden">
            {conversations.length === 0 ? (
              <li className="px-3 py-4 text-[12px] leading-snug text-phx-ink-soft">
                {filters.search || filters.unreadOnly || filters.line
                  ? "No chats match these filters."
                  : "No chats yet. Messages appear here as soon as someone writes to either number."}
              </li>
            ) : null}
            {conversations.map((item) => {
              const active = item.id === selectedId;
              const linked = item.candidate?.name ?? item.employee?.name ?? null;
              return (
                <li key={item.id}>
                  <button
                    className={cn(
                      "flex w-full flex-col gap-0.5 border-l-[3px] px-3 py-2 text-left transition-colors",
                      active ? "border-l-phx-accent bg-phx-accent-soft" : "border-l-transparent hover:bg-phx-paper",
                    )}
                    onClick={() => openConversation(item.id)}
                    type="button"
                  >
                    <span className="flex w-full items-baseline gap-2">
                      <span
                        className={cn("min-w-0 flex-1 break-words text-[13px] leading-snug text-phx-ink", item.unreadCount > 0 ? "font-black" : "font-bold")}
                        dir="auto"
                      >
                        {conversationTitle(item)}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-phx-ink-soft">{formatListTime(item.lastMessageAt)}</span>
                    </span>
                    <span className="flex w-full items-start gap-2">
                      <span className="min-w-0 flex-1 break-words text-[12px] leading-snug text-phx-ink-soft" dir="auto">
                        {item.lastDirection === "outbound" ? "You: " : ""}
                        {item.lastMessagePreview ?? ""}
                      </span>
                      {item.unreadCount > 0 ? <Tally active={active}>{item.unreadCount}</Tally> : null}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-phx-ink-faint">
                      {filters.line === "" && lines.length > 1 ? <span>{item.lineLabel}</span> : null}
                      {linked ? <span className="font-semibold text-phx-ink-2">{item.candidate ? "Candidate" : "Employee"}: {linked}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* ── The open chat, or the new-chat form ── */}
        <section className={cn("min-h-0 flex-col lg:flex", selectedId || composingNew ? "flex" : "hidden")}>
          {composingNew ? (
            <NewChatForm
              lines={lines}
              onCancel={() => setComposingNew(false)}
              onStarted={(conversationId) => {
                void loadList(filtersRef.current);
                openConversation(conversationId);
              }}
            />
          ) : selectedId && thread && thread.conversation.id === selectedId ? (
            <InboxThreadView onBack={closeConversation} onChanged={refreshAll} thread={thread} />
          ) : selectedId ? (
            <div className="flex flex-col gap-2 p-4 text-[12px]">
              <Action className="self-start lg:hidden" onClick={closeConversation} tone="ghost">
                Back to chats
              </Action>
              {threadError ? <p className="text-phx-danger">{threadError}</p> : null}
              {threadLoading ? <p className="text-phx-ink-soft">Opening the chat…</p> : null}
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px] text-phx-ink-soft">
              Choose a chat on the left, or start a new one.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function NewChatForm({
  lines,
  onCancel,
  onStarted,
}: {
  lines: InboxLineOption[];
  onCancel: () => void;
  onStarted: (conversationId: string) => void;
}) {
  const [line, setLine] = useState(lines[0]?.phoneNumberId ?? "");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(input: TemplateSendInput) {
    if (!phone.trim()) {
      setError("Type the number to message.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await postJson("/api/whatsapp-inbox/conversations", { ...input, line, phone: phone.trim() });
      if (typeof data.conversationId === "string") onStarted(data.conversationId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The chat was not started.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
      <div className="flex max-w-xl flex-col gap-3">
        <div>
          <p className="text-[15px] font-black text-phx-ink">Start a new chat</p>
          <p className="mt-0.5 text-[12px] leading-snug text-phx-ink-soft">
            WhatsApp only lets a business write first with an approved template. Once they reply, you can write freely for 24 hours.
          </p>
        </div>
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="font-bold text-phx-ink-2">Send from</span>
          <select
            className="w-full border border-phx-line bg-white px-2 py-1.5 text-[13px] text-phx-ink outline-none focus:border-phx-accent"
            disabled={busy}
            onChange={(event) => setLine(event.target.value)}
            value={line}
          >
            {lines.map((option) => (
              <option key={option.phoneNumberId} value={option.phoneNumberId}>
                {option.label} ({option.displayNumber})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="font-bold text-phx-ink-2">Their WhatsApp number</span>
          <input
            className="w-full border border-phx-line bg-white px-2 py-1.5 text-[13px] text-phx-ink outline-none focus:border-phx-accent"
            disabled={busy}
            inputMode="tel"
            onChange={(event) => setPhone(event.target.value)}
            placeholder="01012345678 or +20 10 1234 5678"
            value={phone}
          />
        </label>
        {line ? <InboxTemplateForm busy={busy} key={line} line={line} onCancel={onCancel} onSend={(input) => void start(input)} submitLabel="Start chat" /> : null}
        {error ? <p className="text-[12px] leading-snug text-phx-danger">{error}</p> : null}
      </div>
    </div>
  );
}
