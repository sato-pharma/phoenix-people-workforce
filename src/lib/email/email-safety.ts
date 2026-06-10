import crypto from "crypto";
import sanitizeHtml from "sanitize-html";

const defaultSignatureCacheTtlMs = 60 * 60 * 1000;
const signatureImageChecks = new Map<string, { checkedAt: number; contentType: string }>();

export type RecipientPolicyIssue =
  | { code: "too_many_recipients"; limit: number; message: string }
  | { code: "external_justification_required"; externalRecipients: string[]; message: string };

export type RecipientPolicyResult = {
  allowedDomains: string[];
  externalRecipients: string[];
  issues: RecipientPolicyIssue[];
  maxRecipients: number;
  totalRecipients: number;
};

export function sanitizeEmailTemplateHtml(value: string) {
  return sanitizeHtml(value, {
    allowedAttributes: {
      // `dir` enables right-to-left Arabic paragraphs in any email client.
      "*": ["style", "dir"],
      a: ["href", "rel", "target", "title", "style", "dir"],
      img: ["src", "alt", "width", "height", "style"],
      span: ["title", "style", "dir"],
      table: ["width", "cellpadding", "cellspacing", "border", "style", "dir"],
      td: ["colspan", "rowspan", "style", "dir"],
      th: ["colspan", "rowspan", "style", "dir"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    // Email clients only load remote images over HTTPS; plain-http would also break the
    // in-app preview with mixed content. Protocol-relative (//host) URLs would bypass the
    // per-tag scheme check entirely, so they are rejected too.
    allowProtocolRelative: false,
    allowedSchemesByTag: { img: ["https"] },
    // Inline styles power the rich editor (colors, font size, tables). Allow ONLY a safe,
    // tightly pattern-matched subset; anything else is dropped.
    allowedStyles: {
      "*": {
        "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i],
        border: [/^[\w\s#().,%-]+$/],
        "border-collapse": [/^(collapse|separate)$/],
        color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i],
        direction: [/^(rtl|ltr)$/],
        "font-family": [/^[\w\s,'"-]+$/],
        "font-size": [/^\d{1,2}(px|pt)$/, /^(x-small|small|medium|large|x-large|xx-large)$/],
        // Chrome's rich editor (styleWithCSS) writes bold/italic/strike as styled spans -
        // without these three, basic formatting would be silently stripped on save.
        "font-style": [/^(italic|normal)$/],
        "font-weight": [/^(bold|bolder|normal|[1-9]00)$/],
        "text-decoration-line": [/^(underline|line-through|underline line-through)$/],
        "letter-spacing": [/^(normal|\d(\.\d+)?px)$/],
        "line-height": [/^(normal|\d(\.\d+)?(px)?)$/],
        "max-width": [/^\d{1,3}%$/, /^\d{1,4}px$/],
        padding: [/^[\d\s]+(px|%)?( \d+(px|%)?){0,3}$/],
        "text-align": [/^(left|right|center|justify)$/],
        "text-decoration": [/^(underline|line-through)$/],
        width: [/^\d{1,3}%$/, /^\d{1,4}px$/],
      },
    },
    allowedTags: [
      "a", "b", "blockquote", "br", "em", "hr", "i", "img", "li", "ol", "p", "s", "span",
      "strong", "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
    ],
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
    transformTags: {
      a: (_tagName, attribs) => ({
        attribs: { ...attribs, rel: "noopener noreferrer", target: "_blank" },
        tagName: "a",
      }),
    },
  }).trim();
}

function configuredMaxRecipients() {
  const parsed = Number.parseInt(String(process.env.PHOENIX_HR_EMAIL_MAX_RECIPIENTS ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
}

function configuredAllowedDomains() {
  return Array.from(new Set(
    String(process.env.PHOENIX_HR_EMAIL_ALLOWED_DOMAINS ?? "satopharma.com")
      .split(/[,\n;]/)
      .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
  ));
}

/**
 * Block hosts that resolve to local/internal networks (SSRF guard for the reusable image
 * validator). Matches the parsed hostname against loopback, RFC1918 private ranges,
 * link-local (incl. the 169.254.169.254 cloud-metadata endpoint), and IPv6
 * loopback/ULA/link-local. The naive original only matched `localhost`/`127.0.0.1`.
 */
export function isBlockedImageHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::1" || h === "::") return true;
  if (/^127\./.test(h)) return true; // IPv4 loopback
  if (/^10\./.test(h)) return true; // RFC1918
  if (/^192\.168\./.test(h)) return true; // RFC1918
  if (/^169\.254\./.test(h)) return true; // link-local incl. cloud metadata
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true; // RFC1918 172.16-31
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(h)) return true; // IPv6 unique-local
  if (/^fe80:/i.test(h)) return true; // IPv6 link-local
  return false;
}

function emailDomain(email: string) {
  return email.trim().toLowerCase().split("@").pop() ?? "";
}

/**
 * Synthetic / non-routable addresses that must never be handed to the email provider.
 *
 * The Supabase-auth identity address `phx-<hex(loginId)>@auth.phoenix.local`
 * (see src/lib/auth/supabase-identity.ts) is an internal LOGIN KEY, not a mailbox. Every
 * `app_auth_users.auth_email` is one of these. Sending to it produces a hard bounce at the
 * provider, which then suppresses the (fake) address and damages sending-domain reputation.
 * Also rejects the reserved `.local` mDNS TLD and anything that is not a real `user@domain.tld`.
 */
export function isNonDeliverableEmail(value: string | null | undefined): boolean {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return true;
  const domain = emailDomain(email);
  if (!domain || !domain.includes(".")) return true;
  if (domain === "phoenix.local" || domain.endsWith(".phoenix.local")) return true;
  if (domain === "local" || domain.endsWith(".local")) return true;
  return false;
}

/**
 * Return the first genuinely deliverable address from the candidates (real mailbox), else null.
 * Used by notification recipient resolution so a missing real email degrades to in-app only
 * instead of silently addressing mail to the synthetic auth identity address.
 */
export function pickDeliverableEmail(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const trimmed = String(candidate ?? "").trim();
    if (trimmed && !isNonDeliverableEmail(trimmed)) return trimmed;
  }
  return null;
}

function isAllowedDomain(email: string, allowedDomains: string[]) {
  const domain = emailDomain(email);
  return allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

export function validateManualEmailRecipientPolicy(input: {
  bcc?: string[];
  cc?: string[];
  externalJustification?: string | null;
  to?: string[];
}): RecipientPolicyResult {
  const recipients = [...(input.to ?? []), ...(input.cc ?? []), ...(input.bcc ?? [])]
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const totalRecipients = recipients.length;
  const maxRecipients = configuredMaxRecipients();
  const allowedDomains = configuredAllowedDomains();
  const externalRecipients = Array.from(new Set(recipients.filter((email) => !isAllowedDomain(email, allowedDomains))));
  const issues: RecipientPolicyIssue[] = [];

  if (totalRecipients > maxRecipients) {
    issues.push({
      code: "too_many_recipients",
      limit: maxRecipients,
      message: `Manual HR emails are limited to ${maxRecipients} total recipients.`,
    });
  }

  if (externalRecipients.length > 0 && String(input.externalJustification ?? "").trim().length < 10) {
    issues.push({
      code: "external_justification_required",
      externalRecipients,
      message: "External recipients require a business justification of at least 10 characters.",
    });
  }

  return { allowedDomains, externalRecipients, issues, maxRecipients, totalRecipients };
}

export function buildManualComposerIdempotencyKey(input: {
  bcc: string[];
  cc: string[];
  clientRequestId?: string | null;
  recipientName: string;
  replyMessage: string;
  senderName: string;
  subject: string;
  to: string[];
  tone: string;
}) {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({
      bcc: input.bcc.map((email) => email.trim().toLowerCase()).sort(),
      cc: input.cc.map((email) => email.trim().toLowerCase()).sort(),
      clientRequestId: String(input.clientRequestId ?? "").trim(),
      recipientName: input.recipientName.trim(),
      replyMessage: input.replyMessage.trim(),
      senderName: input.senderName.trim(),
      subject: input.subject.trim(),
      to: input.to.map((email) => email.trim().toLowerCase()).sort(),
      tone: input.tone.trim().toLowerCase(),
    }))
    .digest("hex");

  return `phoenix-hr-${hash}`;
}

export async function assertReachableEmailImage(url: string, input?: {
  blockLocalAssets?: boolean;
  cacheTtlMs?: number;
}) {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Email signature image URL is invalid.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Email signature image URL must be HTTPS so email clients can load it.");
  }

  if (input?.blockLocalAssets && (isBlockedImageHost(parsed.hostname) || /\/assets\//i.test(parsed.pathname))) {
    throw new Error("Email signature image must not use a local/internal host or a relative /assets URL.");
  }

  const now = Date.now();
  const cacheTtlMs = input?.cacheTtlMs ?? defaultSignatureCacheTtlMs;
  const cached = signatureImageChecks.get(url);
  if (cached && now - cached.checkedAt < cacheTtlMs) {
    return { cached: true, contentType: cached.contentType, verified: true as const };
  }

  const verify = async (method: "GET" | "HEAD") =>
    fetch(url, {
      cache: "no-store",
      headers: method === "GET" ? { Range: "bytes=0-0" } : undefined,
      method,
      signal: AbortSignal.timeout(8000),
    });

  let response = await verify("HEAD").catch(() => null);

  if (!response?.ok || !String(response.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) {
    response = await verify("GET").catch(() => null);
  }

  const contentType = response?.headers.get("content-type") ?? "";
  if (response?.ok && contentType.toLowerCase().startsWith("image/")) {
    signatureImageChecks.set(url, { checkedAt: now, contentType });
    return { cached: false, contentType, verified: true as const };
  }

  if (cached) {
    return {
      cached: true,
      contentType: cached.contentType,
      verified: true as const,
      warning: `Email signature image recheck failed after a previous success. Status: ${response?.status ?? "network_error"}.`,
    };
  }

  throw new Error(`Email signature image is not reachable as an image. Status: ${response?.status ?? "network_error"}.`);
}
