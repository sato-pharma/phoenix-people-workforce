import { NextResponse, type NextRequest } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { canUseSatoEmail } from "@/lib/sato-email/access";
import { listSatoEmailTemplates, upsertSatoEmailTemplate } from "@/lib/sato-email/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every template, retired ones included, so the manager screen can switch one back on. */
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!canUseSatoEmail(access)) {
      return NextResponse.json({ message: "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(await listSatoEmailTemplates({ includeInactive: true }));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to load the templates.") },
      { status: 500 },
    );
  }
}

/**
 * Create or edit a fixed template. Both seats may: the owner asked for a set of templates the
 * module itself maintains, not one only a developer can change.
 *
 * Editing a template sends nothing — it changes what a FUTURE send says. That is why the audit row
 * behind this is the required kind: it is written before anything has been mailed, so refusing the
 * edit when the trail cannot be written costs nothing and loses nothing.
 */
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    if (!canUseSatoEmail(access)) {
      return NextResponse.json({ message: "Forbidden." }, { status: 403 });
    }

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 20,
      scope: "sato-email:templates",
      windowMs: 60_000,
    });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const templateKey = typeof body.templateKey === "string" ? body.templateKey.trim().toLowerCase() : "";
    // The key is the template's identity and it is a primary key in the database, which has the same
    // check. Refusing here means a bad key is a readable 400 rather than a 500 from Postgres.
    if (!/^[a-z][a-z0-9_]*$/.test(templateKey)) {
      return NextResponse.json(
        { message: "templateKey must start with a letter and use only lowercase letters, digits and underscores." },
        { status: 400 },
      );
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ message: "A template name is required." }, { status: 400 });

    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    if (!subject) return NextResponse.json({ message: "A subject is required." }, { status: 400 });

    const bodyHtml = typeof body.bodyHtml === "string" ? body.bodyHtml.trim() : "";
    if (!bodyHtml) return NextResponse.json({ message: "The template body is empty." }, { status: 400 });

    if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
      return NextResponse.json({ message: "isActive must be a boolean." }, { status: 400 });
    }
    if (body.sortOrder !== undefined && !Number.isFinite(Number(body.sortOrder))) {
      return NextResponse.json({ message: "sortOrder must be a number." }, { status: 400 });
    }

    const template = await upsertSatoEmailTemplate(
      {
        bodyHtml,
        isActive: body.isActive as boolean | undefined,
        name,
        sortOrder: body.sortOrder === undefined ? undefined : Number(body.sortOrder),
        subject,
        templateKey,
      },
      access,
    );

    return NextResponse.json({ ok: true, template });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many template saves — slow down.", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to save the template.") },
      { status: 500 },
    );
  }
}
