// Shared helpers for the Approvals WhatsApp API routes (not a route — underscore folder).
//
// Every route calls `resolveAccessContext(request)` itself and then `approvalsWhatsAppForbidden(access)` BEFORE any
// read or write: the Super Admin, acting as himself, and nobody else (owner, 19 Nov 2026: "Super Admin only"). The role
// is checked, never a permission-matrix grant, so widening a resource can never open these chats to another role.
// tests/approvals-whatsapp.test.ts reads each route's own source for both calls.

import { NextResponse } from "next/server";

import type { AccessContext } from "@/lib/auth/permissions";
import { isForbiddenError } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { canUseApprovalsWhatsApp } from "@/lib/approvals-whatsapp/rules";
import { ApprovalsWhatsAppSendError } from "@/lib/approvals-whatsapp/send";
import {
  ApprovalsWhatsAppInputError,
  ApprovalsWhatsAppNotFoundError,
  ApprovalsWhatsAppNotInstalledError,
} from "@/lib/approvals-whatsapp/store";

export function approvalsProblem(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, message, success: false, ...extra }, { status });
}

/** null for the Super Admin; a 403 for everyone else, signed in or not. */
export function approvalsWhatsAppForbidden(access: AccessContext | null | undefined) {
  if (canUseApprovalsWhatsApp(access)) return null;
  return approvalsProblem("This screen is open to the Super Admin only.", 403);
}

export function approvalsApiError(error: unknown, fallback: string) {
  if (error instanceof ApprovalsWhatsAppNotFoundError) return approvalsProblem(error.message, 404);
  if (error instanceof ApprovalsWhatsAppInputError) return approvalsProblem(error.message, 400);
  if (error instanceof ApprovalsWhatsAppSendError) return approvalsProblem(error.message, error.status);
  if (error instanceof ApprovalsWhatsAppNotInstalledError) return approvalsProblem(error.message, 503, { notInstalled: true });
  if (isForbiddenError(error)) return approvalsProblem("This screen is open to the Super Admin only.", 403);
  return approvalsProblem(clientSafeErrorMessage(error, fallback), 500);
}

export function approvalsActor(access: AccessContext): string | null {
  return access.loginId ?? access.hrId ?? null;
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

export function valuesObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
