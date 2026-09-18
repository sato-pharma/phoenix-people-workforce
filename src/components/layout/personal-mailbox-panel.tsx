"use client";

// "My email" — the envelope's second tab. Each person connects their OWN company mailbox once, with
// an app password they create in Turbify, and then reads and sends their company email here. Every
// request goes to /api/messages/mailbox/**, which works out whose mailbox it is from the session
// alone — there is nothing on this screen (or in any request it makes) that names a mailbox.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  KeyRound,
  Loader2,
  Paperclip,
  RefreshCw,
  Reply,
  ReplyAll,
  Send,
  ShieldCheck,
  SquarePen,
  Unplug,
  X,
} from "lucide-react";

import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import {
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENTS,
  quoteForReply,
  readerDocument,
  replyRecipients,
  replyReferences,
  replySubject,
} from "@/lib/personal-mailbox/rules";
import type {
  PersonalMailboxFolder,
  PersonalMailboxMessage,
  PersonalMailboxPage,
  PersonalMailboxState,
  PersonalMailboxSummary,
} from "@/lib/personal-mailbox/types";
import { cn } from "@/lib/utils";

/** What the person names the app password in Turbify — distinct from the monitor's `imap` entry, so
 *  deleting one can never be mistaken for the other. */
const APP_PASSWORD_NAME = "Phoenix email";

type Draft = {
  to: string;
  cc: string;
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: string[];
  files: File[];
};

type View =
  | { kind: "list" }
  | { kind: "read"; uid: number }
  | { kind: "compose"; draft: Draft; back: { kind: "list" } | { kind: "read"; uid: number } };

const emptyDraft: Draft = { body: "", cc: "", files: [], inReplyTo: null, references: [], subject: "", to: "" };

class RequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { message?: unknown };
  if (!response.ok) {
    const message = typeof payload.message === "string" && payload.message ? payload.message : fallback;
    throw new RequestError(message, response.status);
  }
  return payload;
}

const shortTime = stableEnGbFormatter({
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
});
const fullTime = stableEnGbFormatter({
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "long",
  timeZone: "Africa/Cairo",
  weekday: "short",
  year: "numeric",
});

function formatTime(iso: string | null, format: { format(value: Date): string }): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : format.format(date);
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function palette(isAdminMode: boolean) {
  return {
    border: isAdminMode ? "border-[#333333]" : "border-phx-line",
    divider: isAdminMode ? "divide-[#1f2937]" : "divide-phx-line",
    body: isAdminMode ? "text-phx-line-strong" : "text-phx-ink-2",
    ghost: isAdminMode ? "text-[#D4DDE8] hover:bg-[#111111]" : "text-phx-ink-2 hover:bg-phx-paper",
    heading: isAdminMode ? "text-white" : "text-phx-ink",
    input: isAdminMode
      ? "border-[#333333] bg-[#0B0B0B] text-white focus:border-phx-accent"
      : "border-phx-line bg-white text-phx-ink focus:border-phx-accent-line",
    label: isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft",
    muted: isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft",
    rowHover: isAdminMode ? "hover:bg-[#0B0B0B]" : "hover:bg-phx-paper",
    tabOff: isAdminMode ? "text-phx-ink-faint hover:bg-[#111111]" : "text-phx-ink-soft hover:bg-phx-paper",
  };
}

type Palette = ReturnType<typeof palette>;

function Notice({ tone, children }: { tone: "error" | "success"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "border px-3 py-2 text-xs font-bold break-words",
        tone === "error" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-emerald-200 bg-emerald-50 text-emerald-700",
      )}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

