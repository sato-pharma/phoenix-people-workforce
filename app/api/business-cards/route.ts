import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { applyCardEdits, withDoctorTitle } from "@/lib/business-cards/card-content";
import type { BusinessCardFields, EditableCardField } from "@/lib/business-cards/card-content";
import {
  assertBusinessCardsPrintable,
  BusinessCardCharacterError,
  businessCardsZipStream,
  cardFileName,
  renderBusinessCardsPdf,
} from "@/lib/business-cards/render-pdf";
import { canPrintBusinessCards } from "@/lib/business-cards/access";
import { listBusinessCardEmployees } from "@/lib/business-cards/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { mode, cards: [{ hrId, edits?, doctor? }] } → the print-ready file. `doctor: true` prints
// "Dr." before the name (the per-card toggle on the screen).
//
//   mode "combined"  one PDF, every card in it (front, back, front, back…) — one file to the printer.
//   mode "separate"  one PDF per person; several people come back as a ZIP of those PDFs.
//
// The server builds each card from the employee record itself; the browser sends only the HR ids
// and whatever was corrected on screen. Gated like HR Forms: `employee_documents` and an HR seat.

const MAX_CARDS = 500;

type CardRequest = { doctor?: unknown; edits?: Partial<Record<EditableCardField, unknown>>; hrId?: unknown };

function cairoDate(): string {
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(new Date());
}

type RequestBody = { cards?: unknown; check?: unknown; mode?: unknown };

// JSON from fetch(), or a form field `payload` holding the same JSON. The form is how the screen
// downloads a ZIP of separate PDFs: posted into a hidden frame, the browser saves the stream to disk
// as it arrives instead of holding hundreds of megabytes in the page.
async function readBody(request: Request): Promise<RequestBody | null> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
      const payload = (await request.formData()).get("payload");
      return typeof payload === "string" ? (JSON.parse(payload) as RequestBody) : null;
    }
    return (await request.json()) as RequestBody;
  } catch {
    return null;
  }
}

function fail(status: number, error: string, message: string) {
  return NextResponse.json({ error, message }, { status });
}

function fileResponse(body: BodyInit, fileName: string, contentType: string) {
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Type": contentType,
    },
  });
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    // employee_documents for HR Advisory / HR Operations, the request desk for Talent Acquisition —
    // src/lib/business-cards/access.ts, the predicate the page uses too.
    if (!(await canPrintBusinessCards(access))) {
      return fail(403, "forbidden", "Business cards are printed by HR.");
    }

    const body = await readBody(request);
    const mode = body?.mode;
    const requested = Array.isArray(body?.cards) ? (body.cards as CardRequest[]) : [];
    if (mode !== "combined" && mode !== "separate") {
      return fail(400, "invalid_mode", "Choose one PDF for all cards, or a separate PDF for each person.");
    }
    if (requested.length === 0) return fail(400, "no_cards", "Choose at least one employee.");
    if (requested.length > MAX_CARDS) return fail(400, "too_many_cards", `Print at most ${MAX_CARDS} cards at a time.`);

    const employees = new Map((await listBusinessCardEmployees()).employees.map((employee) => [employee.hrId, employee]));
    const cards: Array<{ fields: BusinessCardFields; name: string }> = [];
    for (const entry of requested) {
      const employee = typeof entry?.hrId === "string" ? employees.get(entry.hrId) : undefined;
      if (!employee) {
        return fail(404, "employee_not_active", "One of the chosen people is no longer on the active staff list. Refresh the page and choose again.");
      }
      const edited = applyCardEdits(employee.fields, entry.edits);
      const fields = entry.doctor === true ? { ...edited, name: withDoctorTitle(edited.name) } : edited;
      if (!fields.name) return fail(400, "name_missing", `${employee.name}'s card has no name on it.`);
      cards.push({ fields, name: employee.name });
    }

    // A dry run: every check the download makes, without rendering. The screen asks this first for a
    // streamed ZIP, because once the browser is saving the stream a refusal can no longer reach it.
    if (body?.check === true) {
      assertBusinessCardsPrintable(cards.map((card) => card.fields));
      return new Response(null, { headers: { "Cache-Control": "no-store, max-age=0" }, status: 204 });
    }

    // Every file hands over names, work emails and mobiles, up to 500 people at a time, so who took
    // which cards is recorded BEFORE the file is returned. No row, no file.
    const edited = requested.filter((entry) => entry.edits && Object.keys(entry.edits).length > 0).length;
    const doctors = requested.filter((entry) => entry.doctor === true).length;
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? access.hrId,
      entityId: randomUUID(),
      entityType: "business_cards_export",
      newValues: { cards: cards.length, doctorTitle: doctors, editedOnScreen: edited, hrIds: requested.map((entry) => entry.hrId), mode },
      summary: `Business cards exported (${cards.length} ${cards.length === 1 ? "card" : "cards"}, ${mode === "combined" ? "one PDF" : "separate PDFs"}, ${edited} edited on screen) by ${access.hrId ?? "unknown"}.`,
    });

    const date = cairoDate();
    if (mode === "combined" || cards.length === 1) {
      const [only] = cards;
      const pdf = await renderBusinessCardsPdf(
        cards.map((card) => card.fields),
        { title: cards.length === 1 ? `${only.fields.name} — business card` : "Sato Pharma business cards" },
      );
      const fileName = cards.length === 1 ? cardFileName(only.fields.name, "card") : `sato-pharma-business-cards-${date}.pdf`;
      return fileResponse(Buffer.from(pdf), fileName, "application/pdf");
    }

    // Streamed: each person's PDF is rendered and sent before the next is built (see zip-stream.ts).
    const zip = businessCardsZipStream(
      cards.map((card) => ({ card: card.fields, fileName: cardFileName(card.fields.name, "card") })),
    );
    return fileResponse(zip, `sato-pharma-business-cards-${date}.zip`, "application/zip");
  } catch (error) {
    if (isForbiddenError(error)) return fail(403, "forbidden", "You do not have access to business cards.");
    if (error instanceof BusinessCardCharacterError) {
      return fail(422, "unprintable_characters", `${error.message}. Type the name in English letters.`);
    }
    console.error("[business-cards] render failed", error);
    return fail(500, "business_cards_failed", "The cards could not be generated. Try again.");
  }
}
