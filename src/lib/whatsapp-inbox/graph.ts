// The WhatsApp Inbox — the Graph API calls the inbox needs that the recruitment pipeline did not:
// uploading a file to Meta before sending it, and reading a line's approved templates.
//
// Sending itself is NOT here. Every send goes through `sendWhatsAppPayload` in
// recruitment/inbound/whatsapp-interactive.ts, which is what records it.

const DEFAULT_GRAPH_API_VERSION = "v23.0";
const GRAPH_TIMEOUT_MS = 20_000;

function graphApiVersion(): string {
  return process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_API_VERSION;
}

function accessToken(): string {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  if (!token) throw new Error("WhatsApp is not connected: the access token is not configured.");
  return token;
}

// ── Media ────────────────────────────────────────────────────────────────────────────────────────

export type InboxOutboundMediaType = "image" | "video" | "audio" | "document";

/**
 * Meta's own ceilings per kind of attachment. A file over its ceiling is refused by Meta with a
 * generic error, so it is refused here first with a sentence that says why.
 */
export const WHATSAPP_MEDIA_LIMIT_BYTES: Record<InboxOutboundMediaType, number> = {
  audio: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
};

/** The most the inbox will accept from a browser in one request, whatever the kind. */
export const INBOX_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/3gpp"]);
const AUDIO_TYPES = new Set(["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"]);

/**
 * How a file will be sent. A photo WhatsApp can show inline goes as a photo; anything else — a PDF, a
 * spreadsheet, a HEIC or WebP picture Meta will not render inline — goes as a file, which always works.
 */
export function outboundMediaTypeFor(mimeType: string): InboxOutboundMediaType {
  const type = mimeType.toLowerCase().split(";")[0]!.trim();
  if (IMAGE_TYPES.has(type)) return "image";
  if (VIDEO_TYPES.has(type)) return "video";
  if (AUDIO_TYPES.has(type)) return "audio";
  return "document";
}

export function mediaLimitProblem(mediaType: InboxOutboundMediaType, byteSize: number): string | null {
  const limit = WHATSAPP_MEDIA_LIMIT_BYTES[mediaType];
  if (byteSize <= 0) return "The file is empty.";
  if (byteSize > INBOX_UPLOAD_MAX_BYTES) return "Files over 25 MB cannot be sent from the inbox.";
  if (byteSize > limit) {
    const words = { audio: "An audio file", document: "A file", image: "A photo", video: "A video" }[mediaType];
    return `${words} can be at most ${Math.round(limit / (1024 * 1024))} MB on WhatsApp.`;
  }
  return null;
}

