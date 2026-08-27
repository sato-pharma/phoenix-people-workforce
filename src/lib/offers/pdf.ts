import { existsSync } from "node:fs";

import { renderOfferDocument } from "@/lib/offers/render";
import { satoLogoDataUri, satoSignatureDataUri } from "@/lib/offers/brand";
import type { OfferBlock, OfferFields, OfferTemplateVariant, OfferTheme } from "@/lib/offers/types";

/**
 * The offer letter as a real PDF, rendered by headless Chromium.
 *
 * ── Why server-side, when the hiring pack deliberately is not ──
 * `src/lib/hiring-pack/render-shared.ts` makes the opposite choice on purpose: the employment
 * contract and Form 1 are printed by a person at a print dialog, because only a person can set
 * duplex and paper size. An offer has no person at a print dialog — it is emailed, so the PDF has
 * to exist before anyone sees it. Different constraint, different answer.
 *
 * ── Why puppeteer-core and not pdf-lib/pdfmake (both already dependencies) ──
 * The design is CSS: grid, flexbox, tabular numerals, hairline rules, `break-inside: avoid`.
 * A PDF drawing library would mean re-implementing that layout by hand in coordinates, and it
 * would drift from the HTML preview the moment either changed. Chromium renders the same document
 * the preview shows, so what the candidate receives is what HR approved on screen.
 *
 * ── The runtime contract, already provisioned in the Dockerfile ──
 * Chromium is the SYSTEM package (`apk add chromium`), not Puppeteer's bundled download, which is
 * a glibc binary that cannot run on Alpine/musl. `PUPPETEER_EXECUTABLE_PATH` points at it and
 * `PUPPETEER_SKIP_DOWNLOAD` stops a browser download at install time. puppeteer-core is installed
 * into the runtime node_modules by hand because Next's standalone file-tracing does not follow a
 * dynamic import — which is exactly why the import below is dynamic and marked
 * `webpackIgnore`/`turbopackIgnore`: it must never be traced into a bundle, and never reach a
 * client one.
 *
 * All of that infrastructure has been in the Dockerfile since before this module existed, with
 * the comment "for server-side PDF generation of offer letters", and nothing used it.
 */

export type OfferPdfTemplate = {
  blocks: OfferBlock[];
  fontFamily?: string;
  fontSizePt?: number;
  theme?: OfferTheme;
  variant?: OfferTemplateVariant;
};

export class OfferPdfUnavailableError extends Error {
  // NOT a TypeScript parameter property (`constructor(..., readonly cause)`). The test runner
  // executes TypeScript through Node's strip-only mode, which cannot compile one — it throws
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at import time, so every test that touched this module
  // would fail before running a single assertion.
  readonly reason: unknown;

  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = "OfferPdfUnavailableError";
    this.reason = reason;
  }
}

/**
 * Where Chromium actually is — checked on disk, not assumed.
 *
 * The Dockerfile sets `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser`, which was the binary
 * name Alpine used up to 3.18; since then `apk add chromium` installs `/usr/bin/chromium` and
 * ships `chromium-browser` only as a compatibility symlink that is not guaranteed to be there.
 * A wrong path does not fail loudly: `launch()` throws, the send degrades to a body-only email,
 * and offers go out with the attachment quietly missing. So the configured path is honoured only
 * when it exists, and the known Alpine/Debian locations are tried after it.
 *
 * Returning `undefined` is the local-dev case (Windows/macOS) — puppeteer-core then falls back to
 * its own channel discovery.
 */
