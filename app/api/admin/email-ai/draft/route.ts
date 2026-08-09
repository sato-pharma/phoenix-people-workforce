import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { AiAssistError, draftEmailWithAi, type AiDraftRecipientRules } from "@/lib/email/ai-assist";
import { composerContextTokens } from "@/lib/email/email-composer-service";
import { getEmailDesignerMetadata } from "@/lib/email/email-designer";
import { listEmailCustomVariables } from "@/lib/email-templates/custom-variables";
import { emailTemplateKeys, emailTemplateRecipientRoleOptions } from "@/lib/email-templates/service";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Comfortably above the OpenAI client's own worst case (OPENAI_ROUTE_BUDGET_MS timeout x up
// to 2 attempts with maxRetries: 1) so the platform never cuts the request before the
// client's own timeout/retry logic has a chance to resolve or fail cleanly.
export const maxDuration = 150;

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "update");
    // Each call holds a serverless slot for up to 60s of upstream OpenAI time - a per-actor
    // limiter keeps even an authorized admin from amplifying spend or exhausting slots.
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.hrId || access.loginId, request }),
      limit: 10,
      scope: "email_ai_draft",
      windowMs: 60_000,
    });
    const body = (await request.json().catch(() => ({}))) as {
      current?: Record<string, string>;
      healthIssues?: unknown;
      instruction?: string;
      mode?: string;
      rules?: Partial<Record<keyof AiDraftRecipientRules, unknown>>;
      templateKey?: string;
      templateName?: string;
    };

    // The variable allowlist comes from the server-side catalog (never the client), scoped
    // to the template type so the AI only sees placeholders that will actually resolve.
    // An unrecognized key falls back to the unscoped catalog instead of an empty allowlist,
    // which would otherwise strip every placeholder from the AI draft.
    const mode = body.mode === "composer" ? "composer" as const : "email_template" as const;
    const templateKey = typeof body.templateKey === "string" && (emailTemplateKeys as readonly string[]).includes(body.templateKey)
      ? body.templateKey
      : "";
    // Admin-defined custom variables (owner request, 2026-07-22) are template-editor-only,
    // same as recipient rules/health below — the manual composer has no saved template to
    // bind them to.
    const customVariables = mode === "email_template" ? await listEmailCustomVariables() : [];
    const customVariableEntries = customVariables
      .filter((variable) => variable.sourceAllowed)
      .map((variable) => ({ label: variable.label, sampleValue: `(${variable.sourceColumn})`, token: variable.token }));

    const variables = [
      ...getEmailDesignerMetadata().variables
        .filter((variable) =>
          // Manual composer sends only resolve the employee-context tokens - teaching the
          // model anything else would produce chips that interpolate to "" in sent emails.
          mode === "composer"
            ? (composerContextTokens as readonly string[]).includes(variable.token)
            : !templateKey ||
              variable.allowedTemplateTypes.length === 0 ||
              (variable.allowedTemplateTypes as string[]).includes(templateKey))
        .map((variable) => ({
          label: variable.label,
          sampleValue: variable.sampleValue,
          token: variable.token,
        })),
      ...customVariableEntries,
    ];

    // Only the five known draft fields are forwarded, each size-capped, so an arbitrary
    // client payload cannot be smuggled into the prompt or blow up the upstream request.
    const rawCurrent = (body.current && typeof body.current === "object" ? body.current : {}) as Record<string, unknown>;
    const currentField = (key: string, maxLength: number) => String(rawCurrent[key] ?? "").slice(0, maxLength);
    const stringArray = (value: unknown, maxItems: number, maxLength: number) =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, maxItems).map((item) => item.slice(0, maxLength)) : [];

    // Recipient routing + health context are template-editor-only concepts (the composer
    // sends a one-off email with no saved rules/health to reason about).
    const rules: AiDraftRecipientRules | undefined = mode === "email_template" && body.rules && typeof body.rules === "object"
      ? {
          bccRoles: stringArray(body.rules.bccRoles, 20, 60),
          bccStaticEmails: stringArray(body.rules.bccStaticEmails, 20, 200),
          ccRoles: stringArray(body.rules.ccRoles, 20, 60),
          ccStaticEmails: stringArray(body.rules.ccStaticEmails, 20, 200),
          targetLines: stringArray(body.rules.targetLines, 20, 100),
          targetTitles: stringArray(body.rules.targetTitles, 20, 100),
          toRoles: stringArray(body.rules.toRoles, 20, 60),
          toStaticEmails: stringArray(body.rules.toStaticEmails, 20, 200),
        }
      : undefined;
    const recipientRoles = mode === "email_template"
      ? emailTemplateRecipientRoleOptions.map((value) => ({
          label: value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
          value,
        }))
      : undefined;
    const healthIssues = mode === "email_template" ? stringArray(body.healthIssues, 20, 300) : undefined;

    const result = await draftEmailWithAi({
      current: {
        bodyHtml: currentField("bodyHtml", 40_000),
        closingText: currentField("closingText", 2_000),
        greeting: currentField("greeting", 2_000),
        previewText: currentField("previewText", 2_000),
        rules,
        subject: currentField("subject", 2_000),
      },
      healthIssues,
      instruction: String(body.instruction ?? "").slice(0, 6_000),
      mode,
      recipientRoles,
      templateName: typeof body.templateName === "string" ? body.templateName.slice(0, 200) : undefined,
      variables,
    });

    return NextResponse.json({ result });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to the email AI assistant." }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (error instanceof AiAssistError) {
      const status = error.code === "ai_not_configured" ? 503 : error.code === "ai_rate_limited" ? 429 : 502;
      return NextResponse.json({ error: error.code, message: error.message }, { status });
    }
    const message = clientSafeErrorMessage(error, "AI draft failed.");
    return NextResponse.json({ error: "ai_failed", message }, { status: 500 });
  }
}
