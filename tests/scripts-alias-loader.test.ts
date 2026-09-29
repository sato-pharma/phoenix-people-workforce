// scripts/alias-loader.mjs must be able to load the whole domain graph an ops script reaches —
// including `next/cache` and the JSX email templates.
//
// WHY THIS EXISTS. On 2026-09-30 the owner asked for a dry run of scripts/import-crm-vacation-backfill.ts,
// whose own header documents the exact command to use. That command no longer ran at all, and
// neither fault was in the script:
//
//   1. src/lib/vacation/service.ts imports `unstable_cache` from "next/cache". The loader spelled
//      out `.js` for "next/server" and "next/headers" but not that one, so the run died on
//      ERR_MODULE_NOT_FOUND before the first row.
//   2. The service reaches src/emails/*.tsx through the notification layer, and node cannot load a
//      .tsx file at all — `--experimental-strip-types` leaves the JSX behind and
//      `--experimental-transform-types` does not help either. ERR_UNKNOWN_FILE_EXTENSION.
//
// Both are silent in the ordinary sense: nothing is red, no test fails, the script simply cannot be
// run when someone finally needs it — and the one that needs it writes approved leave into
// production. The gap had to be worked around from outside the repo to answer the owner at all.
//
// This test drives the loader's real hooks rather than reading the file, and the JSX half asserts
// on the COMPILED OUTPUT (no angle brackets left, a jsx-runtime import present), because the whole
// class of bug here is source that looks right and an artifact that will not load.
//
// The template is deliberately compiled rather than stubbed: tests/alias-loader.mjs swaps in
// tests/stubs/* for the same imports, which is right for a test run, and wrong for an ops script
// that can actually send the email it just rendered.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const loaderUrl = pathToFileURL(resolve("scripts/alias-loader.mjs")).href;

/** A `nextResolve` that records what the loader handed on instead of resolving anything. */
function recordingResolve() {
  const seen: { context: unknown; specifier: string }[] = [];
  const hook = (specifier: string, context: unknown) => {
    seen.push({ context, specifier });
    return { shortCircuit: true, url: `recorded:${specifier}` };
  };
  return { hook, seen };
}

export async function runScriptsAliasLoaderTests() {
  const loader = (await import(loaderUrl)) as {
    load: (url: string, context: unknown, nextLoad: unknown) => Promise<{ format?: string; source?: string }>;
    resolve: (specifier: string, context: unknown, nextResolve: unknown) => Promise<{ url: string }>;
  };

  // 1. The Next subpaths node cannot resolve on its own are spelled with .js.
  for (const specifier of ["next/server", "next/headers"]) {
    const { hook, seen } = recordingResolve();
    const result = await loader.resolve(specifier, {}, hook);
    assert.equal(
      seen[0]?.specifier,
      `${specifier}.js`,
      `${specifier} must be handed on with its .js extension, or node cannot resolve it under --experimental-specifier-resolution=node`,
    );
    assert.equal(result.url, `recorded:${specifier}.js`);
  }

  // 2. next/cache is NOT one of them. Resolving it to the real module fixes the import and leaves
  //    the run broken — the real unstable_cache throws "Invariant: incrementalCache missing" the
  //    moment a wrapped function is called, which is a mid-run death rather than a startup one.
  //    Both specifier spellings must land on the CLI module, and its unstable_cache must actually
  //    run the function it wraps.
  for (const specifier of ["next/cache", "next/cache.js"]) {
    const { hook, seen } = recordingResolve();
    const result = await loader.resolve(specifier, {}, hook);
    assert.equal(seen.length, 0, `${specifier} must be resolved by the loader, never handed to node`);
    assert.equal(
      result.url,
      pathToFileURL(resolve("scripts/next-cache-cli.mjs")).href,
      `${specifier} must resolve to scripts/next-cache-cli.mjs`,
    );
  }
  {
    const cliCache = (await import(pathToFileURL(resolve("scripts/next-cache-cli.mjs")).href)) as {
      revalidatePath: (path: string) => void;
      revalidateTag: (tag: string) => void;
      unstable_cache: <T>(fn: T) => T;
      unstable_noStore: () => void;
    };
    let calls = 0;
    const wrapped = cliCache.unstable_cache(async (n: number) => {
      calls += 1;
      return n * 2;
    });
    assert.equal(await wrapped(21), 42, "unstable_cache must run the function it wraps, uncached");
    assert.equal(await wrapped(21), 42);
    assert.equal(calls, 2, "a CLI run reads live — the wrapper must not cache the first answer");
    assert.equal(cliCache.revalidatePath("/anything"), undefined, "revalidatePath is a no-op in a CLI run");
    assert.equal(cliCache.revalidateTag("anything"), undefined, "revalidateTag is a no-op in a CLI run");
    assert.equal(cliCache.unstable_noStore(), undefined, "unstable_noStore is a no-op in a CLI run");
  }

  // 3. Anything else still falls through untouched.
  {
    const { hook, seen } = recordingResolve();
    await loader.resolve("exceljs", {}, hook);
    assert.equal(seen[0]?.specifier, "exceljs", "a plain package specifier must not be rewritten");
  }

  // 4. A .tsx file is COMPILED, not stubbed and not passed through. Asserted on the emitted source.
  const dir = mkdtempSync(join(tmpdir(), "phx-alias-loader-"));
  try {
    const fixture = join(dir, "template.tsx");
    writeFileSync(
      fixture,
      [
        "export type Props = { name: string };",
        "export function Greeting({ name }: Props) {",
        '  return <section className="greeting">Hello {name}</section>;',
        "}",
      ].join("\n"),
      "utf8",
    );

    let passedThrough = false;
    const compiled = await loader.load(pathToFileURL(fixture).href, {}, () => {
      passedThrough = true;
      return { format: "module", source: "" };
    });

    assert.equal(passedThrough, false, "a .tsx file must be compiled by the loader, never handed to node");
    assert.equal(compiled.format, "module");
    const source = compiled.source ?? "";
    assert.ok(!source.includes("<section"), "JSX must be gone from the emitted source — node cannot parse it");
    assert.ok(!source.includes(": Props"), "type annotations must be gone from the emitted source");
    assert.ok(/jsx-runtime/.test(source), "the emitted source must import React's jsx runtime");
    assert.ok(source.includes("Greeting"), "the module's own exports must survive the compile");

    // 5. A plain .ts file is NOT intercepted — node's own type stripping still owns those.
    const plain = join(dir, "plain.ts");
    writeFileSync(plain, "export const a: number = 1;\n", "utf8");
    let plainPassedThrough = false;
    await loader.load(pathToFileURL(plain).href, {}, () => {
      plainPassedThrough = true;
      return { format: "module", source: "" };
    });
    assert.equal(plainPassedThrough, true, "a .ts file must fall through to node, which strips its types");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}
