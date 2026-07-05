import type { Breadcrumb, ErrorEvent, Event } from "@sentry/nextjs";

const filteredValue = "[Filtered]";
const maxRedactionDepth = 4;

const sensitiveKeyPattern =
  /authorization|cookie|email|evidence|hr[_-]?id|image|lat(?:itude)?|location|login[_-]?id|long(?:itude)?|mobile|national|password|payroll|payslip|phone|photo|salary|secret|session|token/i;

const sensitiveRoutePattern =
  /\/api\/auth\/|\/api\/payroll|\/api\/admin\/users|\/api\/outstation|\/api\/support|\/api\/messages|\/password-setup/i;

export const sentryIgnoredErrors = [
  "AbortError",
  "Non-Error promise rejection captured",
  "ResizeObserver loop completed with undelivered notifications",
  "ResizeObserver loop limit exceeded",
];

export function parseSentrySampleRate(rawValue: string | undefined, fallback: number) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

export function resolveSentryEnvironment(publicEnvironment?: string) {
  return publicEnvironment || process.env.VERCEL_ENV || process.env.NODE_ENV || "development";
}

export function resolveSentryRelease(publicRelease?: string) {
  return publicRelease || process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactText(value: string) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, filteredValue)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, filteredValue)
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, filteredValue);
}

function scrubUrl(value: unknown) {
  if (typeof value !== "string") return value;

  try {
    const url = new URL(value, "https://phoenix.local");
    url.search = "";
    return value.startsWith("/") ? `${url.pathname}${url.hash}` : url.toString();
  } catch {
    return redactText(value);
  }
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > maxRedactionDepth) return "[Truncated]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => scrubValue(item, depth + 1));
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      sensitiveKeyPattern.test(key) ? filteredValue : scrubValue(nestedValue, depth + 1),
    ]),
  );
}

function scrubRequest(request: unknown) {
  if (!isRecord(request)) return request;
  const sanitized = { ...request };

  delete sanitized.cookies;
  delete sanitized.data;
  delete sanitized.query_string;

  if (typeof sanitized.url === "string") {
    sanitized.url = scrubUrl(sanitized.url);
  }

  if (isRecord(sanitized.headers)) {
    sanitized.headers = scrubValue(sanitized.headers);
  }

  return sanitized;
}

function scrubEvent<T extends Event>(event: T): T {
  const mutable = event as {
    breadcrumbs?: Breadcrumb[];
    contexts?: unknown;
    extra?: unknown;
    request?: unknown;
    user?: unknown;
  };

  delete mutable.user;
  mutable.request = scrubRequest(mutable.request);
  mutable.extra = scrubValue(mutable.extra);
  mutable.contexts = scrubValue(mutable.contexts);
  mutable.breadcrumbs = mutable.breadcrumbs
    ?.map((breadcrumb: Breadcrumb) => scrubSentryBreadcrumb(breadcrumb))
    .filter((breadcrumb: Breadcrumb | null): breadcrumb is Breadcrumb => Boolean(breadcrumb));

  return mutable as T;
}

/** Drop synthetic smoke-test events emitted by Codex to verify Sentry ingestion. */
const smokeTestPattern = /sentry ingestion smoke/i;

function isSmokeTestEvent(event: Event): boolean {
  if (typeof event.message === "string" && smokeTestPattern.test(event.message)) return true;
  if (event.tags && typeof event.tags === "object") {
    const tags = event.tags as Record<string, unknown>;
    if ("codex_smoke" in tags || "Codex Smoke" in tags) return true;
  }
  return false;
}

export function scrubSentryErrorEvent(event: ErrorEvent) {
  if (isSmokeTestEvent(event)) return null;
  return scrubEvent(event);
}

export function scrubSentryTransactionEvent<T extends Event>(event: T) {
  return scrubEvent(event);
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === "console" || breadcrumb.category === "ui.input") {
    return null;
  }

  if (typeof breadcrumb.message === "string" && sensitiveRoutePattern.test(breadcrumb.message)) {
    return {
      ...breadcrumb,
      data: scrubValue(breadcrumb.data) as Breadcrumb["data"],
      message: breadcrumb.message.replace(/\?.*$/, ""),
    };
  }

  return {
    ...breadcrumb,
    data: scrubValue(breadcrumb.data) as Breadcrumb["data"],
    message: typeof breadcrumb.message === "string" ? redactText(breadcrumb.message) : breadcrumb.message,
  };
}
