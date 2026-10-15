// Recruitment — a job post, drawn. The same HTML the builder previews, rendered by the one headless
// Chromium every Phoenix document uses (`@/lib/pdf/chromium`), never a second engine.
//
// 🔴 EVERY ASSET IS INLINED AS A DATA URI. setContent has no origin, so a `/fonts/...` src resolves
// to nothing and the post silently falls back to Arial (performance-card-render.ts documents the
// same trap). Montserrat is NOT installed in the production image, so the two faces must travel
// inside the page. Read once per process, cached.
//
// 🔴 NOTHING IS PRINTED BEFORE THE LAYOUT PASS HAS RUN. The page exposes window.__jobPostFit; it is
// awaited and a missing report is an error, not a picture with a clipped title.
//
// 🔴 ONE AREA IS ONE REP (owner, 2026-10-15), AND "DOWNLOAD ALL" GIVES BOTH: the all-areas picture
// and one picture per area, each naming only its own area — plus one PDF holding every page.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

import { withChromiumPage, type ChromiumPage } from "@/lib/pdf/chromium";
import {
  JOB_POST_HEIGHT,
  JOB_POST_WIDTH,
  jobPostFileStem,
  jobPostForArea,
  renderJobPostHtml,
  type JobPostAssets,
  type JobPostContent,
  type JobPostTemplateKey,
} from "@/lib/recruitment/job-posts/templates";

const assetCache = new Map<string, string>();
function publicDataUri(relativePath: string, mime: string): string {
  const cached = assetCache.get(relativePath);
  if (cached) return cached;
  const bytes = readFileSync(join(process.cwd(), "public", relativePath));
  const uri = `data:${mime};base64,${bytes.toString("base64")}`;
  assetCache.set(relativePath, uri);
  return uri;
}

/** The two Montserrat faces and the on-light logo, the same files the builder previews with. */
export function jobPostServerAssets(): JobPostAssets {
  return {
    fontBold: publicDataUri("fonts/montserrat-bold.ttf", "font/ttf"),
    fontRegular: publicDataUri("fonts/montserrat-regular.ttf", "font/ttf"),
    logo: publicDataUri("brand/sato-pharma-logo-on-light.png", "image/png"),
  };
}

async function load(page: ChromiumPage, html: string): Promise<void> {
  await page.setViewport({ width: JOB_POST_WIDTH, height: JOB_POST_HEIGHT, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "networkidle0" });
  const report = (await page.evaluate("window.__jobPostFit")) as { titles?: unknown } | null;
  if (!report || typeof report.titles !== "number" || report.titles < 1) {
    throw new Error("The job post's layout pass did not run, so its title was never fitted.");
  }
}

async function png(page: ChromiumPage, html: string): Promise<Uint8Array> {
  await load(page, html);
  await page.emulateMediaType("screen");
  return page.screenshot({ type: "png" });
}

async function pdf(page: ChromiumPage, html: string): Promise<Uint8Array> {
  await load(page, html);
  await page.emulateMediaType("print");
  return page.pdf({ printBackground: true, preferCSSPageSize: true, margin: { top: "0", right: "0", bottom: "0", left: "0" } });
}

export async function renderJobPostPng(content: JobPostContent, template: JobPostTemplateKey): Promise<Uint8Array> {
  const html = renderJobPostHtml(content, template, jobPostServerAssets());
  return withChromiumPage((page) => png(page, html));
}

export async function renderJobPostPdf(content: JobPostContent, template: JobPostTemplateKey): Promise<Uint8Array> {
  const html = renderJobPostHtml(content, template, jobPostServerAssets());
  return withChromiumPage((page) => pdf(page, html));
}

/**
 * The whole set in one ZIP: the all-areas PNG, one PNG per area, and one PDF with every page in the
 * same order. Drawn one after another in ONE browser — the render slot allows two browsers at once,
 * and a post with twelve areas must not take both.
 */
export async function renderJobPostBundle(content: JobPostContent, template: JobPostTemplateKey): Promise<Uint8Array> {
  const assets = jobPostServerAssets();
  const stem = jobPostFileStem(content);
  const variants: Array<{ name: string; content: JobPostContent }> = [
    { name: content.areas.length > 1 ? `${stem}-all-areas` : stem, content },
    ...(content.areas.length > 1
      ? content.areas.map((area) => ({ name: jobPostFileStem(content, area), content: jobPostForArea(content, area) }))
      : []),
  ];

  const rendered = await withChromiumPage(async (page) => {
    const out: Array<{ name: string; png: Uint8Array; pdf: Uint8Array }> = [];
    for (const variant of variants) {
      const html = renderJobPostHtml(variant.content, template, assets);
      out.push({ name: variant.name, png: await png(page, html), pdf: await pdf(page, html) });
    }
    return out;
  });

  const merged = await PDFDocument.create();
  for (const item of rendered) {
    const source = await PDFDocument.load(item.pdf);
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }

  const zip = new JSZip();
  // Names are unique by construction, but two areas that slug alike ("Cairo East 1" / "Cairo East-1")
  // must not overwrite each other inside the archive.
  const used = new Set<string>();
  for (const item of rendered) {
    let name = item.name;
    for (let n = 2; used.has(name); n += 1) name = `${item.name}-${n}`;
    used.add(name);
    zip.file(`${name}.png`, item.png);
  }
  zip.file(`${stem}.pdf`, await merged.save());
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
