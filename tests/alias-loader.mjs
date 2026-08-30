import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = process.cwd();
const aliasRoots = ["", "src"];
const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const emailStubs = new Map([
  ["@/emails/general-notification", "tests/stubs/general-notification.ts"],
  ["@/emails/phoenix-email-layout", "tests/stubs/phoenix-email-layout.ts"],
  // `next/cache` has no runtime equivalent under plain-Node type-stripping. Stub it
  // (both specifier forms) so any domain module importing it loads under test.
  ["next/cache", "tests/stubs/next-cache.ts"],
  ["next/cache.js", "tests/stubs/next-cache.ts"],
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
    for (const ext of extensions) {
      candidates.push(`${basePath}${ext}`);
    }
    for (const ext of extensions) {
      candidates.push(path.join(basePath, `index${ext}`));
    }
  }

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return pathToFileURL(candidate).href;
    }
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

  if (resolved) {
    return { url: resolved, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}

/**
 * JSON imported as a plain module.
 *
 * Next's bundler turns `import map from "./x.json"` into a default export; raw Node under
 * type-stripping demands `with { type: "json" }` and throws ERR_IMPORT_ATTRIBUTE_MISSING without
 * it. That single difference made every module holding a committed data file untestable —
 * src/lib/business-review/portal-scope.ts, which decides what each role may see, among them.
 *
 * Parsed at runtime rather than inlined into the source string, so a value that is valid JSON but
 * awkward JS cannot change meaning on the way through.
 */
export async function load(url, context, nextLoad) {
  if (url.endsWith(".json") && context.importAttributes?.type !== "json") {
    const source = await readFile(fileURLToPath(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: `export default JSON.parse(${JSON.stringify(source)});`,
    };
  }
  return nextLoad(url, context);
}
