import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";

import { envWithPathFirst } from "./support/path-env.ts";

const ROOT = resolve(import.meta.dirname, "..");

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : testFiles(full);
    return /\.(ts|mjs)$/.test(name) ? [full] : [];
  });
}

/**
 * Pins tests/support/path-env.ts: a test that puts a shim first on the search path holds ONE `PATH`
 * key and keeps the rest of the path, whatever the copy's spelling — the Windows `Path` included.
 */
export function runPathEnvTests() {
  // The Windows spelling: the old path survives behind the shim, under the one key a child reads.
  const windows: Record<string, string | undefined> = { Path: "C:\\Windows\\system32", SystemRoot: "C:\\Windows" };
  const fromWindows = envWithPathFirst(windows, "S");
  assert.deepEqual(Object.keys(fromWindows).filter((k) => k.toUpperCase() === "PATH"), ["PATH"], "one key, spelled PATH");
  assert.equal(fromWindows.PATH, `S${delimiter}C:\\Windows\\system32`, "the shim comes first and the old path is kept");
  assert.equal(fromWindows.SystemRoot, "C:\\Windows", "every other variable is carried");
  assert.deepEqual(windows, { Path: "C:\\Windows\\system32", SystemRoot: "C:\\Windows" }, "the base is never changed");

  // Both spellings in one copy: PATH wins, and Path is gone.
  const both = envWithPathFirst<Record<string, string | undefined>>({ PATH: "/usr/bin", Path: "stale" }, "A", "B");
  assert.deepEqual(both, { PATH: `A${delimiter}B${delimiter}/usr/bin` });

  // Linux: unchanged behaviour. No path at all: the shim alone, never a trailing delimiter.
  assert.equal(envWithPathFirst<Record<string, string | undefined>>({ PATH: "/usr/bin" }, "/tmp/bin").PATH, `/tmp/bin${delimiter}/usr/bin`);
  assert.equal(envWithPathFirst<Record<string, string | undefined>>({}, "/tmp/bin").PATH, "/tmp/bin");

  // The ratchet: no test rewrites the search path by hand on a COPY of the environment — the two shapes
  // that broke on Windows (2026-11-07, the spare laptop).
  const offenders: string[] = [];
  for (const file of testFiles(join(ROOT, "tests"))) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (rel === "tests/support/path-env.ts" || rel === "tests/path-env.test.ts") continue;
    const source = readFileSync(file, "utf8");
    if (/\benv\.PATH\s*=/.test(source)) offenders.push(`${rel}: env.PATH = …`);
    if (/\.\.\.process\.env\s*,[^}]*\bPATH\s*:/.test(source)) offenders.push(`${rel}: { ...process.env, PATH: … }`);
  }
  assert.deepEqual(
    offenders,
    [],
    "put a folder first on the search path with envWithPathFirst (tests/support/path-env.ts): on Windows the key " +
      "is `Path`, so a copy's env.PATH is undefined and a second PATH key sits beside the first",
  );
}
