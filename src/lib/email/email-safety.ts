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
      // `bgcolor` is the legacy half of the zebra striping: Outlook's Word engine ignores CSS
      // backgrounds on a table cell, so the attribute is what stripes the row there. Dropping it
      // here flattened every {{detailsTable}} that reached an email through a template body.
      tr: ["bgcolor", "style", "dir"],
      td: ["colspan", "rowspan", "bgcolor", "style", "dir"],
      th: ["colspan", "rowspan", "bgcolor", "style", "dir"],
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
        // The WebKit/Blink twin of `color`, and the one that WINS where both are set. Every colour
        // in the layout is written as that pair, but this half used to be stripped here — so a
        // table inside a template body inherited `-webkit-text-fill-color` from `.phoenix-body`
        // and its own `color` did nothing. Measured 2026-10-09 in the Browser pane: white headings
        // on the reorder alarm's dark header band came out INVISIBLE in light mode (inherited
        // #0f172a), and the dark text of every body cell came out invisible in dark mode
        // (inherited #f8fafc). Same value shape as `color`, so it is no wider a hole than that.
        "-webkit-text-fill-color": [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i],
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
      // sanitize-html's discard mode removes disallowed tags AND their entire content.
      // The AI may generate div / heading wrappers even when instructed not to.
      // Transforming them to <p> (which IS in allowedTags) preserves the content while
      // keeping the email HTML email-client-safe. transformTags runs before the
      // allowedTags check, so the converted <p> passes through normally.
      div: (_tagName, attribs) => ({ tagName: "p", attribs }),
      section: (_tagName, attribs) => ({ tagName: "p", attribs }),
      article: (_tagName, attribs) => ({ tagName: "p", attribs }),
      header: (_tagName, attribs) => ({ tagName: "p", attribs }),
      footer: (_tagName, attribs) => ({ tagName: "p", attribs }),
      main: (_tagName, attribs) => ({ tagName: "p", attribs }),
      aside: (_tagName, attribs) => ({ tagName: "p", attribs }),
      nav: (_tagName, attribs) => ({ tagName: "p", attribs }),
      h1: (_tagName, attribs) => ({ tagName: "p", attribs: { ...attribs, style: `font-size:20px;font-weight:bold${attribs.style ? `;${attribs.style}` : ""}` } }),
      h2: (_tagName, attribs) => ({ tagName: "p", attribs: { ...attribs, style: `font-size:18px;font-weight:bold${attribs.style ? `;${attribs.style}` : ""}` } }),
      h3: (_tagName, attribs) => ({ tagName: "p", attribs: { ...attribs, style: `font-size:16px;font-weight:bold${attribs.style ? `;${attribs.style}` : ""}` } }),
      h4: (_tagName, attribs) => ({ tagName: "p", attribs: { ...attribs, style: `font-size:14px;font-weight:bold${attribs.style ? `;${attribs.style}` : ""}` } }),
      h5: (_tagName, attribs) => ({ tagName: "p", attribs: { ...attribs, style: `font-size:13px;font-weight:bold${attribs.style ? `;${attribs.style}` : ""}` } }),
      h6: (_tagName, attribs) => ({ tagName: "p", attribs: { ...attribs, style: `font-size:12px;font-weight:bold${attribs.style ? `;${attribs.style}` : ""}` } }),
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

/**
 * Hosts reserved by RFC 2606 / RFC 6761 for documentation and testing. Nothing real is ever
 * served from one, so fetching it can only ever produce a misleading failure: the test stub of
 * the email layout points the signature at `https://example.com/…`, and every email sent under
 * a stub loader therefore logged `Signature image unreachable … Status: 404` — which reads like
 * the live signature had vanished, on mail that carried no signature image at all.
 *
 * Only the reserved apexes and the reserved TLDs match. A sub-domain such as
 * `assets.example.com` is deliberately NOT matched: that is the fixture the governance test
 * uses to exercise the real fetch-and-cache path.
 */
export function isReservedTestImageHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (h === "example.com" || h === "example.net" || h === "example.org") return true;
  if (h === "example" || h === "invalid" || h === "test") return true;
  return h.endsWith(".example") || h.endsWith(".invalid") || h.endsWith(".test");
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

export type EmailImageReachability = {
  cached: boolean;
  contentType: string;
  /** True when the URL was recognised as a documentation/test stub and never fetched. */
  skipped?: boolean;
  verified: boolean;
  warning?: string;
};

export async function assertReachableEmailImage(url: string, input?: {
  blockLocalAssets?: boolean;
  cacheTtlMs?: number;
  /**
   * Opt-in, for callers whose URL is a build-time constant that a test loader may have stubbed
   * (the Phoenix signature). A user-supplied or request-derived URL must NOT set this — there a
   * reserved host is a mistake worth reporting.
   */
  skipReservedTestHosts?: boolean;
}): Promise<EmailImageReachability> {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Email signature image URL is invalid.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Email signature image URL must be HTTPS so email clients can load it.");
  }

  // SSRF guard, on every caller: never reach a loopback, private or link-local host, and never
  // send credentials embedded in the URL. The relative /assets check stays opt-in.
  if (isBlockedImageHost(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error("Email signature image must not use a local/internal host or a relative /assets URL.");
  }
  if (input?.blockLocalAssets && /\/assets\//i.test(parsed.pathname)) {
    throw new Error("Email signature image must not use a local/internal host or a relative /assets URL.");
  }

  // A stub URL is not a missing image. Say nothing rather than reporting a 404 nobody can act on.
  if (input?.skipReservedTestHosts && isReservedTestImageHost(parsed.hostname)) {
    return { cached: false, contentType: "", skipped: true, verified: false };
  }

  const now = Date.now();
  const cacheTtlMs = input?.cacheTtlMs ?? defaultSignatureCacheTtlMs;
  const cached = signatureImageChecks.get(url);
  if (cached && now - cached.checkedAt < cacheTtlMs) {
    return { cached: true, contentType: cached.contentType, verified: true as const };
  }

  // Redirects are followed by hand, at most three hops, and each hop is held to the same rule
  // (https, public host, no credentials) — a public URL cannot bounce the check onto an internal one.
  const verify = async (method: "GET" | "HEAD") => {
    let target = parsed;
    for (let hop = 0; ; hop += 1) {
      const response = await fetch(target, {
        cache: "no-store",
        headers: method === "GET" ? { Range: "bytes=0-0" } : undefined,
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location || hop >= 3) return response;
      const next = new URL(location, target);
      if (next.protocol !== "https:" || isBlockedImageHost(next.hostname) || next.username || next.password) {
        return response;
      }
      target = next;
    }
  };

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
