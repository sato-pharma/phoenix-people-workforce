/**
 * Sato composer — reading the document the sender uploaded.
 *
 * The server half of `source-document.ts`: this is where pdf-parse, mammoth and word-extractor are
 * allowed to live. It reads the words out of a file and answers with them; it decides nothing about
 * the email, writes nothing, stores nothing, and the bytes never leave the request.
 *
 * Written here rather than reusing `extractRawTextFromFile` from the recruitment module, which does
 * the same two library calls: that file also top-level-imports the OpenAI client and the Supabase
 * admin client, and its errors are worded for a CV inbox ("This CV file type isn't supported"). The
 * pure decisions the two paths genuinely share — file kind, the text-layer threshold, the readable
 * character count — ARE shared, from `source-document.ts` and `cv-text-layer.ts`.
 */

import * as mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import WordExtractor from "word-extractor";

import { isLegacyDocBytes } from "@/lib/recruitment/cv-file-kind";
import {
  capSourceText,
  chooseSourceRoute,
  detectSatoSourceKind,
  htmlToSourceText,
  SATO_EMAIL_DOCUMENT_MAX_BYTES,
  type SatoAssistSource,
  type SatoSourceKind,
  tidySourceText,
} from "@/lib/sato-email/source-document";

export class SatoSourceDocumentError extends Error {
  code: "document_empty" | "document_too_large" | "document_unreadable" | "document_unsupported";

  constructor(code: SatoSourceDocumentError["code"], message: string) {
    super(message);
    this.name = "SatoSourceDocumentError";
    this.code = code;
  }
}

export type SatoSourceRead = {
  characters: number;
  kind: SatoSourceKind;
  source: SatoAssistSource;
  truncated: boolean;
};

async function pdfText(bytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: bytes });
  try {
    // parseHyperlinks for the same reason the CV path turns it on: a policy's own links live in the
    // PDF's annotations, not in its text layer, and an address the sender's document carries is an
    // address the assistant is allowed to keep. Without this they are dropped, and a draft that
    // reproduced one would be refused as a minted link.
    const result = await parser.getText({ parseHyperlinks: true });
    return result.text ?? "";
  } finally {
    await parser.destroy();
  }
}

async function wordText(bytes: Buffer): Promise<string> {
  // The bytes decide, never the label — a Word 97-2003 binary handed to mammoth dies with an
  // unreadable unzip error, and this corpus has files labelled both ways round.
  if (isLegacyDocBytes(bytes)) {
    const document = await new WordExtractor().extract(bytes);
    return document.getBody() ?? "";
  }
  const result = await mammoth.extractRawText({ buffer: bytes });
  return result.value ?? "";
}

/**
 * Reads one uploaded file and hands back what the assistant will work from.
 *
 * A PDF with no text layer is not an error: it becomes the picture route, where the file itself
 * goes to the model. The only genuine refusals are a file type that cannot be read at all, a file
 * bigger than the ceiling, and a file that is empty or holds nothing but whitespace.
 */
export async function readSatoSourceDocument(input: {
  bytes: Buffer;
  contentType: string;
  fileName: string;
}): Promise<SatoSourceRead> {
  const { bytes, contentType, fileName } = input;
  if (bytes.length === 0) {
    throw new SatoSourceDocumentError("document_empty", "That file is empty.");
  }
  if (bytes.length > SATO_EMAIL_DOCUMENT_MAX_BYTES) {
    throw new SatoSourceDocumentError(
      "document_too_large",
      `That file is larger than ${Math.round(SATO_EMAIL_DOCUMENT_MAX_BYTES / (1024 * 1024))} MB.`,
    );
  }

  const kind = detectSatoSourceKind(contentType, fileName);
  if (kind === "unsupported") {
    throw new SatoSourceDocumentError(
      "document_unsupported",
      "That file cannot be read. Upload a PDF, a Word file, a web page, a text or CSV file, or a picture of the document.",
    );
  }

  let extracted = "";
  if (kind === "pdf" || kind === "word" || kind === "html" || kind === "text") {
    try {
      extracted =
        kind === "pdf"
          ? await pdfText(bytes)
          : kind === "word"
            ? await wordText(bytes)
            : kind === "html"
              ? htmlToSourceText(bytes.toString("utf8"))
              : bytes.toString("utf8");
    } catch {
      // A PDF that will not parse still has a page to look at, so it falls through to the picture
      // route rather than being refused. A Word or text file that will not open has nothing left.
      if (kind !== "pdf") {
        throw new SatoSourceDocumentError(
          "document_unreadable",
          "That file could not be opened. Save it again, or upload it as a PDF.",
        );
      }
    }
  }

  const { text, truncated } = capSourceText(tidySourceText(extracted));
  const route = chooseSourceRoute({ kind, text });

  if (route === "text" && !text) {
    throw new SatoSourceDocumentError("document_unreadable", "There are no words in that file.");
  }

  return {
    characters: route === "text" ? text.length : 0,
    kind,
    source: {
      fileName: fileName.trim() || "document",
      route,
      text: route === "text" ? text : "",
      ...(route === "picture"
        ? {
            file: {
              // The model picks its reader from the type, so a picture that arrived with no label
              // at all is handed over as the PDF or the JPEG the extension says it is.
              contentType: contentType?.trim() || (kind === "pdf" ? "application/pdf" : "image/jpeg"),
              data: bytes.toString("base64"),
            },
          }
        : {}),
    },
    truncated: route === "text" && truncated,
  };
}
