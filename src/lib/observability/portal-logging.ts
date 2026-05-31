/**
 * PII-safe diagnostic logging for Employee Portal server-side failures.
 *
 * Several portal pages catch a data-load error and fall back to a friendly
 * generic empty state. That keeps the UX clean but makes real failures
 * invisible in logs. `logPortalFailure` emits a single structured line with
 * ONLY safe diagnostic fields so these failures can be triaged without
 * exposing sensitive data.
 *
 * Safe fields only: route, module, role, hrId (opaque employee key / actor id),
 * and the error name / scrubbed message / coarse classification.
 *
 * Never logged: salary amounts, tokens, session/cookies, raw request payloads,
 * stack traces, emails/phones, or any other sensitive personal data. The error
 * message is scrubbed before emission and the raw error object is never logged.
 *
 * This helper never throws — logging must not break a page render.
 */

export type PortalFailureContext = {
  /** Stable route identifier, e.g. "/employee-portals/sales". */
  route: string;
  /** Short module name, e.g. "sales", "incentive", "shell". */
  module: string;
  /** Caller role (safe), e.g. "Medical Rep". */
  role?: string | null;
  /** Opaque HR_ID actor id (safe). Never a name/email/phone. */
  hrId?: string | null;
};

const FILTERED = "[Filtered]";

/**
 * Strip the most common secret-bearing substrings from a free-text error
 * message: email addresses, Bearer/Basic auth values, and JWT-shaped tokens.
 */
function scrubMessage(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, FILTERED)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, FILTERED)
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, FILTERED)
    .slice(0, 500);
}

/** Coarse, non-sensitive bucket for the failure. */
function classifyError(name: string, message: string): string {
  const lower = message.toLowerCase();
  if (name === "ForbiddenError" || lower.startsWith("forbidden:") || lower.includes("forbidden")) {
    return "forbidden";
  }
  if (lower.includes("not authenticated") || lower.includes("unauthenticated")) {
    return "unauthenticated";
  }
  if (lower.includes("not found")) return "not_found";
  if (lower.includes("schema") && lower.includes("missing")) return "schema_missing";
  return "error";
}

export function logPortalFailure(context: PortalFailureContext, error: unknown): void {
  try {
    const err =
      error instanceof Error
        ? error
        : new Error(typeof error === "string" ? error : "Unknown error");
    const name = err.name || "Error";
    const message = scrubMessage(err.message || "");

    const payload = {
      event: "employee_portal_failure",
      route: context.route,
      module: context.module,
      role: context.role ?? null,
      hrId: context.hrId ?? null,
      errorName: name,
      errorMessage: message,
      classification: classifyError(name, message),
    };

    console.error("[employee-portal]", JSON.stringify(payload));
  } catch {
    // Logging must never break a render.
  }
}
