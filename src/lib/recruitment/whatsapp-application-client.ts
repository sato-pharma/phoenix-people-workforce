// Recruitment / ATS — fetching one WhatsApp application in the browser, for the two things that need its
// bytes: the print page, which draws them, and the list's Download button, which saves them.
//
// BROWSER CODE, and it imports nothing server-side. The bytes arrive as base64 TEXT rather than a PDF
// because a response that looks like a downloadable document is what a download-manager extension
// cancels (src/lib/recruitment/file-response.ts has the account). Decoding them here gives a byte-for-byte
// copy of the file the route built, so printing and saving are the same document.

import {
  APPLICATION_CV_PAGES_HEADER,
  APPLICATION_FILE_NAME_HEADER,
  APPLICATION_SHEET_PAGES_HEADER,
  applicationFileName,
  candidateApplicationFileName,
  candidateApplicationTextPath,
  whatsAppApplicationTextPath,
} from "@/lib/recruitment/whatsapp-application-file";

export type FetchedApplication = {
  bytes: Uint8Array<ArrayBuffer>;
  fileName: string;
  /** CV pages at the front. Zero when the CV could not be included. Null when the server did not say. */
  cvPages: number | null;
  sheetPages: number | null;
};

// The ArrayBuffer is allocated explicitly rather than by length: `new Uint8Array(n)` is typed
// Uint8Array<ArrayBufferLike>, which BlobPart rejects because it could be a SharedArrayBuffer.
function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function headerNumber(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** The refusal's own sentence when the server sent one, else a plain fallback that names the status. */
async function problemMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message.trim() !== "") return body.message;
  } catch {
    // Not JSON: fall through to the plain sentence.
  }
  if (response.status === 401) return "You are signed out. Sign in again, then press the button once more.";
  if (response.status === 403) return "Your account cannot open WhatsApp applications.";
  if (response.status === 404) return "This application could not be found. It may have been removed.";
  return `The application could not be produced right now (error ${response.status}). Try again in a minute.`;
}

/**
 * Asks the server to build the application and returns its bytes. Throws an Error whose message is a
 * sentence the reader can act on, never a status code alone.
 */
async function fetchApplicationFromPath(textPath: string, fallbackName: string, signal?: AbortSignal): Promise<FetchedApplication> {
  const response = await fetch(textPath, { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(await problemMessage(response));
  const bytes = base64ToBytes(await response.text());
  const named = response.headers.get(APPLICATION_FILE_NAME_HEADER);
  let fileName = "";
  try {
    fileName = named ? decodeURIComponent(named) : "";
  } catch {
    fileName = "";
  }
  return {
    bytes,
    cvPages: headerNumber(response, APPLICATION_CV_PAGES_HEADER),
    fileName: fileName || fallbackName,
    sheetPages: headerNumber(response, APPLICATION_SHEET_PAGES_HEADER),
  };
}

export async function fetchWhatsAppApplication(sessionId: string, signal?: AbortSignal): Promise<FetchedApplication> {
  return fetchApplicationFromPath(whatsAppApplicationTextPath(sessionId), applicationFileName(""), signal);
}

/**
 * The candidate-keyed application, for the screening page's "Download application" on any CV. Same bytes and
 * same headers as the WhatsApp one; only the endpoint and the fallback name differ.
 */
export async function fetchCandidateApplication(candidateId: string, signal?: AbortSignal): Promise<FetchedApplication> {
  return fetchApplicationFromPath(candidateApplicationTextPath(candidateId), candidateApplicationFileName(""), signal);
}

/** Saves bytes as a file through a temporary link, then lets the browser forget the object. */
export function saveBytesAsPdf(bytes: Uint8Array<ArrayBuffer>, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on a later tick: some browsers start the save asynchronously and would lose the object.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
