"use client";

// The interview calendar — a week at a time, a column per day, a row per half hour, the way the
// owner's own "DAILY SCHEDULE" sheet is laid out (2026-09-18), and better: every name on it opens
// that candidate's CV, the export carries the same links, and he can share it from here.
//
// Sunday to Thursday, 9:00 AM to 5:00 PM, Cairo time — his choice. Desktop draws the grid; a phone
// gets the same week as one card per day, because a five-column grid at 375px is a grid nobody can
// read (the fits-the-screen rule: never a sideways scroll).
//
// WHAT EACH PERSON CAN DO follows the access he gave them, and the server enforces every one of
// these; the screen only stops offering what would be refused. Viewer: see it, open the CVs.
// Commenter: also leave notes on an interview. Editor: also move and cancel. Owner: also share.

import {
  AlertTriangle,
  Building2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileSpreadsheet,
  FileText,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Share2,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { CvPreviewModal } from "@/components/recruitment/cv-preview-modal";
import { deleteRequest, getJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { Action } from "@/components/recruitment/workstation/workstation-look";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import {
  ACCESS_LEVEL_LABEL,
  PLATFORM_LABEL,
  canBookInterviews,
  canCommentOnInterviews,
  canShareInterviewCalendar,
  zoomStatusSentence,
  type InterviewBooking,
  type InterviewCalendarRole,
} from "@/lib/recruitment/interview-calendar-types";
import {
  addDays,
  cairoDateKey,
  cairoMinutesOfDay,
  formatDayLong,
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

import { MonthPicker, cursorFor, type MonthCursor } from "./month-picker";
import { InterviewShareDialog } from "./interview-share-dialog";
import { ScheduleInterviewDialog } from "./schedule-interview-dialog";

const API = "/api/recruitment/interview-calendar";

type CalendarFile = { id: string; kind: string; fileName: string; mimeType: string | null; createdAt: string };

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

function sortBookings(list: InterviewBooking[]): InterviewBooking[] {
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

export function InterviewCalendarView({
  initialOpen,
  initialWeek,
  role,
  todayKey,
  zoomConnected,
}: {
  initialOpen: string | null;
  initialWeek: string;
  role: InterviewCalendarRole;
  todayKey: string;
  zoomConnected: boolean;
}) {
  const [weekStart, setWeekStart] = useState(() => weekStartFor(initialWeek));
  const [bookings, setBookings] = useState<InterviewBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(initialOpen);
  const [openBooking, setOpenBooking] = useState<InterviewBooking | null>(null);
  const [sharing, setSharing] = useState(false);
  const [exporting, setExporting] = useState<"pdf" | "xlsx" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerCursor, setPickerCursor] = useState<MonthCursor>(() => cursorFor(weekStartFor(initialWeek)));
  const pickerRef = useRef<HTMLDivElement>(null);

  const days = useMemo(() => weekDays(weekStart), [weekStart]);
  const thisWeek = weekStartFor(todayKey);

  // The address keeps the week (and the open interview), so a copied link lands where it was copied.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("week", weekStart);
    if (openId) url.searchParams.set("open", openId);
    else url.searchParams.delete("open");
    window.history.replaceState(window.history.state, "", `${url.pathname}?${url.searchParams.toString()}`);
  }, [openId, weekStart]);

  // Only the latest week asked for may land: clicking through three weeks quickly must not leave the
  // grid showing whichever answer happened to arrive last.
  const loadSeq = useRef(0);
  const loadWeek = useCallback(async (week: string) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await getJson(`${API}/bookings?week=${encodeURIComponent(week)}`);
      if (seq !== loadSeq.current) return;
      setBookings(sortBookings(Array.isArray(data.bookings) ? (data.bookings as InterviewBooking[]) : []));
    } catch (reason) {
      if (seq !== loadSeq.current) return;
      setBookings([]);
      setLoadError(reason instanceof Error ? reason.message : "The week could not be read.");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWeek(weekStart);
  }, [loadWeek, weekStart]);

  // Resolve `open` to an interview: from the week on screen, or asked for directly when a link
  // points at one outside it.
  useEffect(() => {
    if (!openId) {
      setOpenBooking(null);
      return;
    }
    const inWeek = bookings.find((booking) => booking.id === openId);
    if (inWeek) {
      setOpenBooking(inWeek);
      return;
    }
    if (loading) return;
    let live = true;
    getJson(`${API}/bookings/${encodeURIComponent(openId)}`)
      .then((data) => {
        if (!live) return;
        const booking = data.booking as InterviewBooking;
        setOpenBooking(booking);
        if (weekStartFor(booking.dateKey) !== weekStart) setWeekStart(weekStartFor(booking.dateKey));
      })
      .catch(() => {
        if (live) setOpenId(null);
      });
    return () => {
      live = false;
    };
  }, [bookings, loading, openId, weekStart]);

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
    const sunday = weekStartFor(week);
    setWeekStart(sunday);
    setPickerCursor(cursorFor(sunday));
  }

  function replaceBooking(next: InterviewBooking) {
    setBookings((current) => {
      const rest = current.filter((booking) => booking.id !== next.id);
      return weekStartFor(next.dateKey) === weekStart ? sortBookings([...rest, next]) : rest;
    });
    setOpenBooking((current) => (current && current.id === next.id ? next : current));
  }

  function removeBooking(id: string) {
    setBookings((current) => current.filter((booking) => booking.id !== id));
    setOpenId(null);
  }

  async function exportWeek(format: "pdf" | "xlsx") {
    setExporting(format);
    setExportError(null);
    try {
      const response = await fetch(`${API}/export?week=${encodeURIComponent(weekStart)}&format=${format}`);
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
      setExportError(reason instanceof Error ? reason.message : "The export could not be made.");
    } finally {
      setExporting(null);
    }
  }

  const bySlot = useMemo(() => {
    const map = new Map<string, InterviewBooking[]>();
    for (const booking of bookings) {
      const key = `${booking.dateKey}|${slotFor(booking.startMinutes)}`;
      map.set(key, [...(map.get(key) ?? []), booking]);
    }
    return map;
  }, [bookings]);

  const counts = useMemo(
    () => ({
      office: bookings.filter((booking) => booking.platform === "in_office").length,
      total: bookings.length,
      zoom: bookings.filter((booking) => booking.platform === "zoom").length,
    }),
    [bookings],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* ── The week bar ───────────────────────────────────────────────────────────────────── */}
      <section className="border border-slate-200 bg-white">
        <div className="flex flex-col gap-3 border-b-2 border-b-orange-600 px-4 py-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-[22px] font-bold leading-tight text-slate-900">{formatWeekOf(weekStart)}</p>
            <p className="mt-0.5 text-[13px] text-slate-500">
              {formatWeekRange(weekStart)} · Sunday to Thursday, 9:00 AM to 5:00 PM, Cairo time
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex">
              <button
                aria-label="Previous week"
                className="inline-flex h-9 w-9 items-center justify-center border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900"
                onClick={() => goToWeek(addDays(weekStart, -7))}
                type="button"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                aria-label="Next week"
                className="-ml-px inline-flex h-9 w-9 items-center justify-center border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900"
                onClick={() => goToWeek(addDays(weekStart, 7))}
                type="button"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <Action disabled={weekStart === thisWeek} onClick={() => goToWeek(thisWeek)} size="md" tone="quiet">
              This week
            </Action>
            <div className="relative" ref={pickerRef}>
              <Action aria-expanded={pickerOpen} onClick={() => setPickerOpen((open) => !open)} size="md" tone="quiet">
                <CalendarDays className="h-4 w-4" />
                Choose a week
              </Action>
              {pickerOpen ? (
                <div className="absolute left-0 top-full z-30 mt-1 w-[18rem] border border-slate-200 bg-white p-3 shadow-[0_12px_32px_rgba(15,23,42,0.18)] sm:left-auto sm:right-0">
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
            <span aria-hidden className="mx-1 hidden h-6 w-px bg-slate-200 sm:inline-block" />
            <Action disabled={exporting !== null} onClick={() => void exportWeek("pdf")} size="md" tone="quiet">
              {exporting === "pdf" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              Export PDF
            </Action>
            <Action disabled={exporting !== null} onClick={() => void exportWeek("xlsx")} size="md" tone="quiet">
              {exporting === "xlsx" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
              Export Excel
            </Action>
            {canShareInterviewCalendar(role) ? (
              <Action onClick={() => setSharing(true)} size="md" tone="primary">
                <Share2 className="h-4 w-4" />
                Share
              </Action>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-[12px] text-slate-600">
          <span>
            <span className="font-bold text-slate-900">{counts.total}</span> {counts.total === 1 ? "interview" : "interviews"} this week
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="inline-block h-2.5 w-2.5 bg-orange-600" />
            In office {counts.office}
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="inline-block h-2.5 w-2.5 bg-sky-600" />
            Zoom {counts.zoom}
          </span>
          {role !== "owner" ? <span className="text-slate-500">Your access: {ACCESS_LEVEL_LABEL[role]}</span> : null}
          <span className="text-slate-500">Click a name to open the CV.</span>
        </div>
        {exportError ? (
          <p className="border-t border-red-200 bg-red-50 px-4 py-2 text-[12px] font-semibold text-red-700" role="alert">
            {exportError}
          </p>
        ) : null}
        {loadError ? (
          <p className="border-t border-red-200 bg-red-50 px-4 py-2 text-[12px] font-semibold text-red-700" role="alert">
            {loadError}
          </p>
        ) : null}
      </section>

      {/* ── Desktop: the grid ──────────────────────────────────────────────────────────────── */}
      <section aria-busy={loading} aria-label="Week grid" className="relative hidden border border-slate-200 bg-white md:block">
        {loading ? (
          <div className="absolute right-3 top-3 z-10 inline-flex items-center gap-1 text-[11px] text-slate-500">
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
            <tr className="bg-slate-900 text-white">
              <th className="border-r border-slate-700 px-2 py-2 text-left text-[11px] font-bold uppercase tracking-wide" scope="col">
                Time
              </th>
              {days.map((day) => (
                <th
                  className={cn("border-r border-slate-700 px-2 py-2 text-left last:border-r-0", day === todayKey && "bg-orange-600")}
                  key={day}
                  scope="col"
                >
                  <span className="block text-[13px] font-bold">{weekdayName(day)}</span>
                  <span className="block text-[11px] font-semibold opacity-80">{formatShortDate(day)}</span>
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
                  const here = bySlot.get(`${day}|${minutes}`) ?? [];
                  return (
                    <td className={cn("h-[46px] border-r border-slate-200 p-1 align-top last:border-r-0", day === todayKey && "bg-orange-50/40")} key={day}>
                      <div className="flex flex-col gap-1">
                        {here.map((booking) => (
                          <BookingChip booking={booking} key={booking.id} onOpen={() => setOpenId(booking.id)} />
                        ))}
                      </div>
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
          const today = bookings.filter((booking) => booking.dateKey === day);
          return (
            <li className="border border-slate-200 bg-white" key={day}>
              <p className={cn("flex items-baseline justify-between gap-2 px-3 py-2 text-white", day === todayKey ? "bg-orange-600" : "bg-slate-900")}>
                <span className="text-[14px] font-bold">{weekdayName(day)}</span>
                <span className="text-[12px] font-semibold opacity-80">{formatShortDate(day)}</span>
              </p>
              {today.length === 0 ? (
                <p className="px-3 py-3 text-[12px] text-slate-500">{loading ? "Reading…" : "No interviews."}</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {today.map((booking) => (
                    <li key={booking.id}>
                      <button
                        className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-orange-50"
                        onClick={() => setOpenId(booking.id)}
                        type="button"
                      >
                        <span className="w-[4.75rem] shrink-0 text-[12px] font-bold tabular-nums text-slate-700">
                          {formatTimeOfDay(booking.startMinutes)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block break-words text-[14px] font-bold text-orange-700 underline decoration-orange-300 underline-offset-2">
                            {booking.candidateName}
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                            <span className="inline-flex items-center gap-1">
                              <PlatformIcon className="h-3 w-3" platform={booking.platform} />
                              {PLATFORM_LABEL[booking.platform]}
                            </span>
                            <span>{booking.durationMinutes} min</span>
                            {booking.candidateJobTitle ? <span className="break-words">{booking.candidateJobTitle}</span> : null}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {!loading && bookings.length === 0 && !loadError ? (
        <p className="border border-dashed border-slate-300 bg-white px-4 py-5 text-center text-[13px] text-slate-500">
          No interviews this week.
          {canBookInterviews(role) ? " Book one from any CV with its Schedule interview button." : ""}
        </p>
      ) : null}

      {openBooking ? (
        <InterviewDetail
          booking={openBooking}
          key={openBooking.id}
          onChanged={replaceBooking}
          onClose={() => setOpenId(null)}
          onRemoved={removeBooking}
          role={role}
          zoomConnected={zoomConnected}
        />
      ) : null}

      {sharing ? <InterviewShareDialog onClose={() => setSharing(false)} /> : null}
    </div>
  );
}

function BookingChip({ booking, onOpen }: { booking: InterviewBooking; onOpen: () => void }) {
  const zoom = booking.platform === "zoom";
  const trouble = zoom && booking.zoomStatus !== "created";
  return (
    <button
      className={cn(
        "group block w-full border-l-[3px] px-1.5 py-1 text-left transition-colors",
        zoom ? "border-l-sky-600 bg-sky-50 hover:bg-sky-100" : "border-l-orange-600 bg-orange-50 hover:bg-orange-100",
      )}
      onClick={onOpen}
      title={`Open ${booking.candidateName}'s CV`}
      type="button"
    >
      <span className="block break-words text-[12px] font-bold leading-tight text-slate-900 group-hover:underline">
        {booking.candidateName}
      </span>
      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px] leading-tight text-slate-600">
        <span className="inline-flex items-center gap-0.5">
          <PlatformIcon className="h-3 w-3" platform={booking.platform} />
          {formatTimeRange(booking.startMinutes, booking.durationMinutes)}
        </span>
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

function InterviewDetail({
  booking,
  onChanged,
  onClose,
  onRemoved,
  role,
  zoomConnected,
}: {
  booking: InterviewBooking;
  onChanged: (booking: InterviewBooking) => void;
  onClose: () => void;
  onRemoved: (id: string) => void;
  role: InterviewCalendarRole;
  zoomConnected: boolean;
}) {
  const [files, setFiles] = useState<CalendarFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getJson(`${API}/candidates/${encodeURIComponent(booking.candidateId)}/files`)
      .then((data) => {
        if (live) setFiles(Array.isArray(data.files) ? (data.files as CalendarFile[]) : []);
      })
      .catch((reason) => {
        if (!live) return;
        setFiles([]);
        setFilesError(reason instanceof Error ? reason.message : "The CV could not be read.");
      });
    return () => {
      live = false;
    };
  }, [booking.candidateId]);

  const cv = files ? chooseCv(files) : null;
  const panel = (
    <InterviewPanel booking={booking} onChanged={onChanged} onRemoved={onRemoved} role={role} zoomConnected={zoomConnected} />
  );

  if (cv) {
    return (
      <CvPreviewModal
        downloadUrl={`${API}/candidates/${encodeURIComponent(booking.candidateId)}/files/${encodeURIComponent(cv.id)}`}
        fileName={`${booking.candidateName} · ${cv.fileName}`}
        mimeType={cv.mimeType}
        onClose={onClose}
        sidePanel={panel}
      />
    );
  }

  return (
    <PlainDialog onClose={onClose} title={booking.candidateName}>
      <p
        className={cn(
          "mb-4 px-3 py-2 text-[12px]",
          files === null ? "bg-slate-50 text-slate-500" : "border-l-[3px] border-l-amber-500 bg-amber-50 text-slate-700",
        )}
      >
        {files === null ? "Opening the CV…" : filesError ?? "No readable CV is attached to this candidate."}
      </p>
      {panel}
    </PlainDialog>
  );
}

function PlainDialog({ children, onClose, title }: { children: ReactNode; onClose: () => void; title: string }) {
  const dialogRef = useDialogA11y({ onClose, open: true });
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const body = (
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-slate-900/45 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-label={title}
        aria-modal="true"
        className="flex max-h-[92vh] w-full max-w-[520px] flex-col border border-slate-200 bg-white shadow-[0_24px_60px_rgba(15,23,42,0.28)]"
        ref={dialogRef}
        role="dialog"
      >
        <div className="flex justify-end border-b border-slate-200 px-3 py-2">
          <button
            aria-label="Close"
            className="inline-flex h-8 w-8 items-center justify-center border border-transparent text-slate-500 hover:border-slate-200 hover:text-slate-900"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  );
  return mounted ? createPortal(body, document.body) : null;
}

function InterviewPanel({
  booking,
  onChanged,
  onRemoved,
  role,
  zoomConnected,
}: {
  booking: InterviewBooking;
  onChanged: (booking: InterviewBooking) => void;
  onRemoved: (id: string) => void;
  role: InterviewCalendarRole;
  zoomConnected: boolean;
}) {
  const [moving, setMoving] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState<"cancel" | "zoom" | "note" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const zoomLine = zoomStatusSentence(booking.zoomStatus, booking.zoomError);
  const canBook = canBookInterviews(role);

  async function cancel() {
    setBusy("cancel");
    setError(null);
    try {
      await deleteRequest(`${API}/bookings/${encodeURIComponent(booking.id)}`);
      onRemoved(booking.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The interview could not be cancelled.");
      setBusy(null);
    }
  }

  async function retryZoom() {
    setBusy("zoom");
    setError(null);
    try {
      const data = await postJson(`${API}/bookings/${encodeURIComponent(booking.id)}/zoom`, {});
      onChanged(data.booking as InterviewBooking);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Zoom could not make the meeting.");
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
      const data = await postJson(`${API}/bookings/${encodeURIComponent(booking.id)}/comments`, { body: text });
      onChanged(data.booking as InterviewBooking);
      setNote("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The note could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-orange-700">Interview</p>
        <p className="mt-0.5 break-words text-[17px] font-bold text-slate-900">{booking.candidateName}</p>
        {booking.candidateJobTitle ? <p className="break-words text-[12px] text-slate-500">Applied for {booking.candidateJobTitle}</p> : null}
      </div>

      <dl className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 gap-y-2 text-[13px] text-slate-800">
        <dt className="pt-0.5 text-slate-400">
          <CalendarDays aria-label="Day" className="h-4 w-4" />
        </dt>
        <dd className="font-semibold">{formatDayLong(booking.dateKey)}</dd>
        <dt className="pt-0.5 text-slate-400">
          <Clock3 aria-label="Time" className="h-4 w-4" />
        </dt>
        <dd>
          {formatTimeRange(booking.startMinutes, booking.durationMinutes)} <span className="text-slate-500">({booking.durationMinutes} min)</span>
        </dd>
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
          {canBook && booking.platform === "zoom" && booking.zoomStatus !== "created" && zoomConnected ? (
            <Action className="mt-1.5" disabled={busy !== null} onClick={() => void retryZoom()} tone="quiet">
              {busy === "zoom" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Make the Zoom meeting
            </Action>
          ) : null}
        </dd>
      </dl>

      {booking.notes ? (
        <p className="whitespace-pre-wrap break-words border-l-[3px] border-l-slate-300 bg-slate-50 px-3 py-2 text-[12px] text-slate-700">{booking.notes}</p>
      ) : null}
      {booking.bookedByName ? <p className="text-[11px] text-slate-500">Booked by {booking.bookedByName}</p> : null}

      {canBook ? (
        confirmCancel ? (
          <div className="border border-red-200 bg-red-50 p-3">
            <p className="text-[12px] font-semibold text-red-800">Cancel this interview? It leaves the calendar with its notes{booking.zoomJoinUrl ? ", and its Zoom meeting is deleted" : ""}.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Action onClick={() => setConfirmCancel(false)} tone="quiet">
                Keep it
              </Action>
              <button
                className="inline-flex items-center gap-1.5 border border-red-700 bg-red-700 px-2 py-1.5 text-[12px] font-bold leading-none text-white hover:bg-red-800 disabled:opacity-50"
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
      ) : null}

      {error ? (
        <p className="border-l-[3px] border-l-red-600 bg-red-50 px-3 py-2 text-[12px] font-semibold text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      <section aria-label="Notes" className="border-t border-slate-200 pt-3">
        <p className="mb-2 text-[12px] font-bold uppercase tracking-[0.06em] text-slate-700">
          Notes{booking.comments.length > 0 ? ` (${booking.comments.length})` : ""}
        </p>
        {booking.comments.length === 0 ? (
          <p className="text-[12px] text-slate-500">No notes yet.</p>
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
              className="block w-full border border-slate-200 px-2 py-1.5 text-[13px] text-slate-800 focus:border-orange-500 focus:outline-none"
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

      {moving ? (
        <ScheduleInterviewDialog
          candidate={{ id: booking.candidateId, jobTitle: booking.candidateJobTitle, name: booking.candidateName }}
          existing={booking}
          onClose={() => setMoving(false)}
          onSaved={onChanged}
          zoomConnected={zoomConnected}
        />
      ) : null}
    </div>
  );
}