export function PersonalMailboxPanel({ isAdminMode }: { isAdminMode: boolean }) {
  const colors = palette(isAdminMode);
  const [state, setState] = useState<PersonalMailboxState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);

  // `setState` is listed although React keeps it stable: it is also handed to the child cards below,
  // which makes the React Compiler infer it as a dependency (react-hooks/preserve-manual-memoization).
  const loadState = useCallback(async () => {
    setStateError(null);
    try {
      const response = await fetch("/api/messages/mailbox", { headers: { Accept: "application/json" } });
      const next = await readJson<PersonalMailboxState>(response, "Could not load your email.");
      setState(next);
    } catch (error) {
      setStateError(error instanceof Error ? error.message : "Could not load your email.");
    }
  }, [setState]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void loadState(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadState]);

  // Stable on purpose: the mailbox view reloads its folder whenever this changes identity, and every
  // reload is a real login on the person's mailbox.
  const handleNeedsReconnect = useCallback(() => void loadState(), [loadState]);

  if (stateError) {
    return (
      <div className="space-y-3 p-4">
        <Notice tone="error">{stateError}</Notice>
        <button
          className={cn("inline-flex h-9 items-center gap-2 border px-3 text-xs font-black", colors.border, colors.ghost)}
          onClick={() => void loadState()}
          type="button"
        >
          <RefreshCw className="h-4 w-4" /> Try again
        </button>
      </div>
    );
  }

  if (!state) {
    return (
      <div className={cn("flex items-center gap-2 px-4 py-8 text-sm", colors.muted)}>
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your email...
      </div>
    );
  }

  if (!state.connected) {
    return <ConnectCard colors={colors} emailAddress={state.emailAddress} onConnected={setState} reconnect={false} />;
  }

  if (state.status === "needs_reconnect") {
    return (
      <div>
        <div className="px-4 pt-4">
          <Notice tone="error">{state.lastError ?? "Turbify refused your saved app password."}</Notice>
        </div>
        <ConnectCard colors={colors} emailAddress={state.emailAddress} onConnected={setState} reconnect />
        <div className={cn("border-t px-4 py-3", colors.border)}>
          <DisconnectButton colors={colors} onDisconnected={setState} />
        </div>
      </div>
    );
  }

  return (
    <Mailbox
      colors={colors}
      emailAddress={state.emailAddress}
      onDisconnected={setState}
      onNeedsReconnect={handleNeedsReconnect}
    />
  );
}

function ConnectCard({
  colors,
  emailAddress,
  onConnected,
  reconnect,
}: {
  colors: Palette;
  emailAddress: string | null;
  onConnected: (state: PersonalMailboxState) => void;
  reconnect: boolean;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!emailAddress) {
    return (
      <div className="p-4">
        <p className={cn("text-sm font-black", colors.heading)}>My email</p>
        <p className={cn("mt-2 text-sm", colors.body)}>
          HR has no company email on file for you, so there is nothing to connect yet. Ask HR to add it.
        </p>
      </div>
    );
  }

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/messages/mailbox", {
        body: JSON.stringify({ appPassword: password }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const next = await readJson<PersonalMailboxState>(response, "Could not connect your email.");
      setPassword("");
      onConnected(next);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Could not connect your email.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 p-4">
      <div>
        <p className={cn("text-sm font-black", colors.heading)}>{reconnect ? "Reconnect your email" : "Connect your email"}</p>
        <p className={cn("mt-1 text-xs leading-5", colors.muted)}>
          Read and send your company email right here, as{" "}
          <span className={cn("font-black break-all", colors.heading)} dir="ltr">
            {emailAddress}
          </span>
          . You do this once.
        </p>
      </div>

      <ol className={cn("space-y-2 text-xs leading-5", colors.body)}>
        <li>
          <span className="font-black">1.</span> Open your company email in the browser, where you normally read it.
        </li>
        <li>
          <span className="font-black">2.</span> Go to your account&apos;s security settings and open{" "}
          <span className="font-black">Manage app passwords</span>.
        </li>
        <li>
          <span className="font-black">3.</span> Create an app password named{" "}
          <code className={cn("border px-1.5 py-0.5 font-black", colors.border, colors.heading)}>{APP_PASSWORD_NAME}</code>{" "}
          and copy it.
        </li>
        <li>
          <span className="font-black">4.</span> Paste it below and press Connect. Spaces do not matter.
        </li>
      </ol>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && password.trim()) void connect();
        }}
      >
        <label className="block">
          <span className={cn("mb-1 block text-phx-2xs font-black uppercase tracking-[0.12em]", colors.label)}>App password</span>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-faint" />
            <input
              // "new-password", not "off": browsers ignore "off" on a password field and would offer
              // to save this against the person's Phoenix login.
              autoComplete="new-password"
              className={cn("h-10 w-full border pl-9 pr-3 text-sm font-semibold outline-none", colors.input)}
              dir="ltr"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="abcd efgh ijkl mnop"
              type="password"
              value={password}
            />
          </div>
        </label>
        <button
          className="inline-flex h-10 w-full items-center justify-center bg-phx-accent px-4 text-sm font-black text-white transition hover:bg-phx-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          disabled={busy || !password.trim()}
          type="submit"
        >
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {busy ? "Checking with Turbify..." : "Connect"}
        </button>
      </form>

      <p className={cn("flex items-start gap-2 text-xs leading-5", colors.muted)}>
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        <span>
          Private to you. No screen in Phoenix lets anyone else open this mailbox. Your normal email password is never
          asked for, and you can disconnect at any time.
        </span>
      </p>
    </div>
  );
}

