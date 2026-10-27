"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Clock3,
  Download,
  Eye,
  Gauge,
  Laptop,
  LayoutGrid,
  Loader2,
  Radio,
  RefreshCw,
  ShieldOff,
  TriangleAlert,
  Users,
  X,
  Zap,
} from "lucide-react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
} from "@/components/admin/admin-design-system";
import { useHydrated } from "@/hooks/use-hydrated";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import type {
  ActivityOverview,
  AdoptionRow,
  AdoptionStatus,
  LiveActivity,
  LoginCalendar,
  ModuleJourney,
  OnlineUser,
  RoleBenchmark,
  TimelineSession,
  UserActivitySummary,
  UserTimeline,
} from "@/lib/activity/types";
import { ENGAGEMENT_BAND_THRESHOLDS, type EngagementBand } from "@/lib/activity/engagement";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { phxFieldClassName } from "@/components/ui/form-tokens";

const RANGE_OPTIONS = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
];

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_LABELS = ["12a", "3a", "6a", "9a", "12p", "3p", "6p", "9p"];

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatMinutes(minutes: number): string {
  if (!minutes || minutes <= 0) return "0m";
  const total = Math.round(minutes);
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

// The page trail needs seconds. formatMinutes rounds a 40-second page view up to
// "1m" and a 20-second one down to "0m", which is a lie on a trail whose whole
// point is how long each page was actually looked at.
/**
 * Fold a name for searching: strip accents, lower-case, collapse whitespace.
 *
 * Deliberately NOT `addressWords` from the geo matcher — that one drops words
 * under three letters and every English address word, which is right for an
 * address and wrong for a person ("Ali" would vanish). It also keeps non-Latin
 * letters, so an Arabic spelling still matches an Arabic query.
 */
function foldForSearch(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const rest = total % 60;
  if (mins < 60) return rest ? `${mins}m ${rest}s` : `${mins}m`;
  return formatMinutes(total / 60);
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: PHOENIX_BUSINESS_TIME_ZONE });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return formatStableEnGb(new Date(iso), {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
  });
}

