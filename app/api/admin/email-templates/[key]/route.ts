import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  EMAIL_TEMPLATE_KEYS,
  EMAIL_RECIPIENT_ROLES,
  getEmailTemplate,
  updateEmailTemplate,
  type EmailTemplateKey,
  type EmailRecipientRole,
} from "@/lib/email-templates/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidKey(value: unknown): value is EmailTemplateKey {
  return EMAIL_TEMPLATE_KEYS.includes(value as EmailTemplateKey);
}

function isValidRole(r: unknown): r is EmailRecipientRole {
  return EMAIL_RECIPIENT_ROLES.includes(r as EmailRecipientRole);
}

function cleanRoles(value: unknown): EmailRecipientRole[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(isValidRole)));
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((v) => String(v ?? "").trim()).filter(Boolean)));
}

function cleanString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "read");
    const { key } = await params;

    if (!isValidKey(key)) {
      return NextResponse.json({ error: "invalid_key", message: "Unknown template key." }, { status: 400 });
    }

    const template = await getEmailTemplate(key);
    return NextResponse.json({ template });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to email templates." }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Failed to load template.";
    return NextResponse.json({ error: "load_failed", message }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "update");
    const { key } = await params;

    if (!isValidKey(key)) {
      return NextResponse.json({ error: "invalid_key", message: "Unknown template key." }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const template = await updateEmailTemplate(key, {
      templateName: cleanString(body.templateName) || undefined,
      description: body.description !== undefined ? cleanString(body.description) : undefined,
      subject: body.subject !== undefined ? cleanString(body.subject) : undefined,
      greeting: body.greeting !== undefined ? cleanString(body.greeting) : undefined,
      bodyHtml: body.bodyHtml !== undefined ? cleanString(body.bodyHtml) : undefined,
      bodyText: body.bodyText !== undefined ? cleanString(body.bodyText) : undefined,
      closing: body.closing !== undefined ? cleanString(body.closing) : undefined,
      previewText: body.previewText !== undefined ? cleanString(body.previewText) : undefined,
      isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
      smartGreeting: typeof body.smartGreeting === "boolean" ? body.smartGreeting : undefined,
      toRoles: body.toRoles !== undefined ? cleanRoles(body.toRoles) : undefined,
      ccRoles: body.ccRoles !== undefined ? cleanRoles(body.ccRoles) : undefined,
      bccRoles: body.bccRoles !== undefined ? cleanRoles(body.bccRoles) : undefined,
      targetTitles: body.targetTitles !== undefined ? cleanStringArray(body.targetTitles) : undefined,
      targetLines: body.targetLines !== undefined ? cleanStringArray(body.targetLines) : undefined,
      staticToEmails: body.staticToEmails !== undefined ? cleanStringArray(body.staticToEmails) : undefined,
      staticCcEmails: body.staticCcEmails !== undefined ? cleanStringArray(body.staticCcEmails) : undefined,
      staticBccEmails: body.staticBccEmails !== undefined ? cleanStringArray(body.staticBccEmails) : undefined,
      updatedBy: access.hrId ?? access.loginId ?? "admin",
    });

    return NextResponse.json({ template });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to email templates." }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Failed to save template.";
    return NextResponse.json({ error: "save_failed", message }, { status: 500 });
  }
}