function DisconnectButton({
  colors,
  onDisconnected,
}: {
  colors: Palette;
  onDisconnected: (state: PersonalMailboxState) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/messages/mailbox", { method: "DELETE" });
      onDisconnected(await readJson<PersonalMailboxState>(response, "Could not disconnect your email."));
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : "Could not disconnect your email.");
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button
        className={cn("inline-flex h-8 items-center gap-1.5 px-2 text-xs font-bold", colors.ghost)}
        onClick={() => setConfirming(true)}
        type="button"
      >
        <Unplug className="h-3.5 w-3.5" /> Disconnect
      </button>
    );
  }

  return (
    <div className="space-y-2">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className={cn("text-xs leading-5", colors.body)}>
        Disconnect this mailbox from Phoenix? To cut it off completely, also delete the{" "}
        <span className="font-black">{APP_PASSWORD_NAME}</span> app password in Turbify.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          className="inline-flex h-8 items-center gap-1.5 bg-rose-600 px-3 text-xs font-black text-white hover:bg-rose-700 disabled:opacity-60"
          disabled={busy}
          onClick={() => void disconnect()}
          type="button"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unplug className="h-3.5 w-3.5" />} Disconnect
        </button>
        <button
          className={cn("inline-flex h-8 items-center px-3 text-xs font-bold", colors.ghost)}
          disabled={busy}
          onClick={() => setConfirming(false)}
          type="button"
        >
          Keep it
        </button>
      </div>
    </div>
  );
}

