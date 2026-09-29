import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = process.cwd();
const aliasRoots = ["", "src"];
const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/**
 * Next subpaths that node cannot resolve on its own under
 * `--experimental-specifier-resolution=node` — each needs its `.js` extension spelled out.
 */
const nextSubpathsNeedingJs = new Set(["next/server", "next/headers"]);

/**
 * `next/cache` cannot be the real module here, and it is the trap in this file.
 *
 * src/lib/vacation/service.ts imports `unstable_cache` from it, so before 2026-09-30 every ops
 * script reaching the vacation domain — scripts/import-crm-vacation-backfill.ts among them — died
 * on ERR_MODULE_NOT_FOUND before running a single row. Pointing the specifier at `next/cache.js`
 * fixes the import and NOT the run: the real `unstable_cache` throws
 * `Invariant: incrementalCache missing` the moment a wrapped function is called, so a script that
 * merely imports the domain works while a script that reads through it dies mid-run. Both kinds
 * exist here. See scripts/next-cache-cli.mjs for what replaces it and why running uncached is the
 * correct behaviour for a CLI, not a compromise.
 */
const nextCacheSpecifiers = new Set(["next/cache", "next/cache.js"]);

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
  if (nextCacheSpecifiers.has(specifier)) {
    return { shortCircuit: true, url: pathToFileURL(path.resolve(projectRoot, "scripts/next-cache-cli.mjs")).href };
  }

  if (nextSubpathsNeedingJs.has(specifier)) {
    return nextResolve(`${specifier}.js`, context);
  }

  const resolved = specifier.startsWith("@/")
    ? await resolveAlias(specifier)
    : await resolveRelative(specifier, context.parentURL);

  if (resolved) return { shortCircuit: true, url: resolved };

  return nextResolve(specifier, context);
}

/**
 * JSX, compiled with Next's own SWC.
 *
 * Node cannot load a `.tsx`/`.jsx` file at all: `--experimental-strip-types` removes types but
 * leaves the JSX, and `--experimental-transform-types` does not help either — both end in
 * ERR_UNKNOWN_FILE_EXTENSION. The email templates under src/emails/ are `.tsx`, and the
 * notification layer pulls them in, so any ops script touching a domain that can notify used to
 * stop dead there.
 *
 * Compiling is deliberate rather than stubbing the templates out: these scripts write to
 * production, and a stub would let a run believe it had rendered something it had not. The
 * compiler is the one the app itself builds with, so what runs here is what ships.
 *
 * Bindings load once, lazily — a script that never imports JSX never pays for them.
 */
const require = createRequire(import.meta.url);
let swcPromise = null;
async function loadSwc() {
  if (!swcPromise) {
    swcPromise = (async () => {
      const swc = require("next/dist/build/swc/index.js");
      await swc.loadBindings();
      return swc;
    })();
  }
  return swcPromise;
}

export async function load(url, context, nextLoad) {
  const jsx = url.startsWith("file:") ? /\.(?<lang>[jt])sx$/.exec(new URL(url).pathname) : null;
  if (!jsx) return nextLoad(url, context);

  // A .jsx file is plain JavaScript — parsing it as TypeScript would reject valid JS syntax.
  const typescript = jsx.groups?.lang === "t";
  const filename = fileURLToPath(url);
  const swc = await loadSwc();
  const { code } = await swc.transform(await readFile(filename, "utf8"), {
    filename,
    jsc: {
      parser: typescript ? { syntax: "typescript", tsx: true } : { jsx: true, syntax: "ecmascript" },
      target: "es2022",
      transform: { react: { runtime: "automatic" } },
    },
    module: { type: "es6" },
    sourceMaps: false,
  });

  return { format: "module", shortCircuit: true, source: code };
}
