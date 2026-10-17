// HR Reminders — the rules, with no database and no clock in them.
//
// Everything the module DECIDES lives here as a pure function, so the server (which enforces it)
// and the board (which draws from it) read one implementation and a test can drive every branch:
//
//   · who may SEE an item, and who may CHANGE it
//   · what an author may type, and what is stored from it
//   · who is told about a comment
//   · the week and month grids, and how a list is bucketed into Overdue / Today / Upcoming / Notes
//
// Dates are Cairo calendar days written "YYYY-MM-DD" and times are Cairo wall-clock "HH:MM". They
// are never turned into instants: a reminder for the 18th is for the 18th in Cairo whatever the
// server's or the browser's zone says, so every calculation here runs on the date parts in UTC
// arithmetic and never through the local zone.

import { canonicalHrIdKey, hrIdForStorage } from "@/lib/hr-id";
import {
  REMINDER_BODY_MAX,
  REMINDER_COLORS,
  REMINDER_COMMENT_MAX,
  REMINDER_TITLE_MAX,
  type ReminderColor,
  type ReminderDraft,
  type ReminderRecord,
  type ReminderView,
  type SharingKind,
  type TeamMember,
} from "@/lib/hr-reminders/types";

// ── Who may see and who may change ─────────────────────────────────────────────────────────────

/** The person looking. `hrId` is the PERSON's id (the console login already folded onto B-10). */
export type ReminderAudience = {
  hrId: string;
  isOverseer: boolean;
};

type SharingFields = Pick<ReminderRecord, "ownerHrId" | "shareWithTeam" | "sharedWithHrIds">;

/**
 * Whether this person may read the item.
 *
 * The author always can. The overseer (the HR Manager) always can, whatever the sharing — that is
 * the brief, and the reason an author is told so wherever they choose who sees an item. Anyone else
 * needs the item shared with the whole team or with them by name.
 *
 * The caller has already confirmed the person holds `hr_reminders:read`: "the whole team" means the
 * team that can open the module, not the company.
 */
export function canSeeReminder(viewer: ReminderAudience, reminder: SharingFields): boolean {
  if (viewer.isOverseer) return true;
  const me = canonicalHrIdKey(viewer.hrId);
  if (!me) return false;
  if (canonicalHrIdKey(reminder.ownerHrId) === me) return true;
  if (reminder.shareWithTeam) return true;
  return reminder.sharedWithHrIds.some((hrId) => canonicalHrIdKey(hrId) === me);
}

/**
 * Whether this person may edit, finish or remove the item: its author, and nobody else.
 *
 * Not the overseer. He reads and comments on everything, and a note a teammate wrote stays in her
 * words — the conversation under it is where he answers her.
 */
export function canChangeReminder(viewer: ReminderAudience, reminder: Pick<ReminderRecord, "ownerHrId">): boolean {
  const me = canonicalHrIdKey(viewer.hrId);
  return Boolean(me) && canonicalHrIdKey(reminder.ownerHrId) === me;
}

export function sharingKind(reminder: Pick<ReminderRecord, "shareWithTeam" | "sharedWithHrIds">): SharingKind {
  if (reminder.shareWithTeam) return "team";
  return reminder.sharedWithHrIds.length > 0 ? "people" : "private";
}

// ── What an author may type ────────────────────────────────────────────────────────────────────

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toUtcDate(iso: string): Date {
  const match = ISO_DAY.exec(iso);
  if (!match) return new Date(Number.NaN);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function fromUtcDate(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** A real calendar day, so "2026-02-31" is refused rather than rolled into March. */
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = toUtcDate(value);
  return !Number.isNaN(date.getTime()) && fromUtcDate(date) === value;
}

export function isClockTime(value: unknown): value is string {
  return typeof value === "string" && CLOCK_TIME.test(value);
}

/** The database returns `time` as "HH:MM:SS"; the app speaks "HH:MM". */
export function clockFromDatabase(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 5);
  return isClockTime(trimmed) ? trimmed : null;
}

export function isReminderColor(value: unknown): value is ReminderColor {
  return typeof value === "string" && (REMINDER_COLORS as readonly string[]).includes(value);
}

export type DraftParse =
  | { ok: true; value: ReminderDraft }
  | { message: string; ok: false };

function optionalText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalClock(value: unknown): string | null | "invalid" {
  if (value === null || value === undefined || value === "") return null;
  return isClockTime(value) ? value : "invalid";
}

