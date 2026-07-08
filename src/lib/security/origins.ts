import { systemDeployment } from "@/config/system-settings";

// Production + working-preview origins are single-sourced from system-settings so a
// domain change has exactly one edit point. The two URL-bearing constants previously
// hardcoded here drifted from systemDeployment; keep them derived.
// See docs/workflow-and-route-architecture.md § Route categories.
const productionOrigin = systemDeployment.productionUrl;
// Stable team alias used for shared Phoenix Workforce access. Security-only alias,
// intentionally not part of the deploy config.
const teamPreviewOrigin = "https://phoenix-workforce-team.vercel.app";
const workingPreviewOrigin = systemDeployment.workingPreviewUrl;
// Stable branch alias for codex/ceo-staging-rebuild-hardening (PR #24) preview.
const stagingRebuildPreviewOrigin =
  "https://phoenix-workforce-git-codex-41bc50-phoenix-workspace-s-projects.vercel.app";
// New production custom domain (phoenix-hr.satopharma.com). Added alongside the
// legacy Vercel URL rather than replacing systemDeployment.productionUrl — the
// latter also drives email CTA links (see src/lib/vacation/email.ts,
// src/lib/sales/sos-report-delivery.ts), so a full domain cutover is a separate,
// explicitly-approved decision. This entry only unblocks CSRF/origin checks for
// the new domain while the old Vercel URL stays trusted.
const customDomainOrigin = "https://phoenix-hr.satopharma.com";

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

  const vercelUrl = process.env.VERCEL_URL?.trim()
    ? normalizeOrigin(`https://${process.env.VERCEL_URL.trim()}`)
    : null;

  // VERCEL_BRANCH_URL is the stable branch-alias URL (differs from VERCEL_URL which is
  // per-deployment). Branch preview URLs don't match VERCEL_URL, so without this the
  // CSRF middleware and login rejectUntrustedForwardedOrigin both block preview logins.
  const vercelBranchUrl = process.env.VERCEL_BRANCH_URL?.trim()
    ? normalizeOrigin(`https://${process.env.VERCEL_BRANCH_URL.trim()}`)
    : null;

  return new Set(
    [productionOrigin, customDomainOrigin, teamPreviewOrigin, workingPreviewOrigin, stagingRebuildPreviewOrigin, vercelUrl, vercelBranchUrl, ...configured]
      .map((origin) => normalizeOrigin(origin))
      .filter((origin): origin is string => Boolean(origin)),
  );
}

export function isAllowedPhoenixOrigin(origin: string | null | undefined) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (allowedPhoenixOrigins().has(normalized)) return true;
  return (process.env.NODE_ENV !== "production" || process.env.PHOENIX_CI_SMOKE_LOGIN === "true") && isLocalOrigin(normalized);
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
