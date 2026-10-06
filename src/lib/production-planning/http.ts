import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

import { ProductionPlanningForbiddenError } from "./access";
import { ProductionPlanningInputError } from "./rules";

/**
 * One error mapping for every Production Planner route, so the page reads the same status for the
 * same cause whichever button was pressed.
 *
 * A refused permission is 403 and carries its own sentence, because the people this module refuses
 * are five named colleagues and one of them WILL hit it the day the list is wrong — "Forbidden"
 * with no detail would send that straight to the owner as "the module is broken".
 *
 * A mistake in what was typed is 400 with a sentence in Arabic for the person who typed it:
 * `ProductionPlanningInputError` is only ever thrown with a message meant to be read.
 *
 * Anything else is 500 with a generic message, so a database error never hands a column name or a
 * constraint name back to the browser.
 */
export function productionPlanningErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof ProductionPlanningForbiddenError || isForbiddenError(error)) {
    return NextResponse.json({ message: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
  }
  if (error instanceof ProductionPlanningInputError) {
    return NextResponse.json({ message: error.message, field: error.field }, { status: 400 });
  }
  return NextResponse.json({ message: clientSafeErrorMessage(error, fallback) }, { status: 500 });
}

/** Every GET in this module answers private and uncached: it carries prices and order costs. */
export const PRODUCTION_PLANNING_CACHE_HEADERS = { "cache-control": "private, no-store" } as const;
