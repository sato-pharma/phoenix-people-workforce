"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck2, Info, Loader2 } from "lucide-react";

import {
  saturdayLabel,
  startConfirmText,
  stopConfirmText,
  type PhoenixTeamRow,
  type PhoenixTeamStartsPanelData,
} from "@/lib/crm/phoenix-team-starts";
import { vendorLeftoverNote, VENDOR_LEFTOVER_TITLE } from "@/lib/phoenix-crm/vendor-leftovers";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

/**
 * Which teams every screen outside Phoenix CRM counts from Phoenix CRM — and the ONE place a team is
 * started or stopped (owner, 2026-10-02: "Only when I start it"). Delta (1)'s 3 October start is his
 * own ruling; every other team starts here, from the Saturday he picks, and nowhere else.
 *
 * Super Admin only: it sits on the CRM hub, which redirects everyone else, and the route behind the
 * buttons (app/api/crm/phoenix-team-starts) refuses anyone else before it writes. The buttons offer
 * only what the writer accepts — a Saturday, never before the first day of this Cairo month — and
 * nothing happens until he has read, in words, what it does and confirmed it.
 *
 * Built like the Sync Status panel above it: one row per team that wraps on a phone and never scrolls
 * sideways, square edges, names only (the seat id is the payload, never shown).
 */

const BUTTON =
  "inline-flex h-9 items-center gap-2 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent disabled:opacity-50";
const CONFIRM_BUTTON =
  "inline-flex h-9 items-center gap-2 border border-orange-600 bg-orange-600 px-3 text-xs font-bold text-white shadow-sm transition hover:bg-orange-700 disabled:opacity-50";
const SELECT = cn(phxSelectClassName, "h-9 min-w-0 max-w-full px-2 text-xs");

const FAILED = "The team could not be changed. Reload the page and try again.";

type Pending = { action: "start" | "stop"; day: string | null };

