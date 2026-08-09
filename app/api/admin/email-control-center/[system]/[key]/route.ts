import { NextResponse, type NextRequest } from "next/server";

import { canAccessSystemAdministratorWorkspace, phoenixRoles, type PhoenixRole } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  emailNotificationTypes,
  emailRecipientModes,
  getEmailNotificationPolicies,
  saveEmailNotificationPolicy,
  type EmailNotificationType,
  type EmailRecipientMode,
} from "@/lib/notifications/email";
import { notificationRoleKeys, updateNotificationRolePolicy, type NotificationRoleKey } from "@/lib/notifications/role-recipients";
import {
  EmailTemplateValidationError,
  emailTemplateRecipientRoleOptions,
  getEmailTemplate,
  normalizeEmailTemplateKey,
  saveEmailTemplate,
  type EmailTemplateRecipientRole,
} from "@/lib/email-templates/service";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const controlCenterSystems = ["role-recipients", "email-notifications", "email-templates"] as const;
type ControlCenterSystem = (typeof controlCenterSystems)[number];

function isControlCenterSystem(value: string): value is ControlCenterSystem {
  return (controlCenterSystems as readonly string[]).includes(value);
}

function isNotificationRoleKey(value: string): value is NotificationRoleKey {
  return (notificationRoleKeys as readonly string[]).includes(value);
}

function isEmailNotificationType(value: string): value is EmailNotificationType {
  return (emailNotificationTypes as readonly string[]).includes(value);
}

function sanitizeRoles(value: unknown): PhoenixRole[] | null {
  if (!Array.isArray(value)) return null;
  const roles = value.filter((role): role is PhoenixRole => typeof role === "string" && (phoenixRoles as readonly string[]).includes(role));
  if (roles.length !== value.length) return null;
  return roles;
}

function sanitizeTemplateRoles(value: unknown): EmailTemplateRecipientRole[] | null {
  if (!Array.isArray(value)) return null;
  const roles = value.filter(
    (role): role is EmailTemplateRecipientRole => typeof role === "string" && (emailTemplateRecipientRoleOptions as readonly string[]).includes(role),
  );
  if (roles.length !== value.length) return null;
  return roles;
}

function sanitizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === "string") ? (value as string[]) : null;
}

type ControlCenterPatchBody = {
  bccRoles?: unknown;
  ccRoles?: unknown;
  changeReason?: unknown;
  enabled?: unknown;
  recipientMode?: unknown;
  recipientModes?: unknown;
  roles?: unknown;
  targetLines?: unknown;
  targetTitles?: unknown;
  toRoles?: unknown;
};