/** Uploads bytes to Meta for one line and returns the media id to send. Throws with a readable message. */
export async function uploadWhatsAppMedia(input: {
  phoneNumberId: string;
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", input.mimeType);
  form.append("file", new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.fileName);

  const response = await fetch(`https://graph.facebook.com/${graphApiVersion()}/${input.phoneNumberId}/media`, {
    body: form,
    headers: { Authorization: `Bearer ${accessToken()}` },
    method: "POST",
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null;
  if (!response.ok || !body?.id) {
    throw new Error(`WhatsApp did not accept the file: ${body?.error?.message ?? `status ${response.status}`}`);
  }
  return body.id;
}

// ── Templates ────────────────────────────────────────────────────────────────────────────────────

export type TemplateField = {
  /**
   * The form key: `header:1`, `body:1`, `body:first_name`. Scoped by part because a positional title
   * and a positional message BOTH number their blanks from 1 — one shared key would put the title's
   * value into the message's first blank too.
   */
  key: string;
  /** The placeholder as Meta holds it: `1`, `2` … or the variable's own name. */
  name: string;
  label: string;
  example: string | null;
};

export type InboxTemplate = {
  name: string;
  language: string;
  category: string | null;
  /** The body as Meta holds it, placeholders intact. */
  bodyText: string;
  headerText: string | null;
  footerText: string | null;
  bodyFields: TemplateField[];
  headerFields: TemplateField[];
  parameterFormat: "positional" | "named";
  /** Set when the template needs something the inbox cannot supply yet; the template is then shown but not sendable. */
  unsupportedReason: string | null;
};

type RawComponent = {
  type?: string;
  format?: string;
  text?: string;
  example?: { body_text?: string[][]; header_text?: string[]; body_text_named_params?: Array<{ param_name?: string; example?: string }>; header_text_named_params?: Array<{ param_name?: string; example?: string }> };
  buttons?: Array<{ type?: string; url?: string; text?: string }>;
};

type RawTemplate = {
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  parameter_format?: string;
  components?: RawComponent[];
};

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
// Non-global twin for yes/no checks: `test` on a /g regex carries lastIndex between calls.
const HAS_PLACEHOLDER = /\{\{\s*[A-Za-z0-9_]+\s*\}\}/;

function placeholderKeys(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (!keys.includes(match[1]!)) keys.push(match[1]!);
  }
  return keys;
}

type TemplatePart = "header" | "body";

function fieldsFor(text: string | null, examples: Map<string, string>, part: TemplatePart): TemplateField[] {
  if (!text) return [];
  const prefix = part === "header" ? "Title" : "Message";
  return placeholderKeys(text).map((name) => ({
    example: examples.get(name) ?? null,
    key: `${part}:${name}`,
    label: /^\d+$/.test(name) ? `${prefix} blank ${name}` : `${prefix}: ${name.replace(/_/g, " ")}`,
    name,
  }));
}

/** Meta's raw template -> what the inbox shows and can send. Pure; exported for the test. */
export function mapInboxTemplate(raw: RawTemplate): InboxTemplate | null {
  const name = raw.name?.trim();
  const language = raw.language?.trim();
  if (!name || !language) return null;
  const components = raw.components ?? [];
  const body = components.find((c) => c.type?.toUpperCase() === "BODY");
  const header = components.find((c) => c.type?.toUpperCase() === "HEADER");
  const footer = components.find((c) => c.type?.toUpperCase() === "FOOTER");
  const buttons = components.find((c) => c.type?.toUpperCase() === "BUTTONS");

  const bodyExamples = new Map<string, string>();
  (body?.example?.body_text?.[0] ?? []).forEach((value, index) => bodyExamples.set(String(index + 1), value));
  for (const named of body?.example?.body_text_named_params ?? []) {
    if (named.param_name && named.example) bodyExamples.set(named.param_name, named.example);
  }
  const headerExamples = new Map<string, string>();
  (header?.example?.header_text ?? []).forEach((value, index) => headerExamples.set(String(index + 1), value));
  for (const named of header?.example?.header_text_named_params ?? []) {
    if (named.param_name && named.example) headerExamples.set(named.param_name, named.example);
  }

  const headerFormat = header?.format?.toUpperCase() ?? null;
  const headerText = headerFormat === "TEXT" ? (header?.text ?? null) : null;
  let unsupportedReason: string | null = null;
  if (headerFormat && headerFormat !== "TEXT") {
    unsupportedReason = "This template starts with a photo, video or file, which the inbox cannot attach yet.";
  } else if ((buttons?.buttons ?? []).some((button) => button.type?.toUpperCase() === "URL" && HAS_PLACEHOLDER.test(button.url ?? ""))) {
    unsupportedReason = "This template has a link button that needs its own value, which the inbox cannot fill yet.";
  } else if ((buttons?.buttons ?? []).some((button) => ["COPY_CODE", "OTP", "FLOW", "CATALOG", "MPM"].includes(button.type?.toUpperCase() ?? ""))) {
    unsupportedReason = "This template has a special button the inbox cannot fill yet.";
  }

  return {
    bodyFields: fieldsFor(body?.text ?? null, bodyExamples, "body"),
    bodyText: body?.text ?? "",
    category: raw.category ?? null,
    footerText: footer?.text ?? null,
    headerFields: fieldsFor(headerText, headerExamples, "header"),
    headerText,
    language,
    name,
    parameterFormat: raw.parameter_format?.toUpperCase() === "NAMED" ? "named" : "positional",
    unsupportedReason,
  };
}

/** One part's text with every blank filled from that part's own keys, as the person will read it. */
export function fillTemplateText(text: string, values: Record<string, string>, part: TemplatePart): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => values[`${part}:${name}`]?.trim() || whole);
}

