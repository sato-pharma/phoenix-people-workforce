import { NextResponse, type NextRequest } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canUseCeoEmail } from "@/lib/ceo-email/access";
import { getCeoEmailComposerOptions } from "@/lib/ceo-email/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mirrored by SEARCH_MATCH_CAP in the composer component, so the screen can say it is a cap. */
const MAX_MATCHES = 25;

/**
 * Colleagues who can be added to a letter by name, matched against a search term.
 *
 * Capped at 25 matches, and the cap is a design decision rather than a guard: a picker that returns
 * the whole directory invites somebody to select all of it, and this screen deliberately reaches a
 * whole audience through a named distribution list instead — where somebody has decided who is on it.
 */
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!canUseCeoEmail(access)) {
      return NextResponse.json({ message: "Forbidden." }, { status: 403 });
    }

    const term = String(request.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
    const { employees, warnings } = await getCeoEmailComposerOptions();

    const matches = (term.length < 2
      ? employees
      : employees.filter((employee) =>
          [employee.displayName, employee.email, employee.jobTitle ?? "", employee.where ?? ""].some((field) =>
            field.toLowerCase().includes(term),
          ),
        )
    ).slice(0, MAX_MATCHES);

    return NextResponse.json({ employees: matches, total: employees.length, warnings });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to search colleagues.") },
      { status: 500 },
    );
  }
}
