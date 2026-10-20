// VIEW AS SEAT — starting and leaving a view, server side. The rules (who, what, read-only) live in
// seat-view.ts; the token in seat-view-token.ts. This file only answers "may he open THIS view", records
// that he did, and mints the cookie value.

import { writeAuditLog, writeRequiredAuditLog } from "@/lib/admin/audit";
import { findDevPreviewCandidateByHrId } from "@/lib/auth/dev-preview-picker";
import { displayTitleForRole } from "@/lib/auth/hr-functions";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { parseRoleStrict, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { verifySessionToken } from "@/lib/auth/session-token";
import { validationError, forbiddenError } from "@/lib/http/api-errors";

import {
  isSeatViewableRole,
  seatViewOfficeRoles,
  seatViewPersonRule,
  seatViewPortalRoles,
} from "./seat-view.ts";
import { SEAT_VIEW_TTL_SECONDS } from "./seat-view-constants.ts";
import { createSeatViewToken } from "./seat-view-token.ts";

export type SeatViewChoice = {
  role: PhoenixRole;
  /** The seat as a person reads it — the job title, never the permission key. */
  label: string;
  group: "office" | "portal";
};

/** Only the owner, on the real Super Admin session, may open a view — and not from inside one. */
export function assertSeatViewOwner(access: AccessContext): void {
  if (
    access.source !== "session"
    || access.role !== "Super Admin"
    || access.testPersona
    || access.seatView
    || !access.loginId
  ) {
    throw forbiddenError("Only the Super Admin, on their own sign-in, can view another seat.");
  }
}

export function seatViewChoices(): SeatViewChoice[] {
  const toChoice = (group: SeatViewChoice["group"]) => (role: PhoenixRole): SeatViewChoice => ({
    role,
    label: displayTitleForRole(role),
    group,
  });
  return [
    ...seatViewOfficeRoles().map(toChoice("office")),
    ...seatViewPortalRoles().map(toChoice("portal")),
  ].sort((a, b) => (a.group === b.group ? a.label.localeCompare(b.label) : a.group === "office" ? -1 : 1));
}

export async function startSeatView(input: {
  access: AccessContext;
  sessionToken: string | null | undefined;
  role: string | null | undefined;
  hrId: string | null | undefined;
}): Promise<{ token: string; landingPath: string; maxAge: number }> {
  assertSeatViewOwner(input.access);

  let role: PhoenixRole;
  try {
    role = parseRoleStrict(input.role);
  } catch {
    throw validationError("Pick a seat to view.");
  }
  if (!isSeatViewableRole(role)) throw validationError("That seat cannot be viewed.");

  const session = verifySessionToken(input.sessionToken);
  if (!session || session.loginId !== input.access.loginId) {
    throw forbiddenError("Your own sign-in could not be confirmed. Sign in again, then open the view.");
  }

  const rule = seatViewPersonRule(role);
  let hrId: string | null = null;
  let personName: string | null = null;
  if (rule === "required") {
    const wanted = String(input.hrId ?? "").trim();
    if (!wanted) throw validationError("Pick the person whose portal you want to see.");
    const candidate = await findDevPreviewCandidateByHrId(role, wanted);
    if (!candidate) throw validationError("That person is not an active employee holding this seat.");
    hrId = candidate.hrId;
    personName = candidate.fullName;
  }

  const seatTitle = displayTitleForRole(role);
  const { token, payload } = createSeatViewToken({
    role,
    hrId,
    personName,
    ownerLoginId: input.access.loginId as string,
    ownerSid: session.sid,
  });

  // No record, no view: a look at somebody's portal is always on the audit trail.
  await writeRequiredAuditLog({
    actorLoginId: input.access.loginId,
    entityId: hrId ?? role,
    entityType: "auth_session",
    newValues: {
      kind: "seat_view_started",
      ownerLoginId: input.access.loginId,
      ownerHrId: input.access.hrId,
      seatRole: role,
      seatTitle,
      viewedHrId: hrId,
      viewedName: personName,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    },
    summary: personName
      ? `Super Admin opened a read-only view of ${personName}'s portal (${seatTitle})`
      : `Super Admin opened a read-only view of the ${seatTitle} seat`,
  });

  return { token, landingPath: resolveLandingPathForRole(role), maxAge: SEAT_VIEW_TTL_SECONDS };
}

/** Best effort: leaving a view must always work, so a failed audit row never blocks the exit. */
export async function endSeatView(access: AccessContext): Promise<void> {
  if (!access.seatView) return;
  const seatTitle = displayTitleForRole(access.role);
  await writeAuditLog({
    actorLoginId: access.seatView.ownerLoginId,
    entityId: access.hrId ?? access.role,
    entityType: "auth_session",
    newValues: {
      kind: "seat_view_ended",
      ownerLoginId: access.seatView.ownerLoginId,
      seatRole: access.role,
      seatTitle,
      viewedHrId: access.hrId,
      viewedName: access.seatView.personName,
    },
    summary: access.seatView.personName
      ? `Super Admin left the read-only view of ${access.seatView.personName}'s portal (${seatTitle})`
      : `Super Admin left the read-only view of the ${seatTitle} seat`,
  });
}
