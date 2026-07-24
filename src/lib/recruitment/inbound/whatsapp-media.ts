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

/** Step 1: resolve a media id to its short-lived (~5 min) download URL + MIME type. */
async function fetchWhatsAppMediaUrl(mediaId: string): Promise<{ url: string; mimeType: string }> {
  const response = await fetch(`https://graph.facebook.com/${graphApiVersion()}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken()}` },
  });
  if (!response.ok) {
    throw new Error(`WhatsApp media lookup failed (${response.status}) for media id ${mediaId}.`);
  }
  const body = (await response.json()) as WhatsAppMediaUrlResponse;
  if (!body.url) throw new Error(`WhatsApp media lookup returned no URL for media id ${mediaId}.`);
  return { mimeType: body.mime_type || "application/octet-stream", url: body.url };
}

/** Step 2: download the actual bytes from the short-lived URL (also bearer-authenticated). */
async function downloadWhatsAppMediaBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken()}` } });
  if (!response.ok) {
    throw new Error(`WhatsApp media download failed (${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function downloadWhatsAppMedia(mediaId: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const { url, mimeType } = await fetchWhatsAppMediaUrl(mediaId);
  const bytes = await downloadWhatsAppMediaBytes(url);
  return { bytes, mimeType };
}