/**
 * Read an author's input into a draft, or say plainly what is wrong with it.
 *
 * The same rules the table's CHECK constraints hold, said first in words a person can act on: a
 * constraint violation reaches the browser as a database error, which is no way to tell somebody
 * their end time is before their start time.
 */
export function parseReminderDraft(input: unknown): DraftParse {
  if (!input || typeof input !== "object") return { message: "Send the reminder as an object.", ok: false };
  const raw = input as Record<string, unknown>;

  const title = optionalText(raw.title).trim();
  if (!title) return { message: "Give the reminder a title.", ok: false };
  if (title.length > REMINDER_TITLE_MAX) {
    return { message: `The title is limited to ${REMINDER_TITLE_MAX} characters.`, ok: false };
  }

  const body = optionalText(raw.body).replace(/\r\n/g, "\n").trim();
  if (body.length > REMINDER_BODY_MAX) {
    return { message: `The details are limited to ${REMINDER_BODY_MAX} characters.`, ok: false };
  }

  const remindOnRaw = raw.remindOn;
  const remindOn = remindOnRaw === null || remindOnRaw === undefined || remindOnRaw === "" ? null : remindOnRaw;
  if (remindOn !== null && !isIsoDay(remindOn)) {
    return { message: "That date is not a real calendar day.", ok: false };
  }

  const startsAt = optionalClock(raw.startsAt);
  const endsAt = optionalClock(raw.endsAt);
  if (startsAt === "invalid" || endsAt === "invalid") {
    return { message: "Times are written as hours and minutes, like 09:30.", ok: false };
  }
  if (startsAt !== null && remindOn === null) {
    return { message: "Pick a day before you give the reminder a time.", ok: false };
  }
  if (endsAt !== null && startsAt === null) {
    return { message: "Give the reminder a start time before an end time.", ok: false };
  }
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
    return { message: "The end time has to come after the start time.", ok: false };
  }

  const colorRaw = raw.color === undefined || raw.color === null || raw.color === "" ? "orange" : raw.color;
  if (!isReminderColor(colorRaw)) return { message: "Pick one of the listed colours.", ok: false };

  const shareWithTeam = raw.shareWithTeam === true;
  const sharedRaw = raw.sharedWithHrIds;
  if (sharedRaw !== undefined && sharedRaw !== null && !Array.isArray(sharedRaw)) {
    return { message: "Choose who to share with from the team list.", ok: false };
  }
  const sharedWithHrIds = dedupeHrIds(
    ((sharedRaw ?? []) as unknown[]).filter((entry): entry is string => typeof entry === "string"),
  );

  return {
    ok: true,
    value: {
      body,
      color: colorRaw,
      endsAt,
      remindOn,
      shareWithTeam,
      sharedWithHrIds,
      startsAt,
      title,
    },
  };
}

/** Distinct people, each in stored casing, in the order first met. */
export function dedupeHrIds(hrIds: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hrId of hrIds) {
    const key = canonicalHrIdKey(hrId);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(hrIdForStorage(hrId) ?? String(hrId));
  }
  return out;
}

/**
 * What is stored for the sharing the author chose.
 *
 * Sharing with the whole team already covers everyone, so the named list is dropped rather than
 * kept as a second, contradictory statement. The author is never in their own list, and a name that
 * is not on the HR team is dropped — the service passes the live team, so an old or typed id can
 * never put a note in front of someone outside it.
 */
export function normaliseSharing(
  draft: Pick<ReminderDraft, "shareWithTeam" | "sharedWithHrIds">,
  ownerHrId: string,
  teamHrIds: readonly string[],
): Pick<ReminderDraft, "shareWithTeam" | "sharedWithHrIds"> {
  if (draft.shareWithTeam) return { shareWithTeam: true, sharedWithHrIds: [] };
  const owner = canonicalHrIdKey(ownerHrId);
  const onTeam = new Set(teamHrIds.map((hrId) => canonicalHrIdKey(hrId)).filter((key): key is string => Boolean(key)));
  const kept = dedupeHrIds(draft.sharedWithHrIds).filter((hrId) => {
    const key = canonicalHrIdKey(hrId);
    return Boolean(key) && key !== owner && onTeam.has(key as string);
  });
  return { shareWithTeam: false, sharedWithHrIds: kept };
}

