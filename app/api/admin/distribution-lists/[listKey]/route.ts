import { NextResponse, type NextRequest } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canManageDistributionList, canManageDistributionLists } from "@/lib/distribution-lists/access";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { sanitizeRoles } from "@/lib/distribution-lists/spec";
import {
  resolveDistributionListByKey,
  updateDistributionList,
  type DistributionListUpdate,
} from "@/lib/distribution-lists/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function numbers(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map((item) => Number(item));
  // Every entry must be real. A silently dropped id would let the admin believe they saved a line
  // that never got persisted — and the list would then resolve to a wider audience than the
  // screen showed them.
  return parsed.every((item) => Number.isFinite(item)) ? Array.from(new Set(parsed)) : null;
}

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === "string")) return null;
  return Array.from(new Set((value as string[]).map((item) => item.trim()).filter(Boolean)));
}

// Super Admin, plus the HR Business Partner narrowed to the HR-owned lists. Editing a list changes
// who receives company mail, which is why this both audits (in updateDistributionList) and returns
// the list's NEW membership: the caller sees who it now resolves to before anything is sent, rather
// than discovering it from a send.
export async function POST(request: NextRequest, context: { params: Promise<{ listKey: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    if (!canManageDistributionLists(access)) {
      return NextResponse.json({ message: "Forbidden." }, { status: 403 });
    }

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 20,
      scope: "distribution-lists:update",
      windowMs: 60_000,
    });

    const { listKey } = await context.params;
    // 🔴 THE PER-LIST CHECK, not just the screen's. The HR Business Partner reaches this route, and
    // hiding a row on the page does nothing about a hand-made request naming `closing_fixed_cc` —
    // the list that decides who is Cc'd on every Monthly Closing publish. Owner, 2026-09-11:
    // "HR lists only, she shouldn't touch the closing cc."
    if (!canManageDistributionList(access, listKey)) {
      return NextResponse.json({ message: "Forbidden: that list is not yours to edit." }, { status: 403 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const update: DistributionListUpdate = {};

    if (body.label !== undefined) {
      if (typeof body.label !== "string" || !body.label.trim()) {
        return NextResponse.json({ message: "label must be a non-empty string." }, { status: 400 });
      }
      update.label = body.label.trim();
    }
    if (body.description !== undefined) {
      if (typeof body.description !== "string") {
        return NextResponse.json({ message: "description must be a string." }, { status: 400 });
      }
      update.description = body.description;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return NextResponse.json({ message: "enabled must be a boolean." }, { status: 400 });
      }
      update.enabled = body.enabled;
    }
    if (body.roles !== undefined) {
      const raw = strings(body.roles);
      if (!raw) return NextResponse.json({ message: "roles must be an array of strings." }, { status: 400 });
      const roles = sanitizeRoles(raw);
      if (roles.length !== raw.length) {
        return NextResponse.json({ message: "roles must all be valid role names." }, { status: 400 });
      }
      update.roles = roles;
    }

    for (const field of ["lineIds", "areaIds", "departmentIds", "positionIds"] as const) {
      if (body[field] === undefined) continue;
      const parsed = numbers(body[field]);
      if (!parsed) return NextResponse.json({ message: `${field} must be an array of numbers.` }, { status: 400 });
      update[field] = parsed;
    }

    for (const field of ["regionCodes", "includedHrIds", "excludedHrIds", "externalEmails"] as const) {
      if (body[field] === undefined) continue;
      const parsed = strings(body[field]);
      if (!parsed) return NextResponse.json({ message: `${field} must be an array of strings.` }, { status: 400 });
      update[field] = parsed;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ message: "Nothing to update." }, { status: 400 });
    }

    const spec = await updateDistributionList(listKey, update, access);
    const resolved = await resolveDistributionListByKey(listKey);

    return NextResponse.json({ ok: true, resolved, spec });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many list updates — slow down.", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { ok: false, message: clientSafeErrorMessage(error, "Failed to update the distribution list.") },
      { status: 500 },
    );
  }
}
