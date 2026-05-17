import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.cwd();
const aliasRoots = ["", "src"];
const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

const hasExtension = (value) => path.extname(value) !== "";

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveAlias(specifier) {
  const relativePath = specifier.replace(/^@\//, "");

  for (const root of aliasRoots) {
    const basePath = path.resolve(projectRoot, root, relativePath);
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
  }

  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) {
    return nextResolve(specifier, context);
  }

  const resolved = await resolveAlias(specifier);
  if (resolved) {
    return { url: resolved, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
