import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertScreeningQuestionsAccess } from "@/lib/recruitment/inbound/whatsapp-screening-questions-admin";
import {
  loadRecruitmentSettingsView,
  REJECTION_MESSAGE_TEXT_KEY,
  setRecruitmentSetting,
  WHATSAPP_REASK_ENABLED_KEY,
} from "@/lib/recruitment/recruitment-settings-db";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** WhatsApp's own limit on one text message. */
const MAX_REJECTION_MESSAGE_LENGTH = 1000;

/**
 * The two recruitment settings on the Screening Questions screen (owner, 2026-10-20):
 *
 *   * `whatsAppReaskEnabled` — the half-hourly re-ask of an applicant who went quiet mid-conversation.
 *     OFF until he switches it on.
 *   * `rejectionMessageText` — the words of the "sorry" message HR can send a rejected applicant.
 *     Blank goes back to the default.
 *
 * Same gate as the questions themselves (`assertScreeningQuestionsAccess`), enforced here.
 */

function failure(error: unknown, code: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const message = clientSafeErrorMessage(error, "The screening settings could not be updated.");
  return NextResponse.json({ error: code, message }, { status: 400 });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertScreeningQuestionsAccess(access);
    return NextResponse.json({ settings: await loadRecruitmentSettingsView() });
  } catch (error) {
    return failure(error, "recruitment_settings_read_failed");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertScreeningQuestionsAccess(access);

    const body = (await request.json().catch(() => null)) as {
      whatsAppReaskEnabled?: unknown;
      rejectionMessageText?: unknown;
    } | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Send the settings to change." }, { status: 400 });
    }

    const hrId = access.hrId?.trim() || null;
    const before = await loadRecruitmentSettingsView();
    const changed: Record<string, unknown> = {};

    if (body.whatsAppReaskEnabled !== undefined) {
      if (typeof body.whatsAppReaskEnabled !== "boolean") {
        return NextResponse.json({ error: "The re-ask switch is on or off." }, { status: 400 });
      }
      await setRecruitmentSetting(WHATSAPP_REASK_ENABLED_KEY, body.whatsAppReaskEnabled, hrId);
      changed.whatsAppReaskEnabled = body.whatsAppReaskEnabled;
    }

    if (body.rejectionMessageText !== undefined) {
      if (body.rejectionMessageText !== null && typeof body.rejectionMessageText !== "string") {
        return NextResponse.json({ error: "The message must be text." }, { status: 400 });
      }
      const text = typeof body.rejectionMessageText === "string" ? body.rejectionMessageText.trim() : "";
      if (text.length > MAX_REJECTION_MESSAGE_LENGTH) {
        return NextResponse.json(
          { error: `Keep the message under ${MAX_REJECTION_MESSAGE_LENGTH} characters.` },
          { status: 400 },
        );
      }
      // Blank stores "" — read back as "use the default".
      await setRecruitmentSetting(REJECTION_MESSAGE_TEXT_KEY, text, hrId);
      changed.rejectionMessageText = text || null;
    }

    if (Object.keys(changed).length === 0) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }

    // Best effort: the table keeps who changed it last; the audit row is the history.
    await writeAuditLog({
      actorLoginId: access.loginId ?? hrId,
      entityId: null,
      entityType: "recruitment_settings",
      newValues: changed,
      oldValues: {
        rejectionMessageText: before.rejectionMessageIsDefault ? null : before.rejectionMessageText,
        whatsAppReaskEnabled: before.whatsAppReaskEnabled,
      },
      summary: "Recruitment: changed the WhatsApp re-ask switch or the rejection message",
    });

    return NextResponse.json({ settings: await loadRecruitmentSettingsView() });
  } catch (error) {
    return failure(error, "recruitment_settings_save_failed");
  }
}