export function renderInboxTemplate(template: InboxTemplate, values: Record<string, string>): string {
  return [
    template.headerText ? fillTemplateText(template.headerText, values, "header") : null,
    fillTemplateText(template.bodyText, values, "body"),
    template.footerText,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n\n");
}

/** Blanks left empty, by label. An empty blank is refused by Meta, so it is refused here first. */
export function missingTemplateFields(template: InboxTemplate, values: Record<string, string>): string[] {
  return [...template.headerFields, ...template.bodyFields]
    .filter((field) => !values[field.key]?.trim())
    .map((field) => field.label);
}

/** The `template` object for the Cloud API send. */
export function buildTemplateMessage(template: InboxTemplate, values: Record<string, string>): Record<string, unknown> & { type: "template" } {
  const parameter = (field: TemplateField) => ({
    ...(template.parameterFormat === "named" ? { parameter_name: field.name } : {}),
    text: values[field.key]!.trim(),
    type: "text",
  });
  const components: Array<Record<string, unknown>> = [];
  if (template.headerFields.length > 0) components.push({ parameters: template.headerFields.map(parameter), type: "header" });
  if (template.bodyFields.length > 0) components.push({ parameters: template.bodyFields.map(parameter), type: "body" });
  return {
    template: {
      language: { code: template.language },
      name: template.name,
      ...(components.length > 0 ? { components } : {}),
    },
    type: "template",
  };
}

/** A line's APPROVED templates, straight from Meta. Throws with a readable message. */
export async function listApprovedTemplates(businessAccountId: string): Promise<InboxTemplate[]> {
  const templates: InboxTemplate[] = [];
  let url: string | null =
    `https://graph.facebook.com/${graphApiVersion()}/${businessAccountId}/message_templates` +
    "?fields=name,language,status,category,parameter_format,components&limit=100";
  let pages = 0;
  while (url && pages < 5) {
    pages += 1;
    const response: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken()}` },
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as
      | { data?: RawTemplate[]; paging?: { next?: string }; error?: { message?: string } }
      | null;
    if (!response.ok) {
      throw new Error(`WhatsApp did not return the templates: ${body?.error?.message ?? `status ${response.status}`}`);
    }
    for (const raw of body?.data ?? []) {
      if (raw.status?.toUpperCase() !== "APPROVED") continue;
      const mapped = mapInboxTemplate(raw);
      if (mapped) templates.push(mapped);
    }
    url = body?.paging?.next ?? null;
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}

/**
 * Where ONE template stands with Meta, whatever its status — the approved-only list above cannot say
 * "waiting for approval" or "rejected". Added 2026-10-20 for the recruitment "Ask again" follow-up, so
 * the button can say why it is not sendable yet instead of failing on send.
 * `missing` = no template of that name and language on this business account. Throws on a failed read.
 */
export type TemplateApprovalStatus = "approved" | "pending" | "rejected" | "missing";

export async function readTemplateStatus(
  businessAccountId: string,
  name: string,
  language: string,
): Promise<TemplateApprovalStatus> {
  const url =
    `https://graph.facebook.com/${graphApiVersion()}/${businessAccountId}/message_templates` +
    `?fields=name,language,status&name=${encodeURIComponent(name)}&limit=100`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken()}` },
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => null)) as
    | { data?: Array<{ name?: string; language?: string; status?: string }>; error?: { message?: string } }
    | null;
  if (!response.ok) {
    throw new Error(`WhatsApp did not return the template: ${body?.error?.message ?? `status ${response.status}`}`);
  }
  const match = (body?.data ?? []).find((row) => row.name === name && row.language === language);
  if (!match) return "missing";
  const status = String(match.status ?? "").toUpperCase();
  if (status === "APPROVED") return "approved";
  if (status === "REJECTED" || status === "DISABLED" || status === "PAUSED") return "rejected";
  return "pending";
}
