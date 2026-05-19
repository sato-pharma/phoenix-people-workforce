import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = process.cwd();
const aliasRoots = ["", "src"];
const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const emailStubs = new Map([
  ["@/emails/general-notification", "tests/stubs/general-notification.ts"],
  ["@/emails/offer-letter", "tests/stubs/offer-letter.ts"],
  ["@/emails/phoenix-email-layout", "tests/stubs/phoenix-email-layout.ts"],
]);

const hasExtension = (value) => path.extname(value) !== "";

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveFile(basePath) {
  const candidates = [];

  if (hasExtension(basePath)) {
    candidates.push(basePath);
  } else {
    for (const ext of extensions) candidates.push(`${basePath}${ext}`);
    for (const ext of extensions) candidates.push(path.join(basePath, `index${ext}`));
  }

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return pathToFileURL(candidate).href;
  }

  return null;
}

async function resolveAlias(specifier) {
  const relativePath = specifier.replace(/^@\//, "");

  for (const root of aliasRoots) {
    const resolved = await resolveFile(path.resolve(projectRoot, root, relativePath));
    if (resolved) return resolved;
  }

  return null;
}

async function resolveRelative(specifier, parentURL) {
  if (!parentURL || !specifier.startsWith(".")) return null;

  const parentPath = fileURLToPath(parentURL);
  return resolveFile(path.resolve(path.dirname(parentPath), specifier));
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server" || specifier === "next/headers") {
    return nextResolve(`${specifier}.js`, context);
  }

  const stubPath = emailStubs.get(specifier);
  if (stubPath) {
    return { shortCircuit: true, url: pathToFileURL(path.resolve(projectRoot, stubPath)).href };
  }

  const resolved = specifier.startsWith("@/")
    ? await resolveAlias(specifier)
    : await resolveRelative(specifier, context.parentURL);

  if (resolved) return { shortCircuit: true, url: resolved };

  return nextResolve(specifier, context);
}