export type CommentParse =
  | { body: string; ok: true }
  | { message: string; ok: false };

export function parseCommentBody(input: unknown): CommentParse {
  const body = (typeof input === "string" ? input : "").replace(/\r\n/g, "\n").trim();
  if (!body) return { message: "Write something before you send it.", ok: false };
  if (body.length > REMINDER_COMMENT_MAX) {
    return { message: `A comment is limited to ${REMINDER_COMMENT_MAX} characters.`, ok: false };
  }
  return { body, ok: true };
}

// ── Who hears about a comment ──────────────────────────────────────────────────────────────────

/**
 * The people told, in the bell, that a comment was written.
 *
 * The item's author, everyone it was shared with by name, and everyone already talking under it —
 * minus whoever just wrote. When the item is shared with the whole team nobody is pinged by default:
 * four colleagues would each be told about every remark under a note aimed at all of them. They are
 * told as soon as they have joined the conversation themselves.
 *
 * The HR Manager is not added on top. He reads everything, but being told of every remark under
 * every private note is exactly the noise he did not ask for; the moment he writes under one he is
 * part of the thread and hears the reply.
 */
export function commentAudience(input: {
  authorHrId: string;
  ownerHrId: string;
  priorCommenterHrIds: readonly (string | null | undefined)[];
  sharedWithHrIds: readonly string[];
}): string[] {
  const author = canonicalHrIdKey(input.authorHrId);
  return dedupeHrIds([input.ownerHrId, ...input.sharedWithHrIds, ...input.priorCommenterHrIds]).filter(
    (hrId) => canonicalHrIdKey(hrId) !== author,
  );
}

// ── Calendar arithmetic (Sunday-first, the company week) ───────────────────────────────────────

