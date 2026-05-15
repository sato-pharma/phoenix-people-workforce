export class ApiError extends Error {
  code: string;
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function validationError(message: string, code = "invalid_request") {
  return new ApiError(400, code, message);
}

export function unauthorizedError(message = "Authentication is required.") {
  return new ApiError(401, "unauthenticated", message);
}

export function forbiddenError(message = "Forbidden.") {
  return new ApiError(403, "forbidden", message);
}

export function notFoundError(message: string, code = "not_found") {
  return new ApiError(404, code, message);
}

export function conflictError(message: string, code = "conflict") {
  return new ApiError(409, code, message);
}

export function toApiError(error: unknown, fallbackMessage: string) {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof SyntaxError) {
    return validationError("Request body must be valid JSON.");
  }

  if (error instanceof Error) {
    const message = error.message || fallbackMessage;
    const normalized = message.toLowerCase();

    if (normalized.startsWith("forbidden:")) {
      return forbiddenError(message);
    }
    if (normalized.includes("was not found") || normalized.includes("does not exist")) {
      return notFoundError(message);
    }
    if (
      normalized.includes("cannot remove or deactivate the last active super admin") ||
      normalized.includes("cannot deactivate your own active account") ||
      normalized.includes("cannot downgrade your own role") ||
      normalized.includes("cannot elevate your own role") ||
      normalized.includes("cannot assign peer or higher-privilege roles") ||
      normalized.includes("cannot modify peer or higher-privilege accounts") ||
      normalized.includes("only super admin")
    ) {
      return conflictError(message, "governance_conflict");
    }
    if (
      normalized.includes("unexpected end of json input") ||
      normalized.includes("is not valid json") ||
      normalized.includes("invalid ") ||
      normalized.includes(" is required") ||
      normalized.includes("must be ") ||
      normalized.includes("unsupported")
    ) {
      return validationError(message);
    }
    if (normalized.includes("critical audit log could not be persisted")) {
      return new ApiError(500, "audit_persistence_failed", message);
    }

    return new ApiError(500, "internal_error", message);
  }

  return new ApiError(500, "internal_error", fallbackMessage);
}
