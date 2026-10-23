import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  createCustomTemplate,
  isCustomTemplateLayerMissing,
  listCustomTemplates,
  replaceCustomTemplateArtwork,
  type CustomTemplatePageBytes,
} from "@/lib/hiring-pack/custom-template-store";
import {
  CUSTOM_TEMPLATE_MAX_PAGE_BYTES,
  parseCustomTemplateDraft,
  type CustomTemplateContentType,
} from "@/lib/hiring-pack/custom-templates";
import { copyCustomTemplateFieldLayout } from "@/lib/hiring-pack/field-layout-store";
import { customDocumentFor, isUuid } from "@/lib/hiring-pack/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Company templates — a document uploaded through the UI instead of written into the code.
//
// READ IS GATED ON `employee_documents`, THE SAME RESOURCE AS THE REST OF `/api/hiring-pack/**`.
// Whoever can print the ten built-in documents can see the company templates beside them, because
// on the printing screen they are the same kind of thing.
//
// WRITE IS SUPER ADMIN, and that is narrower on purpose rather than by caution. Uploading a template
// creates a paper the company prints and hands to employees and to government offices. It is not a
// correction to one person's record — it is a change to what the system produces for everybody, in
// the same class as editing the code used to be. The plan's B6 is where a role list on the row
// decides who may PRINT each one; who may CREATE one stays here.

/**
 * The whole request's cap, which is not the same question as one page's cap.
 *
 * A page may be 15MB, and a template may have 24 pages — but 360MB in one multipart body would be
 * read into memory on a container sized for a web app. Thirty-two megabytes is roughly twenty pages
 * of a scanned A4 form at the resolution the upload screen rasterises to, and a template larger than
 * that is a policy manual somebody dropped in by mistake.
 */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: "Not permitted.", status: 403 };
  if (isCustomTemplateLayerMissing(error)) {
    return {
      message:
        "The company-template tables are not ready yet. Run the Supabase migration for hiring_pack_custom_templates.",
      status: 409,
    };
  }
  return { message: clientSafeErrorMessage(error, "Something went wrong."), status: 500 };
}

