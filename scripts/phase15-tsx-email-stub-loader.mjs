import { pathToFileURL } from "node:url";
import path from "node:path";

const projectRoot = process.cwd();

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/headers") {
    return {
      shortCircuit: true,
      url: pathToFileURL(path.resolve(projectRoot, "node_modules/next/headers.js")).href,
    };
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.includes("/src/emails/") && url.endsWith(".tsx")) {
    return {
      format: "module",
      shortCircuit: true,
      source: `
        export function GeneralNotificationEmail() { return null; }
        export function renderGeneralNotificationEmailHtml() { return ""; }
        export function renderGeneralNotificationEmailText() { return ""; }
        export function renderOfferLetterEmailHtml() { return ""; }
        export function renderOfferLetterEmailText() { return ""; }
        export function renderEmailParagraphs() { return ""; }
        export function renderPhoenixEmailHtml() { return ""; }
        export function renderPhoenixEmailText() { return ""; }
        export const phoenixEmailSignatureHostedUrl = "https://example.invalid/phase15-email-signature.png";
      `,
    };
  }

  return nextLoad(url, context);
}
