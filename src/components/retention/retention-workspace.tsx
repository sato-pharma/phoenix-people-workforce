"use client";

/**
 * Retention register — HR Business Partner job description §3, "structured stay discussions and
 * exit interviews, summarised into themes".
 *
 * DESIGN IDENTITY is the HR command centre's, deliberately (AGENTS.md §4). Same `PremiumHero`,
 * same centred metric tile, same orange accent, square corners, slate borders.
 *
 * THE THEME ROLL-UP LEADS, not the conversation list. A register of individual interviews is a
 * filing cabinet; the answer the business wants is *why are people leaving* — so the roll-up sits
 * directly under the metrics, and the conversations are the evidence beneath it.
 *
 * DESKTOP GETS THE TABLE, MOBILE NEVER DOES. The roll-up is a horizontal bar chart at both sizes
 * because it is a comparison, not a table; the conversations are a table on desktop and cards on
 * a phone. Nothing truncates and nothing wraps in the table.
 *
 * CONFIDENTIALITY IS VISIBLE, NOT ASSUMED. The page says in plain words who can read it, because
 * an interviewer who does not know that will not say anything worth recording.
 */

import {
  Heart,
  Loader2,
  LogOut,
  MessageSquareQuote,
  Plus,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { PremiumHero } from "@/components/ui/premium-hero";
// The confidentiality notice below names two seats, and it must name them the way the people
// reading it are addressed everywhere else in the product — by JOB TITLE. "HR Advisory" and
// "HR Operations" are internal ROLE KEYS: they are what the permission matrix is keyed on, not
// what anyone is called. The owner's standing rule is human-readable names, never raw codes
// (AGENTS.md §4), and this notice is the one paragraph on the page an interviewer is meant to
// read aloud, so a key leaking here is read aloud too.
//
// Resolved through the helper rather than hard-coded so the notice cannot drift from
// HR_SEAT_JOB_TITLES — the one place a seat's displayed title is decided.
import { displayTitleForRole } from "@/lib/auth/hr-functions";
import type {
  CreateRetentionConversationInput,
  RetentionConversation,
  RetentionConversationKind,
  RetentionDashboardData,
  RetentionRisk,
  RetentionThemeInput,
  RetentionThemeSentiment,
} from "@/lib/retention/types";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import {
  phxFieldClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";

type KindFilter = "all" | RetentionConversationKind;

const RISK_CLASS: Record<RetentionRisk, string> = {
  low: "border-emerald-300 bg-emerald-50 text-emerald-800",
  medium: "border-amber-300 bg-amber-50 text-amber-800",
  high: "border-rose-300 bg-rose-50 text-rose-800",
};

// DATE-ONLY (hire / exit dates, sliced to 10 chars first), which `new Date` parses as UTC midnight. UTC
// here is CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset. Not
// an instant — do not "fix" this one to Cairo.
function formatDate(value: string | null): string {
  if (!value) return "Not set";
  const parsed = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return value;
  return formatStableEnGb(new Date(parsed), {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function MetricTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "slate" | "amber" | "emerald" | "rose";
}) {
  const toneClass = {
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
    slate: "text-slate-900",
  }[tone];

  return (
    <div className="min-h-32 border border-slate-200 bg-white px-4 py-4 text-center">
      <div className="text-[9px] font-black uppercase leading-tight tracking-[0.14em] text-slate-500">
        {label}
      </div>
      <p className={`mt-4 text-3xl font-black leading-none tabular-nums ${toneClass}`}>{value}</p>
      <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{sub}</p>
    </div>
  );
}

function KindChip({ kind }: { kind: RetentionConversationKind }) {
  return kind === "stay" ? (
    <span className="inline-flex items-center gap-1 whitespace-nowrap border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-emerald-800">
      <Heart aria-hidden="true" className="h-3 w-3" /> Stay
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 whitespace-nowrap border border-slate-300 bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700">
      <LogOut aria-hidden="true" className="h-3 w-3" /> Exit
    </span>
  );
}

export function RetentionWorkspace({
  initialData,
  initialError,
  canRecord,
  canUpdate,
}: {
  initialData: RetentionDashboardData | null;
  initialError: string | null;
  canRecord: boolean;
  canUpdate: boolean;
}) {
  const [data, setData] = useState(initialData);
  const [error, setError] = useState(initialError);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [composerOpen, setComposerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState<{
    kind: RetentionConversationKind;
    employeeHrId: string;
    conductedOn: string;
    summary: string;
    retentionRisk: RetentionRisk;
    isRegrettable: "yes" | "no";
    wouldRejoin: "yes" | "no" | "unknown";
    followUpAction: string;
    followUpDue: string;
    themes: Record<string, RetentionThemeSentiment | "">;
  }>({
    kind: "stay",
    employeeHrId: "",
    conductedOn: "",
    summary: "",
    retentionRisk: "medium",
    isRegrettable: "yes",
    wouldRejoin: "unknown",
    followUpAction: "",
    followUpDue: "",
    themes: {},
  });

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const themes: RetentionThemeInput[] = Object.entries(form.themes)
        .filter(([, sentiment]) => sentiment !== "")
        .map(([themeKey, sentiment]) => ({
          themeKey,
          sentiment: sentiment as RetentionThemeSentiment,
        }));

      const conversation: CreateRetentionConversationInput = {
        kind: form.kind,
        employeeHrId: form.employeeHrId.trim(),
        conductedOn: form.conductedOn,
        summary: form.summary,
        themes,
        followUpAction: form.followUpAction.trim() || null,
        followUpDue: form.followUpDue || null,
        // The two kind-specific fields are sent for their own kind ONLY. Sending both would fail
        // the database's kind constraint, which is exactly the mistake it exists to catch.
        retentionRisk: form.kind === "stay" ? form.retentionRisk : null,
        isRegrettable: form.kind === "exit" ? form.isRegrettable === "yes" : null,
        wouldRejoin:
          form.kind === "exit" && form.wouldRejoin !== "unknown"
            ? form.wouldRejoin === "yes"
            : null,
      };

      const response = await fetch("/api/retention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation }),
      });
      const payload = (await response.json()) as RetentionDashboardData & { message?: string };
      if (!response.ok) {
        setError(payload.message ?? "That conversation could not be recorded.");
        return;
      }
      setData(payload);
      setComposerOpen(false);
      setForm((current) => ({
        ...current,
        employeeHrId: "",
        summary: "",
        followUpAction: "",
        followUpDue: "",
        themes: {},
      }));
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Network request failed.");
    } finally {
      setBusy(false);
    }
  }, [form]);

  /**
   * Close or reopen the follow-up on one conversation.
   *
   * A stay discussion with an open action is the half of this module that has any effect on whether
   * someone stays; the dashboard counts those and flags the overdue ones in rose. Without this the
   * count could only ever go up, so every stay discussion would eventually read as neglected and
   * the number would stop meaning anything. The service stamps follow_up_done_at server-side — the
   * client never sends a timestamp, so a wrong clock on a laptop cannot date-stamp the record.
   */
  const markFollowUp = useCallback(async (id: string, done: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/retention", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation: { id, followUpDone: done } }),
      });
      const payload = (await response.json()) as RetentionDashboardData & { message?: string };
      if (!response.ok) {
        setError(payload.message ?? "That follow-up could not be updated.");
        return;
      }
      setData(payload);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Network request failed.");
    } finally {
      setBusy(false);
    }
  }, []);

  const conversations = useMemo(() => {
    const all = data?.conversations ?? [];
    return kindFilter === "all" ? all : all.filter((c) => c.kind === kindFilter);
  }, [data, kindFilter]);

  const stats = data?.stats;
  const rollup = data?.rollup ?? [];
  const maxRollup = rollup.reduce((max, row) => Math.max(max, row.total), 0);

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <PremiumHero
        kicker="Retention & Employee Experience"
        subtitle="Stay discussions and exit interviews, summarised into the themes that actually drive people to stay or to leave."
        title="Retention Register"
      />

      <div className="mt-5 flex items-start gap-3 border border-slate-800 bg-slate-900 px-4 py-3">
        <ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-orange-400" />
        <p className="text-[11px] font-semibold leading-relaxed text-slate-200">
          <span className="font-black text-white">Confidential.</span> This register is readable by
          the Super Admin and the CEO only. It is not
          visible to the {displayTitleForRole("HR Operations")}, to a line manager, or to the
          person&apos;s own team — say so when you open the conversation.
        </p>
      </div>

      {data && !data.schemaReady ? (
        <div className="mt-5 flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-[11px] font-semibold leading-relaxed text-amber-900">
            The retention tables have not reached this environment yet, so nothing is shown below.
            This is not an empty register — it is a database that has not been migrated.
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="mt-5 flex items-start gap-3 border border-rose-200 bg-rose-50 px-4 py-3" role="alert">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
          <p className="text-[11px] font-semibold leading-relaxed text-rose-900">{error}</p>
        </div>
      ) : null}

      {stats ? (
        <div className="mt-5 grid grid-cols-2 gap-px bg-slate-200 sm:grid-cols-3 lg:grid-cols-5">
          <MetricTile
            label="Stay discussions"
            sub="last 12 months"
            tone="emerald"
            value={stats.stayCount.toLocaleString("en-US")}
          />
          <MetricTile
            label="Exit interviews"
            sub="last 12 months"
            tone="slate"
            value={stats.exitCount.toLocaleString("en-US")}
          />
          <MetricTile
            label="Exit coverage"
            sub={
              stats.exitCoveragePercent === null
                ? "no departures yet"
                : `of ${stats.resignationsInWindow} who left`
            }
            tone={
              stats.exitCoveragePercent !== null && stats.exitCoveragePercent < 60 ? "amber" : "emerald"
            }
            /* Null, not 0% — a rate over an empty base is a lie, not a zero. */
            value={stats.exitCoveragePercent === null ? "—" : `${stats.exitCoveragePercent}%`}
          />
          <MetricTile
            label="Regrettable exits"
            sub="people we wanted to keep"
            tone={stats.regrettableExits > 0 ? "rose" : "slate"}
            value={stats.regrettableExits.toLocaleString("en-US")}
          />
          <MetricTile
            label="Overdue follow-ups"
            sub="promised and not done"
            tone={stats.overdueFollowUps > 0 ? "rose" : "slate"}
            value={stats.overdueFollowUps.toLocaleString("en-US")}
          />
        </div>
      ) : null}

      {/* THE ROLL-UP — the answer, above the evidence. */}
      <section className="mt-5 border border-slate-200 bg-white">
        <header className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <MessageSquareQuote aria-hidden="true" className="h-4 w-4 shrink-0 text-orange-500" />
          <h2 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-700">
            Themes — what holds people, and what pushes them out
          </h2>
        </header>

        {rollup.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12px] font-semibold text-slate-500">
            No themes recorded yet. They appear here as conversations are captured.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rollup.map((row) => (
              <li className="px-4 py-3" key={row.themeKey}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[13px] font-black text-slate-900">{row.label}</p>
                  <p className="text-[11px] font-bold tabular-nums text-slate-500">
                    {row.stayDriverCount} holding · {row.exitBlockerCount} pushing out
                  </p>
                </div>
                <div className="mt-2 flex h-2 w-full overflow-hidden bg-slate-100">
                  <div
                    className="bg-emerald-500"
                    style={{
                      width: `${maxRollup > 0 ? (row.driverCount / maxRollup) * 100 : 0}%`,
                    }}
                    title={`${row.driverCount} named this as a driver`}
                  />
                  <div
                    className="bg-rose-500"
                    style={{
                      width: `${maxRollup > 0 ? (row.blockerCount / maxRollup) * 100 : 0}%`,
                    }}
                    title={`${row.blockerCount} named this as a blocker`}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {([
            { key: "all", label: "All" },
            { key: "stay", label: "Stay discussions" },
            { key: "exit", label: "Exit interviews" },
          ] as { key: KindFilter; label: string }[]).map((option) => (
            <button
              aria-pressed={kindFilter === option.key}
              className={`whitespace-nowrap border px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.1em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                kindFilter === option.key
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
              }`}
              key={option.key}
              onClick={() => setKindFilter(option.key)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>

        {canRecord ? (
          <button
            className="inline-flex items-center gap-2 whitespace-nowrap border border-orange-500 bg-orange-500 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.1em] text-white transition-colors hover:bg-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
            onClick={() => setComposerOpen((open) => !open)}
            type="button"
          >
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            {composerOpen ? "Close" : "Record a conversation"}
          </button>
        ) : null}
      </div>

      {composerOpen && canRecord ? (
        <form
          className="mt-4 border border-slate-300 bg-white px-4 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-600"
                htmlFor="retention-kind"
              >
                Kind of conversation
              </label>
              <select
                className={`${phxSelectClassName} mt-2`}
                id="retention-kind"
                onChange={(event) =>
                  setForm((c) => ({ ...c, kind: event.target.value as RetentionConversationKind }))
                }
                value={form.kind}
              >
                <option value="stay">Stay discussion — still employed</option>
                <option value="exit">Exit interview — leaving</option>
              </select>
            </div>

            <div>
              <label
                className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-600"
                htmlFor="retention-hr-id"
              >
                Employee HR ID
              </label>
              <input
                className={`${phxFieldClassName} mt-2`}
                id="retention-hr-id"
                onChange={(event) => setForm((c) => ({ ...c, employeeHrId: event.target.value }))}
                placeholder="A-1"
                required
                value={form.employeeHrId}
              />
            </div>

            <div>
              <label
                className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-600"
                htmlFor="retention-date"
              >
                Held on
              </label>
              <input
                className={`${phxFieldClassName} mt-2 tabular-nums`}
                id="retention-date"
                onChange={(event) => setForm((c) => ({ ...c, conductedOn: event.target.value }))}
                required
                type="date"
                value={form.conductedOn}
              />
            </div>

            {form.kind === "stay" ? (
              <div>
                <label
                  className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-600"
                  htmlFor="retention-risk"
                >
                  Retention risk
                </label>
                <select
                  className={`${phxSelectClassName} mt-2`}
                  id="retention-risk"
                  onChange={(event) =>
                    setForm((c) => ({ ...c, retentionRisk: event.target.value as RetentionRisk }))
                  }
                  value={form.retentionRisk}
                >
                  <option value="low">Low — settled</option>
                  <option value="medium">Medium — worth watching</option>
                  <option value="high">High — likely to leave</option>
                </select>
              </div>
            ) : (
              <>
                <div>
                  <label
                    className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-600"
                    htmlFor="retention-regrettable"
                  >
                    Regrettable?
                  </label>
                  <select
                    className={`${phxSelectClassName} mt-2`}
                    id="retention-regrettable"
                    onChange={(event) =>
                      setForm((c) => ({ ...c, isRegrettable: event.target.value as "yes" | "no" }))
                    }
                    value={form.isRegrettable}
                  >
                    <option value="yes">Yes — we wanted to keep them</option>
                    <option value="no">No</option>
                  </select>
                </div>
                <div>
                  <label
                    className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-600"
                    htmlFor="retention-rejoin"
                  >
                    Would they rejoin?
                  </label>
                  <select
                    className={`${phxSelectClassName} mt-2`}
                    id="retention-rejoin"
                    onChange={(event) =>
                      setForm((c) => ({
                        ...c,
                        wouldRejoin: event.target.value as "yes" | "no" | "unknown",
                      }))
                    }
                    value={form.wouldRejoin}
                  >
                    <option value="unknown">Not asked</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </div>
              </>
            )}
          </div>

          <div className="mt-4">
            <label
              className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-600"
              htmlFor="retention-summary"
            >
              What was said
            </label>
            <textarea
              className={`${phxTextareaClassName} mt-2 leading-relaxed`}
              id="retention-summary"
              onChange={(event) => setForm((c) => ({ ...c, summary: event.target.value }))}
              required
              rows={4}
              value={form.summary}
            />
          </div>

          <fieldset className="mt-4">
            <legend className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-600">
              Themes — mark each one that came up
            </legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(data?.themes ?? []).map((theme) => (
                <div
                  className="flex items-center justify-between gap-2 border border-slate-200 bg-slate-50 px-2 py-1.5"
                  key={theme.themeKey}
                >
                  <label
                    className="min-w-0 text-[11px] font-bold text-slate-700"
                    htmlFor={`theme-${theme.themeKey}`}
                  >
                    {theme.label}
                  </label>
                  <select
                    className={`${phxSelectClassName} shrink-0`}
                    id={`theme-${theme.themeKey}`}
                    onChange={(event) =>
                      setForm((c) => ({
                        ...c,
                        themes: {
                          ...c.themes,
                          [theme.themeKey]: event.target.value as RetentionThemeSentiment | "",
                        },
                      }))
                    }
                    value={form.themes[theme.themeKey] ?? ""}
                  >
                    <option value="">—</option>
                    <option value="driver">Holds them</option>
                    <option value="blocker">Pushes out</option>
                  </select>
                </div>
              ))}
            </div>
          </fieldset>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label
                className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-600"
                htmlFor="retention-followup"
              >
                Follow-up action (optional)
              </label>
              <input
                className={`${phxFieldClassName} mt-2`}
                id="retention-followup"
                onChange={(event) => setForm((c) => ({ ...c, followUpAction: event.target.value }))}
                value={form.followUpAction}
              />
            </div>
            <div>
              <label
                className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-600"
                htmlFor="retention-followup-due"
              >
                Follow-up due (optional)
              </label>
              <input
                className={`${phxFieldClassName} mt-2 tabular-nums`}
                id="retention-followup-due"
                onChange={(event) => setForm((c) => ({ ...c, followUpDue: event.target.value }))}
                type="date"
                value={form.followUpDue}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className="inline-flex items-center gap-2 border border-orange-500 bg-orange-500 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.1em] text-white transition-colors hover:bg-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
              type="submit"
            >
              {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : null}
              Record conversation
            </button>
            <button
              className="border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.1em] text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              onClick={() => setComposerOpen(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {conversations.length === 0 ? (
        <p className="mt-5 border border-slate-200 bg-white px-4 py-8 text-center text-[12px] font-semibold text-slate-500">
          {data?.schemaReady === false
            ? "Nothing to show until the migration reaches this environment."
            : "No conversations match this filter."}
        </p>
      ) : null}

      {/*
        DESKTOP — the table. Mobile already gets cards below, so the rule's mobile half was met;
        the desktop half was not. This was `overflow-x-auto` over a `min-w-[60rem]` floor with
        `whitespace-nowrap` cells — 960px of table, which is more than the content column has at
        768px (where the sidebar first appears) or in a 1024px window, so the Signal, Themes and
        Follow-up columns sat behind a sideways scroll on exactly the widths a laptop uses.

        Per the golden rule (AGENTS.md §4): `table-fixed` with a `<colgroup>`, no floor, and the
        free-text cells wrap. The chips keep `whitespace-nowrap` deliberately — text inside a
        control stays on one line and the ROW wraps around it, which is the house pattern.
      */}
      {conversations.length > 0 ? (
        <div className="mt-5 hidden border border-slate-200 bg-white md:block">
          <table className="w-full table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-[24%]" />
              <col className="w-[11%]" />
              <col className="w-[12%]" />
              <col className="w-[15%]" />
              <col className="w-[22%]" />
              <col className="w-[16%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                {["Employee", "Kind", "Held on", "Signal", "Themes", "Follow-up"].map((heading) => (
                  <th
                    className="break-words px-4 py-3 text-[10px] font-black uppercase tracking-[0.12em] text-slate-500"
                    key={heading}
                    scope="col"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {conversations.map((conversation) => (
                <tr className="border-b border-slate-100" key={conversation.id}>
                  <td className="break-words px-4 py-3">
                    <p className="break-words text-[13px] font-black text-slate-900">
                      {conversation.employeeName}
                    </p>
                    <p className="break-words text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
                      {conversation.jobTitle ?? "—"}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <KindChip kind={conversation.kind} />
                  </td>
                  <td className="break-words px-4 py-3 text-[12px] font-semibold tabular-nums text-slate-700">
                    {formatDate(conversation.conductedOn)}
                  </td>
                  <td className="px-4 py-3">
                    {conversation.retentionRisk ? (
                      <span
                        className={`inline-flex whitespace-nowrap border px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] ${RISK_CLASS[conversation.retentionRisk]}`}
                      >
                        {conversation.retentionRisk} risk
                      </span>
                    ) : conversation.isRegrettable ? (
                      <span className="inline-flex whitespace-nowrap border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-rose-800">
                        Regrettable
                      </span>
                    ) : (
                      <span className="inline-flex whitespace-nowrap border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-600">
                        Not regrettable
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {conversation.themes.map((theme) => (
                        <span
                          className={`whitespace-nowrap border px-1.5 py-0.5 text-[10px] font-bold ${
                            theme.sentiment === "driver"
                              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                              : "border-rose-200 bg-rose-50 text-rose-800"
                          }`}
                          key={`${theme.themeKey}-${theme.sentiment}`}
                        >
                          {theme.label}
                        </span>
                      ))}
                      {conversation.themes.length === 0 ? (
                        <span className="text-[11px] font-semibold text-slate-400">None</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="break-words px-4 py-3 text-[11px] font-semibold text-slate-700">
                    {conversation.followUpAction ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <span
                          className={
                            conversation.followUpOverdue ? "font-black text-rose-700" : undefined
                          }
                        >
                          {conversation.followUpDoneAt
                            ? "Done"
                            : conversation.followUpOverdue
                              ? `Overdue ${formatDate(conversation.followUpDue)}`
                              : `Due ${formatDate(conversation.followUpDue)}`}
                        </span>
                        {canUpdate ? (
                          <button
                            className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.08em] text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={busy}
                            onClick={() =>
                              void markFollowUp(conversation.id, !conversation.followUpDoneAt)
                            }
                            type="button"
                          >
                            {conversation.followUpDoneAt ? "Reopen" : "Mark done"}
                          </button>
                        ) : null}
                      </span>
                    ) : (
                      "None"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* MOBILE — cards, never a table. */}
      <div className="mt-5 grid gap-3 md:hidden">
        {conversations.map((conversation) => (
          <ConversationCard
            busy={busy}
            canUpdate={canUpdate}
            conversation={conversation}
            key={conversation.id}
            onMarkFollowUp={markFollowUp}
          />
        ))}
      </div>
    </div>
  );
}

function ConversationCard({
  busy,
  canUpdate,
  conversation,
  onMarkFollowUp,
}: {
  busy: boolean;
  canUpdate: boolean;
  conversation: RetentionConversation;
  onMarkFollowUp: (id: string, done: boolean) => Promise<void>;
}) {
  return (
    <div className="border border-slate-200 bg-white px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14px] font-black leading-tight text-slate-900">
            {conversation.employeeName}
          </p>
          <p className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
            {conversation.jobTitle ?? "—"}
          </p>
        </div>
        <KindChip kind={conversation.kind} />
      </div>

      <p className="mt-2 text-[11px] font-bold tabular-nums text-slate-600">
        {formatDate(conversation.conductedOn)}
        {conversation.conductedByName ? ` · by ${conversation.conductedByName}` : ""}
      </p>

      {conversation.retentionRisk ? (
        <span
          className={`mt-2 inline-flex whitespace-nowrap border px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] ${RISK_CLASS[conversation.retentionRisk]}`}
        >
          {conversation.retentionRisk} risk
        </span>
      ) : conversation.isRegrettable ? (
        <span className="mt-2 inline-flex whitespace-nowrap border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-rose-800">
          Regrettable
        </span>
      ) : null}

      <p className="mt-2 text-[12px] font-semibold leading-relaxed text-slate-700">
        {conversation.summary}
      </p>

      {conversation.themes.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {conversation.themes.map((theme) => (
            <span
              className={`whitespace-nowrap border px-1.5 py-0.5 text-[10px] font-bold ${
                theme.sentiment === "driver"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-rose-200 bg-rose-50 text-rose-800"
              }`}
              key={`${theme.themeKey}-${theme.sentiment}`}
            >
              {theme.label}
            </span>
          ))}
        </div>
      ) : null}

      {conversation.followUpAction ? (
        <p
          className={`mt-3 border-t border-slate-100 pt-2 text-[11px] font-semibold ${
            conversation.followUpOverdue ? "text-rose-700" : "text-slate-600"
          }`}
        >
          <span className="font-black uppercase tracking-[0.1em]">Follow-up · </span>
          {conversation.followUpAction}
          {conversation.followUpDoneAt
            ? " (done)"
            : conversation.followUpDue
              ? ` (due ${formatDate(conversation.followUpDue)})`
              : ""}
          {canUpdate ? (
            <button
              className="ml-2 rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.08em] text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
              onClick={() => void onMarkFollowUp(conversation.id, !conversation.followUpDoneAt)}
              type="button"
            >
              {conversation.followUpDoneAt ? "Reopen" : "Mark done"}
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