// formatRelative's output depends on Date.now() at render time, which differs between
// server and client — a real value mismatch, not just a formatting one. Render the
// stable absolute time until hydrated, then switch to the relative label.
function RelativeTime({ iso }: { iso: string | null }) {
  const hydrated = useHydrated();
  return <>{hydrated ? formatRelative(iso) : formatDateTime(iso)}</>;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

const BAND_STYLES: Record<EngagementBand, string> = {
  High: "border-emerald-300 bg-emerald-50 text-emerald-700",
  Moderate: "border-amber-300 bg-amber-50 text-amber-700",
  Low: "border-rose-300 bg-rose-50 text-rose-700",
};

function EngagementBadge({ band, score }: { band: EngagementBand; score: number }) {
  return (
    <span
      // `flex-wrap`, so in a narrow column the band drops under the score
      // instead of pushing the cell wider than its share of the table.
      className={`inline-flex flex-wrap items-center justify-center gap-x-1.5 rounded-full border px-2.5 py-1 text-phx-xs font-bold ${BAND_STYLES[band]}`}
      title="How much Phoenix was used: hands-on minutes against this person's own working days, plus how many modules they opened and how regularly they came back. A usage signal, not a measure of their work."
    >
      <span className="tabular-nums">{score}</span>
      <span className="uppercase tracking-wide">{band}</span>
    </span>
  );
}

function NoDataChip() {
  return (
    <span
      className="inline-flex items-center rounded-full border border-phx-line bg-phx-paper px-2.5 py-1 text-phx-xs font-semibold text-phx-ink-soft"
      title="No page-view activity recorded yet. Tracking only captures navigation going forward."
    >
      No data yet
    </span>
  );
}

function SectionCard({
  icon,
  title,
  description,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[14px] border border-phx-line bg-white shadow-[0_8px_22px_rgba(15,23,42,0.04)]">
      <div className="flex flex-col gap-3 border-b border-[#EEF2F7] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-[#FFF4EA] text-phx-accent-hover">
            {icon}
          </span>
          <div>
            <h2 className="text-sm font-black tracking-tight text-phx-ink">{title}</h2>
            {description ? <p className="text-xs text-phx-ink-soft">{description}</p> : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

const ADOPTION_TONE: Record<AdoptionStatus, string> = {
  active: "text-emerald-700",
  dormant: "text-amber-700",
  never: "text-rose-700",
};

// ── Login-frequency calendar ─────────────────────────────────────────────────
//
// Every date here arrives already bucketed by CAIRO day from the server, over a
// fixed 90-day window of its own. This component therefore holds NO clock: it
// used to key sessions on the UTC date, grid from browser-local `Date`s, and
// compare "today" against `new Date()`, which put the today-ring on yesterday
// between 00:00 and 03:00 Cairo — the hours the owner actually works. It was
// also labelled "last 3 months" while being fed the range picker's 1, 7 or 30
// days, so the empty remainder of the grid read as "never logged in".
//
// The only `Date` used below is a CARRIER built from an explicit Y-M-D triple
// and read back in UTC, purely to name a weekday or a month. It never reads the
// machine's clock or its time zone.

/** A UTC-anchored carrier date for a `YYYY-MM-DD` key — no local time zone, no clock. */
function carrierDateFor(dateIso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

type CalendarCell = { dateIso: string; logins: number; dayOfMonth: number; carrier: Date };

function HeatmapCalendar({ calendar }: { calendar: LoginCalendar }) {
  const { max, weeks } = useMemo(() => {
    const cells: (CalendarCell | null)[] = [];
    let highest = 1;
    let leadingBlanks: number | null = null;

    for (const entry of calendar.counts) {
      const carrier = carrierDateFor(entry.dateIso);
      if (!carrier) continue;
      // Pad the first week so column 1 starts on a Sunday, exactly as the row
      // labels below claim. The pad is derived from the first real date, never
      // from today.
      if (leadingBlanks === null) {
        leadingBlanks = carrier.getUTCDay();
        for (let i = 0; i < leadingBlanks; i += 1) cells.push(null);
      }
      if (entry.logins > highest) highest = entry.logins;
      cells.push({
        carrier,
        dateIso: entry.dateIso,
        dayOfMonth: carrier.getUTCDate(),
        logins: entry.logins,
      });
    }

    const grid: (CalendarCell | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) grid.push(cells.slice(i, i + 7));
    return { max: highest, weeks: grid };
  }, [calendar]);

  function cellColor(count: number): string {
    if (!count) return "bg-slate-100";
    const ratio = count / max;
    if (ratio < 0.25) return "bg-orange-200";
    if (ratio < 0.5) return "bg-orange-300";
    if (ratio < 0.75) return "bg-orange-400";
    return "bg-orange-600";
  }

  return (
    <div>
      <p className="mb-0.5 text-phx-2xs font-bold uppercase tracking-wide text-phx-ink-faint">
        Login frequency — last {calendar.days} days (Cairo)
      </p>
      <p className="mb-2 text-phx-2xs text-phx-ink-faint">
        This calendar keeps its own {calendar.days}-day window and does not follow the range picker above.
      </p>
      <div className="flex gap-0.5">
        {/* Day labels */}
        <div className="flex flex-col gap-0.5 pr-1.5 pt-4">
          {WEEKDAY_LABELS.map((d) => (
            <div key={d} className="h-3 text-phx-3xs leading-3 text-phx-ink-faint">{d}</div>
          ))}
        </div>
        {/* Week columns */}
        {weeks.map((week, wi) => {
          const monthStart = week.find((cell) => cell && cell.dayOfMonth <= 7);
          return (
            <div key={week.find(Boolean)?.dateIso ?? `week-${wi}`} className="flex flex-col gap-0.5">
              <div className="h-3 text-phx-3xs leading-3 text-phx-ink-faint">
                {monthStart ? formatStableEnGb(monthStart.carrier, { month: "short", timeZone: "UTC" }) : ""}
              </div>
              {Array.from({ length: 7 }, (_, index) => {
                const cell = week[index] ?? null;
                if (!cell) return <div key={`blank-${wi}-${index}`} className="h-3 w-3" />;
                const isToday = cell.dateIso === calendar.todayKey;
                return (
                  <div
                    key={cell.dateIso}
                    className={`h-3 w-3 rounded-sm ${cellColor(cell.logins)} ${isToday ? "ring-1 ring-orange-500" : ""}`}
                    title={`${formatStableEnGb(cell.carrier, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}: ${cell.logins} login${cell.logins === 1 ? "" : "s"}`}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-phx-2xs text-phx-ink-faint">
        <span>Less</span>
        {["bg-slate-100", "bg-orange-200", "bg-orange-300", "bg-orange-400", "bg-orange-600"].map((c) => (
          <div key={c} className={`h-3 w-3 rounded-sm ${c}`} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

// ── Time-of-Day heatmap (7 weekdays × 24 hours) ───────────────────────────────

function TimeOfDayHeatmap({ hourlyHeatmap }: { hourlyHeatmap: number[][] }) {
  const max = useMemo(() => Math.max(1, ...hourlyHeatmap.flatMap((row) => row)), [hourlyHeatmap]);

  function cellColor(count: number): string {
    if (!count) return "bg-slate-100";
    const ratio = count / max;
    if (ratio < 0.2) return "bg-blue-100";
    if (ratio < 0.4) return "bg-blue-200";
    if (ratio < 0.6) return "bg-blue-400";
    if (ratio < 0.8) return "bg-blue-500";
    return "bg-blue-700";
  }

  // A fluid 25-column grid — one label column plus 24 equal hour columns that
  // divide whatever width the card has. It was a row of fixed 20px cells inside
  // an `overflow-x-auto`, which is the anti-pattern the fits-the-screen golden
  // rule names by name: it scrolled sideways on a phone instead of fitting.
  return (
    <div className="px-5 py-4">
      <div className="grid grid-cols-[2.25rem_repeat(24,minmax(0,1fr))] gap-0.5">
        {/* Hour labels — every 6 hours on a phone, every 3 from `sm` up. Each of
            the 24 cells stays in the grid so the columns never shift; only the
            text inside it appears or not. */}
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={`hour-${h}`} className="text-center text-phx-4xs leading-3 text-phx-ink-faint">
            <span className={h % 6 === 0 ? "" : "hidden sm:inline"}>
              {h % 3 === 0 ? HOUR_LABELS[h / 3] : ""}
            </span>
          </div>
        ))}
        {/* Rows */}
        {WEEKDAY_LABELS.map((day, wi) => (
          <Fragment key={day}>
            <div className="self-center pr-1 text-right text-phx-2xs text-phx-ink-soft">{day}</div>
            {hourlyHeatmap[wi].map((count, h) => (
              <div
                key={`${day}-${h}`}
                className={`aspect-square w-full rounded-sm ${cellColor(count)}`}
                title={`${day} ${h}:00 — ${count} login${count === 1 ? "" : "s"}`}
              />
            ))}
          </Fragment>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-phx-2xs text-phx-ink-faint">
        <span>Quiet</span>
        {["bg-slate-100", "bg-blue-100", "bg-blue-200", "bg-blue-400", "bg-blue-700"].map((c) => (
          <div key={c} className={`h-3 w-3 rounded-sm ${c}`} />
        ))}
        <span>Busy</span>
        {/* Not "EET": Egypt is on EEST from late April to late October, so that
            abbreviation was wrong for half of every year. */}
        <span className="ml-2">· Cairo time</span>
      </div>
    </div>
  );
}

// ── Role benchmarks table ─────────────────────────────────────────────────────

function scoreBarColor(score: number): string {
  if (score >= ENGAGEMENT_BAND_THRESHOLDS.high) return "bg-emerald-500";
  if (score >= ENGAGEMENT_BAND_THRESHOLDS.moderate) return "bg-amber-400";
  return "bg-rose-400";
}

function EngagementBar({ score }: { score: number }) {
  if (score <= 0) return <span className="text-phx-ink-faint">—</span>;
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 tabular-nums font-semibold text-phx-ink">{score}</span>
      <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-phx-paper-2">
        <span className={`block h-full rounded-full ${scoreBarColor(score)}`} style={{ width: `${score}%` }} />
      </span>
    </div>
  );
}

function RoleBenchmarksTable({ benchmarks }: { benchmarks: RoleBenchmark[] }) {
  if (!benchmarks.length) {
    return <p className="px-5 py-8 text-center text-sm text-phx-ink-faint">No data yet.</p>;
  }

  return (
    <>
      {/* A phone never gets a table (admin-shell rule). */}
      <ul className="divide-y divide-phx-paper-2 md:hidden">
        {benchmarks.map((b) => (
          <li key={b.role} className="min-w-0 px-4 py-3">
            <p className="break-words text-sm font-semibold text-phx-ink">{b.role}</p>
            <p className="break-words text-phx-xs text-phx-ink-soft">
              {b.userCount} {b.userCount === 1 ? "person" : "people"} · session {formatMinutes(b.avgSessionMinutes)} · active{" "}
              {formatMinutes(b.avgActiveMinutes)}
            </p>
            <div className="mt-1.5">
              <EngagementBar score={b.avgEngagementScore} />
            </div>
          </li>
        ))}
      </ul>

      {/* `table-fixed` + a percentage colgroup, never a min-width floor inside an
          overflow wrapper: the score and its bar are now ONE merged column, which
          is what let the stray `colSpan={2}` header and the never-visible second
          bar underneath it go. */}
      <div className="hidden md:block">
        <table className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-[32%]" />
            <col className="w-[12%]" />
            <col className="w-[18%]" />
            <col className="w-[18%]" />
            <col className="w-[20%]" />
          </colgroup>
          <thead>
            <tr>
              <th className="px-4 py-2 text-left align-bottom">Role</th>
              <th className="px-4 py-2 text-right align-bottom">People</th>
              <th className="px-4 py-2 text-right align-bottom">Avg session span</th>
              <th className="px-4 py-2 text-right align-bottom">Avg active</th>
              <th className="px-4 py-2 text-left align-bottom">Avg engagement</th>
            </tr>
          </thead>
          <tbody>
            {benchmarks.map((b) => (
              <tr key={b.role} className="border-t border-phx-paper-2 align-top">
                <td className="px-4 py-2 break-words font-semibold text-phx-ink">{b.role}</td>
                <td className="px-4 py-2 text-right tabular-nums text-phx-ink-2">{b.userCount}</td>
                <td className="px-4 py-2 text-right tabular-nums text-phx-ink-2">{formatMinutes(b.avgSessionMinutes)}</td>
                <td className="px-4 py-2 text-right tabular-nums font-semibold text-phx-ink">{formatMinutes(b.avgActiveMinutes)}</td>
                <td className="px-4 py-2">
                  <EngagementBar score={b.avgEngagementScore} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Who's online now ─────────────────────────────────────────────────────────

type ForceLogoutHandler = (target: { name: string; hrId: string }) => void;

function LogoutButton({ user, onForceLogout }: { user: OnlineUser; onForceLogout: ForceLogoutHandler }) {
  if (!user.hrId) return null;
  const hrId = user.hrId;
  return (
    <button
      type="button"
      onClick={() => onForceLogout({ name: user.name, hrId })}
      className="inline-flex items-center gap-1 rounded-full border border-phx-danger-line px-2.5 py-1 text-phx-xs font-semibold text-phx-danger transition hover:bg-phx-danger-bg"
      title="Force logout this user"
    >
      <ShieldOff className="h-3 w-3" /> Logout
    </button>
  );
}

function OnlineCards({ users, onForceLogout }: { users: OnlineUser[]; onForceLogout: ForceLogoutHandler }) {
  return (
    <ul className="divide-y divide-phx-paper-2 md:hidden">
      {users.map((user) => (
        <li key={`${user.key}-${user.startedAt}`} className="min-w-0 px-4 py-3">
          <div className="flex items-start gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-phx-ink text-phx-2xs font-bold text-white">
              {initialsFor(user.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-semibold text-phx-ink">{user.name}</p>
              <p className="break-words text-phx-xs text-phx-ink-soft">{user.role}</p>
              <p className="mt-1 break-words text-phx-xs text-phx-ink-2">
                {user.currentModule ?? "No module open"} · <RelativeTime iso={user.lastSeenAt} />
              </p>
              <div className="mt-2">
                <LogoutButton user={user} onForceLogout={onForceLogout} />
              </div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function OnlineTable({ users, onForceLogout }: { users: OnlineUser[]; onForceLogout: ForceLogoutHandler }) {
  return (
    // "Last active" is merged under Current module rather than given a column of
    // its own — the fits-the-screen rule buys width by MERGING columns, never by
    // shrinking type or letting the card scroll sideways.
    <div className="hidden md:block">
      <table className="w-full table-fixed border-collapse text-sm">
        {/* 26% for the action column, not 24%: at 478px — this card's narrowest
            state, half of a two-up grid at 1280 — the Logout chip is an
            inline-flex box that does not fit less. */}
        <colgroup>
          <col className="w-[38%]" />
          <col className="w-[36%]" />
          <col className="w-[26%]" />
        </colgroup>
        <thead>
          <tr>
            <th className="px-4 py-2 text-left align-bottom">User</th>
            <th className="px-4 py-2 text-left align-bottom">Current module</th>
            <th className="px-4 py-2 text-right align-bottom">Session</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={`${user.key}-${user.startedAt}`} className="align-top">
              <td className="px-4 py-2">
                <div className="flex items-start gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-phx-ink text-phx-2xs font-bold text-white">
                    {initialsFor(user.name)}
                  </span>
                  <div className="min-w-0">
                    <p className="break-words font-semibold text-phx-ink">{user.name}</p>
                    <p className="break-words text-phx-xs text-phx-ink-soft">{user.role}</p>
                  </div>
                </div>
              </td>
              <td className="px-4 py-2 break-words text-phx-ink-2">
                {user.currentModule ?? "—"}
                <span className="block text-phx-xs text-phx-ink-soft">
                  Last active <RelativeTime iso={user.lastSeenAt} />
                </span>
              </td>
              <td className="px-4 py-2 text-right">
                <LogoutButton user={user} onForceLogout={onForceLogout} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── People — engagement & usage ──────────────────────────────────────────────

const SESSION_SPAN_TITLE =
  "Session span is how long the login itself stayed alive — a tab left open all evening counts in full. It is not hands-on time; the Active figure is.";

function PeopleUsage({
  users,
  onOpenTimeline,
}: {
  users: UserActivitySummary[];
  onOpenTimeline: (user: UserActivitySummary) => void;
}) {
  function nameCell(user: UserActivitySummary) {
    if (!user.hrId) return <span className="break-words font-semibold text-phx-ink">{user.name}</span>;
    return (
      // The name IS the timeline control — that retired a whole action column,
      // which is how this table went from nine columns to five without shrinking
      // any type.
      <button
        type="button"
        onClick={() => onOpenTimeline(user)}
        className="inline-flex items-start gap-1 break-words text-left font-semibold text-phx-accent-press transition hover:underline"
      >
        <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="break-words">{user.name}</span>
      </button>
    );
  }

  return (
    <>
      <ul className="divide-y divide-phx-paper-2 lg:hidden">
        {users.map((user) => (
          <li key={user.key} className="min-w-0 px-4 py-3">
            <p className="break-words text-sm">{nameCell(user)}</p>
            <p className="break-words text-phx-xs text-phx-ink-soft">
              {user.role}
              {user.team ? ` · ${user.team}` : ""}
            </p>
            <p className="mt-1.5 break-words text-phx-xs text-phx-ink-2">
              <span className="font-semibold text-phx-ink">
                {user.pageViews > 0 ? formatMinutes(user.activeMinutes) : "—"} active
              </span>{" "}
              · {formatMinutes(user.sessionMinutes)} session span · seen <RelativeTime iso={user.lastSeenAt} />
            </p>
            <p className="break-words text-phx-xs text-phx-ink-2">
              {user.sessions} {user.sessions === 1 ? "login" : "logins"} · {user.distinctModules}{" "}
              {user.distinctModules === 1 ? "module" : "modules"} · top module {user.topModule ?? "—"}
            </p>
            <div className="mt-2">
              {user.pageViews > 0 ? (
                <EngagementBadge band={user.engagement.band} score={user.engagement.score} />
              ) : (
                <NoDataChip />
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="hidden lg:block">
        <table className="w-full table-fixed border-collapse text-sm">
          {/* 17% for Engagement, not the 12% first drafted: the band chip is an
              inline-flex box and "MODERATE", 11px bold capitals with the chip's
              own padding, does not fit in less. Top module gives up the width —
              a module label wraps, a chip does not. */}
          <colgroup>
            <col className="w-[30%]" />
            <col className="w-[19%]" />
            <col className="w-[15%]" />
            <col className="w-[19%]" />
            <col className="w-[17%]" />
          </colgroup>
          <thead>
            <tr>
              <th className="px-4 py-2 text-left align-bottom">Employee</th>
              <th className="px-4 py-2 text-right align-bottom">Time</th>
              <th className="px-4 py-2 text-right align-bottom">Usage</th>
              <th className="px-4 py-2 text-left align-bottom">Top module</th>
              <th className="px-2 py-2 text-center align-bottom">Engagement</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.key} className="align-top">
                <td className="px-4 py-2">
                  <p className="break-words">{nameCell(user)}</p>
                  <p className="break-words text-phx-xs text-phx-ink-soft">
                    {user.role}
                    {user.team ? ` · ${user.team}` : ""}
                  </p>
                </td>
                <td className="px-4 py-2 text-right text-phx-ink-2">
                  <span className="block tabular-nums font-semibold text-phx-ink">
                    {user.pageViews > 0 ? formatMinutes(user.activeMinutes) : "—"} active
                  </span>
                  <span className="block text-phx-xs tabular-nums" title={SESSION_SPAN_TITLE}>
                    {formatMinutes(user.sessionMinutes)} session span
                  </span>
                  <span className="block text-phx-xs text-phx-ink-soft">
                    seen <RelativeTime iso={user.lastSeenAt} />
                  </span>
                </td>
                <td className="px-4 py-2 text-right text-phx-ink-2">
                  <span className="block tabular-nums">
                    {user.sessions} {user.sessions === 1 ? "login" : "logins"}
                  </span>
                  <span className="block text-phx-xs tabular-nums">
                    {user.distinctModules} {user.distinctModules === 1 ? "module" : "modules"}
                  </span>
                </td>
                <td className="px-4 py-2 break-words text-phx-ink-2">{user.topModule ?? "—"}</td>
                <td className="px-2 py-2 text-center">
                  {user.pageViews > 0 ? (
                    <EngagementBadge band={user.engagement.band} score={user.engagement.score} />
                  ) : (
                    <NoDataChip />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Adoption — who isn't using the system ────────────────────────────────────

function AdoptionList({ rows }: { rows: AdoptionRow[] }) {
  function statusLabel(row: AdoptionRow) {
    return row.status === "never" ? "Never (90d)" : row.status;
  }

  return (
    <>
      <ul className="divide-y divide-phx-paper-2 md:hidden">
        {rows.map((row) => (
          <li key={row.key} className="min-w-0 px-4 py-3">
            <p className="break-words text-sm font-semibold text-phx-ink">{row.name}</p>
            <p className="break-words text-phx-xs text-phx-ink-soft">{row.role}</p>
            <p className={`mt-1 break-words text-phx-xs font-semibold capitalize ${ADOPTION_TONE[row.status]}`}>
              {statusLabel(row)}
              <span className="font-normal text-phx-ink-soft">
                {" "}
                · last seen <RelativeTime iso={row.lastSeenAt} />
              </span>
            </p>
          </li>
        ))}
      </ul>

      <div className="hidden md:block">
        <table className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-[46%]" />
            <col className="w-[26%]" />
            <col className="w-[28%]" />
          </colgroup>
          <thead>
            <tr>
              <th className="px-4 py-2 text-left align-bottom">Employee</th>
              <th className="px-4 py-2 text-left align-bottom">Status</th>
              <th className="px-4 py-2 text-right align-bottom">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="align-top">
                <td className="px-4 py-2">
                  <p className="break-words font-semibold text-phx-ink">{row.name}</p>
                  <p className="break-words text-phx-xs text-phx-ink-soft">{row.role}</p>
                </td>
                <td className={`px-4 py-2 break-words font-semibold capitalize ${ADOPTION_TONE[row.status]}`}>
                  {statusLabel(row)}
                </td>
                <td className="px-4 py-2 text-right text-phx-ink-soft">
                  <RelativeTime iso={row.lastSeenAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Force-logout confirmation dialog ─────────────────────────────────────────

function ForceLogoutDialog({
  name,
  onConfirm,
  onCancel,
  isPending,
}: {
  name: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [reason, setReason] = useState("Security review");
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-[14px] bg-white shadow-2xl">
        <div className="border-b border-[#EEF2F7] px-5 py-4">
          <p className="text-phx-2xs font-black uppercase tracking-[0.2em] text-rose-500">Force logout</p>
          <h3 className="mt-0.5 text-base font-black text-phx-ink">{name}</h3>
          <p className="mt-1 text-xs text-phx-ink-soft">
            All active sessions for this person will be immediately terminated. They will be asked to log in again on their next action. The Phoenix app on their phone stops showing notifications until they sign in again.
          </p>
        </div>
        <div className="px-5 py-4 space-y-3">
          <label className="block">
            <span className="text-phx-xs font-bold uppercase tracking-wide text-phx-ink-soft">Reason (logged to audit trail)</span>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={`${phxFieldClassName} mt-1`}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={isPending}
              className="flex-1 rounded-[8px] border border-phx-line py-2 text-sm font-semibold text-phx-ink-soft transition hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onConfirm(reason)}
              disabled={isPending || !reason.trim()}
              className="flex-1 rounded-[8px] bg-rose-600 py-2 text-sm font-bold text-white transition hover:bg-rose-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldOff className="h-4 w-4" />}
              Force logout
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// What happened to the Phoenix app's notifications on the person's phones. null means the server
// could not get through that step at all; the sessions are revoked either way.
function phoneAppPushNote(phonePush: { failed: number; stopped: number } | null | undefined) {
  if (phonePush === undefined) return "";
  if (phonePush === null) return " The Phoenix app's notifications on their phone could not be stopped; press Force logout again to retry.";
  const notes: string[] = [];
  if (phonePush.stopped > 0) notes.push(`Phoenix app notifications stopped on ${phonePush.stopped} phone${phonePush.stopped === 1 ? "" : "s"}.`);
  if (phonePush.failed > 0) notes.push(`${phonePush.failed} phone${phonePush.failed === 1 ? "" : "s"} could not be stopped; press Force logout again to retry.`);
  return notes.length ? ` ${notes.join(" ")}` : "";
}

// ── Main component ───────────────────────────────────────────────────────────

export function ActivityControlDashboard({
  initialOverview,
  initialError,
  initialDays,
}: {
  initialOverview: ActivityOverview | null;
  initialError: string | null;
  initialDays: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const [peopleQuery, setPeopleQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<UserActivitySummary | null>(null);
  const [timeline, setTimeline] = useState<UserTimeline | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);

  // Live feed state
  const [liveData, setLiveData] = useState<LiveActivity | null>(null);
  const liveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Force-logout state
  const [forceLogoutTarget, setForceLogoutTarget] = useState<{ name: string; hrId: string } | null>(null);
  const [forceLogoutPending, setForceLogoutPending] = useState(false);
  const [forceLogoutFeedback, setForceLogoutFeedback] = useState<string | null>(null);

  const days = initialDays;
  const overview = initialOverview;

  // ── Live feed polling ──────────────────────────────────────────────────────
  // fetchLive is used by handleForceLogout (below) to refresh after a kick.
  const fetchLive = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/activity/live", { credentials: "same-origin" });
      if (!res.ok) return;
      const body = (await res.json()) as { live: LiveActivity };
      setLiveData(body.live);
    } catch {
      // silently degrade — live feed is non-critical
    }
  }, []);

  useEffect(() => {
    // Inline poll so the effect does not hold a direct setState call in its synchronous body.
    let active = true;
    function poll() {
      fetch("/api/admin/activity/live", { credentials: "same-origin" })
        .then((r) => (r.ok ? (r.json() as Promise<{ live: LiveActivity }>) : null))
        .then((body) => { if (active && body?.live) setLiveData(body.live); })
        .catch(() => {});
    }
    poll();
    // A hidden tab asks nothing: every tick is a sign-in check plus the live read, for a feed no one is
    // looking at. Coming back to the tab refreshes it at once, so what shows is never older than before.
    liveIntervalRef.current = setInterval(() => {
      if (document.visibilityState === "visible") poll();
    }, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      if (liveIntervalRef.current) clearInterval(liveIntervalRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // ── Force logout ───────────────────────────────────────────────────────────
  const handleForceLogout = useCallback(async (reason: string) => {
    if (!forceLogoutTarget) return;
    setForceLogoutPending(true);
    try {
      const res = await fetch("/api/admin/activity/force-logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "x-phoenix-csrf": "1" },
        body: JSON.stringify({ hrId: forceLogoutTarget.hrId, reason }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        phonePush?: { failed: number; stopped: number } | null;
        revokedCount?: number;
        message?: string;
      };
      if (!res.ok) throw new Error(body.message ?? "Force logout failed");
      setForceLogoutFeedback(`${forceLogoutTarget.name} has been logged out (${body.revokedCount ?? 0} session${(body.revokedCount ?? 0) === 1 ? "" : "s"} terminated).${phoneAppPushNote(body.phonePush)}`);
      setForceLogoutTarget(null);
      // Refresh live feed immediately.
      setTimeout(fetchLive, 1000);
    } catch (caught) {
      setForceLogoutFeedback(caught instanceof Error ? caught.message : "Force logout failed.");
    } finally {
      setForceLogoutPending(false);
    }
  }, [forceLogoutTarget, fetchLive]);

  const changeRange = useCallback(
    (nextDays: number) => {
      startTransition(() => {
        router.push(`${pathname}?days=${nextDays}`);
      });
    },
    [pathname, router],
  );

  const openTimeline = useCallback(
    async (user: UserActivitySummary) => {
      if (!user.hrId) return;
      setSelectedUser(user);
      setTimeline(null);
      setTimelineError(null);
      setTimelineLoading(true);
      try {
        const res = await fetch(`/api/admin/activity/timeline?hrId=${encodeURIComponent(user.hrId)}&days=${days}`, {
          credentials: "same-origin",
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { message?: string })?.message ?? "Failed to load timeline.");
        }
        const body = (await res.json()) as { timeline: UserTimeline };
        setTimeline(body.timeline);
      } catch (caught) {
        setTimelineError(caught instanceof Error ? caught.message : "Failed to load timeline.");
      } finally {
        setTimelineLoading(false);
      }
    },
    [days],
  );

  const rangeLabel = useMemo(
    () => RANGE_OPTIONS.find((option) => option.days === days)?.label ?? `${days} days`,
    [days],
  );

  // Prefer live data for the online section when available.
  const displayedOnline = liveData?.online ?? overview?.online ?? [];

  // Search by name, folded and accent-stripped so "Yasmeena" finds "Yasmeena
  // Elsafory" and a typed Arabic name finds the Arabic spelling. Hoisted once so
  // the table, the count chip and the empty state can never disagree about who
  // matched. An empty query is NOT a filter — it returns everyone.
  const filteredPeople = useMemo(() => {
    const people = overview?.people ?? [];
    const needle = foldForSearch(peopleQuery);
    if (!needle) return people;
    return people.filter((person) => foldForSearch(person.name).includes(needle));
  }, [overview, peopleQuery]);

  // Hoisted once so the list and its footer count can never disagree.
  const inactiveAdoptionRows = useMemo(
    () => (overview?.adoption.rows ?? []).filter((row) => row.status !== "active"),
    [overview],
  );

  const heroActions = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex items-center rounded-full border border-white/20 bg-white/10 p-0.5 backdrop-blur">
        {RANGE_OPTIONS.map((option) => (
          <button
            key={option.days}
            type="button"
            onClick={() => changeRange(option.days)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
              option.days === days ? "bg-phx-accent text-white" : "text-slate-200 hover:text-white"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <a
        href={`/api/admin/activity/export?days=${days}`}
        className="inline-flex items-center gap-2 rounded-full bg-phx-accent px-4 py-2 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(249,115,22,0.32)] transition hover:bg-phx-accent-hover"
      >
        <Download className="h-4 w-4" />
        Export
      </a>
      <button
        type="button"
        onClick={() => changeRange(days)}
        className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-2 text-sm font-semibold text-phx-paper backdrop-blur transition hover:bg-white/[0.16]"
      >
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Refresh
      </button>
    </div>
  );

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Activity"
        icon={<Activity className="h-3.5 w-3.5" />}
        title="Activity Control Center"
        description="See who is using the system, how long they stay, which modules they spend time in, and a fair engagement signal — all from existing sessions and lightweight page tracking."
        actions={heroActions}
        badges={
          <>
            <span>Window: {rangeLabel}</span>
            {overview ? <span>· Updated <RelativeTime iso={overview.generatedAtIso} /></span> : null}
            <span>· Module-level · no keystrokes or contents</span>
          </>
        }
      />

      {forceLogoutFeedback ? (
        <AdminCallout tone="warning">
          <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex flex-1 items-center justify-between">
            <p className="text-xs">{forceLogoutFeedback}</p>
            <button type="button" onClick={() => setForceLogoutFeedback(null)} className="ml-4 text-xs underline">Dismiss</button>
          </div>
        </AdminCallout>
      ) : null}

      {initialError ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-bold">Could not load activity data</p>
            <p className="font-mono text-xs">{initialError}</p>
          </div>
        </AdminCallout>
      ) : null}

      {overview ? (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <AdminStatCard
              icon={<Radio className="h-5 w-5" />}
              label="Online now"
              value={displayedOnline.length}
              description="Active sessions right now"
              tone="emerald"
              size="compact"
            />
            <AdminStatCard
              icon={<Users className="h-5 w-5" />}
              label="Active users"
              value={overview.kpis.activeUsers}
              description={`Used the system in ${rangeLabel.toLowerCase()}`}
              tone="blue"
              size="compact"
            />
            <AdminStatCard
              icon={<Activity className="h-5 w-5" />}
              label="Sessions"
              value={overview.kpis.sessions}
              description="Logins in the window"
              tone="orange"
              size="compact"
            />
            <AdminStatCard
              icon={<Clock3 className="h-5 w-5" />}
              label="Avg session"
              value={formatMinutes(overview.kpis.avgSessionMinutes)}
              description="Logged-in time per session"
              tone="violet"
              size="compact"
            />
            <AdminStatCard
              icon={<Gauge className="h-5 w-5" />}
              label="Avg active / user"
              value={formatMinutes(overview.kpis.avgActiveMinutesPerUser)}
              description="Hands-on time per person"
              tone="orange"
              size="compact"
            />
            <AdminStatCard
              icon={<LayoutGrid className="h-5 w-5" />}
              label="Top module"
              value={overview.kpis.topModuleLabel ?? "—"}
              description="Most time spent"
              tone="rose"
              size="compact"
            />
          </div>

          {overview.excludedAccounts.length > 0 ? (
            <p className="text-xs leading-5 text-slate-500">
              Service logins are not counted as people:{" "}
              {overview.excludedAccounts
                .map(
                  (account) =>
                    `${account.name} — ${account.sessions.toLocaleString()} ${account.sessions === 1 ? "session" : "sessions"}, ${account.pageViews.toLocaleString()} page ${account.pageViews === 1 ? "view" : "views"}`,
                )
                .join(" · ")}
              . These are left out of every figure on this page.
            </p>
          ) : null}

          {overview.eventsTruncated ? (
            <AdminCallout tone="warning">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-xs leading-5">
                <strong>This window holds more page activity than one read can carry,</strong> so the oldest
                part of it was left behind. <strong>Engagement, module popularity and the People table are
                therefore partial</strong> — they under-count. Sessions, who is online and adoption are built
                from a different read and are unaffected. Pick a shorter range for figures you intend to quote.
              </p>
            </AdminCallout>
          ) : null}

          {overview.kpis.totalPageViews < 25 ? (
            <AdminCallout tone="warning">
              <Activity className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-xs leading-5">
                <strong>Engagement &amp; module data is still warming up.</strong> Page-by-page tracking
                only just started, so active-time, module popularity, and engagement scores will be sparse
                until people navigate the system over the coming hours and days. <strong>Sessions, online,
                and adoption figures are accurate right now.</strong>
              </p>
            </AdminCallout>
          ) : null}

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {/* Who's online now — LIVE, auto-refreshes every 30s */}
            <SectionCard
              icon={<Radio className="h-4 w-4" />}
              title="Who's online now"
              description={`${displayedOnline.length} active · refreshes every 30s`}
              action={
                <div className="flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  <span className="text-phx-xs font-bold text-emerald-600 uppercase tracking-wide">Live</span>
                </div>
              }
            >
              {displayedOnline.length ? (
                <div className="max-h-[360px] overflow-y-auto">
                  <OnlineCards users={displayedOnline} onForceLogout={setForceLogoutTarget} />
                  <OnlineTable users={displayedOnline} onForceLogout={setForceLogoutTarget} />
                </div>
              ) : (
                <p className="px-5 py-8 text-center text-sm text-phx-ink-faint">No one is online right now.</p>
              )}

              {/* Recent navigation events */}
              {liveData?.recentEvents.length ? (
                <div className="border-t border-[#EEF2F7]">
                  <div className="flex items-center gap-2 px-5 py-2.5">
                    <Zap className="h-3.5 w-3.5 text-phx-accent" />
                    <p className="text-phx-xs font-bold uppercase tracking-wide text-phx-ink-soft">Recent navigation (last 15 min)</p>
                  </div>
                  <div className="divide-y divide-phx-paper">
                    {liveData.recentEvents.slice(0, 8).map((event, i) => (
                      <div key={i} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-5 py-1.5">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-phx-accent" />
                          <span className="break-words text-xs font-semibold text-phx-ink">{event.name}</span>
                          <span className="text-xs text-phx-ink-soft">→</span>
                          <span className="break-words text-xs text-phx-ink-2">{event.moduleLabel}</span>
                        </div>
                        <span className="shrink-0 text-phx-xs text-phx-ink-faint"><RelativeTime iso={event.occurredAtIso} /></span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </SectionCard>

            {/* Module popularity */}
            <SectionCard
              icon={<LayoutGrid className="h-4 w-4" />}
              title="Module popularity"
              description="Where employees spend their time"
            >
              {overview.modulePopularity.length ? (
                <div className="space-y-2.5 px-5 py-4">
                  {overview.modulePopularity.slice(0, 10).map((module) => (
                    <div key={module.key} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-phx-ink">{module.label}</span>
                        <span className="tabular-nums text-phx-ink-soft">
                          {formatMinutes(module.activeMinutes)} · {module.distinctUsers} user{module.distinctUsers === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-phx-paper-2">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-phx-accent to-[#FB923C]"
                          style={{ width: `${Math.max(2, Math.min(100, module.sharePct))}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-5 py-8 text-center text-sm text-phx-ink-faint">
                  No page activity recorded yet. Data appears as people navigate the system.
                </p>
              )}
            </SectionCard>
          </div>

          {/* Time-of-Day heatmap */}
          <SectionCard
            icon={<Clock3 className="h-4 w-4" />}
            title="When is the system used?"
            description="Login frequency by day and hour (Cairo time) — great for scheduling maintenance"
          >
            <TimeOfDayHeatmap hourlyHeatmap={overview.hourlyHeatmap} />
          </SectionCard>

          {/* Everyone + engagement, searchable by name */}
          <SectionCard
            icon={<Gauge className="h-4 w-4" />}
            title="People — search by name"
            description="Everyone with activity in this window. How much Phoenix each person used, which modules they opened, and how regularly. Open a name for their full module breakdown and the order they moved between modules. A usage signal, not a measure of their work."
            action={
              <AdminInsightChip tone="orange" surface="light">
                {peopleQuery.trim()
                  ? `${filteredPeople.length} of ${overview.people.length}`
                  : `${overview.people.length} ${overview.people.length === 1 ? "person" : "people"}`}
              </AdminInsightChip>
            }
          >
            <div className="border-b border-[#EEF2F7] px-5 py-3">
              <label className="block">
                <span className="sr-only">Search people by name</span>
                <input
                  type="search"
                  value={peopleQuery}
                  onChange={(event) => setPeopleQuery(event.target.value)}
                  placeholder="Search by name"
                  className={phxFieldClassName}
                />
              </label>
            </div>
            {overview.people.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-phx-ink-faint">No user activity in this window yet.</p>
            ) : filteredPeople.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-phx-ink-faint">
                Nobody here is called &ldquo;{peopleQuery.trim()}&rdquo;. They may have had no activity in this window.
              </p>
            ) : (
              <PeopleUsage users={filteredPeople} onOpenTimeline={openTimeline} />
            )}
            <div className="border-t border-[#EEF2F7] px-5 py-3">
              <AdminCallout tone="neutral">
                <Gauge className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="text-xs leading-5">
                  <strong>How to read engagement.</strong> Hands-on minutes measured against this person&apos;s own
                  scheduled working days carry most of the weight; how many modules they opened and on how many of
                  those days they showed up at all make up the rest — a 0–100 score and a band. It says how much of
                  Phoenix someone used, and nothing about the quality of their work or the part of their job that
                  happens away from a screen.
                </p>
              </AdminCallout>
            </div>
          </SectionCard>

          {/* Role benchmarks */}
          <SectionCard
            icon={<BarChart3 className="h-4 w-4" />}
            title="Role benchmarks"
            description="Average session time, active time, and engagement score by role"
          >
            <RoleBenchmarksTable benchmarks={overview.roleBenchmarks} />
          </SectionCard>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {/* Adoption */}
            <SectionCard
              icon={<Users className="h-4 w-4" />}
              title="Adoption — who isn't using the system"
              description={`Active ${overview.adoption.counts.active} · Dormant ${overview.adoption.counts.dormant} · Never ${overview.adoption.counts.never}`}
            >
              {inactiveAdoptionRows.length ? (
                <>
                  {/* No `.slice(60)` any more: the box already scrolls vertically,
                      so the cut bought nothing and silently hid people from a
                      header that had counted every one of them. */}
                  <div className="max-h-[360px] overflow-y-auto">
                    <AdoptionList rows={inactiveAdoptionRows} />
                  </div>
                  <p className="border-t border-[#EEF2F7] px-5 py-2 text-phx-xs text-phx-ink-soft">
                    Showing all {inactiveAdoptionRows.length}{" "}
                    {inactiveAdoptionRows.length === 1 ? "person who is" : "people who are"} not active.
                  </p>
                </>
              ) : (
                <p className="px-5 py-8 text-center text-sm text-phx-ink-faint">Every account has been active recently. 🎉</p>
              )}
            </SectionCard>

            {/* Anomalies */}
            <SectionCard
              icon={<TriangleAlert className="h-4 w-4" />}
              title="Anomalies"
              description="Concurrent logins and odd-hour access"
            >
              {overview.anomalies.length ? (
                <div className="max-h-[360px] divide-y divide-[#EEF2F7] overflow-y-auto">
                  {overview.anomalies.map((anomaly) => (
                    <div key={anomaly.id} className="flex items-start gap-3 px-5 py-3">
                      <span
                        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                          anomaly.severity === "warning" ? "bg-rose-50 text-rose-600" : "bg-amber-50 text-amber-600"
                        }`}
                      >
                        <TriangleAlert className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-phx-ink">{anomaly.identity.name}</p>
                        <p className="text-xs text-phx-ink-soft">{anomaly.detail}</p>
                        <p className="text-phx-xs text-phx-ink-faint">{formatDateTime(anomaly.occurredAt)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-5 py-8 text-center text-sm text-phx-ink-faint">No anomalies detected in this window.</p>
              )}
            </SectionCard>
          </div>
        </>
      ) : null}

      {/* Timeline drawer */}
      {selectedUser ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setSelectedUser(null)}>
          <div
            className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[#EEF2F7] bg-phx-ink px-5 py-4 text-white">
              <div>
                <p className="text-phx-2xs font-black uppercase tracking-[0.2em] text-orange-300">Activity timeline</p>
                <h3 className="text-lg font-black">{selectedUser.name}</h3>
                <p className="text-xs text-slate-300">{selectedUser.role}{selectedUser.team ? ` · ${selectedUser.team}` : ""} · last {rangeLabel.toLowerCase()}</p>
              </div>
              <div className="flex items-center gap-2">
                {selectedUser.hrId ? (
                  <button
                    type="button"
                    onClick={() => setForceLogoutTarget({ name: selectedUser.name, hrId: selectedUser.hrId! })}
                    className="inline-flex items-center gap-1.5 rounded-full border border-phx-danger-line/30 bg-phx-danger/20 px-3 py-1.5 text-phx-xs font-bold text-phx-danger-bg transition hover:bg-phx-danger/30"
                  >
                    <ShieldOff className="h-3.5 w-3.5" /> Force logout
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setSelectedUser(null)}
                  className="rounded-full p-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="space-y-4 p-5">
              {timelineLoading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-phx-ink-soft">
                  <Loader2 className="h-5 w-5 animate-spin" /> Loading timeline…
                </div>
              ) : timelineError ? (
                <AdminCallout tone="danger">
                  <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
                  <p className="text-sm">{timelineError}</p>
                </AdminCallout>
              ) : timeline ? (
                <>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <SummaryTile label="Logins" value={String(timeline.summary.sessions)} />
                    <SummaryTile label="Active" value={formatMinutes(timeline.summary.activeMinutes)} />
                    <SummaryTile label="Modules" value={String(timeline.summary.distinctModules)} />
                    <SummaryTile label="Pages" value={String(timeline.summary.pageViews)} />
                  </div>

                  {/* Engagement signal */}
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-phx-line bg-[#FBFCFD] px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-phx-xs font-bold uppercase tracking-wide text-phx-ink-faint">Engagement signal</p>
                      <p className="break-words text-xs text-phx-ink-soft">
                        {timeline.summary.pageViews > 0
                          ? `${formatMinutes(timeline.summary.engagement.activeMinutesPerWorkingDay)} hands-on per working day · top module ${timeline.summary.topModule ?? "—"}`
                          : "No page-view activity recorded yet — it appears here as they navigate the system."}
                      </p>
                    </div>
                    {timeline.summary.pageViews > 0 ? (
                      <EngagementBadge band={timeline.summary.engagement.band} score={timeline.summary.engagement.score} />
                    ) : (
                      <NoDataChip />
                    )}
                  </div>

                  {/* Login heatmap calendar — its own fixed Cairo window, bucketed server-side. */}
                  <div className="rounded-[12px] border border-phx-line bg-[#FBFCFD] px-4 py-3">
                    <HeatmapCalendar calendar={timeline.loginCalendar} />
                  </div>

                  {/* Modules and the order they were entered — across every
                      session in the range, not inside one login. */}
                  <ModuleJourneyPanel journey={timeline.journey} />

                  {timeline.sessions.length ? (
                    <div className="space-y-3">
                      {timeline.sessions.map((session, index) => (
                        <SessionTimelineCard key={session.sessionId ?? `loose-${index}`} session={session} />
                      ))}
                    </div>
                  ) : (
                    <p className="py-8 text-center text-sm text-phx-ink-faint">
                      No detailed page activity yet for this person. Sessions appear here as they navigate the system.
                    </p>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* Force-logout confirmation dialog */}
      {forceLogoutTarget ? (
        <ForceLogoutDialog
          name={forceLogoutTarget.name}
          onConfirm={handleForceLogout}
          onCancel={() => setForceLogoutTarget(null)}
          isPending={forceLogoutPending}
        />
      ) : null}
    </div>
  );
}

/** How many trail rows appear per "show more" press. */
const PAGE_TRAIL_STEP = 25;

/**
 * One logical login in the timeline drawer.
 *
 * The drawer already downloaded every path, IP and user-agent for this session
 * and rendered none of them — the owner asked (2026-09-26) for the page trail
 * AND the device. Both live here.
 *
 * Deliberately NO nested `overflow-auto`: this card sits inside a drawer that
 * already scrolls, and a second scroller inside it hides content behind a bar
 * nobody sees. The trail is collapsed and paged instead.
 */
function SessionTimelineCard({ session }: { session: TimelineSession }) {
  const [trailOpen, setTrailOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_TRAIL_STEP);

  const pageCount = session.events.length;
  const shown = trailOpen ? session.events.slice(0, visibleCount) : [];
  const remaining = pageCount - shown.length;

  return (
    <div className="rounded-[12px] border border-phx-line">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-[#EEF2F7] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Clock3 className="h-4 w-4 shrink-0 text-phx-accent-hover" />
          <span className="break-words font-semibold text-phx-ink">{formatDateTime(session.startedAt)}</span>
        </div>
        <span className="break-words text-xs text-phx-ink-soft">
          <span title={SESSION_SPAN_TITLE}>{formatMinutes(session.durationMinutes)} span</span> ·{" "}
          {formatMinutes(session.activeMinutes)} active · {session.endedReason}
        </span>
      </div>

      {/* Device band. `break-all`, not `break-words`: a user agent and an IPv6
          literal have no spaces to break at. */}
      <div className="border-b border-[#EEF2F7] px-4 py-2.5 text-phx-xs text-phx-ink-soft">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Laptop className="h-3.5 w-3.5 shrink-0 text-phx-ink-faint" />
          <span className="break-words font-semibold text-phx-ink-2">{session.deviceLabel ?? "Device not recorded"}</span>
          {session.ip ? <span className="break-all font-mono text-phx-ink-soft">{session.ip}</span> : null}
        </div>
        {session.userAgent ? (
          <details className="mt-1">
            <summary className="cursor-pointer select-none text-phx-accent-press">Show the full browser string</summary>
            <p className="mt-1 break-all font-mono text-phx-ink-soft">{session.userAgent}</p>
          </details>
        ) : null}
      </div>

      {session.modules.length ? (
        <div className="flex flex-wrap gap-1.5 px-4 py-3">
          {session.modules.map((module) => (
            <span
              key={module.label}
              className="inline-flex items-center gap-1 rounded-full border border-[#FED7AA] bg-phx-accent-soft px-2.5 py-1 text-phx-xs font-semibold text-[#9A3412]"
            >
              {module.label}
              <span className="text-phx-accent-press/70">{formatMinutes(module.minutes)}</span>
            </span>
          ))}
        </div>
      ) : (
        <p className="px-4 py-3 text-xs text-phx-ink-faint">No page views recorded for this session.</p>
      )}

      {pageCount ? (
        <div className="border-t border-[#EEF2F7] px-4 py-2.5">
          {trailOpen ? (
            <>
              <p className="mb-2 text-phx-xs font-bold uppercase tracking-wide text-phx-ink-faint">
                Pages opened ({pageCount})
              </p>
              <ol className="space-y-2">
                {shown.map((event, index) => (
                  <li key={`${event.atIso}-${index}`} className="min-w-0 border-l-2 border-phx-paper-2 pl-2.5">
                    <p className="break-words text-phx-xs text-phx-ink-2">
                      <span className="font-semibold text-phx-ink">{formatDateTime(event.atIso)}</span> ·{" "}
                      {event.moduleLabel} · {formatSeconds(event.dwellSeconds)}
                    </p>
                    <p className="block w-full break-all font-mono text-phx-2xs text-phx-ink-soft">{event.path}</p>
                  </li>
                ))}
              </ol>
              {remaining > 0 ? (
                <button
                  type="button"
                  onClick={() => setVisibleCount((count) => count + PAGE_TRAIL_STEP)}
                  className="mt-2 rounded-[8px] border border-phx-line px-2.5 py-1 text-phx-xs font-semibold text-phx-accent-press transition hover:bg-phx-accent-soft"
                >
                  Show {Math.min(remaining, PAGE_TRAIL_STEP)} more {remaining === 1 ? "page" : "pages"}
                </button>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              onClick={() => setTrailOpen(true)}
              className="rounded-[8px] border border-phx-line px-2.5 py-1 text-phx-xs font-semibold text-phx-accent-press transition hover:bg-phx-accent-soft"
            >
              Show the {pageCount} {pageCount === 1 ? "page" : "pages"}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** How many journey runs appear per "show more" press. */
const JOURNEY_STEP = 25;

/**
 * Where one person's time actually went, and the order they moved in.
 *
 * The owner asked for this on 2026-09-26: which modules each person entered, how
 * long they stayed in each, and the workflow BETWEEN modules. Before it, the
 * drawer showed module chips per session only — a module opened across three
 * logins read as three unrelated entries, and the ORDER was nowhere on the page.
 *
 * Every figure here is credited (overlap-deduplicated) seconds, the same ones
 * behind the Active tile, so the module rows sum to Active instead of being a
 * second measurement that disagrees with the first.
 *
 * A LIST, not a table, on purpose: at 303px (the drawer at 375px) a four-column
 * table cannot hold a module name plus three figures without shrinking type,
 * which the fits-the-screen golden rule forbids. Square edges, no nested
 * scroller — the drawer already scrolls, and a second bar inside it hides rows.
 */
function ModuleJourneyPanel({ journey }: { journey: ModuleJourney }) {
  const [journeyOpen, setJourneyOpen] = useState(false);
  const [visibleRuns, setVisibleRuns] = useState(JOURNEY_STEP);

  if (!journey.totals.length) {
    return (
      <div className="border border-phx-line px-4 py-3">
        <p className="break-words text-phx-xs text-phx-ink-faint">
          No module activity recorded in this range, so there is no journey to show.
        </p>
      </div>
    );
  }

  const runCount = journey.visits.length;
  const shownRuns = journeyOpen ? journey.visits.slice(0, visibleRuns) : [];
  const remainingRuns = runCount - shownRuns.length;

  return (
    <div className="space-y-3">
      <div className="border border-phx-line">
        <div className="border-b border-[#EEF2F7] px-4 py-2.5">
          <p className="text-phx-xs font-bold uppercase tracking-wide text-phx-ink-faint">
            Modules — where the time went
          </p>
          <p className="mt-0.5 break-words text-phx-2xs text-phx-ink-soft">
            {journey.totals.length} {journey.totals.length === 1 ? "module" : "modules"} entered. Share is of this
            person&apos;s own active time, so these rows add up to the Active figure above.
          </p>
        </div>
        <ul className="divide-y divide-[#EEF2F7]">
          {journey.totals.map((total) => (
            <li key={total.moduleLabel} className="px-4 py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="break-words text-sm font-semibold text-phx-ink">{total.moduleLabel}</span>
                <span className="break-words text-phx-xs font-semibold text-phx-ink-2">
                  {formatSeconds(total.seconds)} · {total.sharePct.toFixed(1)}%
                </span>
              </div>
              {/* A hairline, never a rounded pill — the square-edge rule holds for
                  anything new on this page. */}
              <div className="mt-1.5 h-1.5 w-full bg-phx-paper-2">
                <div className="h-full bg-phx-accent" style={{ width: `${Math.min(Math.max(total.sharePct, 1), 100)}%` }} />
              </div>
              <p className="mt-1 break-words text-phx-2xs text-phx-ink-soft">
                {total.visits} {total.visits === 1 ? "visit" : "visits"} · {total.views}{" "}
                {total.views === 1 ? "page" : "pages"} · first {formatDateTime(total.firstAtIso)} · last{" "}
                {formatDateTime(total.lastAtIso)}
              </p>
            </li>
          ))}
        </ul>
      </div>

      {journey.transitions.length ? (
        <div className="border border-phx-line">
          <div className="border-b border-[#EEF2F7] px-4 py-2.5">
            <p className="text-phx-xs font-bold uppercase tracking-wide text-phx-ink-faint">
              Movement between modules
            </p>
            <p className="mt-0.5 break-words text-phx-2xs text-phx-ink-soft">
              How often they went straight from one module into the next, most frequent first.
            </p>
          </div>
          <ul className="divide-y divide-[#EEF2F7]">
            {journey.transitions.map((transition) => (
              <li
                key={`${transition.fromLabel} → ${transition.toLabel}`}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2"
              >
                <span className="break-words text-phx-xs text-phx-ink-2">
                  <span className="font-semibold text-phx-ink">{transition.fromLabel}</span> →{" "}
                  <span className="font-semibold text-phx-ink">{transition.toLabel}</span>
                </span>
                <span className="text-phx-xs font-semibold text-phx-ink-soft">
                  {transition.count} {transition.count === 1 ? "time" : "times"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="border border-phx-line px-4 py-2.5">
        {journeyOpen ? (
          <>
            <p className="mb-2 text-phx-xs font-bold uppercase tracking-wide text-phx-ink-faint">
              The order they moved ({runCount}) — newest first
            </p>
            <ol className="space-y-2">
              {shownRuns.map((visit, index) => (
                <li
                  key={`${visit.startedAtIso}-${visit.moduleLabel}-${index}`}
                  className="min-w-0 border-l-2 border-phx-paper-2 pl-2.5"
                >
                  <p className="break-words text-phx-xs text-phx-ink-2">
                    <span className="font-semibold text-phx-ink">{formatDateTime(visit.startedAtIso)}</span> ·{" "}
                    {visit.moduleLabel}
                  </p>
                  <p className="break-words text-phx-2xs text-phx-ink-soft">
                    stayed {formatSeconds(visit.seconds)} · {visit.views} {visit.views === 1 ? "page" : "pages"} ·
                    left {formatDateTime(visit.endedAtIso)}
                  </p>
                </li>
              ))}
            </ol>
            {remainingRuns > 0 ? (
              <button
                type="button"
                onClick={() => setVisibleRuns((count) => count + JOURNEY_STEP)}
                className="mt-2 border border-phx-line px-2.5 py-1 text-phx-xs font-semibold text-phx-accent-press transition hover:bg-phx-accent-soft"
              >
                Show {Math.min(remainingRuns, JOURNEY_STEP)} more {remainingRuns === 1 ? "move" : "moves"}
              </button>
            ) : null}
          </>
        ) : (
          <button
            type="button"
            onClick={() => setJourneyOpen(true)}
            className="border border-phx-line px-2.5 py-1 text-phx-xs font-semibold text-phx-accent-press transition hover:bg-phx-accent-soft"
          >
            Show the module-by-module order ({runCount} {runCount === 1 ? "move" : "moves"})
          </button>
        )}
      </div>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[12px] border border-phx-line bg-white px-3 py-2.5 text-center">
      <p className="text-phx-2xs font-bold uppercase tracking-wide text-phx-ink-faint">{label}</p>
      <p className="text-lg font-black text-phx-ink">{value}</p>
    </div>
  );
}
