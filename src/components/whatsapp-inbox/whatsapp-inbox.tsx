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

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Briefcase,
  FileText,
  Link2,
  Loader2,
  Mail,
  MailOpen,
  Map as MapIcon,
  MapPin,
  MessageCirclePlus,
  MessagesSquare,
  RefreshCw,
  Search,
  X,
} from "lucide-react";

import {
  adminPanelClassName,
  adminPanelHeaderClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { Action, Band, BandSays } from "@/components/recruitment/workstation/workstation-look";
import { getJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { candidateRegionCodes, candidateRegionLabels } from "@/lib/recruitment/candidate-region";
import { candidateRoleFamilies, candidateRoleFamilyLabels } from "@/lib/recruitment/candidate-role-family";
import { inboxPlaceText, inboxPositionHasArea, inboxPositionHasRegion } from "@/lib/whatsapp-inbox/position-filter";
import type { InboxConversationSummary, InboxThread } from "@/lib/whatsapp-inbox/store";
import { cn } from "@/lib/utils";

import { conversationTitle, formatListTime } from "./inbox-format";
import { InboxAvatar, InboxEmptyState, LineChip, LineMark, lineToneFor } from "./inbox-look";
import { InboxTemplateForm, type TemplateSendInput } from "./inbox-template-form";
import { InboxThreadView } from "./inbox-thread";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";

export type InboxLineOption = { phoneNumberId: string; label: string; displayNumber: string };

/** "" shows every chat; "unread" and "read" are the Read / Unread filter. */
type ReadFilter = "" | "unread" | "read";
type Filters = { line: string; search: string; readState: ReadFilter; position: string; region: string; area: string; limit: number };

/** Every job the candidate pool sorts people into, then the chats where nothing says which job. */
const POSITION_OPTIONS = [
  ...candidateRoleFamilies.map((family) => ({ label: candidateRoleFamilyLabels[family], value: family as string })),
  { label: "No position given", value: "none" },
];

const POLL_MS = 10_000;
/** One page of chats; "Show more chats" asks for the next one. Matches the server's default. */
const LIST_PAGE_SIZE = 150;

function listUrl(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.line) params.set("line", filters.line);
  if (filters.search) params.set("q", filters.search);
  if (filters.readState) params.set("state", filters.readState);
  if (filters.position) params.set("position", filters.position);
  if (filters.region) params.set("region", filters.region);
  if (filters.area) params.set("area", filters.area);
  if (filters.limit !== LIST_PAGE_SIZE) params.set("limit", String(filters.limit));
  const query = params.toString();
  return `/api/whatsapp-inbox/conversations${query ? `?${query}` : ""}`;
}

export function WhatsAppInbox({
  initialConversations,
  initialTotalCount,
  initialTotalUnread,
  lines,
}: {
  initialConversations: InboxConversationSummary[];
  initialTotalCount: number;
  initialTotalUnread: number;
  lines: InboxLineOption[];
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [totalCount, setTotalCount] = useState(initialTotalCount);
  const [totalUnread, setTotalUnread] = useState(initialTotalUnread);
  const [filters, setFilters] = useState<Filters>({
    area: "",
    limit: LIST_PAGE_SIZE,
    line: "",
    position: "",
    region: "",
    readState: "",
    search: "",
  });
  const [areaOptions, setAreaOptions] = useState<string[]>([]);
  const [searchDraft, setSearchDraft] = useState("");
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
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
      const rows = Array.isArray(data.conversations) ? (data.conversations as InboxConversationSummary[]) : [];
      setConversations(rows);
      setTotalCount(typeof data.totalCount === "number" ? data.totalCount : rows.length);
      setTotalUnread(typeof data.totalUnread === "number" ? data.totalUnread : 0);
      setAreaOptions(Array.isArray(data.areaOptions) ? data.areaOptions.filter((area): area is string => typeof area === "string") : []);
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

  // A new filter starts from the first page again; only "Show more chats" grows the list.
  function applyFilters(next: Omit<Filters, "limit">) {
    const withLimit = { ...next, limit: LIST_PAGE_SIZE };
    filtersRef.current = withLimit;
    setFilters(withLimit);
    void loadList(withLimit);
  }

  async function showMore() {
    const next = { ...filtersRef.current, limit: filtersRef.current.limit + LIST_PAGE_SIZE };
    filtersRef.current = next;
    setFilters(next);
    setLoadingMore(true);
    try {
      await loadList(next);
    } finally {
      setLoadingMore(false);
    }
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

  // Mark as read / Mark as unread, from a chat's row or the open chat. Marking the open chat unread
  // closes it — left open, the next refresh would read it again at once, as WhatsApp's own does.
  async function markChat(conversationId: string, read: boolean) {
    if (!read && selectedRef.current === conversationId) closeConversation();
    setListError(null);
    try {
      await postJson(`/api/whatsapp-inbox/conversations/${conversationId}/read`, read ? {} : { unread: true });
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Could not change whether the chat is read.");
    }
    await loadList(filtersRef.current);
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

  function startNewChat() {
    closeConversation();
    setComposingNew(true);
  }

  const filtered = Boolean(filters.search || filters.readState || filters.line || filters.position);

  // Height and floor are divided by the display scale: this frame sits inside <main>'s zoom, which
  // does not compensate viewport units, so a bare 100vh painted it at 80% of the window. See the
  // screening page's frame (workstation-page-client.tsx) and the display-scale block in globals.css.
  return (
    <div
      className={cn(
        "flex h-[calc((100vh_-_4rem)_/_var(--phx-scale-applied,1))] min-h-[calc(32rem_/_var(--phx-scale-applied,1))] flex-col",
        adminPanelClassName,
      )}
    >
      {/* ── The header: the admin shell's premium page header, in the inbox's own frame ── */}
      <header className="relative shrink-0 bg-[linear-gradient(180deg,#FFFFFF_0%,#FFFBF7_100%)]">
        <div className="relative px-3 pb-2.5 pt-3 sm:px-4">
          <span aria-hidden className={pageHeaderRailClassName} />
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2.5 pl-2">
            <div className="min-w-0">
              <span className={pageHeaderKickerClassName}>Recruitment · WhatsApp</span>
              <h1 className={cn(pageHeaderTitleClassName, "mt-1")}>WhatsApp Inbox</h1>
              <p className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] leading-5 text-slate-500">
                {lines.map((line) => (
                  <span className="inline-flex items-center gap-1.5" key={line.phoneNumberId}>
                    <LineMark tone={lineToneFor(line.label)} />
                    <span className="font-semibold text-slate-700">{line.label}</span>
                    <span className="tabular-nums" dir="ltr">
                      {line.displayNumber}
                    </span>
                  </span>
                ))}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <StatTile hot={totalUnread > 0} label="Unread" value={totalUnread} />
              <StatTile label={totalCount === 1 ? "Chat" : "Chats"} value={totalCount} />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 pl-2">
            <div
              aria-label="Which number"
              className="inline-flex flex-wrap border border-slate-200 bg-slate-100/80 p-0.5 shadow-[inset_0_1px_2px_rgba(15,23,42,0.07)]"
              role="group"
            >
              <Segment active={filters.line === ""} onClick={() => applyFilters({ ...filters, line: "" })}>
                Both numbers
              </Segment>
              {lines.map((line) => (
                <Segment
                  active={filters.line === line.phoneNumberId}
                  key={line.phoneNumberId}
                  onClick={() => applyFilters({ ...filters, line: line.phoneNumberId })}
                  title={line.displayNumber}
                >
                  <LineMark tone={lineToneFor(line.label)} />
                  {line.label}
                </Segment>
              ))}
            </div>
            <div
              aria-label="Read or unread"
              className="inline-flex flex-wrap border border-slate-200 bg-slate-100/80 p-0.5 shadow-[inset_0_1px_2px_rgba(15,23,42,0.07)]"
              role="group"
            >
              <Segment active={filters.readState === ""} onClick={() => applyFilters({ ...filters, readState: "" })}>
                All
              </Segment>
              <Segment active={filters.readState === "unread"} onClick={() => applyFilters({ ...filters, readState: "unread" })}>
                <span aria-hidden className="h-2 w-2 bg-orange-500" />
                Unread
              </Segment>
              <Segment active={filters.readState === "read"} onClick={() => applyFilters({ ...filters, readState: "read" })}>
                <span aria-hidden className="h-2 w-2 border border-slate-400 bg-white" />
                Read
              </Segment>
            </div>
            <FilterSelect
              active={Boolean(filters.position)}
              ariaLabel="Filter chats by the position applied for"
              icon={<Briefcase aria-hidden className="h-3.5 w-3.5 shrink-0" />}
              label="Position"
              onChange={(position) =>
                // A region only means something for a job hired by region, and an area for one hired by area.
                applyFilters({
                  ...filters,
                  area: inboxPositionHasArea(position) ? filters.area : "",
                  position,
                  region: inboxPositionHasRegion(position) ? filters.region : "",
                })
              }
              value={filters.position}
            >
              <option value="">All positions</option>
              {POSITION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </FilterSelect>
            {inboxPositionHasRegion(filters.position) ? (
              <FilterSelect
                active={Boolean(filters.region)}
                ariaLabel="Filter chats by the region applied for"
                icon={<MapIcon aria-hidden className="h-3.5 w-3.5 shrink-0" />}
                label="Region"
                onChange={(region) => applyFilters({ ...filters, area: "", region })}
                value={filters.region}
              >
                <option value="">All regions</option>
                {candidateRegionCodes.map((code) => (
                  <option key={code} value={code}>
                    {candidateRegionLabels[code]}
                  </option>
                ))}
              </FilterSelect>
            ) : null}
            {inboxPositionHasArea(filters.position) && filters.region ? (
              <FilterSelect
                active={Boolean(filters.area)}
                ariaLabel="Filter chats by the area applied for"
                icon={<MapPin aria-hidden className="h-3.5 w-3.5 shrink-0" />}
                label="Area"
                onChange={(area) => applyFilters({ ...filters, area })}
                value={filters.area}
              >
                <option value="">All areas</option>
                {(filters.area && !areaOptions.includes(filters.area) ? [filters.area, ...areaOptions] : areaOptions).map((area) => (
                  <option key={area} value={area}>
                    {area}
                  </option>
                ))}
              </FilterSelect>
            ) : null}
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <Action onClick={() => void refreshAll()} title="Check for new messages now" tone="ghost">
                <RefreshCw aria-hidden className="h-3.5 w-3.5" />
                Refresh
              </Action>
              <button className={newChatButtonClassName} onClick={startNewChat} type="button">
                <MessageCirclePlus aria-hidden className="h-3.5 w-3.5" />
                New chat
              </button>
            </div>
          </div>
        </div>
        <div aria-hidden className={pageHeaderRuleClassName} />
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(18rem,23rem)_minmax(0,1fr)]">
        {/* ── The chat list ── */}
        <aside
          className={cn(
            "min-h-0 flex-col bg-[linear-gradient(180deg,#FBFBFA_0%,#F7F6F3_100%)] lg:flex lg:border-r lg:border-slate-200",
            selectedId || composingNew ? "hidden" : "flex",
          )}
        >
          {/* The list's own title band — the house dark band every panel in the module wears — with how
              many chats it holds now, so a narrowed list says so before a row is read. */}
          <div
            className={cn(
              "flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 py-2 text-white",
              adminPanelHeaderClassName,
            )}
          >
            <span className="inline-flex items-center gap-2">
              <MessagesSquare aria-hidden className="h-3.5 w-3.5 text-orange-300" />
              <span className="text-[11px] font-black uppercase tracking-[0.14em]">Chats</span>
              <span className="border border-orange-400/40 bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-black tabular-nums text-orange-100">
                {conversations.length < totalCount ? `${conversations.length} of ${totalCount}` : totalCount}
              </span>
            </span>
            {filtered ? (
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300">Filtered</span>
            ) : null}
          </div>
          <form
            className="shrink-0 border-b border-slate-200 p-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              applyFilters({ ...filters, search: searchDraft.trim() });
            }}
          >
            <div className="flex items-center gap-2 border border-slate-200 bg-white px-2.5 shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)] focus-within:border-orange-300 focus-within:shadow-[inset_0_1px_2px_rgba(15,23,42,0.06),0_0_0_3px_rgba(249,115,22,0.12)]">
              <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <input
                aria-label="Search chats"
                className="min-w-0 flex-1 border-0 bg-transparent py-2 text-[13px] text-slate-900 outline-none placeholder:text-slate-400"
                dir="auto"
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Search by name or number"
                value={searchDraft}
              />
              {filters.search ? (
                <button
                  className="inline-flex shrink-0 items-center p-1 text-slate-400 hover:text-slate-800"
                  onClick={() => {
                    setSearchDraft("");
                    applyFilters({ ...filters, search: "" });
                  }}
                  title="Clear the search"
                  type="button"
                >
                  <X aria-hidden className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </form>

          {listError ? (
            <Band tone="warn">
              <BandSays>{listError}</BandSays>
            </Band>
          ) : null}

          <ul className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            {conversations.length === 0 ? (
              <li>
                <InboxEmptyState
                  body={
                    filtered
                      ? "Try another number, position, region or area, clear the search, or choose All instead of Read or Unread."
                      : "Messages appear here as soon as someone writes to either number."
                  }
                  compact
                  title={filtered ? "No chats match these filters" : "No chats yet"}
                />
              </li>
            ) : null}
            {conversations.map((item) => {
              const active = item.id === selectedId;
              const unread = item.unreadCount > 0;
              const title = conversationTitle(item);
              return (
                <li className="relative border-b border-slate-200/80" key={item.id}>
                  <button
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "relative flex w-full gap-3 px-3 py-2.5 text-left transition",
                      active
                        ? "bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_8px_20px_rgba(15,23,42,0.07)]"
                        : "hover:bg-white/80",
                    )}
                    onClick={() => openConversation(item.id)}
                    type="button"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "absolute inset-y-0 left-0 w-[3px]",
                        active ? "bg-[linear-gradient(180deg,#F97316_0%,#FB923C_60%,rgba(251,146,60,0.25)_100%)]" : "bg-transparent",
                      )}
                    />
                    <InboxAvatar name={item.contactName} tone={lineToneFor(item.lineLabel)} />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      {/* Room on the right for the Mark as read / unread button, which sits over this line. */}
                      <span className="flex w-full items-baseline gap-2 pr-7">
                        <span
                          className={cn(
                            "min-w-0 flex-1 break-words text-[13px] leading-snug tracking-[-0.005em]",
                            unread ? "font-black text-slate-950" : "font-bold text-slate-800",
                          )}
                          dir="auto"
                        >
                          {title}
                        </span>
                        <span className={cn("shrink-0 text-[11px] tabular-nums", unread ? "font-bold text-orange-600" : "text-slate-400")}>
                          {formatListTime(item.lastMessageAt)}
                        </span>
                      </span>
                      <span className="flex w-full items-start gap-2">
                        <span
                          className={cn("min-w-0 flex-1 break-words text-[12px] leading-snug", unread ? "text-slate-700" : "text-slate-500")}
                          dir="auto"
                        >
                          {item.lastDirection === "outbound" ? <span className="font-semibold text-slate-400">You: </span> : null}
                          {item.lastMessagePreview ?? ""}
                        </span>
                        {unread ? (
                          <span className="min-w-[1.375rem] shrink-0 bg-[linear-gradient(135deg,#FB923C_0%,#EA580C_100%)] px-1.5 py-[3px] text-center text-[11px] font-black leading-none tabular-nums text-white shadow-[0_1px_2px_rgba(234,88,12,0.35),0_3px_8px_rgba(249,115,22,0.28)]">
                            {item.unreadCount}
                          </span>
                        ) : null}
                      </span>
                      {(filters.line === "" && lines.length > 1) || item.candidate || item.employee || item.positions.length > 0 || item.cv ? (
                        // Room on the right for the Open CV button, which sits over this row outside the button.
                        <span className={cn("flex min-h-[1.375rem] flex-wrap items-center gap-1.5", item.cv && "pr-[5.25rem]")}>
                          {filters.line === "" && lines.length > 1 ? <LineChip label={item.lineLabel} /> : null}
                          {item.positions.map((position) => {
                            const place = inboxPlaceText(position);
                            return (
                              <span className="contents" key={`${position.family}|${place}`}>
                                <span className="inline-flex max-w-full items-center gap-1 border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-bold leading-tight text-slate-700 shadow-[0_1px_1px_rgba(15,23,42,0.04)]">
                                  <Briefcase aria-hidden className="h-3 w-3 shrink-0 text-slate-400" />
                                  <span className="break-words">{position.label}</span>
                                </span>
                                {place ? (
                                  <span className="inline-flex max-w-full items-center gap-1 border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold leading-tight text-sky-800 shadow-[0_1px_1px_rgba(15,23,42,0.04)]">
                                    <MapPin aria-hidden className="h-3 w-3 shrink-0 text-sky-500" />
                                    <span className="break-words" dir="auto">
                                      {place}
                                    </span>
                                  </span>
                                ) : null}
                              </span>
                            );
                          })}
                          {item.candidate || item.employee ? (
                            <span className="inline-flex max-w-full items-center gap-1 border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[10px] font-bold leading-none text-orange-800">
                              <Link2 aria-hidden className="h-3 w-3 shrink-0" />
                              <span className="break-words">
                                {item.candidate ? "Candidate" : "Employee"}: {item.candidate?.name ?? item.employee?.name}
                              </span>
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <button
                    aria-label={unread ? `Mark the chat with ${title} as read` : `Mark the chat with ${title} as unread`}
                    className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center border border-transparent text-slate-400 transition hover:border-slate-300 hover:bg-white hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60"
                    onClick={() => void markChat(item.id, unread)}
                    title={unread ? "Mark as read" : "Mark as unread"}
                    type="button"
                  >
                    {unread ? <MailOpen aria-hidden className="h-3.5 w-3.5" /> : <Mail aria-hidden className="h-3.5 w-3.5" />}
                  </button>
                  {item.cv ? (
                    // A link, so it cannot live inside the row's button; it opens the CV in a new tab and
                    // leaves the chat list exactly where it was.
                    <a
                      className="absolute bottom-2.5 right-3 inline-flex items-center gap-1 border border-orange-300 bg-[linear-gradient(180deg,#FFFFFF_0%,#FFF7ED_100%)] px-2 py-1 text-[11px] font-black leading-none text-orange-700 shadow-[0_1px_2px_rgba(249,115,22,0.14),0_4px_10px_rgba(249,115,22,0.12)] transition hover:border-orange-400 hover:text-orange-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60"
                      href={`/api/whatsapp-inbox/media/${encodeURIComponent(item.cv.messageId)}`}
                      rel="noreferrer"
                      target="_blank"
                      title={
                        item.cv.count > 1
                          ? `Open the newest of ${item.cv.count} files ${title} sent${item.cv.fileName ? `: ${item.cv.fileName}` : ""}`
                          : `Open the CV ${title} sent${item.cv.fileName ? `: ${item.cv.fileName}` : ""}`
                      }
                    >
                      <FileText aria-hidden className="h-3.5 w-3.5 shrink-0" />
                      Open CV
                    </a>
                  ) : null}
                </li>
              );
            })}
            {conversations.length > 0 && conversations.length < totalCount ? (
              <li className="flex flex-col items-center gap-2 px-3 py-4">
                <p className="text-center text-[12px] leading-snug text-slate-500">
                  Showing the newest {conversations.length} of {totalCount} chats. Older chats are also found by search.
                </p>
                <Action disabled={loadingMore} onClick={() => void showMore()} tone="quiet">
                  {loadingMore ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : null}
                  {loadingMore ? "Loading…" : `Show ${Math.min(LIST_PAGE_SIZE, totalCount - conversations.length)} more chats`}
                </Action>
              </li>
            ) : null}
          </ul>
        </aside>

        {/* ── The open chat, or the new-chat form ── */}
        <section className={cn("min-h-0 flex-col bg-white lg:flex", selectedId || composingNew ? "flex" : "hidden")}>
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
            <InboxThreadView
              onBack={closeConversation}
              onChanged={refreshAll}
              onMarkUnread={() => void markChat(thread.conversation.id, false)}
              thread={thread}
            />
          ) : selectedId ? (
            <div className="flex flex-1 flex-col gap-3 p-4 text-[12px]">
              <Action className="self-start lg:hidden" onClick={closeConversation} tone="ghost">
                Back to chats
              </Action>
              {threadError ? (
                <Band tone="warn">
                  <BandSays>{threadError}</BandSays>
                </Band>
              ) : null}
              {threadLoading ? (
                <p className="flex flex-1 items-center justify-center gap-2 text-[13px] text-slate-500">
                  <Loader2 aria-hidden className="h-4 w-4 animate-spin text-orange-500" />
                  Opening the chat…
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-1 flex-col bg-[linear-gradient(180deg,#FFFFFF_0%,#FAF8F5_100%)]">
              <InboxEmptyState
                action={
                  <button className={newChatButtonClassName} onClick={startNewChat} type="button">
                    <MessageCirclePlus aria-hidden className="h-3.5 w-3.5" />
                    New chat
                  </button>
                }
                body="Choose a chat on the left to read it and reply, or start a new one with an approved template."
                title="Pick a conversation"
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** The one orange action on the screen: square, a gradient face and an orange glow under it. */
const newChatButtonClassName =
  "inline-flex shrink-0 items-center gap-1.5 border border-orange-600 bg-[linear-gradient(180deg,#FB923C_0%,#F97316_55%,#EA580C_100%)] px-3 py-1.5 text-[12px] font-bold leading-none text-white shadow-[0_1px_2px_rgba(194,65,12,0.35),0_8px_18px_rgba(249,115,22,0.28)] transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60";

function StatTile({ hot = false, label, value }: { hot?: boolean; label: string; value: number }) {
  return (
    <span
      className={cn(
        "flex min-w-[5rem] flex-col gap-1 border px-3 py-2",
        hot
          ? "border-orange-200 bg-[linear-gradient(160deg,#FFF7ED_0%,#FFEDD5_100%)] shadow-[0_1px_2px_rgba(249,115,22,0.10),0_8px_20px_rgba(249,115,22,0.14)]"
          : "border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05),0_8px_20px_rgba(15,23,42,0.05)]",
      )}
    >
      <span className={cn("text-[10px] font-black uppercase leading-none tracking-[0.18em]", hot ? "text-orange-700" : "text-slate-400")}>
        {label}
      </span>
      <span className={cn("text-[20px] font-black leading-none tabular-nums tracking-[-0.02em]", hot ? "text-orange-600" : "text-slate-900")}>
        {value}
      </span>
    </span>
  );
}

/** One filter menu in the header: an icon, its name, and the choice — orange while it narrows the list. */
function FilterSelect({
  active,
  ariaLabel,
  children,
  icon,
  label,
  onChange,
  value,
}: {
  active: boolean;
  ariaLabel: string;
  children: React.ReactNode;
  icon: React.ReactNode;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 border py-0.5 pl-2.5 pr-1 text-[12px] font-bold leading-none transition",
        active
          ? "border-orange-300 bg-orange-50 text-orange-700 shadow-[0_1px_2px_rgba(249,115,22,0.12),0_4px_12px_rgba(249,115,22,0.12)]"
          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
      )}
    >
      {icon}
      <span className="shrink-0">{label}</span>
      <select
        aria-label={ariaLabel}
        className="min-w-0 max-w-full cursor-pointer border-0 bg-transparent py-1 pr-1 text-[12px] font-bold text-slate-900 outline-none"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {children}
      </select>
    </label>
  );
}

function Segment({
  active,
  children,
  onClick,
  title,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-bold leading-none transition",
        active
          ? "bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.12),0_4px_10px_rgba(15,23,42,0.07)]"
          : "text-slate-500 hover:text-slate-900",
      )}
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
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
    <div className="min-h-0 flex-1 overflow-y-auto bg-[linear-gradient(180deg,#FFFFFF_0%,#FAF8F5_100%)] p-3 sm:p-5">
      <div className="flex max-w-xl flex-col gap-3.5 border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.05),0_12px_28px_rgba(15,23,42,0.055)] sm:p-5">
        <div className="relative pl-3">
          <span aria-hidden className="absolute inset-y-0.5 left-0 w-[3px] bg-[linear-gradient(180deg,#F97316_0%,#FB923C_55%,rgba(251,146,60,0.15)_100%)]" />
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-orange-600">New conversation</p>
          <p className="mt-1 text-[16px] font-black tracking-[-0.015em] text-slate-900">Start a new chat</p>
          <p className="mt-1 text-[12px] leading-5 text-slate-500">
            WhatsApp only lets a business write first with an approved template. Once they reply, you can write freely for 24 hours.
          </p>
        </div>
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="font-bold text-slate-700">Send from</span>
          <select
            className={phxSelectClassName}
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
          <span className="font-bold text-slate-700">Their WhatsApp number</span>
          <input
            className={phxFieldClassName}
            disabled={busy}
            inputMode="tel"
            onChange={(event) => setPhone(event.target.value)}
            placeholder="01012345678 or +20 10 1234 5678"
            value={phone}
          />
        </label>
        {line ? <InboxTemplateForm busy={busy} key={line} line={line} onCancel={onCancel} onSend={(input) => void start(input)} submitLabel="Start chat" /> : null}
        {error ? (
          <Band tone="warn">
            <BandSays>{error}</BandSays>
          </Band>
        ) : null}
      </div>
    </div>
  );
}
