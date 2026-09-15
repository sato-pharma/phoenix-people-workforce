"use client";

// WhatsApp Inbox — choosing the candidate or employee a chat (or an attachment) belongs to.
//
// It only ever SUGGESTS. People whose phone matches the chat's number come first, but a shared phone
// is not the same person — a father forwards his son's CV, a recruiter's own number sends a friend's —
// so nothing is linked until a human presses the row.

import { useEffect, useState } from "react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import { getJson } from "@/components/recruitment/recruitment-fetch";
import type { InboxPersonOption } from "@/lib/whatsapp-inbox/store";

type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; people: InboxPersonOption[] };

export function InboxPeoplePicker({
  busy,
  candidatesOnly = false,
  conversationId,
  heading,
  onCancel,
  onPick,
}: {
  busy: boolean;
  candidatesOnly?: boolean;
  conversationId: string;
  heading: string;
  onCancel: () => void;
  onPick: (person: InboxPersonOption) => void;
}) {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ conversationId });
    if (search) params.set("q", search);
    getJson(`/api/whatsapp-inbox/people?${params.toString()}`)
      .then((data) => {
        if (!cancelled) setState({ kind: "ready", people: Array.isArray(data.people) ? (data.people as InboxPersonOption[]) : [] });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : "Could not look people up." });
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, search]);

  const people = state.kind === "ready" ? state.people.filter((person) => !candidatesOnly || person.kind === "candidate") : [];

  return (
    <div className="flex flex-col gap-2 border border-phx-line bg-white p-3 text-[12px]">
      <p className="text-[13px] font-bold text-phx-ink">{heading}</p>
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          setState({ kind: "loading" });
          setSearch(draft.trim());
        }}
      >
        <input
          className="min-w-0 flex-1 border border-phx-line bg-white px-2 py-1.5 text-[13px] text-phx-ink outline-none focus:border-phx-accent"
          dir="auto"
          onChange={(event) => setDraft(event.target.value)}
          placeholder={candidatesOnly ? "Search candidates by name or phone" : "Search by name or phone"}
          value={draft}
        />
        <Action disabled={busy} tone="quiet" type="submit">
          Search
        </Action>
      </form>
      {state.kind === "loading" ? <p className="text-phx-ink-soft">Looking…</p> : null}
      {state.kind === "error" ? <p className="text-phx-danger">{state.message}</p> : null}
      {state.kind === "ready" && people.length === 0 ? (
        <p className="leading-snug text-phx-ink-soft">
          {search ? "Nobody matches that search." : "Nobody on file shares this chat's phone number. Search by name instead."}
        </p>
      ) : null}
      {people.length > 0 ? (
        <ul className="flex max-h-64 flex-col divide-y divide-phx-line overflow-y-auto border border-phx-line">
          {people.map((person) => (
            <li key={`${person.kind}:${person.id}`}>
              <button
                className="flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left hover:bg-phx-paper disabled:opacity-45"
                disabled={busy}
                onClick={() => onPick(person)}
                type="button"
              >
                <span className="flex w-full flex-wrap items-baseline gap-x-2">
                  <span className="break-words text-[13px] font-bold text-phx-ink" dir="auto">
                    {person.name}
                  </span>
                  <span className="text-[11px] text-phx-ink-soft">{person.kind === "candidate" ? "Candidate" : "Employee"}</span>
                  {person.phoneMatch ? <span className="text-[11px] font-bold text-phx-accent-press">Same phone number</span> : null}
                </span>
                {person.detail ? (
                  <span className="break-words text-[11px] text-phx-ink-soft" dir="auto">
                    {person.detail}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <Action disabled={busy} onClick={onCancel} tone="ghost">
          Cancel
        </Action>
      </div>
    </div>
  );
}
