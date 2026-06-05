import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  adminDisableTelegram,
  adminDisconnectTelegram,
  adminRetryTelegramDelivery,
  adminSendTelegramTest,
  getTelegramAdminControlCenter,
  setTelegramGlobalSwitch,
  updateTelegramPolicy,
} from "@/lib/notifications/telegram-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function assertTelegramAdmin(request: Request, action: "read" | "update") {
  const access = await resolveAccessContext(request);
  await assertPermission(access, "communication", action);
  return access;
}

export async function GET(request: Request) {
  try {
    await assertTelegramAdmin(request, "read");
    return NextResponse.json({ data: await getTelegramAdminControlCenter(), success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const message = error instanceof Error ? error.message : "Telegram admin data failed.";
    return NextResponse.json({ error: "telegram_admin_failed", message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await assertTelegramAdmin(request, "update");
    const body = await request.json();
    if (body?.type === "global_switch") {
      await setTelegramGlobalSwitch(access, body.enabled === true);
      return NextResponse.json({ data: await getTelegramAdminControlCenter(), success: true });
    }
    if (body?.type === "module_policy") {
      await updateTelegramPolicy(access, {
        enabled: body.enabled === true,
        genericOnly: body.genericOnly === true,
        module: String(body.module ?? ""),
        notes: typeof body.notes === "string" ? body.notes : null,
        optional: body.optional === true,
      });
      return NextResponse.json({ data: await getTelegramAdminControlCenter(), success: true });
    }
    return NextResponse.json({ error: "invalid_action", message: "Unsupported Telegram admin update." }, { status: 400 });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const message = error instanceof Error ? error.message : "Telegram admin update failed.";
    return NextResponse.json({ error: "telegram_admin_update_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await assertTelegramAdmin(request, "update");
    const body = await request.json();
    const userId = String(body?.userId ?? "").trim();
    if (body?.action === "disable_user" && userId) {
      await adminDisableTelegram(access, userId);
      return NextResponse.json({ data: await getTelegramAdminControlCenter(), success: true });
    }
    if (body?.action === "disconnect_user" && userId) {
      await adminDisconnectTelegram(access, userId);
      return NextResponse.json({ data: await getTelegramAdminControlCenter(), success: true });
    }
    if (body?.action === "send_test") {
      const result = await adminSendTelegramTest(access);
      return NextResponse.json({ data: { result, view: await getTelegramAdminControlCenter() }, success: true });
    }
    if (body?.action === "retry_delivery") {
      const deliveryId = String(body?.deliveryId ?? "").trim();
      if (!deliveryId) return NextResponse.json({ error: "missing_delivery", message: "Delivery ID is required." }, { status: 400 });
      const result = await adminRetryTelegramDelivery(access, deliveryId);
      return NextResponse.json({ data: { result, view: await getTelegramAdminControlCenter() }, success: true });
    }
    return NextResponse.json({ error: "invalid_action", message: "Unsupported Telegram admin action." }, { status: 400 });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const message = error instanceof Error ? error.message : "Telegram admin action failed.";
    return NextResponse.json({ error: "telegram_admin_action_failed", message }, { status: 500 });
  }
}
