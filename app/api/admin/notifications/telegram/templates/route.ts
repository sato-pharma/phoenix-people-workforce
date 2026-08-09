import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  listTelegramTemplates,
  previewTelegramTemplate,
  saveTelegramTemplate,
  sendTelegramTemplateAdminPreview,
  type TelegramTemplateWorkflowKey,
} from "@/lib/notifications/telegram-templates";
import { TelegramTemplateError } from "@/lib/notifications/telegram-template-types";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function assertTelegramTemplateAdmin(request: Request, action: "read" | "update") {
  const access = await resolveAccessContext(request);
  await assertPermission(access, "communication", action);
  return access;
}

function templateInput(body: Record<string, unknown>) {
  const buttons = Array.isArray(body.buttons)
    ? body.buttons
        .filter((button): button is Record<string, unknown> => Boolean(button) && typeof button === "object" && !Array.isArray(button))
        .map((button) => ({
          enabled: button.enabled !== false,
          label: String(button.label ?? ""),
          type: String(button.type ?? "custom") as "open_phoenix" | "view_details" | "custom",
          url: String(button.url ?? ""),
        }))
    : undefined;
  return {
    buttons,
    ctaEnabled: body.ctaEnabled === true,
    ctaLabel: String(body.ctaLabel ?? ""),
    ctaUrl: String(body.ctaUrl ?? ""),
    isActive: body.isActive === true,
    message: String(body.message ?? ""),
    templateKey: String(body.templateKey ?? "") as TelegramTemplateWorkflowKey,
    title: String(body.title ?? ""),
  };
}

function templateErrorResponse(error: unknown, fallback: string) {
  if (error instanceof TelegramTemplateError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 400 });
  }
  const message = clientSafeErrorMessage(error, fallback);
  return NextResponse.json({ error: "telegram_template_error", message }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    await assertTelegramTemplateAdmin(request, "read");
    return NextResponse.json({ data: await listTelegramTemplates(), success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return templateErrorResponse(error, "Telegram templates failed.");
  }
}

export async function POST(request: Request) {
  try {
    const access = await assertTelegramTemplateAdmin(request, "update");
    const body = await request.json();
    if (body?.action === "preview") {
      return NextResponse.json({ data: previewTelegramTemplate(templateInput(body)), success: true });
    }
    if (body?.action === "send_admin_preview") {
      const result = await sendTelegramTemplateAdminPreview(access, templateInput(body));
      return NextResponse.json({ data: { result, templates: await listTelegramTemplates() }, success: true });
    }
    return NextResponse.json({ error: "invalid_action", message: "Unsupported Telegram template action." }, { status: 400 });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return templateErrorResponse(error, "Telegram template action failed.");
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await assertTelegramTemplateAdmin(request, "update");
    const body = await request.json();
    return NextResponse.json({ data: await saveTelegramTemplate(access, templateInput(body)), success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return templateErrorResponse(error, "Telegram template save failed.");
  }
}
