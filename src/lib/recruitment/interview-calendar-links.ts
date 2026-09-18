// Recruitment — the interview calendar's COPY LINKS.
//
// The owner, 2026-09-18, "exactly as Google Sheets": he makes a link, chooses what it gives —
// Viewer, Commenter or Editor — and whether it opens the whole calendar or only the week on his
// screen, then copies it or sends it on WhatsApp himself. He can switch a link off, switch it back
// on, change it, or delete it, and sees how often it was opened.
//
// His answer on signing in was "View without sign-in": whoever holds a link SEES what it opens with
// no account at all. Commenting and editing need a Phoenix sign-in, which then gives the link's
// level. The rule itself — who is what, on which week — is `effectiveCalendarRole` in
// interview-calendar-types.ts; the gate that applies it is `requireCalendarAccess`.
//
// A link is a bearer secret: 32 random bytes, 43 characters. Only the owner lists, copies or changes
// links, and a switched-off or deleted link opens nothing from the moment it is switched.

import { randomBytes } from "node:crypto";

import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdForStorage } from "@/lib/hr-id";
import { isUuid } from "@/lib/http/uuid";
import { recruitmentDb } from "@/lib/recruitment/db";
import {
  LINK_COLUMNS,
  grantFromLinkRow,
  isSignedInCaller,
  loadInterviewCalendarLinkByToken,
  loadPeople,
  personName,
  requireCalendarAccess,
  resolveInterviewCalendarRole,
  type InterviewCalendarCaller,
  type InterviewCalendarLinkRow,
} from "@/lib/recruitment/interview-calendar";
import {
  bestCalendarRole,
  isInterviewCalendarAccessLevel,
  type InterviewCalendarLink,
  type InterviewCalendarLinkGrant,
  type InterviewCalendarRole,
} from "@/lib/recruitment/interview-calendar-types";
import { isDateKey, weekStartFor } from "@/lib/recruitment/interview-calendar-week";

const LINKS = "ats_interview_calendar_links";

/** A new link's secret: 32 random bytes, URL-safe. */
export function newInterviewCalendarLinkToken(): string {
  return randomBytes(32).toString("base64url");
}

async function mapLinks(rows: readonly InterviewCalendarLinkRow[]): Promise<InterviewCalendarLink[]> {
  const people = await loadPeople(rows.map((row) => row.created_by_hr_id));
  return rows
    .filter((row) => isInterviewCalendarAccessLevel(row.access_level))
    .map((row) => ({
      accessLevel: row.access_level as InterviewCalendarLink["accessLevel"],
      createdAt: row.created_at,
      createdByName: personName(people, row.created_by_hr_id),
      guestCvs: row.guest_cvs !== false,
      id: row.id,
      isActive: row.is_active !== false,
      lastUsedAt: row.last_used_at,
      token: row.token,
      useCount: Number(row.use_count ?? 0),
      weekStart: row.week_start ? String(row.week_start).slice(0, 10) : null,
    }));
}

export async function listInterviewCalendarLinks(caller: InterviewCalendarCaller): Promise<InterviewCalendarLink[]> {
  requireCalendarAccess(caller, "share", null);
  const { data, error } = await recruitmentDb().from(LINKS).select(LINK_COLUMNS).order("created_at", { ascending: false });
  if (error) throw error;
  return mapLinks((data ?? []) as InterviewCalendarLinkRow[]);
}

function readWeek(value: unknown): string | null {
  if (value === null || value === undefined || value === "" || value === "all") return null;
  if (!isDateKey(value)) throw new Error("Choose the week the link opens, or the whole calendar.");
  return weekStartFor(value);
}

export async function createInterviewCalendarLink(
  caller: InterviewCalendarCaller,
  input: { accessLevel?: unknown; weekStart?: unknown; guestCvs?: unknown },
): Promise<InterviewCalendarLink[]> {
  requireCalendarAccess(caller, "share", null);
  if (!isInterviewCalendarAccessLevel(input.accessLevel)) throw new Error("Choose Viewer, Commenter or Editor.");
  const actor = hrIdForStorage(caller.access.hrId);
  const { error } = await recruitmentDb()
    .from(LINKS)
    .insert({
      access_level: input.accessLevel,
      created_by_hr_id: actor,
      guest_cvs: input.guestCvs !== false,
      token: newInterviewCalendarLinkToken(),
      updated_by_hr_id: actor,
      week_start: readWeek(input.weekStart),
    });
  if (error) throw error;
  return listInterviewCalendarLinks(caller);
}

export async function updateInterviewCalendarLink(
  caller: InterviewCalendarCaller,
  linkId: string,
  patch: { accessLevel?: unknown; weekStart?: unknown; guestCvs?: unknown; isActive?: unknown },
): Promise<InterviewCalendarLink[]> {
  requireCalendarAccess(caller, "share", null);
  if (!isUuid(linkId)) throw new Error("Link not found.");
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by_hr_id: hrIdForStorage(caller.access.hrId),
  };
  if (patch.accessLevel !== undefined) {
    if (!isInterviewCalendarAccessLevel(patch.accessLevel)) throw new Error("Choose Viewer, Commenter or Editor.");
    update.access_level = patch.accessLevel;
  }
  if (patch.weekStart !== undefined) update.week_start = readWeek(patch.weekStart);
  if (patch.guestCvs !== undefined) update.guest_cvs = patch.guestCvs === true;
  if (patch.isActive !== undefined) update.is_active = patch.isActive === true;
  const { data, error } = await recruitmentDb().from(LINKS).update(update).eq("id", linkId).select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw new Error("Link not found.");
  return listInterviewCalendarLinks(caller);
}

/** Deleting is final: whoever holds the link is refused from now on, and the same link cannot be made again. */
export async function deleteInterviewCalendarLink(caller: InterviewCalendarCaller, linkId: string): Promise<InterviewCalendarLink[]> {
  requireCalendarAccess(caller, "share", null);
  if (!isUuid(linkId)) throw new Error("Link not found.");
  const { error } = await recruitmentDb().from(LINKS).delete().eq("id", linkId);
  if (error) throw error;
  return listInterviewCalendarLinks(caller);
}

export type OpenedInterviewCalendarLink = {
  grant: InterviewCalendarLinkGrant;
  /** The person's own level, if they hold the calendar in their own right. */
  own: InterviewCalendarRole | null;
  /** The highest level on the calendar for this visit — what the screen draws buttons for. */
  role: InterviewCalendarRole;
  signedIn: boolean;
};

/**
 * Someone opened a link's page. Returns what it gives them, or null when the link is switched off
 * or does not exist. Counts the visit — the owner sees how often each link was opened.
 */
export async function openInterviewCalendarLink(token: string, access: AccessContext): Promise<OpenedInterviewCalendarLink | null> {
  const row = await loadInterviewCalendarLinkByToken(token);
  if (!row) return null;
  const signedIn = isSignedInCaller(access);
  const grant = grantFromLinkRow(row, signedIn);
  if (!grant) return null;
  const own = signedIn ? await resolveInterviewCalendarRole(access) : null;
  const role = bestCalendarRole({ link: grant, own });
  if (!role) return null;

  // A count, not an audit: two visits in the same instant may count once, which is harmless here.
  const { error } = await recruitmentDb()
    .from(LINKS)
    .update({ last_used_at: new Date().toISOString(), use_count: Number(row.use_count ?? 0) + 1 })
    .eq("id", row.id);
  if (error) console.warn("[interview-calendar] could not count a link visit", error.message);

  return { grant, own, role, signedIn };
}