/** Every company template that prints today, with its pages. `archived=1` includes the rest. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "read");

    const url = new URL(request.url);
    const includeArchived = url.searchParams.get("archived") === "1";
    const templates = await listCustomTemplates({ includeArchived });

    return NextResponse.json({ canManage: access.role === "Super Admin", templates });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_custom_templates_read_failed", message }, { status });
  }
}

/**
 * Store an uploaded template.
 *
 * MULTIPART, with the description as one JSON field and one file part per page. The alternative —
 * base64 inside a JSON body — inflates every byte by a third and would put a 40MB string through
 * `JSON.parse`, which is the sort of thing that reads as a hang rather than as a large upload.
 *
 * THE FILE PARTS ARE READ BY INDEX, `page-0`, `page-1`, and matched against the description's own
 * page list. A mismatch is refused rather than reconciled: the description carries the pixel sizes
 * the browser measured, and pairing them with the wrong images would record a page as a size it is
 * not, which surfaces much later as artwork that prints at the wrong scale.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "update");
    if (access.role !== "Super Admin") {
      return NextResponse.json(
        {
          error: "forbidden",
          message: "Only a Super Admin can add a company template.",
        },
        { status: 403 },
      );
    }

    const form = await request.formData();
    const rawDraft = form.get("template");
    if (typeof rawDraft !== "string") {
      return NextResponse.json(
        { error: "invalid_request", message: "The template's details are missing." },
        { status: 400 },
      );
    }

    let draftInput: unknown;
    try {
      draftInput = JSON.parse(rawDraft);
    } catch {
      return NextResponse.json(
        { error: "invalid_request", message: "The template's details could not be read." },
        { status: 400 },
      );
    }

    const parsed = parseCustomTemplateDraft((draftInput ?? {}) as Record<string, unknown>);
    if (!parsed.ok) {
      return NextResponse.json({ error: "invalid_template", message: parsed.message }, { status: 400 });
    }
    const draft = parsed.value;

    const pages: CustomTemplatePageBytes[] = [];
    let totalBytes = 0;
    for (let index = 0; index < draft.pages.length; index += 1) {
      const part = form.get(`page-${index}`);
      if (!(part instanceof Blob)) {
        return NextResponse.json(
          { error: "invalid_request", message: `Page ${index + 1}'s image is missing.` },
          { status: 400 },
        );
      }

      const bytes = Buffer.from(await part.arrayBuffer());
      if (bytes.byteLength === 0) {
        return NextResponse.json(
          { error: "invalid_request", message: `Page ${index + 1} arrived empty. Try again.` },
          { status: 400 },
        );
      }
      if (bytes.byteLength > CUSTOM_TEMPLATE_MAX_PAGE_BYTES) {
        return NextResponse.json(
          {
            error: "invalid_request",
            message: `Page ${index + 1} is larger than 15 MB. Scan it at a lower resolution.`,
          },
          { status: 413 },
        );
      }

      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES) {
        return NextResponse.json(
          {
            error: "invalid_request",
            message:
              "The whole template is larger than 32 MB. Upload it at a lower resolution, or split it into two templates.",
          },
          { status: 413 },
        );
      }

      pages.push({
        bytes,
        contentType: draft.pages[index].contentType as CustomTemplateContentType,
      });
    }

    // ── Replacing, or adding? ────────────────────────────────────────────────────────────────
    // ONE FIELD DECIDES, and it carries the template's stable `key` — never a version id. The key
    // is what `custom:<key>` names, so a replacement stays the same document and keeps every field
    // rule, every print link and every place it is listed. Naming a version here would create a
    // second document that happens to look the same, which is the failure the B1 migration's header
    // warns about at length.
    const rawReplaces = form.get("replaces");
    const replacesKey = typeof rawReplaces === "string" ? rawReplaces.trim() : "";
    if (replacesKey && !isUuid(replacesKey)) {
      return NextResponse.json(
        { error: "invalid_request", message: "The template being replaced was not named correctly." },
        { status: 400 },
      );
    }

    if (replacesKey) {
      const { archivedVersionId, previousVersion, template } = await replaceCustomTemplateArtwork({
        actorHrId: access.hrId ?? null,
        draft,
        pages,
        templateKey: replacesKey,
      });

      // THE FIELD LAYER FOLLOWS THE PAPER, and this runs AFTER the version is live rather than
      // inside it: the rows live in a different table that may not exist yet, and a template whose
      // artwork is correct but whose boxes did not copy is recoverable in the editor, while a
      // replacement rolled back over a missing field table is not what anybody asked for.
      let fields = { copied: 0, droppedForMissingPage: 0 };
      let fieldsMessage: string | null = null;
      try {
        fields = await copyCustomTemplateFieldLayout({
          actorHrId: access.hrId ?? null,
          document: customDocumentFor(replacesKey),
          fromTemplateVersionId: archivedVersionId,
          pageCount: template.pages.length,
          toTemplateVersionId: template.id,
        });
      } catch (cause) {
        fieldsMessage =
          cause instanceof Error
            ? `Version ${template.version} is live, but its fields could not be copied from version ${previousVersion}: ${cause.message}`
            : `Version ${template.version} is live, but its fields could not be copied from version ${previousVersion}.`;
      }

      return NextResponse.json({
        replaced: {
          archivedVersionId,
          fieldsCopied: fields.copied,
          fieldsDropped: fields.droppedForMissingPage,
          fieldsMessage,
          previousVersion,
        },
        template,
      });
    }

    const template = await createCustomTemplate({
      actorHrId: access.hrId ?? null,
      draft,
      pages,
    });

    return NextResponse.json({ template });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_custom_templates_save_failed", message }, { status });
  }
}
