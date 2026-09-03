import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  carryForwardDocumentFields,
  carryForwardOffer,
  deleteDocumentField,
  isFieldLayerMissing,
  loadDocumentFieldLayout,
  parseDocumentFieldWrite,
  resetDocumentFieldLayout,
  saveDocumentField,
  type DocumentFieldWriteInput,
} from "@/lib/hiring-pack/field-layout-store";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { HIRING_PACK_DOCUMENTS } from "@/lib/hiring-pack/types";
import type { HiringPackDocument } from "@/lib/hiring-pack/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The operator's own field layer — what has been moved, hidden or added on a printed document. See
// field-layout.ts for why this exists and field-layout-store.ts for the schema and the validation
// that mirrors the table's own CHECK constraints.
//
// GATED ON THE SAME `employee_documents` RESOURCE AS THE REST OF `/api/hiring-pack/**`, not a
// narrower one of its own. Whoever can already print these ten documents and correct the values on
// them is exactly who this screen is for — a separate "layout" permission would only mean asking
// someone to hold a second grant to move a box on a page they can already fill in and sign off.

function isKnownDocument(value: unknown): value is HiringPackDocument {
  return typeof value === "string" && (HIRING_PACK_DOCUMENTS as readonly string[]).includes(value);
}

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: "Not permitted.", status: 403 };
  if (isFieldLayerMissing(error)) {
    return {
      message:
        "The field-layout table is not ready yet. Run the Supabase migration for hiring_pack_document_fields.",
      status: 409,
    };
  }
  return { message: error instanceof Error ? error.message : "Something went wrong.", status: 500 };
}

/** Read one document's layout, for one template version. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "read");

    const url = new URL(request.url);
    const document = url.searchParams.get("document");
    const templateVersionId = url.searchParams.get("templateVersionId");
    if (!isKnownDocument(document) || !templateVersionId) {
      return NextResponse.json(
        {
          error: "invalid_request",
          message: `Pass document= (one of ${HIRING_PACK_DOCUMENTS.join(", ")}) and templateVersionId=.`,
        },
        { status: 400 },
      );
    }

    // THE OFFER RIDES WITH THE LAYOUT, in one round trip rather than two. It is needed at exactly
    // the moment a layout is read and is null in every ordinary case — a version with work on it
    // never has one — so a second request would spend a trip to be told nothing almost every time.
    const [fields, carryForward] = await Promise.all([
      loadDocumentFieldLayout(document, templateVersionId),
      carryForwardOffer(document, templateVersionId),
    ]);
    return NextResponse.json({ fields, carryForward });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_field_layout_read_failed", message }, { status });
  }
}

/**
 * Move, hide, add or reset a field — one row per call, except `intent: "reset"`, which clears every
 * row for one document version at once.
 *
 * ONE ENDPOINT, NOT A REST VERB PER ACTION. A drag ends in a save, a delete ends in a save (of
 * nothing), and a reset is a bulk delete — three shapes of "the layout just changed", and the editor
 * reloads the same way after each. Splitting them across verbs would not make any one of them
 * simpler; it would just mean the client picks a method instead of an intent.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "update");

    const body = (await request.json()) as { intent?: string } & Record<string, unknown>;

    if (body.intent === "reset") {
      const document = body.document;
      const templateVersionId = body.templateVersionId;
      if (!isKnownDocument(document) || typeof templateVersionId !== "string" || templateVersionId.trim() === "") {
        return NextResponse.json(
          { error: "invalid_request", message: "Pass document and templateVersionId to reset." },
          { status: 400 },
        );
      }
      const removed = await resetDocumentFieldLayout(document, templateVersionId);
      return NextResponse.json({ removed });
    }

    // CARRY A PREVIOUS VERSION'S LAYOUT ONTO THIS ONE. Both ids are named by the caller rather
    // than re-derived here: the offer the editor showed is what the operator agreed to, and a
    // server that recomputed the source could copy a different version than the one on screen.
    if (body.intent === "carryForward") {
      const document = body.document;
      const fromTemplateVersionId = body.fromTemplateVersionId;
      const toTemplateVersionId = body.toTemplateVersionId;
      if (
        !isKnownDocument(document) ||
        typeof fromTemplateVersionId !== "string" ||
        typeof toTemplateVersionId !== "string" ||
        fromTemplateVersionId.trim() === "" ||
        toTemplateVersionId.trim() === ""
      ) {
        return NextResponse.json(
          {
            error: "invalid_request",
            message: "Pass document, fromTemplateVersionId and toTemplateVersionId to carry a layout forward.",
          },
          { status: 400 },
        );
      }
      const carried = await carryForwardDocumentFields(
        document,
        fromTemplateVersionId,
        toTemplateVersionId,
        access.hrId ?? null,
      );
      return NextResponse.json({ carried });
    }

    const parsed = parseDocumentFieldWrite(body as DocumentFieldWriteInput);
    if (!parsed.ok) {
      return NextResponse.json({ error: "invalid_field_layout", message: parsed.message }, { status: 400 });
    }

    const field = await saveDocumentField(parsed.write, access.hrId ?? null);
    return NextResponse.json({ field });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_field_layout_save_failed", message }, { status });
  }
}

/** Delete one field. An added field goes; an override goes back to its compiled default. */
export async function DELETE(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "update");

    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "invalid_request", message: "Pass id=." }, { status: 400 });
    }
    await deleteDocumentField(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_field_layout_delete_failed", message }, { status });
  }
}
