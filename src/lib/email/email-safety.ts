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
      a: ["href", "rel", "target", "title"],
      span: ["title"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedTags: ["a", "b", "blockquote", "br", "em", "i", "li", "ol", "p", "span", "strong", "u", "ul"],
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

function emailDomain(email: string) {
  return email.trim().toLowerCase().split("@").pop() ?? "";
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

  if (input?.blockLocalAssets && /localhost|127\.0\.0\.1|\/assets\//i.test(url)) {
    throw new Error("Email signature image must not use localhost or a relative /assets URL.");
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
