import { NextResponse } from "next/server";

import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  ExpenseNoteAssistError,
  polishExpenseApprovalNote,
  type ExpenseNoteFact,
  type ExpenseNoteOutcome,
} from "@/lib/outstation/expense-note-assist";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OUTCOMES: readonly ExpenseNoteOutcome[] = ["adjusted", "approved", "pending", "rejected"];

/**
 * Rewrites an approver's rough comment into the system-voice note the employee reads.
 *
 * A POST because it calls out to a paid service, not because it writes anything — nothing here
 * touches the database and nothing is decided. The rewritten sentence goes back to the approver's
 * own screen, into the field he was already editing, and is saved by the Save he was always going
 * to press.
 *
 * Gated on decision access rather than the wider review access the queue GET uses: a CEO cannot
 * record a decision here (2026-08-08), so a note for him to attach to one would be a dead end.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;
    assertSystemAdministratorWorkspaceAccess(access, "outstation expense note");

    const body = (await request.json().catch(() => null)) as {
      draft?: unknown;
      facts?: unknown;
      outcome?: unknown;
    } | null;

    const draft = typeof body?.draft === "string" ? body.draft : "";
    const rawOutcome = String(body?.outcome ?? "") as ExpenseNoteOutcome;
    const outcome = OUTCOMES.includes(rawOutcome) ? rawOutcome : "pending";
    // Shaped, then re-capped inside the domain module — the browser is the only source of these
    // and they end up in a prompt.
    const facts: ExpenseNoteFact[] = Array.isArray(body?.facts)
      ? (body.facts as unknown[])
          .filter((fact): fact is { label: unknown; value: unknown } => Boolean(fact) && typeof fact === "object")
          .map((fact) => ({ label: String(fact.label ?? ""), value: String(fact.value ?? "") }))
      : [];

    return NextResponse.json(await polishExpenseApprovalNote({ draft, facts, outcome }));
  } catch (error) {
    if (error instanceof ExpenseNoteAssistError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.code === "note_rate_limited" ? 429 : 400 },
      );
    }
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_note_failed",
        message: error instanceof Error ? error.message : "The note could not be written.",
      },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
