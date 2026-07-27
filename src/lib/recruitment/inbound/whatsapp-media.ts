// Recruitment / ATS — WhatsApp Cloud API media download (2-step Graph API, plain fetch, no SDK
// — matches this repo's existing style for external HTTP APIs elsewhere in the codebase).

const DEFAULT_GRAPH_API_VERSION = "v23.0";

function graphApiVersion(): string {
  return process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_API_VERSION;
}

function accessToken(): string {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN is not configured.");
  return token;
}

type WhatsAppMediaUrlResponse = { url?: string; mime_type?: string; file_size?: number };

// Thrown when Meta reports (or the actual bytes reveal) a media file over the accepted CV size. A
// distinct type so the worker can treat it as TERMINAL (this file will never be a valid CV) rather
// than a retryable download failure.
export class WhatsAppMediaTooLargeError extends Error {
  constructor(
    readonly sizeBytes: number,
    readonly maxBytes: number,
  ) {
    super(`WhatsApp media is ${sizeBytes} bytes, over the ${maxBytes}-byte limit.`);
    this.name = "WhatsAppMediaTooLargeError";
  }
}

/** Step 1: resolve a media id to its short-lived (~5 min) download URL + MIME type + size. */
async function fetchWhatsAppMediaUrl(mediaId: string): Promise<{ url: string; mimeType: string; fileSize: number | null }> {
  const response = await fetch(`https://graph.facebook.com/${graphApiVersion()}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken()}` },
  });
  if (!response.ok) {
    throw new Error(`WhatsApp media lookup failed (${response.status}) for media id ${mediaId}.`);
  }
  const body = (await response.json()) as WhatsAppMediaUrlResponse;
  if (!body.url) throw new Error(`WhatsApp media lookup returned no URL for media id ${mediaId}.`);
  const fileSize = Number(body.file_size);
  return {
    fileSize: Number.isFinite(fileSize) && fileSize > 0 ? fileSize : null,
    mimeType: body.mime_type || "application/octet-stream",
    url: body.url,
  };
}

/** Step 2: download the actual bytes from the short-lived URL (also bearer-authenticated). */
async function downloadWhatsAppMediaBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken()}` } });
  if (!response.ok) {
    throw new Error(`WhatsApp media download failed (${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * `opts.maxBytes` (when given) rejects an oversized file BEFORE downloading it, using Meta's
 * reported file_size — so a huge/abusive attachment never gets pulled into the worker's memory.
 * The post-download check is a backstop for when Meta omits file_size.
 */
export async function downloadWhatsAppMedia(
  mediaId: string,
  opts?: { maxBytes?: number },
): Promise<{ bytes: Buffer; mimeType: string }> {
  const { url, mimeType, fileSize } = await fetchWhatsAppMediaUrl(mediaId);
  if (opts?.maxBytes && fileSize !== null && fileSize > opts.maxBytes) {
    throw new WhatsAppMediaTooLargeError(fileSize, opts.maxBytes);
  }
  const bytes = await downloadWhatsAppMediaBytes(url);
  if (opts?.maxBytes && bytes.length > opts.maxBytes) {
    throw new WhatsAppMediaTooLargeError(bytes.length, opts.maxBytes);
  }
  return { bytes, mimeType };
}