// Every write here dispatches into the exact same update function the item's own existing
// admin surface (cron-control's role-recipients section / email-notifications / email-templates)
// already calls — this route adds no new gating logic of its own, only a shared entry point.
export async function PATCH(request: NextRequest, context: { params: Promise<{ system: string; key: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    if (!canAccessSystemAdministratorWorkspace(access)) {
      return NextResponse.json({ message: "Forbidden: Super Admin only." }, { status: 403 });
    }

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 20,
      scope: "email-control-center:update",
      windowMs: 60_000,
    });

    const { system, key } = await context.params;
    if (!isControlCenterSystem(system)) {
      return NextResponse.json({ message: `"${system}" is not a recognized source system.` }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as ControlCenterPatchBody;
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return NextResponse.json({ message: "enabled must be a boolean." }, { status: 400 });
    }

    if (system === "role-recipients") {
      if (!isNotificationRoleKey(key)) {
        return NextResponse.json({ message: `"${key}" is not a recognized notification.` }, { status: 404 });
      }
      const roles = body.roles === undefined ? undefined : sanitizeRoles(body.roles);
      if (body.roles !== undefined && !roles) {
        return NextResponse.json({ message: "roles must be an array of valid role names." }, { status: 400 });
      }
      const policy = await updateNotificationRolePolicy(key, { roles: roles ?? undefined, enabled: body.enabled as boolean | undefined }, access);
      return NextResponse.json({ ok: true, policy });
    }

    if (system === "email-notifications") {
      if (!isEmailNotificationType(key)) {
        return NextResponse.json({ message: `"${key}" is not a recognized email notification.` }, { status: 404 });
      }
      const current = (await getEmailNotificationPolicies()).find((policy) => policy.type === key);
      if (!current) {
        return NextResponse.json({ message: `"${key}" is not a recognized email notification.` }, { status: 404 });
      }
      if (body.recipientMode !== undefined && !(emailRecipientModes as readonly string[]).includes(String(body.recipientMode))) {
        return NextResponse.json({ message: "recipientMode is not a recognized mode." }, { status: 400 });
      }
      const recipientModes = body.recipientModes === undefined ? undefined : (body.recipientModes as unknown[]);
      if (recipientModes && (!Array.isArray(recipientModes) || recipientModes.some((mode) => !(emailRecipientModes as readonly string[]).includes(String(mode))))) {
        return NextResponse.json({ message: "recipientModes must be an array of recognized modes." }, { status: 400 });
      }
      const targetTitles = body.targetTitles === undefined ? undefined : sanitizeStringArray(body.targetTitles);
      if (body.targetTitles !== undefined && !targetTitles) {
        return NextResponse.json({ message: "targetTitles must be an array of strings." }, { status: 400 });
      }
      const targetLines = body.targetLines === undefined ? undefined : sanitizeStringArray(body.targetLines);
      if (body.targetLines !== undefined && !targetLines) {
        return NextResponse.json({ message: "targetLines must be an array of strings." }, { status: 400 });
      }

      const policy = await saveEmailNotificationPolicy(
        key,
        {
          enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
          includeHrInbox: current.includeHrInbox,
          recipientMode: (body.recipientMode as EmailRecipientMode | undefined) ?? current.recipientMode,
          recipientModes: (recipientModes as EmailRecipientMode[] | undefined) ?? current.recipientModes,
          targetLines: targetLines ?? current.targetLines,
          targetTitles: targetTitles ?? current.targetTitles,
        },
        access.hrId ?? access.loginId ?? null,
      );
      return NextResponse.json({ ok: true, policy });
    }

    // system === "email-templates"
    const templateKey = normalizeEmailTemplateKey(key);
    if (!templateKey) {
      return NextResponse.json({ message: `"${key}" is not a recognized email template.` }, { status: 404 });
    }
    const current = await getEmailTemplate(templateKey);
    if (!current) {
      return NextResponse.json({ message: `"${key}" is not a recognized email template.` }, { status: 404 });
    }

    const toRoles = body.toRoles === undefined ? undefined : sanitizeTemplateRoles(body.toRoles);
    if (body.toRoles !== undefined && !toRoles) {
      return NextResponse.json({ message: "toRoles must be an array of recognized recipient roles." }, { status: 400 });
    }
    const ccRoles = body.ccRoles === undefined ? undefined : sanitizeTemplateRoles(body.ccRoles);
    if (body.ccRoles !== undefined && !ccRoles) {
      return NextResponse.json({ message: "ccRoles must be an array of recognized recipient roles." }, { status: 400 });
    }
    const bccRoles = body.bccRoles === undefined ? undefined : sanitizeTemplateRoles(body.bccRoles);
    if (body.bccRoles !== undefined && !bccRoles) {
      return NextResponse.json({ message: "bccRoles must be an array of recognized recipient roles." }, { status: 400 });
    }
    const targetTitles = body.targetTitles === undefined ? undefined : sanitizeStringArray(body.targetTitles);
    if (body.targetTitles !== undefined && !targetTitles) {
      return NextResponse.json({ message: "targetTitles must be an array of strings." }, { status: 400 });
    }
    const targetLines = body.targetLines === undefined ? undefined : sanitizeStringArray(body.targetLines);
    if (body.targetLines !== undefined && !targetLines) {
      return NextResponse.json({ message: "targetLines must be an array of strings." }, { status: 400 });
    }

    const nextIsActive = typeof body.enabled === "boolean" ? body.enabled : current.isActive;
    const isEnabling = nextIsActive && !current.isActive;
    const changeReason = typeof body.changeReason === "string" && body.changeReason.trim().length > 0
      ? body.changeReason.trim()
      : isEnabling
        ? "Enabled via Email Control Center dashboard"
        : undefined;

    // Fetch-then-merge over the CURRENT published rules (never a static default) — an
    // omitted field here must survive untouched, including toStaticEmails/ccStaticEmails/
    // bccStaticEmails, which this dashboard never edits but must not silently drop.
    const rules = {
      ...current.rules,
      bccRoles: bccRoles ?? current.rules.bccRoles,
      ccRoles: ccRoles ?? current.rules.ccRoles,
      targetLines: targetLines ?? current.rules.targetLines,
      targetTitles: targetTitles ?? current.rules.targetTitles,
      toRoles: toRoles ?? current.rules.toRoles,
    };

    const saved = await saveEmailTemplate(
      templateKey,
      { changeReason, isActive: nextIsActive, rules },
      access.loginId ?? access.hrId ?? null,
      { action: "save", reason: changeReason },
    );
    return NextResponse.json({ ok: true, template: saved });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many updates — slow down.", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    if (error instanceof EmailTemplateValidationError) {
      return NextResponse.json(
        { error: "validation_failed", issues: error.issues, message: "Fix the highlighted template issues before saving." },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { ok: false, message: clientSafeErrorMessage(error, "Failed to update the email control center.") },
      { status: 500 },
    );
  }
}
