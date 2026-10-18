"use client";

// Copy links — the owner, 2026-09-18: "exactly as Google Sheets". He makes a link, chooses what it
// gives (Viewer, Commenter or Editor) and whether it opens the whole calendar or only the week on his
// screen, then copies it or sends it on WhatsApp himself. He can switch a link off and on, change
// it, or delete it, and sees how often it was opened.
//
// Holding a link without signing in VIEWS — his choice. Comment or Edit need a Phoenix sign-in,
// which then gives the link's level. Nothing is sent from here: WhatsApp opens on his own device.

import { Check, ClipboardCopy, Link2, Loader2, MessageCircle, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { phxWhatsAppShareButtonClassName } from "@/components/ui/brand-tokens";
import { Action } from "@/components/recruitment/workstation/workstation-look";
import {
  ACCESS_LEVEL_LABEL,
  INTERVIEW_CALENDAR_ACCESS_LEVELS,
  interviewCalendarLinkPath,
  whatsAppShareUrl,
  type InterviewCalendarAccessLevel,
  type InterviewCalendarLink,
} from "@/lib/recruitment/interview-calendar-types";
import { cairoDateKey, cairoMinutesOfDay, formatShortDate, formatTimeOfDay, formatWeekRange } from "@/lib/recruitment/interview-calendar-week";
import { cn } from "@/lib/utils";

import { calendarApi, reasonText } from "./calendar-api";
import { ErrorLine, NoteLine, PanelHeading, Segmented, Switch } from "./calendar-dialog";
import { phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { adminRecessedDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { RecruitmentPill } from "@/components/recruitment/recruitment-premium";

const LEVEL_WITH_LINK: Record<InterviewCalendarAccessLevel, string> = {
  commenter: "Anyone with the link sees the calendar and opens its CVs; after signing in to Phoenix they can also leave notes.",
  editor: "Anyone with the link sees the calendar and opens its CVs; after signing in to Phoenix they can also book, move and cancel.",
  viewer: "Anyone with the link sees the calendar and opens its CVs. No sign-in needed.",
};

function linkUrl(token: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}${interviewCalendarLinkPath(token)}`;
}

function scopeText(link: Pick<InterviewCalendarLink, "weekStart">): string {
  return link.weekStart ? `The week of ${formatWeekRange(link.weekStart)} only` : "The whole calendar";
}

function stamp(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${formatShortDate(cairoDateKey(at))}, ${formatTimeOfDay(cairoMinutesOfDay(at))}`;
}

function shareMessage(link: InterviewCalendarLink): string {
  const scope = link.weekStart ? `the interviews for the week of ${formatWeekRange(link.weekStart)}` : "the interview calendar";
  return `Here is ${scope} (Sato Pharma recruitment):\n${linkUrl(link.token)}`;
}

const selectClass  = phxSelectClassName;

export function CopyLinkSection({ weekStart }: { weekStart: string }) {
  const [api] = useState(() => calendarApi(null));
  const [links, setLinks] = useState<InterviewCalendarLink[] | null>(null);
  const [level, setLevel] = useState<InterviewCalendarAccessLevel>("viewer");
  const [scope, setScope] = useState<"week" | "all">("week");
  const [guestCvs, setGuestCvs] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get("/links")
      .then((data) => {
        if (live) setLinks(Array.isArray(data.links) ? (data.links as InterviewCalendarLink[]) : []);
      })
      .catch((reason) => {
        if (!live) return;
        setLinks([]);
        setError(reasonText(reason, "The links could not be read."));
      });
    return () => {
      live = false;
    };
  }, [api]);

  function land(data: Record<string, unknown>) {
    setLinks(Array.isArray(data.links) ? (data.links as InterviewCalendarLink[]) : []);
  }

  async function run(key: string, work: () => Promise<Record<string, unknown>>, fallback: string) {
    setBusy(key);
    setError(null);
    try {
      land(await work());
    } catch (reason) {
      setError(reasonText(reason, fallback));
    } finally {
      setBusy(null);
    }
  }

  async function copy(link: InterviewCalendarLink) {
    try {
      await navigator.clipboard.writeText(linkUrl(link.token));
      setCopied(link.id);
      window.setTimeout(() => setCopied((current) => (current === link.id ? null : current)), 2000);
    } catch {
      setError("The browser did not allow copying. Select the link and copy it by hand.");
    }
  }

  return (
    <section aria-label="Copy link" className="mt-5 border-t border-slate-200 pt-4">
      <PanelHeading>
        <span className="inline-flex items-center gap-1.5">
          <Link2 className="h-3.5 w-3.5" /> Copy link
        </span>
      </PanelHeading>
      <div className={`border border-slate-200 bg-slate-50 p-3 ${adminRecessedDepthClassName}`}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={phxLabelClassName}>Anyone with the link is</span>
            <select className={selectClass} onChange={(event) => setLevel(event.target.value as InterviewCalendarAccessLevel)} value={level}>
              {INTERVIEW_CALENDAR_ACCESS_LEVELS.map((entry) => (
                <option key={entry} value={entry}>
                  {ACCESS_LEVEL_LABEL[entry]}
                </option>
              ))}
            </select>
          </label>
          <div>
            <span className={phxLabelClassName}>It opens</span>
            <Segmented<"week" | "all">
              label="What the link opens"
              onChange={setScope}
              options={[
                { label: "This week only", value: "week" },
                { label: "The whole calendar", value: "all" },
              ]}
              value={scope}
            />
            <p className="mt-1 text-[11px] text-slate-500">{scope === "week" ? `The week of ${formatWeekRange(weekStart)}.` : "Every week, past and future."}</p>
          </div>
        </div>
        <p className="mt-2 break-words text-[11px] leading-5 text-slate-600">{LEVEL_WITH_LINK[level]}</p>
        <div className="mt-3">
          <Switch
            checked={guestCvs}
            hint={
              guestCvs
                ? "Someone who has not signed in can open the CVs on it. Anyone the link is forwarded to can too."
                : "The calendar opens without sign-in, but the CVs open only after signing in to Phoenix."
            }
            label="CVs open without sign-in"
            onChange={setGuestCvs}
          />
        </div>
        <div className="mt-3 flex justify-end">
          <Action
            disabled={busy !== null}
            onClick={() => void run("create", () => api.post("/links", { accessLevel: level, guestCvs, weekStart: scope === "week" ? weekStart : null }), "The link could not be made.")}
            size="md"
            tone="primary"
          >
            {busy === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Make a link
          </Action>
        </div>
      </div>

      {error ? (
        <div className="mt-3">
          <ErrorLine>{error}</ErrorLine>
        </div>
      ) : null}

      <ul className="mt-3 flex flex-col gap-2">
        {links === null ? (
          <li className="text-[12px] text-slate-500">Reading…</li>
        ) : links.length === 0 ? (
          <li>
            <NoteLine>No links yet.</NoteLine>
          </li>
        ) : (
          links.map((link) => (
            <li
              className={
                link.isActive
                  ? `border border-slate-200 border-l-[3px] border-l-orange-500 bg-white p-3 ${adminSoftDepthClassName}`
                  : `border border-slate-200 bg-slate-50 p-3 ${adminRecessedDepthClassName}`
              }
              key={link.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] font-bold text-slate-900">
                    <RecruitmentPill tone={link.isActive ? "emerald" : "slate"}>{link.isActive ? "On" : "Off"}</RecruitmentPill>
                    <span className="break-words">
                      {ACCESS_LEVEL_LABEL[link.accessLevel]} · {scopeText(link)}
                    </span>
                  </p>
                  <p className="mt-0.5 break-words text-[11px] tabular-nums text-slate-500">
                    {link.isActive ? "On" : "Switched off — it opens nothing"} · made {stamp(link.createdAt)}
                    {link.createdByName ? ` by ${link.createdByName}` : ""} ·{" "}
                    {link.useCount === 0 ? "not opened yet" : `opened ${link.useCount} ${link.useCount === 1 ? "time" : "times"}, last ${stamp(link.lastUsedAt)}`}
                  </p>
                </div>
                <Switch
                  checked={link.isActive}
                  disabled={busy !== null}
                  label={link.isActive ? "On" : "Off"}
                  onChange={(checked) => void run(link.id, () => api.patch(`/links/${link.id}`, { isActive: checked }), "The link could not be changed.")}
                />
              </div>
              <p className={cn(`mt-2 break-all border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-[11px] ${adminRecessedDepthClassName}`, link.isActive ? "text-slate-800" : "text-slate-400 line-through")}>
                {linkUrl(link.token)}
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center">
                <select
                  aria-label="Access with this link"
                  className={selectClass}
                  disabled={busy !== null}
                  onChange={(event) =>
                    void run(link.id, () => api.patch(`/links/${link.id}`, { accessLevel: event.target.value }), "The link could not be changed.")
                  }
                  value={link.accessLevel}
                >
                  {INTERVIEW_CALENDAR_ACCESS_LEVELS.map((entry) => (
                    <option key={entry} value={entry}>
                      {ACCESS_LEVEL_LABEL[entry]}
                    </option>
                  ))}
                </select>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  <Action disabled={!link.isActive} onClick={() => void copy(link)} tone="quiet">
                    {copied === link.id ? <Check className="h-3.5 w-3.5" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
                    {copied === link.id ? "Copied" : "Copy link"}
                  </Action>
                  {link.isActive ? (
                    <a
                      className={phxWhatsAppShareButtonClassName}
                      href={whatsAppShareUrl(shareMessage(link))}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <MessageCircle className="h-3.5 w-3.5" />
                      WhatsApp
                    </a>
                  ) : null}
                  <Action
                    disabled={busy !== null}
                    onClick={() => void run(link.id, () => api.del(`/links/${link.id}`), "The link could not be deleted.")}
                    tone="ghost"
                  >
                    {busy === link.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    Delete
                  </Action>
                </div>
              </div>
              <div className="mt-2">
                <Switch
                  checked={link.guestCvs}
                  disabled={busy !== null}
                  label="CVs open without sign-in"
                  onChange={(checked) => void run(link.id, () => api.patch(`/links/${link.id}`, { guestCvs: checked }), "The link could not be changed.")}
                />
              </div>
            </li>
          ))
        )}
      </ul>
      <p className="mt-2 text-[11px] text-slate-500">
        WhatsApp opens on your device with the link typed in; nothing is sent until you press Send there. Switching a link off or deleting it
        stops it at once.
      </p>
    </section>
  );
}
