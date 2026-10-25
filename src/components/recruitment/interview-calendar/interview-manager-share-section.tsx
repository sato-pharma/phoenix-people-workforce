"use client";

// Share one interviewer's interviews with one manager — the owner, 2026-10-26: "choose Ali Muhammad
// Ali and choose Zahra, the PDA Cairo district manager, and share. Only the interviews related to
// them appear." Not the whole calendar: the manager sees only the interviews ticked here, view only,
// with the CV. Phoenix pre-ticks the ones in the manager's line and region and says why for each;
// the owner ticks or unticks the rest. The manager is told in Phoenix and on their phone.

import { Check, Loader2, Search, Share2 } from "lucide-react";
import { useEffect, useState } from "react";

import { getJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { Action } from "@/components/recruitment/workstation/workstation-look";
import { phxFieldClassName, phxLabelClassName } from "@/components/ui/form-tokens";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import type { InterviewCalendarPerson, InterviewManagerSharePlan } from "@/lib/recruitment/interview-calendar-types";
import { cairoDateKey, cairoMinutesOfDay, formatDayLong, formatTimeOfDay } from "@/lib/recruitment/interview-calendar-week";
import { cn } from "@/lib/utils";

import { ErrorLine, NoteLine, PanelHeading } from "./calendar-dialog";

const API = "/api/recruitment/interview-calendar/interview-shares";

/** Pick one District Manager or above by name or job title. */
function PersonPicker({
  id,
  label,
  onPick,
  picked,
}: {
  id: string;
  label: string;
  onPick: (person: InterviewCalendarPerson | null) => void;
  picked: InterviewCalendarPerson | null;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ people: InterviewCalendarPerson[]; text: string } | null>(null);
  const text = query.trim();
  const answered = text.length >= 2 && found !== null && found.text === text;
  const people = answered && found ? found.people : [];

  useEffect(() => {
    if (text.length < 2) return;
    let live = true;
    const timer = window.setTimeout(() => {
      getJson(`/api/recruitment/interview-calendar/people?q=${encodeURIComponent(text)}&for=interviewer`)
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
  }, [text]);

  if (picked) {
    return (
      <div>
        <p className={phxLabelClassName}>{label}</p>
        <div className={`flex items-start justify-between gap-2 border border-orange-200 border-l-[3px] border-l-orange-500 bg-orange-50 px-3 py-2 ${adminSoftDepthClassName}`}>
          <div className="min-w-0">
            <p className="break-words text-[13px] font-bold text-slate-900">{picked.name}</p>
            {picked.jobTitle ? <p className="break-words text-[11px] text-slate-600">{picked.jobTitle}</p> : null}
          </div>
          <Action onClick={() => onPick(null)} tone="ghost">
            Change
          </Action>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label className={phxLabelClassName} htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          autoComplete="off"
          className={cn(phxFieldClassName, "pl-8")}
          id={id}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name or job title"
          type="search"
          value={query}
        />
      </div>
      {text.length >= 2 ? (
        <ul className={`mt-1 divide-y divide-slate-100 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          {!answered ? (
            <li className="px-3 py-2 text-[12px] text-slate-500">Searching…</li>
          ) : people.length === 0 ? (
            <li className="px-3 py-2 text-[12px] text-slate-500">No District Manager or above by that name.</li>
          ) : (
            people.map((person) => (
              <li key={person.hrId}>
                <button
                  className="block w-full px-3 py-2 text-left hover:bg-orange-50"
                  onClick={() => {
                    onPick(person);
                    setQuery("");
                  }}
                  type="button"
                >
                  <span className="block break-words text-[13px] font-semibold text-slate-900">{person.name}</span>
                  {person.jobTitle ? <span className="block break-words text-[11px] text-slate-500">{person.jobTitle}</span> : null}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

function whenText(iso: string): string {
  const at = new Date(iso);
  return `${formatDayLong(cairoDateKey(at))}, ${formatTimeOfDay(cairoMinutesOfDay(at))}`;
}

export function InterviewManagerShareSection() {
  const [interviewer, setInterviewer] = useState<InterviewCalendarPerson | null>(null);
  const [manager, setManager] = useState<InterviewCalendarPerson | null>(null);
  // The plan with the pair it answers, so a plan for an earlier pair is never shown against this one.
  const [loaded, setLoaded] = useState<{ key: string; plan: InterviewManagerSharePlan | null; error: string | null } | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const pairKey = interviewer && manager ? `${interviewer.hrId}|${manager.hrId}` : null;
  const current = pairKey && loaded?.key === pairKey ? loaded : null;
  const plan = current?.plan ?? null;

  useEffect(() => {
    if (!interviewer || !manager) return;
    const key = `${interviewer.hrId}|${manager.hrId}`;
    let live = true;
    getJson(`${API}?interviewer=${encodeURIComponent(interviewer.hrId)}&manager=${encodeURIComponent(manager.hrId)}`)
      .then((data) => {
        if (!live) return;
        const next = data.plan as InterviewManagerSharePlan;
        setLoaded({ error: null, key, plan: next });
        // Already shared stays ticked; otherwise what Phoenix suggests is ticked to start with.
        const anyShared = next.items.some((item) => item.shared);
        setTicked(new Set(next.items.filter((item) => (anyShared ? item.shared : item.suggested)).map((item) => item.bookingId)));
      })
      .catch((reason) => {
        if (live) setLoaded({ error: reason instanceof Error ? reason.message : "The interviews could not be read.", key, plan: null });
      });
    return () => {
      live = false;
    };
  }, [interviewer, manager]);

  function toggle(id: string) {
    setSaved(null);
    setTicked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    if (!interviewer || !manager || !plan) return;
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      const data = await postJson(API, { bookingIds: [...ticked], interviewerHrId: interviewer.hrId, managerHrId: manager.hrId });
      const next = data.plan as InterviewManagerSharePlan;
      setLoaded({ error: null, key: `${interviewer.hrId}|${manager.hrId}`, plan: next });
      setTicked(new Set(next.items.filter((item) => item.shared).map((item) => item.bookingId)));
      const count = next.items.filter((item) => item.shared).length;
      setSaved(
        count === 0
          ? `${manager.name} sees none of ${interviewer.name}'s interviews.`
          : `${manager.name} now sees ${count} of ${interviewer.name}'s interviews, and was told in Phoenix.`,
      );
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "Sharing failed.");
    } finally {
      setSaving(false);
    }
  }

  const unchanged = plan ? plan.items.every((item) => item.shared === ticked.has(item.bookingId)) : true;
  const seat = plan ? [plan.manager.line, plan.manager.area ?? plan.manager.region].filter(Boolean).join(" · ") : "";

  return (
    <section aria-label="Share interviews with a manager" className="mt-5">
      <PanelHeading>Share interviews with a manager</PanelHeading>
      <p className="mb-3 break-words text-[12px] leading-5 text-slate-600">
        The manager sees only the interviews you tick, with the CV, and cannot change them.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <PersonPicker id="interview-share-interviewer" label="Interviewer" onPick={setInterviewer} picked={interviewer} />
        <PersonPicker id="interview-share-manager" label="Share with" onPick={setManager} picked={manager} />
      </div>

      {pairKey && !current ? <p className="mt-3 text-[12px] text-slate-500">Reading the interviews…</p> : null}
      {current?.error ? (
        <div className="mt-3">
          <ErrorLine>{current.error}</ErrorLine>
        </div>
      ) : null}

      {plan ? (
        <div className="mt-3">
          {seat ? (
            <NoteLine>
              {plan.manager.name} covers {seat}.
            </NoteLine>
          ) : null}
          {plan.items.length === 0 ? (
            <p className="mt-2 text-[12px] text-slate-500">{plan.interviewer.name} has no upcoming interviews.</p>
          ) : (
            <ul className={`mt-2 divide-y divide-slate-100 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
              {plan.items.map((item) => {
                const on = ticked.has(item.bookingId);
                return (
                  <li key={item.bookingId}>
                    <label className={cn("flex cursor-pointer items-start gap-3 px-3 py-2", on ? "bg-orange-50" : "hover:bg-slate-50")}>
                      <input
                        checked={on}
                        className="mt-1 h-4 w-4 shrink-0 accent-orange-600"
                        onChange={() => toggle(item.bookingId)}
                        type="checkbox"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-[13px] font-semibold text-slate-900">{item.candidateName}</span>
                        <span className="block break-words text-[11px] text-slate-600">
                          {whenText(item.startsAt)}
                          {[item.line, item.area, item.jobTitle].filter(Boolean).length > 0
                            ? ` · ${[item.line, item.area, item.jobTitle].filter(Boolean).join(" · ")}`
                            : ""}
                        </span>
                        <span className={cn("mt-0.5 block break-words text-[11px]", item.suggested ? "font-semibold text-emerald-700" : "text-slate-500")}>
                          {item.shared ? "Shared now. " : ""}
                          {item.reason}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {saveError ? (
            <div className="mt-2">
              <ErrorLine>{saveError}</ErrorLine>
            </div>
          ) : null}
          {saved ? (
            <div className="mt-2">
              <NoteLine tone="emerald">
                <Check aria-hidden className="mr-1 inline h-3.5 w-3.5" />
                {saved}
              </NoteLine>
            </div>
          ) : null}
          {plan.items.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-bold tabular-nums text-slate-500">
                {ticked.size} of {plan.items.length} ticked
              </span>
              <Action disabled={saving || unchanged} onClick={() => void save()} size="md" tone="primary">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                Share
              </Action>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
