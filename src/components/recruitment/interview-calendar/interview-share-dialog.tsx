"use client";

// Share the interview calendar — the owner's own control, and only his. "I want to be able to share
// the schedule from Phoenix itself, also I can choose the access: editor, commenter, viewer."
//
// Viewer sees the calendar and opens the CVs on it; Commenter also leaves notes on an interview;
// Editor also books, moves and cancels. Nobody but the owner can share it onward. The person is told
// in Phoenix (in-app and push, never email) when they are added or their access changes.
//
// Below the people, COPY LINKS (the owner, 2026-09-18, "exactly as Google Sheets"): a link at a level
// he picks, for the week on screen or the whole calendar, to copy or send on WhatsApp himself.

import { Loader2, Search, Share2, Trash2, UserPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useHydrated } from "@/hooks/use-hydrated";
import { Action } from "@/components/recruitment/workstation/workstation-look";
import { deleteRequest, getJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { canonicalHrIdKey } from "@/lib/hr-id";
import {
  ACCESS_LEVEL_HINT,
  ACCESS_LEVEL_LABEL,
  INTERVIEW_CALENDAR_ACCESS_LEVELS,
  type InterviewCalendarAccessLevel,
  type InterviewCalendarPerson,
  type InterviewCalendarShare,
} from "@/lib/recruitment/interview-calendar-types";
import { cn } from "@/lib/utils";

import { RecruitmentPill } from "@/components/recruitment/recruitment-premium";

import { PanelHeading } from "./calendar-dialog";
import { CopyLinkSection } from "./copy-link-section";
import {
  phxFieldClassName,
  phxLabelClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { adminPanelHeaderClassName, adminRecessedDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

function AccessSelect({
  disabled,
  id,
  onChange,
  value,
}: {
  disabled?: boolean;
  id?: string;
  onChange: (level: InterviewCalendarAccessLevel) => void;
  value: InterviewCalendarAccessLevel;
}) {
  return (
    <select
      aria-label="Access"
      className={phxSelectClassName}
      disabled={disabled}
      id={id}
      onChange={(event) => onChange(event.target.value as InterviewCalendarAccessLevel)}
      value={value}
    >
      {INTERVIEW_CALENDAR_ACCESS_LEVELS.map((level) => (
        <option key={level} value={level}>
          {ACCESS_LEVEL_LABEL[level]}
        </option>
      ))}
    </select>
  );
}

export function InterviewShareDialog({ onClose, weekStart }: { onClose: () => void; weekStart: string }) {
  const dialogRef = useDialogA11y({ onClose, open: true });
  const mounted = useHydrated();

  const [shares, setShares] = useState<InterviewCalendarShare[] | null>(null);
  const [query, setQuery] = useState("");
  // The last answer, with the text it answered. What is shown is derived from it during render, so
  // an answer to an older spelling is never shown against the current one.
  const [found, setFound] = useState<{ people: InterviewCalendarPerson[]; text: string } | null>(null);
  const [picked, setPicked] = useState<InterviewCalendarPerson | null>(null);
  const [level, setLevel] = useState<InterviewCalendarAccessLevel>("viewer");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const searchText = query.trim();
  const searchable = searchText.length >= 2;
  const answered = searchable && found !== null && found.text === searchText;
  const people = answered && found ? found.people : [];
  const searching = searchable && !answered;

  useEffect(() => {
    getJson("/api/recruitment/interview-calendar/shares")
      .then((data) => setShares(Array.isArray(data.shares) ? (data.shares as InterviewCalendarShare[]) : []))
      .catch((reason) => {
        setShares([]);
        setError(reason instanceof Error ? reason.message : "The list of people could not be read.");
      });
  }, []);

  // Search as the name is typed, a quarter-second after the last key; only the latest answer lands.
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) return;
    let live = true;
    const timer = window.setTimeout(() => {
      getJson(`/api/recruitment/interview-calendar/people?q=${encodeURIComponent(text)}`)
        .then((data) => {
          if (live) setFound({ people: Array.isArray(data.people) ? (data.people as InterviewCalendarPerson[]) : [], text });
        })
        .catch(() => {
          if (live) setFound({ people: [], text });
        });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  async function share(hrId: string, accessLevel: InterviewCalendarAccessLevel) {
    setBusy(hrId);
    setError(null);
    try {
      const data = await postJson(`/api/recruitment/interview-calendar/shares`, { accessLevel, hrId });
      setShares(data.shares as InterviewCalendarShare[]);
      setPicked(null);
      setQuery("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sharing failed.");
    } finally {
      setBusy(null);
    }
  }

  async function unshare(hrId: string) {
    setBusy(hrId);
    setError(null);
    try {
      const data = await deleteRequest(`/api/recruitment/interview-calendar/shares/${encodeURIComponent(hrId)}`);
      setShares(data.shares as InterviewCalendarShare[]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Removing failed.");
    } finally {
      setBusy(null);
    }
  }

  const sharedIds = new Set((shares ?? []).map((row) => canonicalHrIdKey(row.hrId)));

  const body = (
    <div
      className="fixed inset-0 z-[210] flex items-end justify-center bg-slate-900/45 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-labelledby="share-interview-calendar-title"
        aria-modal="true"
        className="flex max-h-[92vh] w-full max-w-[560px] flex-col border border-slate-200 bg-white shadow-[0_24px_60px_rgba(15,23,42,0.32)]"
        ref={dialogRef}
        role="dialog"
      >
        <header className={`flex items-start justify-between gap-3 px-4 py-3.5 text-white sm:px-5 ${adminPanelHeaderClassName}`}>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-orange-300">
              <Share2 aria-hidden className="h-3.5 w-3.5" />
              Share
            </p>
            <h2 className="mt-1 break-words text-[17px] font-bold leading-snug tracking-tight text-white" id="share-interview-calendar-title">
              Share the interview calendar
            </h2>
            <p className="mt-0.5 break-words text-[12px] leading-5 text-slate-300">
              People you add are told in Phoenix. A copy link reaches whoever you send it to. Only you can share it.
            </p>
          </div>
          <button
            aria-label="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-white/15 text-slate-300 transition-colors hover:border-white/40 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <section aria-label="Add a person">
            {picked ? (
              <div className={`border border-orange-200 border-l-[3px] border-l-orange-500 bg-orange-50 p-3 ${adminSoftDepthClassName}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words text-[14px] font-bold text-slate-900">{picked.name}</p>
                    {picked.jobTitle ? <p className="break-words text-[12px] text-slate-600">{picked.jobTitle}</p> : null}
                  </div>
                  <Action onClick={() => setPicked(null)} tone="ghost">
                    Change
                  </Action>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                  <div>
                    <AccessSelect onChange={setLevel} value={level} />
                    <p className="mt-1 text-[11px] text-slate-600">{ACCESS_LEVEL_HINT[level]}</p>
                  </div>
                  <Action disabled={busy !== null} onClick={() => void share(picked.hrId, level)} size="md" tone="primary">
                    {busy === picked.hrId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                    Share
                  </Action>
                </div>
              </div>
            ) : (
              <>
                <label className={phxLabelClassName} htmlFor="interview-share-search">
                  Add a person
                </label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    autoComplete="off"
                    className={cn(phxFieldClassName, "pl-8")}
                    id="interview-share-search"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Name or job title"
                    type="search"
                    value={query}
                  />
                </div>
                {query.trim().length >= 2 ? (
                  <ul className={`mt-1 divide-y divide-slate-100 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
                    {searching && people.length === 0 ? (
                      <li className="px-3 py-2 text-[12px] text-slate-500">Searching…</li>
                    ) : people.length === 0 ? (
                      <li className="px-3 py-2 text-[12px] text-slate-500">Nobody by that name.</li>
                    ) : (
                      people.map((person) => {
                        const already = sharedIds.has(canonicalHrIdKey(person.hrId));
                        return (
                          <li key={person.hrId}>
                            <button
                              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-orange-50"
                              onClick={() => {
                                setPicked(person);
                                setLevel(
                                  (shares ?? []).find((row) => canonicalHrIdKey(row.hrId) === canonicalHrIdKey(person.hrId))?.accessLevel ??
                                    "viewer",
                                );
                              }}
                              type="button"
                            >
                              <span className="min-w-0">
                                <span className="block break-words text-[13px] font-semibold text-slate-900">{person.name}</span>
                                {person.jobTitle ? <span className="block break-words text-[11px] text-slate-500">{person.jobTitle}</span> : null}
                              </span>
                              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-bold text-orange-700">
                                <UserPlus className="h-3.5 w-3.5" />
                                {already ? "Change access" : "Add"}
                              </span>
                            </button>
                          </li>
                        );
                      })
                    )}
                  </ul>
                ) : null}
              </>
            )}
          </section>

          {error ? (
            <p className="mt-3 break-words border border-red-200 border-l-[3px] border-l-red-600 bg-red-50 px-3 py-2 text-[12px] font-semibold text-red-700" role="alert">
              {error}
            </p>
          ) : null}

          <section aria-label="People with access" className="mt-5">
            <PanelHeading
              aside={
                shares && shares.length > 0 ? (
                  <span className="text-[11px] font-bold tabular-nums text-slate-500">
                    {shares.length} {shares.length === 1 ? "person" : "people"}
                  </span>
                ) : null
              }
            >
              People with access
            </PanelHeading>
            <ul className={`divide-y divide-slate-100 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
              <li className="flex items-center justify-between gap-3 bg-slate-50 px-3 py-2">
                <span className="text-[13px] font-semibold text-slate-900">You</span>
                <RecruitmentPill tone="orange">{ACCESS_LEVEL_LABEL.owner}</RecruitmentPill>
              </li>
              {shares === null ? (
                <li className="px-3 py-2 text-[12px] text-slate-500">Reading…</li>
              ) : shares.length === 0 ? (
                <li className="px-3 py-2 text-[12px] text-slate-500">Not shared with anyone yet.</li>
              ) : (
                shares.map((row) => (
                  <li className="grid grid-cols-[minmax(0,1fr)_7.5rem_auto] items-center gap-2 px-3 py-2" key={row.hrId}>
                    <span className="min-w-0">
                      <span className="block break-words text-[13px] font-semibold text-slate-900">{row.name}</span>
                      {row.jobTitle ? <span className="block break-words text-[11px] text-slate-500">{row.jobTitle}</span> : null}
                    </span>
                    <AccessSelect
                      disabled={busy !== null}
                      onChange={(next) => {
                        if (next !== row.accessLevel) void share(row.hrId, next);
                      }}
                      value={row.accessLevel}
                    />
                    <button
                      aria-label={`Remove ${row.name}`}
                      className={cn(
                        "inline-flex h-9 w-9 items-center justify-center border border-transparent text-slate-400 hover:border-red-200 hover:text-red-700 disabled:opacity-40",
                      )}
                      disabled={busy !== null}
                      onClick={() => void unshare(row.hrId)}
                      title={`Remove ${row.name}`}
                      type="button"
                    >
                      {busy === row.hrId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </section>

          <CopyLinkSection weekStart={weekStart} />
        </div>

        <footer className={`flex justify-end border-t border-slate-200 bg-slate-50 px-4 py-3 sm:px-5 ${adminRecessedDepthClassName}`}>
          <Action onClick={onClose} size="md" tone="quiet">
            Done
          </Action>
        </footer>
      </div>
    </div>
  );

  return mounted ? createPortal(body, document.body) : null;
}
