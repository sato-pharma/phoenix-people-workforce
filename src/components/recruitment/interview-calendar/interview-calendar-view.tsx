"use client";

// The interview calendar — a week at a time, a column per day, a row per half hour, the way the
// owner's own "DAILY SCHEDULE" sheet is laid out (2026-09-18), and better: every name on it opens
// that candidate's CV, the export carries the same links, and he can share it from here.
//
// Sunday to Thursday, 9:00 AM to 5:00 PM, Cairo time — his choice. Desktop draws the grid; a phone
// gets the same week as one card per day, because a five-column grid at 375px is a grid nobody can
// read (the fits-the-screen rule: never a sideways scroll).
//
// A FREE TIME IS PRESSABLE (the owner, 2026-09-18): pressing an empty cell books someone there —
// from Recruitment, or from outside with their CV — or sets up an interview SESSION: one Zoom
// meeting for a block of the day, cut into slots. A session is drawn as a tinted block with its
// chip at the top; its slots fill as people are booked into them.
//
// WHAT EACH PERSON CAN DO follows the access he gave them, and the server enforces every one of
// these; the screen only stops offering what would be refused. Viewer: see it, open the CVs.
// Commenter: also leave notes on an interview. Editor: also book, move and cancel. Owner: also share.
// Someone who opened it from a COPY LINK without signing in views only; the link's own level
// applies once they sign in.

import {
  AlertTriangle,
  Building2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  FileSpreadsheet,
  FileText,
  Link2,
  Loader2,
  LogIn,
  Mail,
  MapPin,
  MessageSquarePlus,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Send,
  Share2,
  Trash2,
  Upload,
  UserRound,
  Users,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useHydrated } from "@/hooks/use-hydrated";
import { CvPreviewModal } from "@/components/recruitment/cv-preview-modal";
import { WhatsAppApplicationActions } from "@/components/recruitment/whatsapp-application-actions";
import { Action } from "@/components/recruitment/workstation/workstation-look";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import {
  ACCESS_LEVEL_LABEL,
  PLATFORM_LABEL,
  canBookInterviews,
  canCommentOnInterviews,
  canShareInterviewCalendar,
  interviewAwaitsOutcome,
  interviewOutcomeGroup,
  interviewOutcomeGroups,
  interviewOutcomeLabels,
  sessionSlotStarts,
  zoomStatusSentence,
  type InterviewBooking,
  type InterviewCalendarAccessLevel,
  type InterviewCalendarRole,
  type InterviewOutcome,
  type InterviewOutcomeGroup,
  type InterviewSession,
} from "@/lib/recruitment/interview-calendar-types";
import {
  adminControlDepthClassName,
  adminPanelDepthClassName,
  adminPanelHeaderClassName,
  adminSoftDepthClassName,
} from "@/components/admin/admin-design-tokens";
import {
  RecruitmentEmptyState,
  RecruitmentKpiStrip,
  recruitmentToolbarClassName,
  type RecruitmentKpi,
} from "@/components/recruitment/recruitment-premium";
import {
  SLOT_MINUTES,
  WORKDAY_END_MINUTES,
  WORKDAY_START_MINUTES,
  addDays,
  cairoDateKey,
  cairoMinutesOfDay,
  formatDayLong,
  formatDuration,
  formatShortDate,
  formatTimeOfDay,
  formatTimeRange,
  formatWeekOf,
  formatWeekRange,
  slotFor,
  slotStarts,
  weekDays,
  weekStartFor,
  weekdayName,
} from "@/lib/recruitment/interview-calendar-week";
import { cn } from "@/lib/utils";

import { calendarApi, reasonText, type CalendarApi } from "./calendar-api";
import { CalendarDialog, ErrorLine, PanelHeading } from "./calendar-dialog";
import { CellDialog } from "./cell-dialog";
import { EditInterviewDetailsDialog } from "./edit-details-dialog";
import { MonthPicker, cursorFor, type MonthCursor } from "./month-picker";
import { InterviewShareDialog } from "./interview-share-dialog";
import { RequestInterviewDialog } from "./request-interview-dialog";
import { OutcomePromptPanel } from "./outcome-prompt-panel";
import { InterviewRequestPanels } from "./requests-inbox";
import { ScheduleInterviewDialog } from "./schedule-interview-dialog";
import { SessionDialog } from "./session-dialog";
import { InvitationPanel } from "./invitation-panel";
import { InterviewExtrasPanel } from "./interview-extras-panel";
import { ScorecardPanel } from "./scorecard-panel";
import { ZoomAutoOpen } from "./zoom-auto-open";
import { ZoomMeetingPanels, type MeetingTarget } from "./zoom-panels";
import { phxButtonAccentClassName, phxButtonDangerDenseClassName, phxTextareaClassName } from "@/components/ui/form-tokens";

type CalendarFile = { id: string; kind: string; fileName: string; mimeType: string | null; createdAt: string };

/** The calendar opened from a copy link — what the link gives, and how to sign in for more. */
export type InterviewCalendarLinkView = {
  token: string;
  signedIn: boolean;
  /** The one week the link opens, or null for the whole calendar. */
  weekStart: string | null;
  accessLevel: InterviewCalendarAccessLevel;
  guestCvs: boolean;
  /** Where to sign in and come back — null when already signed in. */
  signInHref: string | null;
};

export type InterviewCalendarAbilities = { canSearchCandidates: boolean; canAddToRecruitment: boolean };

/** The newest attachment filed as a CV that the preview can draw — the same choice screening makes. */
function chooseCv(files: CalendarFile[]): CalendarFile | null {
  const drawable = files.filter((file) => file.kind === "cv" && detectCvFileKind(file.mimeType ?? "", file.fileName) !== "unsupported");
  return [...drawable].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0] ?? null;
}

function cairoStamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${formatShortDate(cairoDateKey(at))}, ${formatTimeOfDay(cairoMinutesOfDay(at))}`;
}

function byTime<T extends { dateKey: string; startMinutes: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => (a.dateKey === b.dateKey ? a.startMinutes - b.startMinutes : a.dateKey < b.dateKey ? -1 : 1));
}

function PlatformIcon({ platform, className }: { platform: InterviewBooking["platform"]; className?: string }) {
  return platform === "zoom" ? <Video className={className} /> : <Building2 className={className} />;
}

function readFilename(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return fallback;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1] : fallback;
}

/** The first quarter hour from now — the earliest a booking made today may start. */
function nextQuarter(minutes: number): number {
  return Math.ceil(minutes / 15) * 15;
}

const LAST_START = WORKDAY_END_MINUTES - SLOT_MINUTES;

type CellContent = {
  sessions: InterviewSession[];
  bookings: InterviewBooking[];
  /** Long interviews that began in an earlier row and are still going. */
  continuing: InterviewBooking[];
  /** The session this half hour falls inside, if any. */
  cover: InterviewSession | null;
  /** Free slots of that session starting in this half hour. */
  freeSlots: number;
};

export function InterviewCalendarView({
  abilities,
  canReadRequests,
  canRequest,
  initialOpen,
  initialWeek,
  link = null,
  lockedWeek = null,
  refreshToken,
  role,
  todayKey,
  zoomConnected,
}: {
  abilities?: InterviewCalendarAbilities;
  /** May this viewer READ the requests waiting for a time without booking them (the Talent Acquisition seat). Server-decided. */
  canReadRequests?: boolean;
  /** May this viewer ask for an interview (a District Manager and above, or HR). Server-decided. */
  canRequest?: boolean;
  initialOpen: string | null;
  initialWeek: string;
  /** Set when the calendar was opened from a copy link. */
  link?: InterviewCalendarLinkView | null;
  /** The one week a week-limited link opens — the week cannot be changed. */
  lockedWeek?: string | null;
  /**
   * A host page that re-reads itself on a timer (the Talent Acquisition overview) passes a value that
   * changes with each server render. The week is fetched by this component's own effect, which a
   * `router.refresh()` never re-runs, so without it the grid sits on what it read when the page
   * opened while everything around it moves. Changing it re-reads the week IN PLACE: no loading
   * flash, and nothing the viewer has open is closed.
   */
  refreshToken?: number | string;
  role: InterviewCalendarRole;
  todayKey: string;
  zoomConnected: boolean;
}) {
  const linkToken = link?.token ?? null;
  const api = useMemo(() => calendarApi(linkToken), [linkToken]);
  const hydrated = useHydrated();
  const canBook = canBookInterviews(role);
  // A requester sees the Request button and their own requests; the server is the authority, so a
  // link view (no seat) never requests. Falls back to the requester seat role when no flag is passed.
  const mayRequest = !link && (canRequest ?? role === "requester");
  // Reading the waiting list is a seat the server names, never a link holder's.
  const mayReadRequests = !link && canReadRequests === true;
  const canSearch = abilities?.canSearchCandidates === true;
  const canAdd = abilities?.canAddToRecruitment === true;

  const [weekStart, setWeekStart] = useState(() => weekStartFor(lockedWeek ?? initialWeek));
  const [bookings, setBookings] = useState<InterviewBooking[]>([]);
  const [sessions, setSessions] = useState<InterviewSession[]>([]);
  // The week the grid last finished reading. "Loading" is derived from it rather than stored, so no
  // state is written in an effect body — every write lands when an answer arrives.
  const [loadedWeek, setLoadedWeek] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(initialOpen);
  // An interview a link pointed at outside the week on screen, or one moved out of it while open.
  const [fetchedOpen, setFetchedOpen] = useState<InterviewBooking | null>(null);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [cell, setCell] = useState<{ dateKey: string; start: number } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [exporting, setExporting] = useState<"pdf" | "xlsx" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerCursor, setPickerCursor] = useState<MonthCursor>(() => cursorFor(weekStartFor(lockedWeek ?? initialWeek)));
  const pickerRef = useRef<HTMLDivElement>(null);
  // The request flow (owner, 2026-09-23): ask for a day, HR books the times. The signal makes the
  // inbox and "your requests" panels re-read after a new request is sent.
  const [requesting, setRequesting] = useState(false);
  const [requestReload, setRequestReload] = useState(0);
  // Bumped whenever a booking comes back changed, so the outcome prompt drops the one just answered.
  const [bookingChanged, setBookingChanged] = useState(0);

  // The clock the "is this time already past?" answers read, moved on each minute.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const nowKey = cairoDateKey(new Date(nowMs));
  const earliestToday = nextQuarter(cairoMinutesOfDay(new Date(nowMs)));

  const days = useMemo(() => weekDays(weekStart), [weekStart]);
  const thisWeek = weekStartFor(todayKey);
  const loading = loadedWeek !== weekStart;
  const openBooking = openId
    ? (bookings.find((booking) => booking.id === openId) ?? (fetchedOpen && fetchedOpen.id === openId ? fetchedOpen : null))
    : null;

  /** The earliest a booking may start in the half hour from `minutes`, or null when it is past. */
  const bookableStart = useCallback(
    (dateKey: string, minutes: number): number | null => {
      if (dateKey < nowKey) return null;
      const start = dateKey === nowKey ? Math.max(minutes, earliestToday) : minutes;
      if (start >= minutes + SLOT_MINUTES || start > LAST_START) return null;
      return start;
    },
    [earliestToday, nowKey],
  );

  // The address keeps the week (and the open interview), so a copied link lands where it was copied.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("week", weekStart);
    if (openId) url.searchParams.set("open", openId);
    else url.searchParams.delete("open");
    window.history.replaceState(window.history.state, "", `${url.pathname}?${url.searchParams.toString()}`);
  }, [openId, weekStart]);

  // Only the latest week asked for may land: clicking through three weeks quickly must not leave the
  // grid showing whichever answer happened to arrive last — a superseded answer finds `live` false.
  useEffect(() => {
    let live = true;
    api
      .get(`/bookings?week=${encodeURIComponent(weekStart)}`)
      .then((data) => {
        if (!live) return;
        setBookings(byTime(Array.isArray(data.bookings) ? (data.bookings as InterviewBooking[]) : []));
        setSessions(byTime(Array.isArray(data.sessions) ? (data.sessions as InterviewSession[]) : []));
        setLoadError(null);
      })
      .catch((reason: unknown) => {
        if (!live) return;
        setBookings([]);
        setSessions([]);
        setLoadError(reasonText(reason, "The week could not be read."));
      })
      .finally(() => {
        if (live) setLoadedWeek(weekStart);
      });
    return () => {
      live = false;
    };
  }, [api, refreshToken, weekStart]);

  // An interview in the week on screen is read straight from it (above). One a link points at outside
  // that week is asked for directly, and the grid moves to its week.
  useEffect(() => {
    if (!openId || loading) return;
    if (bookings.some((booking) => booking.id === openId)) return;
    if (fetchedOpen && fetchedOpen.id === openId) return;
    let live = true;
    api
      .get(`/bookings/${encodeURIComponent(openId)}`)
      .then((data) => {
        if (!live) return;
        const booking = data.booking as InterviewBooking;
        setFetchedOpen(booking);
        if (!lockedWeek && weekStartFor(booking.dateKey) !== weekStart) setWeekStart(weekStartFor(booking.dateKey));
      })
      .catch(() => {
        if (live) setOpenId(null);
      });
    return () => {
      live = false;
    };
  }, [api, bookings, fetchedOpen, loading, lockedWeek, openId, weekStart]);

  // Close the week picker on a click anywhere else.
  useEffect(() => {
    if (!pickerOpen) return;
    function onDown(event: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pickerOpen]);

  function goToWeek(week: string) {
    if (lockedWeek) return;
    const sunday = weekStartFor(week);
    setWeekStart(sunday);
    setPickerCursor(cursorFor(sunday));
  }

  function replaceBooking(next: InterviewBooking) {
    setBookingChanged((count) => count + 1);
    setBookings((current) => {
      const rest = current.filter((booking) => booking.id !== next.id);
      return weekStartFor(next.dateKey) === weekStart ? byTime([...rest, next]) : rest;
    });
    // An interview moved to another week stays open, though it has left the grid.
    if (next.id === openId) setFetchedOpen(next);
  }

  function removeBooking(id: string) {
    setBookings((current) => current.filter((booking) => booking.id !== id));
    setOpenId(null);
  }

  function upsertSession(next: InterviewSession) {
    setSessions((current) => {
      const rest = current.filter((session) => session.id !== next.id);
      return weekStartFor(next.dateKey) === weekStart ? byTime([...rest, next]) : rest;
    });
  }

  // The session dialog hands back the session and every interview in it, after any change there.
  const sessionChanged = useCallback(
    (next: InterviewSession, inSession: InterviewBooking[]) => {
      setSessions((current) => {
        const rest = current.filter((session) => session.id !== next.id);
        return weekStartFor(next.dateKey) === weekStart ? byTime([...rest, next]) : rest;
      });
      setBookings((current) => {
        const rest = current.filter((booking) => booking.sessionId !== next.id);
        return byTime([...rest, ...inSession.filter((booking) => weekStartFor(booking.dateKey) === weekStart)]);
      });
    },
    [weekStart],
  );

  function sessionRemoved(sessionId: string, bookingIds: string[]) {
    const gone = new Set(bookingIds);
    setSessions((current) => current.filter((session) => session.id !== sessionId));
    setBookings((current) => current.filter((booking) => !gone.has(booking.id) && booking.sessionId !== sessionId));
    setOpenSessionId(null);
    if (openId && gone.has(openId)) setOpenId(null);
  }

  function openInterview(id: string) {
    setOpenSessionId(null);
    setCell(null);
    setOpenId(id);
  }

  function openSession(id: string) {
    setOpenId(null);
    setCell(null);
    setOpenSessionId(id);
  }

  async function exportWeek(format: "pdf" | "xlsx") {
    setExporting(format);
    setExportError(null);
    try {
      const response = await api.fetch(`/export?week=${encodeURIComponent(weekStart)}&format=${format}`);
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(typeof data.message === "string" ? data.message : "The export could not be made.");
      }
      const blob = await response.blob();
      const name = readFilename(response.headers.get("Content-Disposition"), `interview-calendar-${weekStart}.${format}`);
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (reason) {
      setExportError(reasonText(reason, "The export could not be made."));
    } finally {
      setExporting(null);
    }
  }

  // What each half hour of the grid holds.
  const cells = useMemo(() => {
    const map = new Map<string, CellContent>();
    const at = (dateKey: string, minutes: number) => {
      const key = `${dateKey}|${minutes}`;
      let entry = map.get(key);
      if (!entry) {
        entry = { bookings: [], continuing: [], cover: null, freeSlots: 0, sessions: [] };
        map.set(key, entry);
      }
      return entry;
    };
    const rows = slotStarts();
    const takenBySession = new Map<string, Set<number>>();
    for (const booking of bookings) {
      const first = slotFor(booking.startMinutes);
      at(booking.dateKey, first).bookings.push(booking);
      for (const row of rows) {
        if (row > first && row < booking.startMinutes + booking.durationMinutes) at(booking.dateKey, row).continuing.push(booking);
      }
      if (booking.sessionId) {
        const taken = takenBySession.get(booking.sessionId) ?? new Set<number>();
        taken.add(booking.startMinutes);
        takenBySession.set(booking.sessionId, taken);
      }
    }
    for (const session of sessions) {
      at(session.dateKey, slotFor(session.startMinutes)).sessions.push(session);
      const taken = takenBySession.get(session.id) ?? new Set<number>();
      const slots = sessionSlotStarts(session);
      for (const row of rows) {
        if (row + SLOT_MINUTES <= session.startMinutes || row >= session.startMinutes + session.durationMinutes) continue;
        const entry = at(session.dateKey, row);
        if (!entry.cover) entry.cover = session;
        entry.freeSlots += slots.filter((start) => start >= row && start < row + SLOT_MINUTES && !taken.has(start)).length;
      }
    }
    return map;
  }, [bookings, sessions]);

  const bookedInSession = useMemo(() => {
    const counts = new Map<string, number>();
    for (const booking of bookings) {
      if (booking.sessionId) counts.set(booking.sessionId, (counts.get(booking.sessionId) ?? 0) + 1);
    }
    return counts;
  }, [bookings]);

  const counts = useMemo(
    () => ({
      awaiting: bookings.filter((booking) => interviewAwaitsOutcome(booking)).length,
      office: bookings.filter((booking) => booking.platform === "in_office").length,
      sessions: sessions.length,
      total: bookings.length,
      zoom: bookings.filter((booking) => booking.platform === "zoom").length,
    }),
    [bookings, sessions],
  );

  const cvsNeedSignIn = Boolean(link && !link.signedIn && !link.guestCvs);

  // The week's figures at a glance — counted from the week the grid already read, never a fetch of
  // their own. While the week is reading, or when it could not be read, a tile says "—" rather than
  // drawing a zero nobody measured.
  const known = !loading && !loadError;
  const figure = (value: number) => <span className="tabular-nums">{known ? String(value) : "—"}</span>;
  const kpis: RecruitmentKpi[] = [
    {
      description: counts.total === 1 ? "Interview booked this week" : "Interviews booked this week",
      icon: <CalendarDays aria-hidden className="h-4 w-4" />,
      label: "This week",
      tone: "violet",
      value: figure(counts.total),
    },
    {
      description: "At the office",
      icon: <Building2 aria-hidden className="h-4 w-4" />,
      label: "In office",
      tone: "orange",
      value: figure(counts.office),
    },
    {
      description: "On Phoenix's Zoom",
      icon: <Video aria-hidden className="h-4 w-4" />,
      label: "Zoom",
      tone: "blue",
      value: figure(counts.zoom),
    },
    {
      description: "Blocks of the day cut into slots",
      icon: <Users aria-hidden className="h-4 w-4" />,
      label: "Sessions",
      tone: "emerald",
      value: figure(counts.sessions),
    },
    {
      description: "Held, and nobody has said how it went",
      icon: <ClipboardCheck aria-hidden className="h-4 w-4" />,
      label: "Awaiting outcome",
      tone: "rose",
      value: figure(counts.awaiting),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {link ? <LinkBanner link={link} role={role} /> : null}
      {link ? null : <ZoomAutoOpen api={api} />}

      {/* ── The week bar: the week's name on the house band, its controls in the tray below ──── */}
      <section aria-label="The week" className={`min-w-0 border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
        <header className={`flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-4 py-3.5 text-white sm:px-5 ${adminPanelHeaderClassName}`}>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-orange-300">
              <CalendarDays aria-hidden className="h-3.5 w-3.5" />
              {weekStart === thisWeek ? "This week" : "Interview week"}
            </p>
            <h2 className="mt-1 break-words text-[22px] font-black leading-tight tracking-tight text-white">{formatWeekOf(weekStart)}</h2>
            <p className="mt-0.5 break-words text-[12px] tabular-nums text-slate-300">
              {formatWeekRange(weekStart)} · Sunday to Thursday, 9:00 AM to 5:00 PM, Cairo time
            </p>
          </div>
          {role !== "owner" ? (
            <p className="max-w-full break-words border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200">
              Your access: <span className="text-white">{ACCESS_LEVEL_LABEL[role]}</span>
            </p>
          ) : null}
        </header>
        <div className="flex flex-col gap-3 p-3 sm:p-4">
          <div className={cn(recruitmentToolbarClassName, "relative items-center")}>
            {lockedWeek ? null : (
              <>
                <div className="flex">
                  <button
                    aria-label="Previous week"
                    className={`inline-flex h-9 w-9 items-center justify-center border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900 ${adminControlDepthClassName}`}
                    onClick={() => goToWeek(addDays(weekStart, -7))}
                    type="button"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    aria-label="Next week"
                    className={`-ml-px inline-flex h-9 w-9 items-center justify-center border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900 ${adminControlDepthClassName}`}
                    onClick={() => goToWeek(addDays(weekStart, 7))}
                    type="button"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
                <Action disabled={weekStart === thisWeek} onClick={() => goToWeek(thisWeek)} size="md" tone="quiet">
                  This week
                </Action>
                <div className="sm:relative" ref={pickerRef}>
                  <Action aria-expanded={pickerOpen} onClick={() => setPickerOpen((open) => !open)} size="md" tone="quiet">
                    <CalendarDays className="h-4 w-4" />
                    Choose a week
                  </Action>
                  {pickerOpen ? (
                    <div className="absolute left-3 right-3 top-full z-30 mt-1 border border-slate-200 bg-white p-3 shadow-[0_12px_32px_rgba(15,23,42,0.18)] sm:left-auto sm:right-0 sm:w-[18rem]">
                      <MonthPicker
                        allowPast
                        cursor={pickerCursor}
                        highlightWeekOf={days}
                        onCursor={setPickerCursor}
                        onSelect={(key) => {
                          goToWeek(key);
                          setPickerOpen(false);
                        }}
                        selected={null}
                        todayKey={todayKey}
                      />
                    </div>
                  ) : null}
                </div>
                <span aria-hidden className="mx-1 hidden h-6 w-px bg-slate-300 sm:inline-block" />
              </>
            )}
            <Action disabled={exporting !== null} onClick={() => void exportWeek("pdf")} size="md" tone="quiet">
              {exporting === "pdf" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              Export PDF
            </Action>
            <Action disabled={exporting !== null} onClick={() => void exportWeek("xlsx")} size="md" tone="quiet">
              {exporting === "xlsx" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
              Export Excel
            </Action>
            {mayRequest || canShareInterviewCalendar(role) ? (
              <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
                {mayRequest ? (
                  <Action onClick={() => setRequesting(true)} size="md" tone="primary">
                    <Send className="h-4 w-4" />
                    Request an interview
                  </Action>
                ) : null}
                {canShareInterviewCalendar(role) ? (
                  <Action onClick={() => setSharing(true)} size="md" tone={mayRequest ? "quiet" : "primary"}>
                    <Share2 className="h-4 w-4" />
                    Share
                  </Action>
                ) : null}
              </div>
            ) : null}
          </div>

          <RecruitmentKpiStrip items={kpis} />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-slate-600">
            <span className="inline-flex items-center gap-1.5 font-semibold text-slate-700">
              <span aria-hidden className="inline-block h-2.5 w-2.5 bg-orange-600 shadow-[0_0_0_2px_#ffedd5]" />
              In office
            </span>
            <span className="inline-flex items-center gap-1.5 font-semibold text-slate-700">
              <span aria-hidden className="inline-block h-2.5 w-2.5 bg-sky-600 shadow-[0_0_0_2px_#e0f2fe]" />
              Zoom
            </span>
            <span className="inline-flex items-center gap-1.5 font-semibold text-slate-700">
              <Users aria-hidden className="h-3 w-3 text-slate-500" />
              Session
            </span>
            {role === "interviewer" ? <span className="text-slate-500">You see the interviews you were chosen to conduct.</span> : null}
            <span className="text-slate-500">
              {cvsNeedSignIn ? "Sign in to open the CVs." : "Click a name to open the CV."}
              {canBook ? " Press a free time to book someone or set up a Zoom session." : ""}
            </span>
          </div>

          {exportError ? <ErrorLine>{exportError}</ErrorLine> : null}
          {loadError && !loading ? <ErrorLine>{loadError}</ErrorLine> : null}
        </div>
      </section>

      {link ? null : <OutcomePromptPanel api={api} onOpenBooking={openInterview} reloadSignal={bookingChanged} />}

      {mayRequest || canBook || mayReadRequests ? (
        <InterviewRequestPanels
          api={api}
          canBook={canBook}
          canReadInbox={mayReadRequests}
          canRequest={mayRequest}
          onBookingCreated={replaceBooking}
          onOpenBooking={openInterview}
          reloadSignal={requestReload}
          todayKey={todayKey}
          zoomConnected={zoomConnected}
        />
      ) : null}

      {/* ── Desktop: the grid ──────────────────────────────────────────────────────────────── */}
      <section aria-busy={loading} aria-label="Week grid" className={`relative hidden border border-slate-200 bg-white md:block ${adminPanelDepthClassName}`}>
        {loading ? (
          <div className="absolute right-3 top-2.5 z-10 inline-flex items-center gap-1 border border-orange-400/40 bg-slate-950/80 px-2 py-0.5 text-[11px] font-semibold text-orange-100">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the week…
          </div>
        ) : null}
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-[5.75rem]" />
            {days.map((day) => (
              <col key={day} />
            ))}
          </colgroup>
          <thead>
            {/* The week grid's head is the shared dark band, not a local `bg-slate-900`: the same
                treatment the Approvals Hub and the Coverage Report wear, so the three cannot
                drift. Every OTHER bg-slate-900 in this module is a selected state on a button. */}
            <tr className={`${adminPanelHeaderClassName} text-white`}>
              <th className="border-r border-slate-700 px-2 py-2.5 text-left text-[11px] font-black uppercase tracking-[0.12em]" scope="col">
                Time
              </th>
              {days.map((day) => (
                <th
                  className={cn("border-r border-slate-700 px-2 py-2.5 text-left last:border-r-0", day === todayKey && "bg-orange-600")}
                  key={day}
                  scope="col"
                >
                  <span className="flex flex-wrap items-baseline gap-x-1.5">
                    <span className="text-[13px] font-black tracking-tight">{weekdayName(day)}</span>
                    {day === todayKey ? <span className="text-[10px] font-black uppercase tracking-[0.12em] opacity-90">Today</span> : null}
                  </span>
                  <span className="block text-[11px] font-semibold tabular-nums opacity-80">{formatShortDate(day)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slotStarts().map((minutes, rowIndex) => (
              <tr className={cn("border-t border-slate-200", rowIndex % 2 === 1 && "bg-slate-50/70")} key={minutes}>
                <th className="border-r border-slate-200 px-2 py-1.5 text-left align-top text-[12px] font-semibold tabular-nums text-slate-500" scope="row">
                  {formatTimeOfDay(minutes)}
                </th>
                {days.map((day) => {
                  const here = cells.get(`${day}|${minutes}`);
                  const cover = here?.cover ?? null;
                  const start = hydrated && canBook && !loading ? bookableStart(day, minutes) : null;
                  const empty = !here || (here.bookings.length === 0 && here.sessions.length === 0 && here.continuing.length === 0);
                  return (
                    <td
                      className={cn(
                        "group relative h-[46px] border-r border-slate-200 p-1 align-top last:border-r-0",
                        cover
                          ? cover.platform === "zoom"
                            ? "bg-sky-50"
                            : "bg-orange-50"
                          : day === todayKey && "bg-orange-50/40",
                      )}
                      key={day}
                    >
                      {cover ? (
                        <button
                          aria-label={`Open the session ${cover.title ?? "Interview session"}`}
                          className="absolute inset-0 z-0 cursor-pointer"
                          onClick={() => openSession(cover.id)}
                          type="button"
                        />
                      ) : start !== null ? (
                        <button
                          aria-label={`Book at ${formatTimeOfDay(start)}, ${formatDayLong(day)}`}
                          className={cn(
                            "absolute inset-0 z-0 flex cursor-pointer items-center justify-center text-[11px] font-bold text-orange-700 opacity-0 transition-opacity hover:bg-orange-50 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500 group-hover:opacity-100",
                            !empty && "items-end pb-0.5",
                          )}
                          onClick={() => setCell({ dateKey: day, start })}
                          type="button"
                        >
                          <span className="inline-flex items-center gap-0.5">
                            <Plus className="h-3 w-3" /> Book
                          </span>
                        </button>
                      ) : null}
                      {here ? (
                        <div className="pointer-events-none relative z-[1] flex flex-col gap-1">
                          {here.sessions.map((session) => (
                            <SessionChip
                              booked={bookedInSession.get(session.id) ?? 0}
                              key={session.id}
                              onOpen={() => openSession(session.id)}
                              session={session}
                            />
                          ))}
                          {here.bookings.map((booking) => (
                            <BookingChip booking={booking} key={booking.id} onOpen={() => openInterview(booking.id)} />
                          ))}
                          {here.continuing.map((booking) => (
                            <button
                              aria-label={`${booking.candidateName}, until ${formatTimeOfDay(booking.startMinutes + booking.durationMinutes)}`}
                              className={cn(
                                "pointer-events-auto block h-2 w-full",
                                booking.platform === "zoom" ? "bg-sky-300 hover:bg-sky-500" : "bg-orange-300 hover:bg-orange-500",
                              )}
                              key={booking.id}
                              onClick={() => openInterview(booking.id)}
                              title={`${booking.candidateName} — until ${formatTimeOfDay(booking.startMinutes + booking.durationMinutes)}`}
                              type="button"
                            />
                          ))}
                          {cover && here.freeSlots > 0 && canBook && !cover.ended ? (
                            <button
                              className="pointer-events-auto self-start text-[10.5px] font-bold text-sky-800 underline decoration-sky-300 underline-offset-2 hover:text-sky-950"
                              onClick={() => openSession(cover.id)}
                              type="button"
                            >
                              {here.freeSlots} free {here.freeSlots === 1 ? "slot" : "slots"}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ── Phone: a card per day ──────────────────────────────────────────────────────────── */}
      <ul aria-busy={loading} className="flex flex-col gap-3 md:hidden">
        {days.map((day) => {
          const daySessions = sessions.filter((session) => session.dateKey === day);
          const dayBookings = bookings.filter((booking) => booking.dateKey === day);
          const items = [
            ...daySessions.map((session) => ({ at: session.startMinutes, kind: "session" as const, order: 0, session })),
            ...dayBookings.map((booking) => ({ at: booking.startMinutes, booking, kind: "booking" as const, order: 1 })),
          ].sort((a, b) => a.at - b.at || a.order - b.order);
          const firstFree =
            hydrated && canBook && !loading
              ? bookableStart(day, day === nowKey ? Math.max(WORKDAY_START_MINUTES, slotFor(earliestToday)) : WORKDAY_START_MINUTES)
              : null;
          return (
            <li className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`} key={day}>
              <p
                className={cn(
                  "flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 px-3 py-2.5 text-white",
                  day === todayKey ? "bg-orange-600" : adminPanelHeaderClassName,
                )}
              >
                <span className="inline-flex items-baseline gap-1.5">
                  <span className="text-[14px] font-black tracking-tight">{weekdayName(day)}</span>
                  {day === todayKey ? <span className="text-[10px] font-black uppercase tracking-[0.12em] text-orange-100">Today</span> : null}
                </span>
                <span className="inline-flex items-baseline gap-2 text-[12px] font-semibold tabular-nums opacity-90">
                  {items.length > 0 ? (
                    <span className="text-[11px] font-bold opacity-80">
                      {items.length} {items.length === 1 ? "entry" : "entries"}
                    </span>
                  ) : null}
                  {formatShortDate(day)}
                </span>
              </p>
              {items.length === 0 ? (
                <p className="px-3 py-3 text-[12px] text-slate-500">{loading ? "Reading…" : "No interviews."}</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {items.map((item) =>
                    item.kind === "session" ? (
                      <li key={`s-${item.session.id}`}>
                        <button
                          className={cn(
                            "flex w-full items-start gap-3 border-l-[3px] px-3 py-2.5 text-left transition-colors",
                            item.session.platform === "zoom"
                              ? "border-l-sky-600 bg-sky-50 hover:bg-sky-100"
                              : "border-l-orange-600 bg-orange-50 hover:bg-orange-100",
                          )}
                          onClick={() => openSession(item.session.id)}
                          type="button"
                        >
                          <span className="w-[4.75rem] shrink-0 text-[12px] font-bold tabular-nums text-slate-700">
                            {formatTimeOfDay(item.session.startMinutes)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-slate-600">
                              <Users className="h-3 w-3" /> Session
                            </span>
                            <span className="block break-words text-[14px] font-bold text-slate-900">{item.session.title ?? "Interview session"}</span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                              <span>{formatTimeRange(item.session.startMinutes, item.session.durationMinutes)}</span>
                              <span>
                                {bookedInSession.get(item.session.id) ?? 0} of {sessionSlotStarts(item.session).length} booked
                              </span>
                            </span>
                          </span>
                        </button>
                      </li>
                    ) : (
                      <li key={item.booking.id}>
                        <button
                          className={cn(
                            "flex w-full items-start gap-3 border-l-[3px] px-3 py-2.5 text-left transition-colors hover:bg-orange-50",
                            item.booking.platform === "zoom" ? "border-l-sky-300" : "border-l-orange-300",
                          )}
                          onClick={() => openInterview(item.booking.id)}
                          type="button"
                        >
                          <span className="w-[4.75rem] shrink-0 text-[12px] font-bold tabular-nums text-slate-700">
                            {formatTimeOfDay(item.booking.startMinutes)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-[14px] font-bold text-orange-700 underline decoration-orange-300 underline-offset-2">
                              {item.booking.candidateName}
                              {item.booking.area ? <span className="font-semibold text-slate-500"> / {item.booking.area}</span> : null}
                            </span>
                            {item.booking.interviewerName || item.booking.line ? (
                              <span className="mt-0.5 block break-words text-[11px] font-semibold text-slate-700">
                                {[item.booking.interviewerName, item.booking.line].filter(Boolean).join(" · ")}
                              </span>
                            ) : null}
                            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                              <span className="inline-flex items-center gap-1">
                                <PlatformIcon className="h-3 w-3" platform={item.booking.platform} />
                                {PLATFORM_LABEL[item.booking.platform]}
                              </span>
                              <span>{formatDuration(item.booking.durationMinutes)}</span>
                              {item.booking.sessionTitle ? <span className="break-words">in {item.booking.sessionTitle}</span> : null}
                              {item.booking.external ? <span>from outside</span> : null}
                              {item.booking.outcome ? <span className="font-bold text-slate-900">{interviewOutcomeLabels[item.booking.outcome]}</span> : null}
                              {interviewAwaitsOutcome(item.booking) ? <span className="font-bold text-amber-700">Outcome?</span> : null}
                              {item.booking.candidateJobTitle ? <span className="break-words">{item.booking.candidateJobTitle}</span> : null}
                            </span>
                          </span>
                        </button>
                      </li>
                    ),
                  )}
                </ul>
              )}
              {firstFree !== null ? (
                <div className="border-t border-slate-100 bg-slate-50/70 px-3 py-2">
                  <Action onClick={() => setCell({ dateKey: day, start: firstFree })} tone="quiet">
                    <Plus className="h-3.5 w-3.5" />
                    Book on this day
                  </Action>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {!loading && bookings.length === 0 && sessions.length === 0 && !loadError ? (
        <section aria-label="No interviews this week" className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
          <RecruitmentEmptyState
            icon={<CalendarDays aria-hidden className="h-5 w-5" />}
            message={
              canBook
                ? "Press a free time on the calendar (on a phone, Book on this day) to book someone from Phoenix or from outside, or to set up a Zoom session. Any CV's Schedule interview button books too."
                : "Nothing is on the calendar for these five days."
            }
            title="No interviews this week"
          />
        </section>
      ) : null}

      {openBooking ? (
        <InterviewDetail
          api={api}
          booking={openBooking}
          cvsNeedSignIn={cvsNeedSignIn}
          key={openBooking.id}
          onChanged={replaceBooking}
          onClose={() => setOpenId(null)}
          onOpenSession={openSession}
          onRemoved={removeBooking}
          role={role}
          zoomConnected={zoomConnected}
        />
      ) : null}

      {openSessionId ? (
        <SessionDialog
          api={api}
          canAdd={canAdd}
          canBook={canBook}
          canSearch={canSearch}
          key={openSessionId}
          onChanged={sessionChanged}
          onClose={() => setOpenSessionId(null)}
          onOpenBooking={openInterview}
          onRemoved={sessionRemoved}
          sessionId={openSessionId}
          zoomConnected={zoomConnected}
        />
      ) : null}

      {cell ? (
        <CellDialog
          api={api}
          canAdd={canAdd}
          canSearch={canSearch}
          dateKey={cell.dateKey}
          initialStart={cell.start}
          key={`${cell.dateKey}|${cell.start}`}
          onBooked={replaceBooking}
          onClose={() => setCell(null)}
          onOpenBooking={openInterview}
          onOpenSession={openSession}
          onSessionCreated={upsertSession}
          zoomConnected={zoomConnected}
        />
      ) : null}

      {sharing ? <InterviewShareDialog onClose={() => setSharing(false)} weekStart={weekStart} /> : null}

      {requesting ? (
        <RequestInterviewDialog
          api={api}
          canSearch={canSearch}
          defaultDay={days[0] ?? null}
          onClose={() => setRequesting(false)}
          onCreated={() => setRequestReload((value) => value + 1)}
          todayKey={todayKey}
        />
      ) : null}
    </div>
  );
}

// ── The copy-link banner ───────────────────────────────────────────────────────────────────────

function LinkBanner({ link, role }: { link: InterviewCalendarLinkView; role: InterviewCalendarRole }) {
  const scope = link.weekStart ? `the week of ${formatWeekRange(link.weekStart)}` : "the whole calendar";
  const more =
    link.accessLevel === "editor" ? "book, move and cancel interviews" : link.accessLevel === "commenter" ? "leave notes on interviews" : null;
  return (
    <section
      className={`flex flex-col gap-3 border border-sky-200 border-l-[3px] border-l-sky-600 bg-gradient-to-r from-sky-50 to-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${adminSoftDepthClassName}`}
    >
      <div className="flex min-w-0 items-start gap-3 text-[13px] text-slate-800">
        <span aria-hidden className={`mt-0.5 hidden h-9 w-9 shrink-0 items-center justify-center border border-sky-200 bg-white text-sky-700 sm:inline-flex ${adminSoftDepthClassName}`}>
          <Link2 className="h-4 w-4" />
        </span>
        <div className="min-w-0">
        <p className="inline-flex items-center gap-1.5 font-bold text-slate-900">
          <Link2 className="h-4 w-4 text-sky-700 sm:hidden" /> Opened from a shared link
        </p>
        <p className="mt-0.5 break-words leading-5">
          {link.signedIn
            ? `It opens ${scope}. You are ${ACCESS_LEVEL_LABEL[role]} here.`
            : `It opens ${scope}, to view.${more ? ` Sign in to Phoenix to also ${more}.` : ""}${link.guestCvs ? "" : " The CVs open after signing in."}`}
        </p>
        </div>
      </div>
      {link.signInHref ? (
        <a className={`${phxButtonAccentClassName} shrink-0 justify-center ${adminControlDepthClassName}`} href={link.signInHref}>
          <LogIn className="h-4 w-4" />
          Sign in
        </a>
      ) : null}
    </section>
  );
}

// ── The chips ──────────────────────────────────────────────────────────────────────────────────

function SessionChip({ booked, onOpen, session }: { booked: number; onOpen: () => void; session: InterviewSession }) {
  const zoom = session.platform === "zoom";
  const total = sessionSlotStarts(session).length;
  const trouble = zoom && session.zoomStatus !== "created";
  return (
    <button
      className={cn(
        "pointer-events-auto block w-full border border-l-[3px] bg-white px-1.5 py-1 text-left shadow-[0_1px_2px_rgba(15,23,42,0.08)] transition-colors",
        zoom ? "border-sky-300 border-l-sky-600 hover:bg-sky-100" : "border-orange-300 border-l-orange-600 hover:bg-orange-100",
      )}
      onClick={onOpen}
      title="Open the session"
      type="button"
    >
      <span className={cn("flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide", zoom ? "text-sky-800" : "text-orange-800")}>
        <Users className="h-3 w-3" /> Session · {PLATFORM_LABEL[session.platform]}
      </span>
      <span className="block break-words text-[12px] font-bold leading-tight text-slate-900">{session.title ?? "Interview session"}</span>
      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px] leading-tight tabular-nums text-slate-600">
        <span>{formatTimeRange(session.startMinutes, session.durationMinutes)}</span>
        <span>
          {booked} of {total} booked
        </span>
        {trouble ? (
          <span className="inline-flex items-center gap-0.5 font-semibold text-amber-700">
            <AlertTriangle className="h-3 w-3" /> No link yet
          </span>
        ) : null}
      </span>
    </button>
  );
}

function BookingChip({ booking, onOpen }: { booking: InterviewBooking; onOpen: () => void }) {
  const zoom = booking.platform === "zoom";
  const trouble = zoom && booking.zoomStatus !== "created";
  return (
    <button
      className={cn(
        "group/chip pointer-events-auto block w-full border-l-[3px] px-1.5 py-1 text-left shadow-[0_1px_2px_rgba(15,23,42,0.08)] transition-colors",
        zoom ? "border-l-sky-600 bg-sky-100 hover:bg-sky-200" : "border-l-orange-600 bg-orange-100 hover:bg-orange-200",
      )}
      onClick={onOpen}
      title={`Open ${booking.candidateName}'s CV`}
      type="button"
    >
      <span className="block break-words text-[12px] font-bold leading-tight text-slate-900 group-hover/chip:underline">
        {booking.candidateName}
        {booking.area ? <span className="font-semibold text-slate-600"> / {booking.area}</span> : null}
      </span>
      {booking.jobTitle ? (
        <span className="mt-0.5 block break-words text-[10.5px] leading-tight text-slate-600">{booking.jobTitle}</span>
      ) : null}
      {booking.interviewerName || booking.line ? (
        <span className="mt-0.5 block break-words text-[10.5px] font-semibold leading-tight text-slate-700">
          {[booking.interviewerName, booking.line].filter(Boolean).join(" · ")}
        </span>
      ) : null}
      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px] leading-tight text-slate-600">
        <span className="inline-flex items-center gap-0.5 tabular-nums">
          <PlatformIcon className="h-3 w-3" platform={booking.platform} />
          {formatTimeRange(booking.startMinutes, booking.durationMinutes)}
        </span>
        {booking.external ? <span className="font-semibold text-slate-500">outside</span> : null}
        {booking.outcome ? <span className="font-bold text-slate-900">{interviewOutcomeLabels[booking.outcome]}</span> : null}
        {interviewAwaitsOutcome(booking) ? <span className="font-bold text-amber-700">Outcome?</span> : null}
        {trouble ? (
          <span className="inline-flex items-center gap-0.5 font-semibold text-amber-700">
            <AlertTriangle className="h-3 w-3" /> No link yet
          </span>
        ) : null}
        {booking.comments.length > 0 ? <span className="text-slate-500">{booking.comments.length} note{booking.comments.length === 1 ? "" : "s"}</span> : null}
      </span>
    </button>
  );
}

// ── One interview, with its CV ─────────────────────────────────────────────────────────────────

type OpenedCv = { downloadUrl: string; fileName: string; mimeType: string | null };

function InterviewDetail({
  api,
  booking,
  cvsNeedSignIn,
  onChanged,
  onClose,
  onOpenSession,
  onRemoved,
  role,
  zoomConnected,
}: {
  api: CalendarApi;
  booking: InterviewBooking;
  cvsNeedSignIn: boolean;
  onChanged: (booking: InterviewBooking) => void;
  onClose: () => void;
  onOpenSession: (id: string) => void;
  onRemoved: (id: string) => void;
  role: InterviewCalendarRole;
  zoomConnected: boolean;
}) {
  const candidateId = booking.candidateId;
  const [files, setFiles] = useState<CalendarFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  // Bumped after a CV is attached here, so the files are read again and the CV opens in place.
  const [filesVersion, setFilesVersion] = useState(0);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const attachRef = useRef<HTMLInputElement | null>(null);
  // The candidate's WhatsApp application, when there is one this viewer may open: the id of the
  // conversation the Download and Print buttons act on. Null draws no buttons.
  const [applicationSessionId, setApplicationSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (!candidateId || cvsNeedSignIn) return;
    let live = true;
    api
      .get(`/candidates/${encodeURIComponent(candidateId)}/files`)
      .then((data) => {
        if (live) setFiles(Array.isArray(data.files) ? (data.files as CalendarFile[]) : []);
      })
      .catch((reason) => {
        if (!live) return;
        setFiles([]);
        setFilesError(reasonText(reason, "The CV could not be read."));
      });
    return () => {
      live = false;
    };
  }, [api, candidateId, cvsNeedSignIn, filesVersion]);

  // A Phoenix candidate booked with no CV (typed in on the calendar, nothing attached) — the CV is
  // added here and lands on their Recruitment record. The server adds a missing CV only, never a
  // replacement, and refuses anyone who may not add to Recruitment from the calendar.
  async function attachCv() {
    const file = attachRef.current?.files?.[0];
    if (!file) {
      setAttachError("Choose the CV file first.");
      return;
    }
    setAttaching(true);
    setAttachError(null);
    try {
      const form = new FormData();
      form.append("cv", file);
      const data = await api.postForm(`/bookings/${encodeURIComponent(booking.id)}/cv`, form);
      onChanged(data.booking as InterviewBooking);
      setFiles(null);
      setFilesError(null);
      setFilesVersion((version) => version + 1);
    } catch (reason) {
      setAttachError(reasonText(reason, "The CV could not be attached."));
    } finally {
      setAttaching(false);
    }
  }

  useEffect(() => {
    if (!candidateId || cvsNeedSignIn) return;
    let live = true;
    api
      .get(`/candidates/${encodeURIComponent(candidateId)}/application`)
      .then((data) => {
        const application = data.application as { sessionId?: unknown } | null | undefined;
        if (live) setApplicationSessionId(typeof application?.sessionId === "string" && application.sessionId !== "" ? application.sessionId : null);
      })
      // A lookup that fails only means no buttons; the CV and the interview panel do not depend on it.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, candidateId, cvsNeedSignIn]);

  const applicationActions = applicationSessionId ? (
    <WhatsAppApplicationActions applicantName={booking.candidateName} sessionId={applicationSessionId} />
  ) : null;

  let cv: OpenedCv | null = null;
  if (!cvsNeedSignIn && candidateId && files) {
    const chosen = chooseCv(files);
    if (chosen) {
      cv = {
        downloadUrl: api.href(`/candidates/${encodeURIComponent(candidateId)}/files/${encodeURIComponent(chosen.id)}`),
        fileName: `${booking.candidateName} · ${chosen.fileName}`,
        mimeType: chosen.mimeType,
      };
    }
  } else if (!cvsNeedSignIn && !candidateId && booking.externalHasCv) {
    // Someone from outside: the CV kept on the booking itself.
    cv = {
      downloadUrl: api.href(`/bookings/${encodeURIComponent(booking.id)}/cv`),
      fileName: `${booking.candidateName} · ${booking.externalCvFileName ?? "CV"}`,
      mimeType: booking.externalCvMimeType,
    };
  }

  const panel = (
    <InterviewPanel
      api={api}
      booking={booking}
      onChanged={onChanged}
      onOpenSession={onOpenSession}
      onRemoved={onRemoved}
      role={role}
      zoomConnected={zoomConnected}
    />
  );

  if (cv) {
    return (
      <CvPreviewModal
        downloadUrl={cv.downloadUrl}
        fileName={cv.fileName}
        headerActions={applicationActions}
        mimeType={cv.mimeType}
        onClose={onClose}
        sidePanel={panel}
        sidePanelFirstOnPhone
      />
    );
  }

  const waiting = Boolean(candidateId) && !cvsNeedSignIn && files === null;
  const mayAttach = Boolean(candidateId) && !cvsNeedSignIn && files !== null && !filesError && canBookInterviews(role);
  const why = cvsNeedSignIn
    ? "Sign in to Phoenix to open this CV."
    : candidateId
      ? (filesError ?? "No readable CV is attached to this candidate.")
      : "No CV was added for this person.";
  return (
    <CalendarDialog onClose={onClose} title={booking.candidateName} width="sm" z={200}>
      <p
        className={cn(
          "mb-4 px-3 py-2 text-[12px]",
          waiting ? "bg-slate-50 text-slate-500" : "border-l-[3px] border-l-amber-500 bg-amber-50 text-slate-700",
        )}
      >
        {waiting ? "Opening the CV…" : why}
      </p>
      {mayAttach ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            accept=".pdf,.doc,.docx,image/*"
            aria-label="CV file"
            className="max-w-full text-[12px] text-slate-700 file:mr-2 file:border file:border-slate-300 file:bg-white file:px-2 file:py-1 file:text-[12px] file:font-semibold"
            ref={attachRef}
            type="file"
          />
          <Action disabled={attaching} onClick={() => void attachCv()} tone="quiet">
            {attaching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Attach CV
          </Action>
          {attachError ? <div className="w-full"><ErrorLine>{attachError}</ErrorLine></div> : null}
        </div>
      ) : null}
      {applicationActions ? <div className="mb-4">{applicationActions}</div> : null}
      {panel}
    </CalendarDialog>
  );
}

function InterviewPanel({
  api,
  booking,
  onChanged,
  onOpenSession,
  onRemoved,
  role,
  zoomConnected,
}: {
  api: CalendarApi;
  booking: InterviewBooking;
  onChanged: (booking: InterviewBooking) => void;
  onOpenSession: (id: string) => void;
  onRemoved: (id: string) => void;
  role: InterviewCalendarRole;
  zoomConnected: boolean;
}) {
  const [moving, setMoving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState<"cancel" | "zoom" | "note" | "outcome" | null>(null);
  const [outcomeNote, setOutcomeNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const zoomLine = zoomStatusSentence(booking.zoomStatus, booking.zoomError);
  const canBook = canBookInterviews(role);
  const activeGroup = interviewOutcomeGroup(booking.outcome);
  const path = `/bookings/${encodeURIComponent(booking.id)}`;
  const target: MeetingTarget = { id: booking.id, kind: "booking" };
  const pollTarget: MeetingTarget = booking.sessionId ? { id: booking.sessionId, kind: "session" } : target;

  async function cancel() {
    setBusy("cancel");
    setError(null);
    try {
      await api.del(path);
      onRemoved(booking.id);
    } catch (reason) {
      setError(reasonText(reason, "The interview could not be cancelled."));
      setBusy(null);
    }
  }

  async function retryZoom() {
    setBusy("zoom");
    setError(null);
    try {
      const data = await api.post(`${path}/zoom`, {});
      onChanged(data.booking as InterviewBooking);
    } catch (reason) {
      setError(reasonText(reason, "Zoom could not make the meeting."));
    } finally {
      setBusy(null);
    }
  }

  async function chooseOutcome(next: InterviewOutcome | null) {
    setBusy("outcome");
    setError(null);
    setOutcomeNote(null);
    try {
      const data = await api.patch(`${path}/outcome`, { outcome: next });
      onChanged(data.booking as InterviewBooking);
      setOutcomeNote(typeof data.candidateNote === "string" ? data.candidateNote : null);
    } catch (reason) {
      setError(reasonText(reason, "The outcome could not be saved."));
    } finally {
      setBusy(null);
    }
  }

  async function addNote() {
    const text = note.trim();
    if (!text) return;
    setBusy("note");
    setError(null);
    try {
      const data = await api.post(`${path}/comments`, { body: text });
      onChanged(data.booking as InterviewBooking);
      setNote("");
    } catch (reason) {
      setError(reasonText(reason, "The note could not be saved."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="border-l-[3px] border-l-orange-500 pl-3">
        <p className="text-[11px] font-black uppercase tracking-[0.12em] text-orange-700">Interview</p>
        <p className="mt-0.5 break-words text-[18px] font-black leading-snug tracking-tight text-slate-950">{booking.candidateName}</p>
        {booking.jobTitle ? <p className="break-words text-[12px] font-semibold text-slate-700">Interviewed for {booking.jobTitle}</p> : null}
        {booking.candidateJobTitle && booking.candidateJobTitle !== booking.jobTitle ? (
          <p className="break-words text-[12px] text-slate-500">Applied for {booking.candidateJobTitle}</p>
        ) : null}
        {booking.external ? <p className="text-[12px] text-slate-500">From outside Phoenix — kept on the calendar only, not in Recruitment.</p> : null}
      </div>

      <dl className={`grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 gap-y-2 border border-slate-200 bg-white p-3 text-[13px] text-slate-800 ${adminSoftDepthClassName}`}>
        <dt className="pt-0.5 text-slate-400">
          <CalendarDays aria-label="Day" className="h-4 w-4" />
        </dt>
        <dd className="font-semibold">{formatDayLong(booking.dateKey)}</dd>
        <dt className="pt-0.5 text-slate-400">
          <Clock3 aria-label="Time" className="h-4 w-4" />
        </dt>
        <dd className="tabular-nums">
          {formatTimeRange(booking.startMinutes, booking.durationMinutes)}{" "}
          <span className="text-slate-500">({formatDuration(booking.durationMinutes)})</span>
        </dd>
        {booking.sessionId ? (
          <>
            <dt className="pt-0.5 text-slate-400">
              <Users aria-label="Session" className="h-4 w-4" />
            </dt>
            <dd>
              A slot in <span className="font-semibold">{booking.sessionTitle ?? "an interview session"}</span>
              <button
                className="ml-1.5 text-[12px] font-bold text-sky-700 underline decoration-sky-300 underline-offset-2 hover:text-sky-900"
                onClick={() => onOpenSession(booking.sessionId as string)}
                type="button"
              >
                Open the session
              </button>
            </dd>
          </>
        ) : null}
        <dt className="pt-0.5 text-slate-400">
          <PlatformIcon className="h-4 w-4" platform={booking.platform} />
        </dt>
        <dd>
          <span className="font-semibold">{PLATFORM_LABEL[booking.platform]}</span>
          {booking.zoomJoinUrl ? (
            <a className="mt-0.5 block break-all text-[12px] font-semibold text-sky-700 underline" href={booking.zoomJoinUrl} rel="noreferrer" target="_blank">
              {booking.zoomJoinUrl}
            </a>
          ) : null}
          {zoomLine && booking.zoomStatus !== "created" ? <span className="mt-0.5 block text-[12px] text-amber-800">{zoomLine}</span> : null}
          {canBook && !booking.sessionId && booking.platform === "zoom" && booking.zoomStatus !== "created" && zoomConnected ? (
            <Action className="mt-1.5" disabled={busy !== null} onClick={() => void retryZoom()} tone="quiet">
              {busy === "zoom" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Make the Zoom meeting
            </Action>
          ) : null}
          {booking.sessionId && booking.platform === "zoom" && booking.zoomStatus !== "created" ? (
            <span className="mt-0.5 block text-[12px] text-slate-500">The meeting belongs to the session; make it again from there.</span>
          ) : null}
        </dd>
        {booking.interviewerName ? (
          <>
            <dt className="pt-0.5 text-slate-400">
              <UserRound aria-label="Interviewer" className="h-4 w-4" />
            </dt>
            <dd>
              Interviewer <span className="font-semibold">{booking.interviewerName}</span>
            </dd>
          </>
        ) : null}
        {booking.panelists.length > 0 ? (
          <>
            <dt className="pt-0.5 text-slate-400">
              <Users aria-label="Panel" className="h-4 w-4" />
            </dt>
            <dd>
              Panel <span className="font-semibold">{booking.panelists.map((member) => member.name).join(", ")}</span>
            </dd>
          </>
        ) : null}
        {booking.line || booking.area ? (
          <>
            <dt className="pt-0.5 text-slate-400">
              <MapPin aria-label="Area and line" className="h-4 w-4" />
            </dt>
            <dd>
              <span className="font-semibold">{[booking.line, booking.area].filter(Boolean).join(" · ")}</span>
            </dd>
          </>
        ) : null}
        {booking.externalPhone ? (
          <>
            <dt className="pt-0.5 text-slate-400">
              <Phone aria-label="Phone" className="h-4 w-4" />
            </dt>
            <dd>
              <a className="font-semibold text-slate-800 underline decoration-slate-300 underline-offset-2" dir="ltr" href={`tel:${booking.externalPhone}`}>
                {booking.externalPhone}
              </a>
            </dd>
          </>
        ) : null}
        {booking.externalEmail ? (
          <>
            <dt className="pt-0.5 text-slate-400">
              <Mail aria-label="E-mail" className="h-4 w-4" />
            </dt>
            <dd className="break-all">{booking.externalEmail}</dd>
          </>
        ) : null}
      </dl>

      {booking.notes ? (
        <p className="whitespace-pre-wrap break-words border-l-[3px] border-l-slate-300 bg-slate-50 px-3 py-2 text-[12px] text-slate-700">{booking.notes}</p>
      ) : null}
      {booking.bookedByName ? <p className="text-[11px] text-slate-500">Booked by {booking.bookedByName}</p> : null}

      {booking.canSetOutcome || booking.outcome ? (
        <section aria-label="How it went" className="border-t border-slate-200 pt-3">
          <PanelHeading
            aside={interviewAwaitsOutcome(booking) ? <span className="text-[11px] font-black uppercase tracking-[0.06em] text-amber-700">Waiting</span> : null}
          >
            How it went
          </PanelHeading>
          {booking.canSetOutcome ? (
            <>
              <div aria-label="Did they come" className="mt-1.5 flex flex-wrap gap-1.5" role="group">
                {(Object.keys(interviewOutcomeGroups) as InterviewOutcomeGroup[]).map((group) => {
                  const parent = interviewOutcomeGroups[group].parent;
                  const chosen = activeGroup === group;
                  return (
                    <button
                      aria-pressed={chosen}
                      className={cn(
                        "min-h-[44px] border px-3 py-1.5 text-[12px] font-bold leading-none transition-colors disabled:opacity-50 lg:min-h-0 lg:px-2",
                        chosen
                          ? "border-slate-900 bg-slate-900 text-white shadow-[inset_0_-2px_0_#f97316]"
                          : "border-slate-300 bg-white text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:border-slate-500",
                      )}
                      disabled={busy !== null}
                      key={group}
                      onClick={() => void chooseOutcome(chosen ? null : parent)}
                      type="button"
                    >
                      {interviewOutcomeLabels[parent]}
                    </button>
                  );
                })}
              </div>
              {activeGroup ? (
                <div aria-label={activeGroup === "attended" ? "What was decided" : "Why they did not come"} className="mt-1.5 flex flex-wrap gap-1.5 border-l-[3px] border-l-slate-300 pl-2" role="group">
                  {interviewOutcomeGroups[activeGroup].followUps.map((option) => {
                    const chosen = booking.outcome === option;
                    return (
                      <button
                        aria-pressed={chosen}
                        className={cn(
                          "min-h-[44px] border px-3 py-1.5 text-[12px] font-bold leading-none transition-colors disabled:opacity-50 lg:min-h-0 lg:px-2",
                          chosen
                            ? "border-slate-900 bg-slate-900 text-white shadow-[inset_0_-2px_0_#f97316]"
                            : "border-slate-300 bg-white text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:border-slate-500",
                        )}
                        disabled={busy !== null}
                        key={option}
                        onClick={() => void chooseOutcome(chosen ? interviewOutcomeGroups[activeGroup].parent : option)}
                        type="button"
                      >
                        {interviewOutcomeLabels[option]}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <p className="mt-1.5 text-[11px] text-slate-500">
                {booking.external
                  ? "Marks this interview only."
                  : "Shortlisted, Back-up, Rejected and Prioritized also move the candidate in Recruitment. Nothing is sent to them."}
                {" "}Press a chosen one again to step back.
              </p>
            </>
          ) : booking.outcome ? (
            <p className="mt-1 text-[13px] font-semibold text-slate-900">{interviewOutcomeLabels[booking.outcome]}</p>
          ) : null}
          {booking.outcome && booking.outcomeSetByName ? <p className="mt-1 text-[11px] text-slate-500">Recorded by {booking.outcomeSetByName}</p> : null}
          {outcomeNote ? <p className="mt-1 text-[12px] text-slate-700">{outcomeNote}</p> : null}
        </section>
      ) : null}

      {canBook ? (
        confirmCancel ? (
          <div className="border border-red-200 border-l-[3px] border-l-red-600 bg-red-50 p-3">
            <p className="break-words text-[12px] font-semibold text-red-800">
              Cancel this interview? It leaves the calendar with its notes
              {booking.sessionId ? ", and its slot in the session is free again" : booking.zoomJoinUrl ? ", and its Zoom meeting is deleted" : ""}.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Action onClick={() => setConfirmCancel(false)} tone="quiet">
                Keep it
              </Action>
              <button
                className={cn("inline-flex items-center gap-1.5 border px-2 py-1.5 text-[12px] font-bold leading-none disabled:opacity-50", phxButtonDangerDenseClassName)}
                disabled={busy !== null}
                onClick={() => void cancel()}
                type="button"
              >
                {busy === "cancel" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Cancel interview
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Action onClick={() => setEditing(true)} tone="quiet">
              <Pencil className="h-3.5 w-3.5" />
              Edit details
            </Action>
            <Action onClick={() => setMoving(true)} tone="quiet">
              <CalendarDays className="h-3.5 w-3.5" />
              Move
            </Action>
            <Action onClick={() => setConfirmCancel(true)} tone="ghost">
              <Trash2 className="h-3.5 w-3.5" />
              Cancel interview
            </Action>
          </div>
        )
      ) : booking.canReschedule ? (
        <div>
          <Action onClick={() => setMoving(true)} tone="quiet">
            <CalendarDays className="h-3.5 w-3.5" />
            Change day & time
          </Action>
          <p className="mt-1 text-[11px] text-slate-500">You requested this interview — you can change its day, time and place. The interviewer and area are HR&rsquo;s to set.</p>
        </div>
      ) : null}

      {error ? <ErrorLine>{error}</ErrorLine> : null}

      {booking.platform === "zoom" ? (
        <section aria-label="Zoom" className="border-t border-slate-200 pt-3">
          <ZoomMeetingPanels api={api} canBook={canBook} hasMeeting={booking.hasMeeting} pollTarget={pollTarget} target={target} zoomConnected={zoomConnected} />
        </section>
      ) : null}

      {canBook ? (
        <section aria-label="Invitation" className="border-t border-slate-200 pt-3">
          <InvitationPanel api={api} bookingId={booking.id} key={`${booking.id}:${booking.updatedAt}`} />
        </section>
      ) : null}

      <InterviewExtrasPanel api={api} booking={booking} canBook={canBook} onChanged={onChanged} />

      <ScorecardPanel api={api} booking={booking} onChanged={onChanged} />

      <section aria-label="Notes" className="border-t border-slate-200 pt-3">
        <PanelHeading
          aside={
            booking.comments.length > 0 ? (
              <span className="border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[11px] font-black tabular-nums text-slate-700">{booking.comments.length}</span>
            ) : null
          }
        >
          Notes
        </PanelHeading>
        {booking.comments.length === 0 ? (
          <p className="border border-dashed border-slate-300 px-3 py-2 text-[12px] text-slate-500">No notes yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {booking.comments.map((comment) => (
              <li className={cn("border-l-[3px] px-3 py-2", comment.mine ? "border-l-orange-500 bg-orange-50/60" : "border-l-slate-300 bg-slate-50")} key={comment.id}>
                <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-[11px]">
                  <span className="font-bold text-slate-800">{comment.mine ? "You" : comment.authorName}</span>
                  <span className="text-slate-500">{cairoStamp(comment.createdAt)}</span>
                </p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] text-slate-700">{comment.body}</p>
              </li>
            ))}
          </ul>
        )}
        {canCommentOnInterviews(role) ? (
          <div className="mt-3">
            <textarea
              aria-label="Add a note"
              className={`${phxTextareaClassName} block`}
              maxLength={2000}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Add a note for the panel"
              rows={2}
              value={note}
            />
            <div className="mt-1.5 flex justify-end">
              <Action disabled={busy !== null || note.trim().length === 0} onClick={() => void addNote()} tone="primary">
                {busy === "note" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquarePlus className="h-3.5 w-3.5" />}
                Add note
              </Action>
            </div>
          </div>
        ) : null}
      </section>

      {editing ? (
        <EditInterviewDetailsDialog
          api={api}
          booking={booking}
          onClose={() => setEditing(false)}
          onSaved={onChanged}
        />
      ) : null}

      {moving ? (
        <ScheduleInterviewDialog
          api={api}
          candidate={{ id: booking.candidateId, jobTitle: booking.candidateJobTitle, name: booking.candidateName }}
          existing={booking}
          onClose={() => setMoving(false)}
          onSaved={onChanged}
          timeOnly={!canBook}
          zoomConnected={zoomConnected}
        />
      ) : null}
    </div>
  );
}
