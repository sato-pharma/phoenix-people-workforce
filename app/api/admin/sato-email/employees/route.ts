import { NextResponse, type NextRequest } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { canUseSatoEmail } from "@/lib/sato-email/access";
import { getSatoEmailComposerOptions } from "@/lib/sato-email/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MATCHES = 25;

/**
 * Colleagues the sender can add to a send by name, matched against a search term.
 *
 * Capped at 25 matches on purpose, and the cap is a UX decision rather than a guard: a picker that
 * returns the whole directory invites somebody to select all of it, and this screen deliberately
 * reaches a whole audience through a named distribution list instead — where somebody has decided
 * who is on it.
 */
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!canUseSatoEmail(access)) {
      return NextResponse.json({ message: "Forbidden." }, { status: 403 });
    }

    const term = String(request.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
    const { employees, warnings } = await getSatoEmailComposerOptions();

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
