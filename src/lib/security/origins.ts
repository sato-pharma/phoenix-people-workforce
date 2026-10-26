import { systemDeployment } from "@/config/system-settings";
import { isCiSmokeLoginEnabled } from "@/lib/auth/ci-smoke-login";

// Production + working-preview origins are single-sourced from system-settings so a
// domain change has exactly one edit point. The two URL-bearing constants previously
// hardcoded here drifted from systemDeployment; keep them derived.
// See docs/workflow-and-route-architecture.md § Route categories.
const productionOrigin = systemDeployment.productionUrl;
// Production custom domain. Since the GCP migration, systemDeployment.productionUrl IS
// this domain (it also drives email CTA links); kept as an explicit belt-and-suspenders
// entry so CSRF/origin checks trust the custom domain even if productionUrl is repointed.
const customDomainOrigin = "https://phoenix-hr.satopharma.com";
// The legacy Vercel preview origins (team alias, working-branch preview, staging-rebuild
// preview) were REMOVED from the CSRF/redirect trust set after the Vercel -> Cloud Run
// migration — no production traffic uses them. If a temporary preview origin is ever
// needed for rollback, add it narrowly via the PHOENIX_ALLOWED_ORIGINS env var (parsed
// in allowedPhoenixOrigins) rather than hardcoding a broadly-trusted host.

function normalizeLocalHostname(hostname: string) {
  const normalized = hostname
    .trim()
    .replace(/^\[(.*)\]$/, "$1")
    .toLowerCase();

  if (normalized === "127.0.0.1" || normalized === "::1") {
    return "localhost";
  }

  return normalized;
}

export function normalizeOrigin(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    url.hostname = normalizeLocalHostname(url.hostname);
    url.hash = "";
    url.pathname = "";
    url.search = "";
    return url.origin;
  } catch {
    return null;
  }
}

export function originFromHostParts(host: string | null | undefined, proto: string | null | undefined) {
  const normalizedHost = String(host ?? "").trim();
  if (!normalizedHost) return null;

  const normalizedProto = String(proto ?? "").trim() || "https";
  return normalizeOrigin(`${normalizedProto}://${normalizedHost}`);
}

function isLocalOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return normalizeLocalHostname(url.hostname) === "localhost";
  } catch {
    return false;
  }
}

export function allowedPhoenixOrigins() {
  const configured = String(process.env.PHOENIX_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => normalizeOrigin(origin))
    .filter((origin): origin is string => Boolean(origin));

  // Add fallback support for standard Next.js / cloud-agnostic URL variables
  const appUrl = process.env.APP_URL?.trim()
    ? normalizeOrigin(process.env.APP_URL.trim())
    : null;

  const nextPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL?.trim()
    ? normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL.trim())
    : null;

  // Standardize preview URL for generic cloud providers (e.g. Google Cloud Run previews)
  const previewUrl = process.env.PREVIEW_URL?.trim()
    ? normalizeOrigin(process.env.PREVIEW_URL.trim())
    : null;

  return new Set(
    [productionOrigin, customDomainOrigin, appUrl, nextPublicAppUrl, previewUrl, ...configured]
      .map((origin) => normalizeOrigin(origin))
      .filter((origin): origin is string => Boolean(origin)),
  );
}

export function isAllowedPhoenixOrigin(origin: string | null | undefined) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (allowedPhoenixOrigins().has(normalized)) return true;
  // A loopback origin is trusted in development, and on a production build only inside the CI
  // login smoke test — APP_ENV exactly "ci" AND the flag, never the flag alone (audit point 16).
  return (process.env.NODE_ENV !== "production" || isCiSmokeLoginEnabled()) && isLocalOrigin(normalized);
}

export function requestOriginCandidates(request: Pick<Request, "headers" | "url">) {
  return {
    forwardedOrigin: originFromHostParts(
      request.headers.get("x-forwarded-host"),
      request.headers.get("x-forwarded-proto"),
    ),
    hostOrigin: originFromHostParts(
      request.headers.get("host"),
      new URL(request.url).protocol.replace(/:$/, ""),
    ),
    originHeader: normalizeOrigin(request.headers.get("origin")),
    refererOrigin: normalizeOrigin(request.headers.get("referer")),
    requestUrlOrigin: normalizeOrigin(request.url),
  };
}

export function trustedOriginForRedirect(request: Pick<Request, "headers" | "url">) {
  const candidates = requestOriginCandidates(request);
  for (const origin of [
    candidates.forwardedOrigin,
    candidates.originHeader,
    candidates.hostOrigin,
    candidates.requestUrlOrigin,
  ]) {
    if (origin && isAllowedPhoenixOrigin(origin)) return origin;
  }

  return productionOrigin;
}

export function rejectUntrustedForwardedOrigin(request: Pick<Request, "headers" | "url">) {
  const candidates = requestOriginCandidates(request);

  if (candidates.forwardedOrigin && !isAllowedPhoenixOrigin(candidates.forwardedOrigin)) {
    return { origin: candidates.forwardedOrigin, reason: "untrusted_forwarded_host" };
  }
  if (candidates.originHeader && !isAllowedPhoenixOrigin(candidates.originHeader)) {
    return { origin: candidates.originHeader, reason: "untrusted_origin" };
  }
  if (candidates.refererOrigin && !isAllowedPhoenixOrigin(candidates.refererOrigin)) {
    return { origin: candidates.refererOrigin, reason: "untrusted_referer" };
  }

  return null;
}
