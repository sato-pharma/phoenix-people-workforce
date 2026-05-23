#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

const FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".vercel",
  "node_modules",
  "dist",
  "coverage",
  "build",
  "out",
]);
const ROOT = process.cwd();

function listFiles(dir, files = []) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      if (![".agents", ".github"].includes(entry.name)) {
        continue;
      }
    }

    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(fullPath, files);
      continue;
    }

    if (FILE_EXTENSIONS.has(extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function isUnderDevRoute(filePath) {
  const normalized = resolve(filePath);
  const appDevPath = resolve(ROOT, "app", "dev");
  return normalized === appDevPath || normalized.startsWith(`${appDevPath}${sep}`);
}

function isAppRouteFile(filePath) {
  const base = basename(filePath);
  return filePath.includes(`${sep}app${sep}`) && /^(page|layout|loading|error|not-found|template)\.tsx?$/.test(base);
}

function isDevPreviewModule(source) {
  const lower = source.toLowerCase();
  return lower.includes("dev-preview");
}

const staticImportRegexes = [
  /\bimport\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g,
  /^\s*import\s+["']([^"']+)["']\s*;?/gm,
];

function getLineNumber(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

const files = listFiles(ROOT);
const violations = [];

for (const filePath of files) {
  const relative = filePath.replace(`${ROOT}${sep}`, "");
  if (!isAppRouteFile(filePath) || isUnderDevRoute(filePath)) {
    continue;
  }

  const content = readFileSync(filePath, "utf8");
  if (!content.includes("dev-preview")) {
    continue;
  }

  for (const regex of staticImportRegexes) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const importPath = match[1];
      if (!importPath || !isDevPreviewModule(importPath)) {
        continue;
      }

      if (filePath.endsWith(`${sep}src${sep}lib${sep}employee-portal${sep}dev-preview-data.ts`)) {
        continue;
      }

      violations.push({
        file: relative,
        line: getLineNumber(content, match.index),
        source: importPath,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("[dev-preview-imports] Static dev-preview imports found in non-dev routes:");
  for (const violation of violations) {
    console.error(
      `  - ${violation.file}:${violation.line} -> ${violation.source}`,
    );
  }
  process.exitCode = 1;
} else {
  console.log("[dev-preview-imports] No forbidden static imports found.");
}