function TeamActions({ team, cairoToday }: { team: PhoenixTeamRow; cairoToday: string }) {
  const router = useRouter();
  const [startDay, setStartDay] = useState(team.startDefault ?? team.startOptions[0] ?? "");
  const [stopDay, setStopDay] = useState(team.stopOptions[0] ?? "");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running = team.runningStartsOn;
  const confirmText =
    pending === null
      ? null
      : pending.action === "start"
        ? startConfirmText(pending.day ?? "", team.reps)
        : stopConfirmText(running ?? "", pending.day, team.reps, cairoToday);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/crm/phoenix-team-starts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: pending.action, teamSeatId: team.teamSeatId, day: pending.day }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: unknown };
      if (!response.ok) {
        setError(typeof payload.error === "string" && payload.error ? payload.error : FAILED);
        return;
      }
      setPending(null);
      router.refresh();
    } catch {
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
      {pending === null ? (
        <div className="flex flex-wrap items-center gap-2">
          {running === null ? (
            team.startOptions.length > 0 ? (
              <>
                <select
                  aria-label={`Start ${team.team} from`}
                  className={SELECT}
                  onChange={(event) => setStartDay(event.target.value)}
                  value={startDay}
                >
                  {team.startOptions.map((day) => (
                    <option key={day} value={day}>
                      {saturdayLabel(day)}
                    </option>
                  ))}
                </select>
                <button
                  className={BUTTON}
                  disabled={!startDay}
                  onClick={() => {
                    setError(null);
                    setPending({ action: "start", day: startDay });
                  }}
                  type="button"
                >
                  Start
                </button>
              </>
            ) : null
          ) : team.stopOptions.length === 0 ? (
            // Not reached yet: Stop takes the start back whole.
            <button
              className={BUTTON}
              onClick={() => {
                setError(null);
                setPending({ action: "stop", day: null });
              }}
              type="button"
            >
              Take back the start
            </button>
          ) : (
            <>
              <select
                aria-label={`Stop ${team.team} from`}
                className={SELECT}
                onChange={(event) => setStopDay(event.target.value)}
                value={stopDay}
              >
                {team.stopOptions.map((day) => (
                  <option key={day} value={day}>
                    {saturdayLabel(day)}
                  </option>
                ))}
              </select>
              <button
                className={BUTTON}
                disabled={!stopDay}
                onClick={() => {
                  setError(null);
                  setPending({ action: "stop", day: stopDay });
                }}
                type="button"
              >
                Stop
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="w-full border border-orange-200 bg-orange-50 px-3 py-2.5 sm:max-w-md">
          <p className="break-words text-xs font-semibold leading-5 text-slate-800">{confirmText}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button className={CONFIRM_BUTTON} disabled={busy} onClick={confirm} type="button">
              {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : null}
              {pending.action === "start" ? "Yes, start it" : "Yes, stop it"}
            </button>
            <button
              className={BUTTON}
              disabled={busy}
              onClick={() => {
                setPending(null);
                setError(null);
              }}
              type="button"
            >
              Keep it as it is
            </button>
          </div>
        </div>
      )}
      {error ? <p className="break-words text-xs font-semibold text-red-700">{error}</p> : null}
    </div>
  );
}

export function CrmPhoenixTeamStartsPanel({ data }: { data: PhoenixTeamStartsPanelData | null }) {
  return (
    <div className="scroll-mt-4 overflow-hidden border border-slate-200 bg-white" id="phoenix-team-starts">
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
        <h2 className="text-phx-sm font-bold uppercase tracking-widest text-slate-300">Teams counted from Phoenix CRM</h2>
        <div className="h-1.5 w-12 bg-orange-500" />
      </div>

      <p className="flex items-start gap-2 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs leading-5 text-slate-600">
        <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
        <span className="min-w-0">
          From the Saturday a team starts, every screen outside Phoenix CRM reads its Phoenix CRM visits, weekly plans and
          day activities instead of its iReports360 ones. A team starts only when you press Start, from the Saturday you
          pick, never before the first day of this month; Stop sends it back to iReports360 from a Saturday. You are told
          in-app and on Telegram the first time a rep of a team not started sends a weekly plan.
        </span>
      </p>

      {data === null ? (
        <p className="px-5 py-4 text-sm text-slate-500">The teams could not be read just now.</p>
      ) : !data.provisioned ? (
        <p className="px-5 py-4 text-sm text-slate-500">Team starts are not set up on this database yet.</p>
      ) : data.teams.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-500">The organogram holds no team with territories.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.teams.map((team) => {
            const counted = team.state === "running" || team.state === "starts" || team.state === "stopping";
            return (
              <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 py-3 text-sm" key={team.teamSeatId}>
                <div className="min-w-0 flex-1 basis-64">
                  <p className="break-words font-semibold text-slate-900" dir="auto">
                    {team.team}
                  </p>
                  <p className="mt-0.5 flex items-start gap-1.5 break-words text-phx-xs text-slate-600">
                    {counted ? (
                      <CalendarCheck2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                    ) : null}
                    <span className="min-w-0">{team.stateLine}</span>
                  </p>
                  <p className="text-phx-xs text-slate-500">
                    {team.territories === 1 ? "1 territory" : `${team.territories} territories`}
                    {" · "}
                    {team.reps === 1 ? "1 rep" : `${team.reps} reps`}
                  </p>
                  {/* Where the work is being recorded, never a word about the rep — one still on
                      the old app is following the habit he was trained in, and his visits there
                      now land in no figure at all. */}
                  {vendorLeftoverNote(team.stillOnVendor) ? (
                    <p className="mt-0.5 break-words text-phx-xs font-semibold text-amber-700">
                      {VENDOR_LEFTOVER_TITLE}: {vendorLeftoverNote(team.stillOnVendor)}
                    </p>
                  ) : null}
                  {team.firstPlanLine ? (
                    <p className="mt-0.5 break-words text-phx-xs font-semibold text-amber-700">{team.firstPlanLine}</p>
                  ) : null}
                </div>
                <TeamActions cairoToday={data.cairoToday} team={team} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
