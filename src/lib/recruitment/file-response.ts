import { NextResponse } from "next/server";

import { isLegacyDocBytes } from "./cv-file-kind";

/**
 * How the bytes of a recruitment file are handed to the browser.
 *
 * A download-manager browser extension (IDM and its relatives) hooks any response that LOOKS
 * like a downloadable document — `Content-Type: application/pdf` together with a `.pdf`
 * filename in `Content-Disposition` — and CANCELS the page's own request so it can fetch the
 * file itself. That is what broke the in-page CV preview in production on 2026-08-14: the
 * modal's `fetch()` rejected with the browser's bare "Failed to fetch" while the very same URL
 * downloaded fine a second later THROUGH the extension, at the correct size. Reported as
 * "when I press on view CV it tells me failed to fetch and the CV is download".
 *
 * No header can ask such an extension to keep its hands off — it matches on exactly the headers
 * a correct file response must send. So the renderer stops asking for something that looks like
 * a file: `?format=base64` returns the same bytes as plain text, with no document content-type,
 * no filename, and no Content-Disposition at all. There is nothing left to recognise. The
 * client decodes the base64 back to byte-identical content.
 *
 * The other two modes are unchanged and still needed:
 *   - `?disposition=inline` — the "Open the CV in a new tab" escape hatch, and <img> sources.
 *   - no parameter — the real Download control, which must produce a save-file prompt.
 *
 * A fourth mode, `?format=doc-text`, serves the ONE format no browser can render: the Word
 * 97-2003 binary .doc. It is a RENDER, not a file — the document's own lines as JSON, read on the
 * server (legacy-doc-text.ts) because the only reader for that format runs in Node. Like the
 * base64 mode it carries no filename, no document content-type and no Content-Disposition, so it
 * hands a download manager nothing and hands a reader no copy.
 */
export type RecruitmentFileBody = {
  bytes: Uint8Array | Buffer;
  fileName: string;
  mimeType: string;
};

/**
 * Async only because of the `doc-text` branch. Every caller already returns this straight out of
 * its own async route handler, so a promise changed nothing at any call site.
 */
export async function recruitmentFileResponse(
  request: Request,
  download: RecruitmentFileBody,
): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;

  if (params.get("format") === "doc-text") {
    const bytes = Buffer.from(download.bytes);
    if (!isLegacyDocBytes(bytes)) {
      // The renderer asks for this mode only after finding the OLE2 signature in bytes it already
      // holds, so arriving here with anything else is a wiring mistake — said plainly rather than
      // answered with an empty document, which would paint on screen as a blank CV.
      return NextResponse.json(
        { error: "not_legacy_doc", message: "This file is not a Word 97-2003 (.doc) document.", success: false },
        { status: 415 },
      );
    }
    const { extractLegacyDocText } = await import("./legacy-doc-text");
    const { paragraphs, truncated } = await extractLegacyDocText(bytes);
    return NextResponse.json(
      { paragraphs, success: true, truncated },
      { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } },
    );
  }

  if (params.get("format") === "base64") {
    return new NextResponse(Buffer.from(download.bytes).toString("base64"), {
      headers: {
        "Cache-Control": "private, no-store",
        // Deliberately NOT the file's own mime type, and deliberately no Content-Disposition:
        // those two headers are precisely what a download manager matches on. nosniff stops the
        // browser re-deriving the real type from the bytes, which would hand the extension its
        // trigger straight back.
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const inline = params.get("disposition") === "inline";
  return new NextResponse(download.bytes as unknown as BodyInit, {
    headers: {
      // A candidate's CV or ID scan, the same as the two answers above: never left in a shared
      // browser's cache or a proxy (cache audit, 2026-10-26).
      "Cache-Control": "private, no-store",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${download.fileName.replace(/"/g, "")}"`,
      "Content-Type": download.mimeType,
    },
  });
}
