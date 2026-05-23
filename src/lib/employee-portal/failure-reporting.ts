import "server-only";

function normalizeScope(scope: string) {
  return scope
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "unknown";
}

type ErrorEnvelope = {
  name?: string;
  message: string;
  stack?: string;
  raw?: unknown;
};

function normalizeError(error: unknown): ErrorEnvelope {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message || "Unknown error",
      stack: error.stack,
    };
  }

  if (typeof error === "string") {
    return { message: error };
  }

  if (typeof error === "object" && error !== null) {
    const safeMessage = (error as { message?: unknown }).message;
    return {
      message: typeof safeMessage === "string" ? safeMessage : "Unknown error",
      raw: error,
    };
  }

  return { message: "Unknown error" };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function safeSerialize(value: unknown): unknown | undefined {
  if (typeof value === "undefined") return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function reportViaWebhook(scope: string, reference: string, error: ErrorEnvelope) {
  const webhookUrl = process.env.EMPLOYEE_PORTAL_ERROR_WEBHOOK_URL;
  if (!webhookUrl) return;

  const payload = {
    event: "employee-portal-failure",
    source: "reportEmployeePortalFailure",
    scope,
    reference,
    error,
    severity: "error",
    timestamp: new Date().toISOString(),
    service: "employee-portal",
  };

  void fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Explicitly ignore webhook errors to avoid masking original errors.
  });
}

export async function reportEmployeePortalFailure(scope: string, error: unknown) {
  const normalizedScope = normalizeScope(scope);
  const reference = `ep-${normalizedScope}-${Date.now().toString(36)}`;
  const normalizedError = normalizeError(error);

  console.error(`[employee-portal:${normalizedScope}] ${reference}`, error);

  reportViaWebhook(normalizedScope, reference, normalizedError);

  return reference;
}