function Mailbox({
  colors,
  emailAddress,
  onDisconnected,
  onNeedsReconnect,
}: {
  colors: Palette;
  emailAddress: string;
  onDisconnected: (state: PersonalMailboxState) => void;
  onNeedsReconnect: () => void;
}) {
  const [folder, setFolder] = useState<PersonalMailboxFolder>("inbox");
  const [messages, setMessages] = useState<PersonalMailboxSummary[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });

  const fail = useCallback(
    (failure: unknown, fallback: string) => {
      if (failure instanceof RequestError && failure.status === 409) {
        onNeedsReconnect();
        return;
      }
      setError(failure instanceof Error ? failure.message : fallback);
    },
    [onNeedsReconnect],
  );

  const loadFolder = useCallback(
    async (target: PersonalMailboxFolder, before: number | null) => {
      setLoading(true);
      setError(null);
      try {
        const query = new URLSearchParams({ folder: target });
        if (before !== null) query.set("before", String(before));
        const response = await fetch(`/api/messages/mailbox/messages?${query.toString()}`, {
          headers: { Accept: "application/json" },
        });
        const page = await readJson<PersonalMailboxPage>(response, "Could not load your email.");
        setMessages((current) => (before === null ? page.messages : [...current, ...page.messages]));
        setNextBefore(page.nextBefore);
        setLoaded(true);
      } catch (loadError) {
        fail(loadError, "Could not load your email.");
      } finally {
        setLoading(false);
      }
    },
    [fail],
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void loadFolder(folder, null), 0);
    return () => window.clearTimeout(timeoutId);
  }, [folder, loadFolder]);

  function switchFolder(target: PersonalMailboxFolder) {
    if (target === folder) return;
    setMessages([]);
    setNextBefore(null);
    setLoaded(false);
    setNotice(null);
    setView({ kind: "list" });
    setFolder(target);
  }

  function startReply(message: PersonalMailboxMessage, all: boolean) {
    const { cc, to } = replyRecipients(message, emailAddress, all);
    setNotice(null);
    setView({
      back: { kind: "read", uid: message.uid },
      draft: {
        body: quoteForReply(message),
        cc: cc.join(", "),
        files: [],
        inReplyTo: message.messageId,
        references: replyReferences(message),
        subject: replySubject(message.subject),
        to: to.join(", "),
      },
      kind: "compose",
    });
  }

  return (
    <div>
      <div className={cn("flex flex-wrap items-center gap-2 border-b px-3 py-2", colors.border)}>
        <div className="flex flex-wrap gap-1">
          {(["inbox", "sent"] as const).map((target) => (
            <button
              className={cn(
                "h-8 px-3 text-phx-2xs font-black uppercase tracking-[0.12em]",
                folder === target ? "bg-phx-accent-soft text-phx-accent-press" : colors.tabOff,
              )}
              key={target}
              onClick={() => switchFolder(target)}
              type="button"
            >
              {target === "inbox" ? "Inbox" : "Sent"}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <button
            className="inline-flex h-8 items-center gap-1.5 bg-phx-accent px-3 text-xs font-black text-white hover:bg-phx-accent-hover"
            onClick={() => {
              setNotice(null);
              setView({ back: { kind: "list" }, draft: emptyDraft, kind: "compose" });
            }}
            type="button"
          >
            <SquarePen className="h-3.5 w-3.5" /> New email
          </button>
          <button
            aria-label="Refresh"
            className={cn("flex h-8 w-8 items-center justify-center", colors.ghost)}
            onClick={() => {
              setNotice(null);
              setView({ kind: "list" });
              void loadFolder(folder, null);
            }}
            type="button"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <div className="max-h-[540px] overflow-y-auto">
        {error ? (
          <div className="px-3 pt-3">
            <Notice tone="error">{error}</Notice>
          </div>
        ) : null}
        {notice ? (
          <div className="px-3 pt-3">
            <Notice tone="success">{notice}</Notice>
          </div>
        ) : null}

        {view.kind === "list" ? (
          <MessageList
            colors={colors}
            folder={folder}
            loaded={loaded}
            loading={loading}
            messages={messages}
            nextBefore={nextBefore}
            onLoadOlder={() => void loadFolder(folder, nextBefore)}
            onOpen={(uid) => {
              setNotice(null);
              setView({ kind: "read", uid });
            }}
          />
        ) : null}

        {view.kind === "read" ? (
          <Reader
            colors={colors}
            folder={folder}
            key={`${folder}:${view.uid}`}
            onBack={() => setView({ kind: "list" })}
            onFailure={fail}
            onOpened={(uid) =>
              setMessages((current) => current.map((row) => (row.uid === uid ? { ...row, seen: true } : row)))
            }
            onReply={startReply}
            uid={view.uid}
          />
        ) : null}

        {view.kind === "compose" ? (
          <Composer
            colors={colors}
            draft={view.draft}
            fromAddress={emailAddress}
            onCancel={() => setView(view.back)}
            onFailure={fail}
            onSent={(message) => {
              setNotice(message);
              setView({ kind: "list" });
              if (folder === "sent") void loadFolder("sent", null);
            }}
          />
        ) : null}
      </div>

      <div className={cn("flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2", colors.border)}>
        <p className={cn("min-w-0 text-xs break-all", colors.muted)} dir="ltr">
          {emailAddress}
        </p>
        <DisconnectButton colors={colors} onDisconnected={onDisconnected} />
      </div>
    </div>
  );
}

function MessageList({
  colors,
  folder,
  loaded,
  loading,
  messages,
  nextBefore,
  onLoadOlder,
  onOpen,
}: {
  colors: Palette;
  folder: PersonalMailboxFolder;
  loaded: boolean;
  loading: boolean;
  messages: PersonalMailboxSummary[];
  nextBefore: number | null;
  onLoadOlder: () => void;
  onOpen: (uid: number) => void;
}) {
  if (messages.length === 0) {
    return (
      <div className={cn("px-4 py-8 text-center text-sm", colors.muted)}>
        {loading || !loaded ? "Loading your email..." : folder === "inbox" ? "Your inbox is empty." : "Nothing in Sent yet."}
      </div>
    );
  }

  return (
    <div>
      <ul className={cn("divide-y", colors.divider)}>
        {messages.map((message) => {
          const who =
            folder === "inbox"
              ? message.fromName || message.fromAddress || "Unknown sender"
              : `To ${message.toAddresses.join(", ") || "no one"}`;
          return (
            <li key={message.uid}>
              <button className={cn("block w-full px-3 py-2.5 text-left", colors.rowHover)} onClick={() => onOpen(message.uid)} type="button">
                <div className="flex items-start gap-2">
                  <span
                    aria-label={message.seen ? undefined : "Unread"}
                    className={cn("mt-1.5 h-2 w-2 shrink-0", message.seen ? "bg-transparent" : "bg-phx-accent")}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                      <p className={cn("min-w-0 break-words text-sm", message.seen ? "font-semibold" : "font-black", colors.heading)} dir="auto">
                        {who}
                      </p>
                      <span className={cn("text-phx-xs", colors.muted)}>{formatTime(message.date, shortTime)}</span>
                    </div>
                    <p className={cn("mt-0.5 break-words text-xs", message.seen ? colors.body : colors.heading)} dir="auto">
                      {message.hasAttachments ? <Paperclip className="mr-1 inline h-3 w-3 align-[-1px]" /> : null}
                      {message.subject || "(no subject)"}
                    </p>
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      {nextBefore !== null ? (
        <div className="p-3">
          <button
            className={cn("inline-flex h-9 w-full items-center justify-center gap-2 border text-xs font-black", colors.border, colors.ghost)}
            disabled={loading}
            onClick={onLoadOlder}
            type="button"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Load older emails
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Reader({
  colors,
  folder,
  onBack,
  onFailure,
  onOpened,
  onReply,
  uid,
}: {
  colors: Palette;
  folder: PersonalMailboxFolder;
  onBack: () => void;
  onFailure: (failure: unknown, fallback: string) => void;
  onOpened: (uid: number) => void;
  onReply: (message: PersonalMailboxMessage, all: boolean) => void;
  uid: number;
}) {
  const [message, setMessage] = useState<PersonalMailboxMessage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const timeoutId = window.setTimeout(async () => {
      try {
        const query = new URLSearchParams({ folder, uid: String(uid) });
        const response = await fetch(`/api/messages/mailbox/message?${query.toString()}`, {
          headers: { Accept: "application/json" },
        });
        const opened = await readJson<PersonalMailboxMessage>(response, "Could not open that email.");
        if (!active) return;
        setMessage(opened);
        onOpened(uid);
      } catch (openError) {
        if (!active) return;
        setFailed(true);
        onFailure(openError, "Could not open that email.");
      }
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
    // onOpened/onFailure are stable enough for this one-shot load; re-running on their identity
    // would re-open (and re-log-in) on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, uid]);

  const backButton = (
    <button className={cn("inline-flex h-8 items-center gap-1.5 px-2 text-xs font-bold", colors.ghost)} onClick={onBack} type="button">
      <ArrowLeft className="h-3.5 w-3.5" /> Back
    </button>
  );

  if (!message) {
    return (
      <div className="p-3">
        {backButton}
        {failed ? null : (
          <div className={cn("flex items-center gap-2 px-1 py-6 text-sm", colors.muted)}>
            <Loader2 className="h-4 w-4 animate-spin" /> Opening...
          </div>
        )}
      </div>
    );
  }

  const from = message.fromName && message.fromAddress ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress ?? message.fromName ?? "";

  return (
    <article className="space-y-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {backButton}
        <div className="flex flex-wrap gap-1">
          <button
            className={cn("inline-flex h-8 items-center gap-1.5 border px-3 text-xs font-black", colors.border, colors.ghost)}
            onClick={() => onReply(message, false)}
            type="button"
          >
            <Reply className="h-3.5 w-3.5" /> Reply
          </button>
          <button
            className={cn("inline-flex h-8 items-center gap-1.5 border px-3 text-xs font-black", colors.border, colors.ghost)}
            onClick={() => onReply(message, true)}
            type="button"
          >
            <ReplyAll className="h-3.5 w-3.5" /> Reply all
          </button>
        </div>
      </div>

      <div>
        <h3 className={cn("break-words text-base font-black", colors.heading)} dir="auto">
          {message.subject || "(no subject)"}
        </h3>
        <dl className={cn("mt-2 space-y-0.5 text-xs", colors.body)}>
          <div className="flex gap-2">
            <dt className={cn("w-10 shrink-0 font-black", colors.muted)}>From</dt>
            <dd className="min-w-0 break-words" dir="auto">{from}</dd>
          </div>
          <div className="flex gap-2">
            <dt className={cn("w-10 shrink-0 font-black", colors.muted)}>To</dt>
            <dd className="min-w-0 break-all">{message.toAddresses.join(", ")}</dd>
          </div>
          {message.ccAddresses.length > 0 ? (
            <div className="flex gap-2">
              <dt className={cn("w-10 shrink-0 font-black", colors.muted)}>Cc</dt>
              <dd className="min-w-0 break-all">{message.ccAddresses.join(", ")}</dd>
            </div>
          ) : null}
          <div className="flex gap-2">
            <dt className={cn("w-10 shrink-0 font-black", colors.muted)}>Date</dt>
            <dd className="min-w-0">{formatTime(message.date, fullTime)}</dd>
          </div>
        </dl>
      </div>

      {message.attachments.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {message.attachments.map((attachment) => {
            const query = new URLSearchParams({ folder, index: String(attachment.index), uid: String(message.uid) });
            return (
              <li className="min-w-0 max-w-full" key={attachment.index}>
                <a
                  className={cn("inline-flex max-w-full items-start gap-1.5 border px-2.5 py-1.5 text-xs font-bold", colors.border, colors.ghost)}
                  download
                  href={`/api/messages/mailbox/attachment?${query.toString()}`}
                >
                  <Paperclip className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-all" dir="auto">
                    {attachment.filename || "attachment"}
                    {attachment.sizeBytes !== null ? <span className={cn("ml-1 font-semibold", colors.muted)}>{formatSize(attachment.sizeBytes)}</span> : null}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}

      {message.html ? (
        // No allow-scripts and no allow-same-origin: nothing in a received email can run, or reach
        // Phoenix or the person's session. allow-popups lets a clicked link open in a new tab.
        <iframe
          className={cn("h-[420px] w-full border bg-white", colors.border)}
          referrerPolicy="no-referrer"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={readerDocument(message.html)}
          title={message.subject || "Email"}
        />
      ) : (
        <div className={cn("whitespace-pre-wrap break-words border p-3 text-sm leading-6", colors.border, colors.body)} dir="auto">
          {message.text?.trim() || "(This email has no text.)"}
        </div>
      )}
    </article>
  );
}

function Composer({
  colors,
  draft: initial,
  fromAddress,
  onCancel,
  onFailure,
  onSent,
}: {
  colors: Palette;
  draft: Draft;
  fromAddress: string;
  onCancel: () => void;
  onFailure: (failure: unknown, fallback: string) => void;
  onSent: (message: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalBytes = draft.files.reduce((sum, file) => sum + file.size, 0);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const added = Array.from(list);
    setDraft((current) => ({ ...current, files: [...current.files, ...added] }));
  }

  async function send() {
    setError(null);
    if (!draft.to.trim()) {
      setError("Add at least one address in To.");
      return;
    }
    if (draft.files.length > MAX_ATTACHMENTS) {
      setError(`Attach at most ${MAX_ATTACHMENTS} files.`);
      return;
    }
    if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
      setError("The attachments are over 15 MB together.");
      return;
    }
    setSending(true);
    try {
      const form = new FormData();
      form.set("to", draft.to);
      form.set("cc", draft.cc);
      form.set("subject", draft.subject);
      form.set("body", draft.body);
      if (draft.inReplyTo) form.set("inReplyTo", draft.inReplyTo);
      if (draft.references.length > 0) form.set("references", draft.references.join(" "));
      for (const file of draft.files) form.append("files", file, file.name);
      const response = await fetch("/api/messages/mailbox/send", { body: form, method: "POST" });
      const result = await readJson<{ rejected: string[]; filedInSent: boolean }>(response, "The email was not sent.");
      const parts = [`Sent from ${fromAddress}.`];
      if (result.rejected.length > 0) parts.push(`The mail server refused: ${result.rejected.join(", ")}.`);
      if (!result.filedInSent) parts.push("A copy could not be saved in your Sent folder.");
      onSent(parts.join(" "));
    } catch (sendError) {
      if (sendError instanceof RequestError && sendError.status === 409) {
        onFailure(sendError, "The email was not sent.");
        return;
      }
      setError(sendError instanceof Error ? sendError.message : "The email was not sent.");
    } finally {
      setSending(false);
    }
  }

  const field = (label: string, input: ReactNode) => (
    <label className="block">
      <span className={cn("mb-1 block text-phx-2xs font-black uppercase tracking-[0.12em]", colors.label)}>{label}</span>
      {input}
    </label>
  );

  return (
    <form
      className="space-y-3 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!sending) void send();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={cn("text-sm font-black", colors.heading)}>{draft.inReplyTo ? "Reply" : "New email"}</p>
        <p className={cn("min-w-0 text-xs break-all", colors.muted)} dir="ltr">
          From {fromAddress}
        </p>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {field(
        "To",
        <input
          className={cn("h-10 w-full border px-3 text-sm font-semibold outline-none", colors.input)}
          dir="ltr"
          onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
          placeholder="name@example.com, another@example.com"
          value={draft.to}
        />,
      )}
      {field(
        "Cc",
        <input
          className={cn("h-10 w-full border px-3 text-sm font-semibold outline-none", colors.input)}
          dir="ltr"
          onChange={(event) => setDraft((current) => ({ ...current, cc: event.target.value }))}
          value={draft.cc}
        />,
      )}
      {field(
        "Subject",
        <input
          className={cn("h-10 w-full border px-3 text-sm font-semibold outline-none", colors.input)}
          dir="auto"
          onChange={(event) => setDraft((current) => ({ ...current, subject: event.target.value }))}
          value={draft.subject}
        />,
      )}
      {field(
        "Message",
        <textarea
          className={cn("min-h-40 w-full resize-y border px-3 py-2.5 text-sm font-medium leading-6 outline-none", colors.input)}
          dir="auto"
          onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))}
          value={draft.body}
        />,
      )}

      <div className="space-y-2">
        <label className={cn("inline-flex h-8 cursor-pointer items-center gap-1.5 border px-3 text-xs font-black", colors.border, colors.ghost)}>
          <Paperclip className="h-3.5 w-3.5" /> Attach files
          <input
            className="sr-only"
            multiple
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = "";
            }}
            type="file"
          />
        </label>
        {draft.files.length > 0 ? (
          <ul className="space-y-1">
            {draft.files.map((file, index) => (
              <li className={cn("flex items-start gap-2 text-xs", colors.body)} key={`${file.name}:${index}`}>
                <span className="min-w-0 flex-1 break-all" dir="auto">
                  {file.name} <span className={colors.muted}>{formatSize(file.size)}</span>
                </span>
                <button
                  aria-label={`Remove ${file.name}`}
                  className={cn("flex h-6 w-6 shrink-0 items-center justify-center", colors.ghost)}
                  onClick={() =>
                    setDraft((current) => ({ ...current, files: current.files.filter((_, position) => position !== index) }))
                  }
                  type="button"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          className="inline-flex h-10 flex-1 items-center justify-center bg-phx-accent px-4 text-sm font-black text-white transition hover:bg-phx-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          disabled={sending}
          type="submit"
        >
          {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
          {sending ? "Sending..." : "Send"}
        </button>
        <button
          className={cn("inline-flex h-10 items-center justify-center border px-4 text-sm font-bold", colors.border, colors.ghost)}
          disabled={sending}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