export function addDays(iso: string, days: number): string {
  const date = toUtcDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtcDate(date);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayIndex(iso: string): number {
  return toUtcDate(iso).getUTCDay();
}

export function startOfWeek(iso: string): string {
  return addDays(iso, -weekdayIndex(iso));
}

export function weekOf(iso: string): string[] {
  const first = startOfWeek(iso);
  return Array.from({ length: 7 }, (_, index) => addDays(first, index));
}

export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** The first day of the month `months` away from the month `iso` falls in. */
export function addMonths(iso: string, months: number): string {
  const date = toUtcDate(startOfMonth(iso));
  date.setUTCMonth(date.getUTCMonth() + months);
  return fromUtcDate(date);
}

export function sameMonth(left: string, right: string): boolean {
  return left.slice(0, 7) === right.slice(0, 7);
}

/** Every week that touches the month, as rows of seven days, Sunday first. */
export function monthWeeks(iso: string): string[][] {
  const first = startOfMonth(iso);
  const nextFirst = addMonths(first, 1);
  const last = addDays(nextFirst, -1);
  const weeks: string[][] = [];
  for (let cursor = startOfWeek(first); cursor <= last; cursor = addDays(cursor, 7)) {
    weeks.push(weekOf(cursor));
  }
  return weeks;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export function weekdayName(iso: string): string {
  return WEEKDAY_NAMES[weekdayIndex(iso)] ?? "";
}

export function weekdayShort(iso: string): string {
  return weekdayName(iso).slice(0, 3);
}

export function monthName(iso: string): string {
  return MONTH_NAMES[Number(iso.slice(5, 7)) - 1] ?? "";
}

export function dayOfMonth(iso: string): number {
  return Number(iso.slice(8, 10));
}

/** "Sunday 18 October" — the weekday is what a reminder is planned around. */
export function formatDayLong(iso: string): string {
  return `${weekdayName(iso)} ${dayOfMonth(iso)} ${monthName(iso)}`;
}

/** "18 Oct 2026". */
export function formatDayShort(iso: string): string {
  return `${dayOfMonth(iso)} ${monthName(iso).slice(0, 3)} ${iso.slice(0, 4)}`;
}

export function formatMonthTitle(iso: string): string {
  return `${monthName(iso)} ${iso.slice(0, 4)}`;
}

/** "9:30 AM" from "09:30". */
export function formatClock(value: string | null): string {
  if (!value || !isClockTime(value)) return "";
  const hours = Number(value.slice(0, 2));
  const minutes = value.slice(3, 5);
  const suffix = hours >= 12 ? "PM" : "AM";
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${minutes} ${suffix}`;
}

/** "9:30 AM – 10:15 AM", "9:30 AM", or "" for an item with no time. */
export function formatTimeSpan(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt) return "";
  const start = formatClock(startsAt);
  return endsAt ? `${start} – ${formatClock(endsAt)}` : start;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcDate(to).getTime() - toUtcDate(from).getTime()) / 86_400_000);
}

/** "Today", "Tomorrow", "Yesterday", else "Sunday 18 October" — relative to the server's Cairo today. */
export function relativeDayLabel(day: string, today: string): string {
  const diff = daysBetween(today, day);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return formatDayLong(day);
}

/** Who an item is shared with, in words, for the open item's header. */
export function describeSharing(
  reminder: SharingFields,
  team: readonly Pick<TeamMember, "hrId" | "name">[],
  ownerName: string,
): string {
  if (reminder.shareWithTeam) return "Shared with the whole team";
  if (reminder.sharedWithHrIds.length === 0) return `Private to ${ownerName}`;
  const names = reminder.sharedWithHrIds.map(
    (hrId) => team.find((member) => canonicalHrIdKey(member.hrId) === canonicalHrIdKey(hrId))?.name ?? hrId,
  );
  return `Shared with ${names.join(", ")}`;
}

// ── Lists: ordering, filtering, bucketing ──────────────────────────────────────────────────────

type Plannable = Pick<ReminderRecord, "remindOn" | "startsAt" | "title">;

/** Earlier day first, then earlier time, an all-day item before a timed one, then by title. */
export function compareByDayThenTime(left: Plannable, right: Plannable): number {
  const leftDay = left.remindOn ?? "9999-12-31";
  const rightDay = right.remindOn ?? "9999-12-31";
  if (leftDay !== rightDay) return leftDay < rightDay ? -1 : 1;
  const leftTime = left.startsAt ?? "";
  const rightTime = right.startsAt ?? "";
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return left.title.localeCompare(right.title);
}

/** Items bucketed by their day, each day ordered by time. Undated items are not in the map. */
export function groupByDay<T extends Plannable>(items: readonly T[]): Map<string, T[]> {
  const byDay = new Map<string, T[]>();
  for (const item of items) {
    if (!item.remindOn) continue;
    const list = byDay.get(item.remindOn);
    if (list) list.push(item);
    else byDay.set(item.remindOn, [item]);
  }
  for (const list of byDay.values()) list.sort(compareByDayThenTime);
  return byDay;
}

export type NoteBuckets<T> = {
  done: T[];
  overdue: T[];
  today: T[];
  undated: T[];
  upcoming: T[];
};

/**
 * The notes view's sections. An open item with a day before today is Overdue; one for today is
 * Today; later is Upcoming; no day at all is a plain Note. Finished items go last, newest first.
 */
export function bucketForNotes<T extends Pick<ReminderView, "doneAt" | "remindOn" | "startsAt" | "status" | "title" | "updatedAt">>(
  items: readonly T[],
  today: string,
): NoteBuckets<T> {
  const buckets: NoteBuckets<T> = { done: [], overdue: [], today: [], undated: [], upcoming: [] };
  for (const item of items) {
    if (item.status === "done") buckets.done.push(item);
    else if (!item.remindOn) buckets.undated.push(item);
    else if (item.remindOn < today) buckets.overdue.push(item);
    else if (item.remindOn === today) buckets.today.push(item);
    else buckets.upcoming.push(item);
  }
  buckets.overdue.sort(compareByDayThenTime);
  buckets.today.sort(compareByDayThenTime);
  buckets.upcoming.sort(compareByDayThenTime);
  buckets.undated.sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0));
  buckets.done.sort((left, right) => String(right.doneAt ?? "").localeCompare(String(left.doneAt ?? "")));
  return buckets;
}

/** Keep one person's items, or everything. Matches the author, in whatever casing it is stored. */
export function filterByOwner<T extends Pick<ReminderRecord, "ownerHrId">>(
  items: readonly T[],
  ownerHrId: string | "all",
): T[] {
  if (ownerHrId === "all") return [...items];
  const key = canonicalHrIdKey(ownerHrId);
  return items.filter((item) => canonicalHrIdKey(item.ownerHrId) === key);
}

/** "YG" from "Yomna Gamal" — two letters at most, for the owner's mark on a card. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? words[words.length - 1]?.[0] ?? "" : "";
  return `${first}${last}`.toUpperCase();
}