export function resolveChromiumPath(
  exists: (path: string) => boolean = fileExists,
  // A plain string rather than an env object. `NodeJS.ProcessEnv` cannot be handed an object
  // literal from a test, and a structural stand-in for it hits TypeScript's weak-type rule from
  // the other direction — and neither type is honest anyway: this function reads exactly one
  // variable, so that variable is the parameter.
  configuredPath: string = process.env.PUPPETEER_EXECUTABLE_PATH ?? "",
): string | undefined {
  const configured = configuredPath.trim();
  const candidates = [
    configured,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
  ].filter((candidate) => candidate !== "");

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  // Nothing on disk. Hand back the configured path anyway so the launch error names the path that
  // was actually expected, rather than a bare "Could not find browser".
  return configured === "" ? undefined : configured;
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * True when this process can produce a PDF at all.
 *
 * Callers use it to degrade rather than fail: an offer can still be sent as an email body with no
 * attachment, and HR is told the attachment is missing. Silently sending an offer that promises
 * "the signature page is in the attached PDF" with nothing attached is the worse outcome.
 */
export async function isOfferPdfAvailable(): Promise<boolean> {
  try {
    await loadPuppeteer();
    return true;
  } catch {
    return false;
  }
}

type PuppeteerModule = {
  launch: (options: Record<string, unknown>) => Promise<{
    close: () => Promise<void>;
    newPage: () => Promise<{
      emulateMediaType: (type: string) => Promise<void>;
      pdf: (options: Record<string, unknown>) => Promise<Uint8Array>;
      setContent: (html: string, options: Record<string, unknown>) => Promise<void>;
    }>;
  }>;
};

let cached: PuppeteerModule | null = null;

async function loadPuppeteer(): Promise<PuppeteerModule> {
  if (cached) return cached;
  try {
    // The ignore comments are load-bearing: without them the bundler traces puppeteer-core into
    // the build, which is both enormous and wrong — the Dockerfile installs it separately at
    // runtime precisely because it must not be bundled.
    const mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "puppeteer-core")) as
      | PuppeteerModule
      | { default: PuppeteerModule };
    cached = "launch" in mod ? mod : mod.default;
    return cached;
  } catch (error) {
    throw new OfferPdfUnavailableError(
      "puppeteer-core is not installed in this runtime, so the offer PDF cannot be rendered.",
      error,
    );
  }
}

/**
 * Render the offer to PDF bytes.
 *
 * A4 with `printBackground` on — the design is almost entirely background fills (the blue rail,
 * the tinted compensation panel, the black clause numerals). Without it the letter prints as
 * unstyled text and every visual hierarchy in it disappears.
 */
export async function renderOfferPdf(
  template: OfferPdfTemplate,
  fields: OfferFields,
  options: { logoUrl?: string; signatureUrl?: string; timeoutMs?: number } = {},
): Promise<Uint8Array> {
  const puppeteer = await loadPuppeteer();
  // `setContent` gives the page no origin, so a relative `/brand/...` would resolve to nothing.
  // Both images are read off disk instead — see `brand.ts` for why, and for why the signature is
  // the one image with no public URL at all.
  const { html, pageFooterHtml, pageHeaderHtml, pageSize } = renderOfferDocument(template, fields, {
    logoUrl: options.logoUrl ?? satoLogoDataUri() ?? undefined,
    signatureUrl: options.signatureUrl ?? satoSignatureDataUri() ?? undefined,
  });
  const timeout = options.timeoutMs ?? 30_000;

  let browser: Awaited<ReturnType<PuppeteerModule["launch"]>> | null = null;
  try {
    browser = await puppeteer.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        // The container has a small /dev/shm; without this Chromium crashes on larger documents.
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
      executablePath: resolveChromiumPath(),
      headless: true,
    });

    const page = await browser.newPage();
    // `domcontentloaded`, not `networkidle0`: the document embeds its own stylesheet and the only
    // possible network request is the logo. Waiting for network idle would add seconds to every
    // offer, and would hang the send outright if the logo host were slow.
    await page.setContent(html, { timeout, waitUntil: "domcontentloaded" });
    // Chromium applies `@media screen` by default even when producing a PDF.
    await page.emulateMediaType("print");

    return await page.pdf({
      // Only the designs that ask for a running foot get one. `headerTemplate` still has to be a
      // non-empty element: given "" Chromium falls back to its own default header, which prints
      // the page title and the date across the top of a legal document.
      displayHeaderFooter: pageFooterHtml !== "" || pageHeaderHtml !== "",
      footerTemplate: pageFooterHtml || "<span></span>",
      format: pageSize,
      headerTemplate: pageHeaderHtml || "<span></span>",
      // The margins live in the document's own `@page` rule, next to the design they belong to;
      // `preferCSSPageSize` is what makes that rule win over the format above.
      margin: { bottom: "14mm", left: "13mm", right: "13mm", top: "12mm" },
      preferCSSPageSize: true,
      printBackground: true,
      timeout,
    });
  } catch (error) {
    if (error instanceof OfferPdfUnavailableError) throw error;
    throw new OfferPdfUnavailableError("Chromium failed to render the offer PDF.", error);
  } finally {
    // Never leak a browser process. One leaked Chromium per offer would exhaust the container's
    // memory within a day of normal HR use.
    if (browser) await browser.close().catch(() => undefined);
  }
}

/** `Offer_of_Employment_SAMAA_SHALABY.pdf` — safe on every filesystem and mail client. */
export function offerPdfFilename(fields: Pick<OfferFields, "candidateName" | "reference">): string {
  const who = (fields.candidateName || "Candidate")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 60);
  const ref = (fields.reference || "").replace(/[^\w-]/g, "").slice(0, 30);
  return `Offer_of_Employment_${who}${ref ? `_${ref}` : ""}.pdf`;
}
