import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  carryForwardDocumentFields,
  carryForwardOffer,
  deleteDocumentField,
  isFieldLayerMissing,
  loadDocumentFieldLayout,
  loadFieldHistory,
  parseDocumentFieldWrite,
  resetDocumentFieldLayout,
  saveDocumentField,
  summariseDocumentFieldHistory,
  type DocumentFieldWriteInput,
} from "@/lib/hiring-pack/field-layout-store";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  asPrintableDocument,
  type PrintableDocument,
} from "@/lib/hiring-pack/document-registry";
import { HIRING_PACK_DOCUMENTS, isBuiltInDocument } from "@/lib/hiring-pack/types";
import type { HiringPackDocument } from "@/lib/hiring-pack/types";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

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

/** One of the ten. Still the answer for the two intents that read the COMPILED registry. */
function isKnownDocument(value: unknown): value is HiringPackDocument {
  return typeof value === "string" && (HIRING_PACK_DOCUMENTS as readonly string[]).includes(value);
}

/**
 * The document a request names — one of the ten, or a company template somebody uploaded.
 *
 * `asPrintableDocument` rather than a list check, because "which documents are there" stopped
 * being a closed question the moment a template could be uploaded, and the store already keys
 * layouts on the wider type. WHAT THIS FIXES was a real half-state: the POST validator accepted a
 * box dropped on an uploaded paper while the GET refused to list it, so the box saved, vanished
 * from the field table, and printed anyway — a value on a signed document that the screen said
 * was not there.
 */
function requestedDocument(value: unknown): PrintableDocument | null {
  return typeof value === "string" ? asPrintableDocument(value) : null;
}

/** The sentence a caller who named no document, or an unknown one, gets back. */
const DOCUMENT_EXPECTED =
  `Pass document= (one of ${HIRING_PACK_DOCUMENTS.join(", ")}, or a company template as ` +
  "custom:<uuid>)";

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: "Not permitted.", status: 403 };
  if (isFieldLayerMissing(error)) {
    return {
      message:
        "The field-layout table is not ready yet. Run the Supabase migration for hiring_pack_document_fields.",
      status: 409,
    };
  }
  return { message: clientSafeErrorMessage(error, "Something went wrong."), status: 500 };
}

/**
 * Read one document's layout, for one template version — or the past states of a single field.
 *
 * `historyFor=<id>` is the detail read behind opening one row's history, and it is answered before
 * the document arguments are looked at because a field that has been DELETED still has a history and
 * no longer has a document row to be found through. That is the case the history exists for.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "read");

    const url = new URL(request.url);

    const historyFor = url.searchParams.get("historyFor");
    if (historyFor) {
      return NextResponse.json({ history: await loadFieldHistory(historyFor) });
    }

    const document = requestedDocument(url.searchParams.get("document"));
    const templateVersionId = url.searchParams.get("templateVersionId");
    if (!document || !templateVersionId) {
      return NextResponse.json(
        { error: "invalid_request", message: `${DOCUMENT_EXPECTED} and templateVersionId=.` },
        { status: 400 },
      );
    }

    // THE OFFER RIDES WITH THE LAYOUT, in one round trip rather than two. It is needed at exactly
    // the moment a layout is read and is null in every ordinary case — a version with work on it
    // never has one — so a second request would spend a trip to be told nothing almost every time.
    //
    // `changed` rides along for the same reason and costs two columns: it is one line of text per
    // row — "changed 12 Sep, 14:20" — and asking for it separately would double the panel's opening
    // cost to deliver a timestamp. The full previous states are fetched only for the row somebody
    // opens, through `historyFor` above.
    // NO CARRY-FORWARD OFFER FOR A COMPANY TEMPLATE, and null is the honest answer rather than a
    // gap. The offer is built from `templateVersionsFor` — the COMPILED registry, which knows the
    // ten and nothing else — so asking it about an uploaded template returns an empty version list,
    // which reads as "there is no earlier layout to carry" whether or not that is true. An uploaded
    // template's versions live in a database table, and offering across them is what replacing a
    // template's artwork will need; until that is built, saying nothing beats answering wrongly.
    const [fields, carryForward, changed] = await Promise.all([
      loadDocumentFieldLayout(document, templateVersionId),
      isBuiltInDocument(document) ? carryForwardOffer(document, templateVersionId) : null,
      summariseDocumentFieldHistory(document, templateVersionId),
    ]);
    return NextResponse.json({ fields, carryForward, changed });
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
      const document = requestedDocument(body.document);
      const templateVersionId = body.templateVersionId;
      if (!document || typeof templateVersionId !== "string" || templateVersionId.trim() === "") {
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
    // `isKnownDocument`, NOT `requestedDocument`, and that is the same reason the GET above returns
    // no offer for a company template: this copies a layout between two versions of the COMPILED
    // registry. An uploaded template's versions are rows, and carrying between them is B6's work.
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

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // PLACING THE SIGNATURE IS NARROWER THAN EVERY OTHER WRITE ON THIS ROUTE, and it is the only
    // thing here that is.
    //
    // `employee_documents:update` is held by everyone who prepares these papers, and that is right
    // for moving a box or retyping a caption. It is not right for putting the HR Section Head's
    // signature onto a document: a stored signature is the MEANS of signing, and whoever may apply
    // it is deciding that a paper is signed. So the grant that governs the image governs placing it
    // too — the same Super Admin gate as `/api/hiring-pack/signature`, for the same reason.
    //
    // THE STAMP IS NOT GATED THIS WAY, deliberately. The company seal is the company's own mark on
    // its own paper, it is already drawn on every job offer, and it says nothing about who approved
    // anything — the signature beside it is what does that.
    //
    // A DELETE IS NOT GATED EITHER. Removing a mark returns the paper to unsigned, which is the safe
    // direction, and a mark nobody can take off again would be the worse arrangement.
    //
    // 🔒 CONFIRMED BY THE OWNER, 2026-09-29, put to him as a choice and answered "keep the signature
    // super admin only". The alternative he was offered — letting anyone with
    // `employee_documents:update` place it, so HR Operations could sign a contract they are
    // preparing — is the one thing not to "fix" back here. See `document-marks.ts`.
    // ─────────────────────────────────────────────────────────────────────────────────────────
    if (
      parsed.write.source.kind === "mark" &&
      parsed.write.source.mark === "signature" &&
      access.role !== "Super Admin"
    ) {
      return NextResponse.json(
        {
          error: "forbidden",
          message:
            "Only a Super Admin can place the stored signature on a paper. The company stamp is available to you.",
        },
        { status: 403 },
      );
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
