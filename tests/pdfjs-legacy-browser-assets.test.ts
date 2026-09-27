import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

import {
  PDFJS_BROWSER_POLYFILL,
  PDFJS_POLYFILL_VERSION,
  PDFJS_POLYFILLED_BUILTINS,
} from "../scripts/pdfjs-browser-polyfill.mjs";

/**
 * On 2026-09-14 managers across the field opened a CV and got "Promise.withResolvers is not a
 * function" instead of the page. public/pdfjs/ held pdf.js's MODERN build, which calls that
 * built-in with no fallback, so every phone browser older than roughly Chrome 119 / Safari 17.4
 * (older Samsung Internet included) could not render a single PDF.
 *
 * The answer that day was the LEGACY build, which carries core-js polyfills inside both files.
 * pdfjs-dist 6 then showed that answer was only half of one: 6.3.289's legacy build still bundles
 * core-js but no longer includes the Promise.withResolvers polyfill, while calling it 27 times in
 * pdf.min.mjs and 14 in the worker. So we now carry the fallback ourselves, prepended into each
 * served file by scripts/sync-pdfjs-assets.mjs.
 *
 * These pin the EMITTED files — what the browser actually downloads, not the sync script's intent:
 *   1. each served file opens with exactly our polyfill,
 *   2. everything after it is the installed version's legacy build, byte for byte,
 *   3. no built-in the vendor build CALLS is left defined by nobody,
 *   4. every wasm module the vendor build NAMES is actually served, byte for byte,
 *   5. and every viewer that opens a PDF tells pdf.js where those modules are.
 * (3) is the one that generalises: it is what would have caught pdfjs 6 the morning it was
 * proposed, instead of a field outage.
 *
 * (4) and (5) are the same lesson applied to the 6.x bump. pdf.js 6 moved the JBIG2 and CCITTFax
 * decoders out of the JS bundle into jbig2.wasm — CCITT Group 3/4 being how a scanned or faxed page
 * is encoded, i.e. a large share of the CVs this app reads — and fetches them from the `wasmUrl` the
 * caller passes, defaulting to null. A miss there is invisible in the ordinary case and blank in the
 * scanned one, which is precisely the half-working shape that made 2026-09-14 take a day to see.
 */
export function runPdfjsLegacyBrowserAssetsTests() {
  const require = createRequire(import.meta.url);
  // Normally the installed pdfjs-dist. PHX_PDFJS_DIST_ROOT points this at an unpacked candidate
  // tarball instead, so a version can be put through check (3) BEFORE it is installed — which is
  // how pdfjs-dist 6 was assessed without ever letting it near the lockfile. Nothing sets it in
  // CI or in any script; it only changes which vendor build is read, never what is required of
  // the served files.
  const candidateRoot = process.env.PHX_PDFJS_DIST_ROOT;
  const pkgRoot = candidateRoot ?? dirname(require.resolve("pdfjs-dist/package.json"));
  const publicDir = join(process.cwd(), "public", "pdfjs");
  const installedVersion = candidateRoot
    ? String(
        (JSON.parse(readFileSync(join(candidateRoot, "package.json"), "utf8")) as {
          version?: string;
        }).version ?? "unknown",
      )
    : String((require("pdfjs-dist/package.json") as { version?: string }).version ?? "unknown");

  for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
    const served = readFileSync(join(publicDir, file), "utf8");
    const vendor = readFileSync(join(pkgRoot, "legacy", "build", file), "utf8");

    // 1. The polyfill is FIRST, so it is defined before pdf.js's own first line runs. Both the
    //    library and its worker need it, and a worker has its own global — which is why it is
    //    prepended into each file rather than loaded once by the page.
    assert.ok(
      served.startsWith(PDFJS_BROWSER_POLYFILL),
      `public/pdfjs/${file} does not begin with the Phoenix pdf.js polyfill (v${PDFJS_POLYFILL_VERSION}). Run node scripts/sync-pdfjs-assets.mjs`,
    );

    // 2. And everything after it is the installed version's legacy file, untouched — so the API
    //    types the viewer imports (pdfjs-dist/legacy/build/pdf.mjs) describe the code that really
    //    runs, and nobody has hand-edited a vendor bundle.
    assert.equal(
      served.slice(PDFJS_BROWSER_POLYFILL.length),
      vendor,
      `public/pdfjs/${file} is not the polyfill followed by the installed pdfjs-dist ${installedVersion} legacy/build/${file}. Run node scripts/sync-pdfjs-assets.mjs`,
    );

    // 3. Whatever the vendor build calls, SOMEBODY defines — its own core-js, or us.
    //
    //    Detection reads core-js's two minified shapes, `name:function name(` and `name:function(`
    //    (it drops the inner name for reserved words like `try`). The list is deliberately
    //    curated: `Array.prototype.at` and `String.prototype.replaceAll` are NOT on it, because
    //    their call patterns also match ordinary methods of other objects and read as undefined
    //    even in 5.4.296 — the build that has served the field correctly since 2026-09-14 — so
    //    checking them would fail on a known-good build. Every entry below was verified to report
    //    truthfully against 5.4.296 before being added.
    //    `mustBeCalled` marks one we KNOW this pdfjs major uses, and it turns a zero count from a
    //    skip into a failure. Without it the whole check is one stale pattern away from silence: a
    //    regex that stops matching reads exactly like a vendor that stopped calling, and this file
    //    would go green while covering nothing (the shape of trap AGENTS.md §2.1 names, where a gate
    //    reads zero and reports clean).
    const RISKY_BUILTINS: {
      label: string;
      calledBy: RegExp;
      definedAs: string;
      since: string;
      mustBeCalled?: boolean;
    }[] = [
      {
        label: "Promise.withResolvers",
        calledBy: /Promise\.withResolvers/g,
        definedAs: "withResolvers",
        since: "Chrome 119 / Safari 17.4",
      },
      {
        label: "Promise.try",
        calledBy: /Promise\.try\(/g,
        definedAs: "try",
        since: "Chrome 128 / Safari 18.2",
      },
      {
        label: "Array.prototype.findLast",
        calledBy: /\.findLast\(/g,
        definedAs: "findLast",
        since: "Chrome 97 / Safari 15.4",
      },
      {
        label: "Object/Map.groupBy",
        calledBy: /\.groupBy\(/g,
        definedAs: "groupBy",
        since: "Chrome 117 / Safari 17.4",
      },
      {
        label: "Array.prototype.toSorted",
        calledBy: /\.toSorted\(/g,
        definedAs: "toSorted",
        since: "Chrome 110 / Safari 16",
      },
      {
        label: "Set.prototype.union",
        calledBy: /\.union\(/g,
        definedAs: "union",
        since: "Chrome 122 / Safari 17",
      },
      // Not a method call at all, which is why the 2026-09-23 list missed it: `for await` over a
      // ReadableStream needs ReadableStream.prototype[Symbol.asyncIterator], which no Safari and no
      // Chromium before 124 has and core-js has never polyfilled. pdf.js 6's getTextContent drains
      // its text stream that way, and on 2026-09-24 → 26 managers on iPhones and Samsung Internet
      // 20 got "e is not async iterable" out of the CV preview's phone-redaction pass. EVERY
      // `for await` is counted, not only the ones over a stream: iterating an async generator needs
      // nothing, but a minified bundle cannot tell the two apart, so the coverage has to be in
      // place whenever one exists at all.
      //
      // The whitespace is optional in the pattern although today's minifier emits none (measured:
      // `for await(` twice in pdf.min.mjs and once in pdf.worker.min.mjs, `for await (` never), so
      // a future build that formats it differently still matches. And it is read from the VENDOR
      // file, never the served one — the served copy carries this same phrase inside our own
      // polyfill's comments, which would satisfy the scanner with our text instead of pdf.js's.
      {
        label: "ReadableStream.prototype[Symbol.asyncIterator]",
        calledBy: /for await\s*\(/g,
        definedAs: "Symbol.asyncIterator]",
        since: "Chrome 124 / any Safari",
        mustBeCalled: true,
      },
    ];

    // The vendor's core-js is read by ITS shape. Ours is not written that way — it installs each
    // built-in through Object.defineProperty, so pattern-matching core-js's shape against our own
    // source reports our polyfill as absent and fails a build we have in fact made safe. Ours is
    // therefore read from its declared list, and the list is held honest just below.
    const vendorDefines = (prop: string) =>
      vendor.includes(`${prop}:function ${prop}(`) || vendor.includes(`${prop}:function(`);

    for (const label of PDFJS_POLYFILLED_BUILTINS) {
      // A symbol-keyed built-in ("X.prototype[Symbol.asyncIterator]") is installed by the symbol
      // itself and never by a quoted name, so it is read by the key it is defined with.
      const symbolKey = /\[(Symbol\.\w+)\]$/.exec(label)?.[1];
      const prop = symbolKey ?? label.split(".").pop();
      const installedAs = symbolKey ? `, ${symbolKey}, {` : `"${prop}"`;
      assert.ok(
        PDFJS_BROWSER_POLYFILL.includes(`Object.defineProperty`) &&
          PDFJS_BROWSER_POLYFILL.includes(installedAs),
        `scripts/pdfjs-browser-polyfill.mjs lists ${label} as covered but its source never defines ${prop} — the coverage list must not be able to lie, or a real gap reads as handled`,
      );
    }

    for (const builtin of RISKY_BUILTINS) {
      const calls = (vendor.match(builtin.calledBy) ?? []).length;
      assert.ok(
        calls > 0 || !builtin.mustBeCalled,
        `the scanner for ${builtin.label} matched NOTHING in pdfjs-dist ${installedVersion}'s legacy/build/${file}, and this major is known to use it. Either the pattern went stale — in which case every check below it has been passing on an empty count — or the vendor really did stop, which is a deliberate decision to record by dropping mustBeCalled, never something to leave reading as covered.`,
      );
      if (calls === 0) continue;
      assert.ok(
        vendorDefines(builtin.definedAs) || PDFJS_POLYFILLED_BUILTINS.includes(builtin.label),
        `pdfjs-dist ${installedVersion}'s legacy/build/${file} calls ${builtin.label} ${calls} time(s) and NOTHING defines it — not its own core-js, not scripts/pdfjs-browser-polyfill.mjs. On a phone browser older than ${builtin.since} every CV stops opening, which is the 2026-09-14 outage. Cover ${builtin.label} in scripts/pdfjs-browser-polyfill.mjs before taking this version.`,
      );
    }
  }

  // 4. THE WASM DECODERS ARE ACTUALLY SERVED.
  //
  //    pdf.js names each module it may load in its own source — `_filename="jbig2.wasm"` and a
  //    `_noWasmFilename` beside it for the JS fallback. Reading the names out of the bundle rather
  //    than listing them here is the point: when a future version adds a decoder, or renames one,
  //    this check follows it instead of going quietly stale.
  const vendorWasmDir = join(pkgRoot, "wasm");
  const servedWasmDir = join(publicDir, "wasm");
  const named = new Set<string>();
  for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
    const vendor = readFileSync(join(pkgRoot, "legacy", "build", file), "utf8");
    for (const match of vendor.matchAll(/_(?:noWasm)?[Ff]ilename\s*=\s*"([^"]+\.(?:wasm|js))"/g)) {
      named.add(match[1]);
    }
  }
  assert.ok(
    named.size > 0,
    `Neither pdfjs-dist ${installedVersion} legacy build names a wasm module. Either the library stopped using them — in which case delete this check and public/pdfjs/wasm/ — or the pattern here has gone stale and is now proving nothing.`,
  );
  for (const name of [...named].sort()) {
    assert.ok(
      existsSync(join(servedWasmDir, name)),
      `pdfjs-dist ${installedVersion} loads "${name}" at runtime but public/pdfjs/wasm/${name} is not served. It fetches wasmUrl + that name, so a PDF needing it renders BLANK while every other PDF looks perfect — scanned and faxed CVs are what this decodes. Run node scripts/sync-pdfjs-assets.mjs and commit the result.`,
    );
  }

  //    The directory is then a MIRROR — same names, same bytes. Both halves are load-bearing, and
  //    the NAMES half alone is not enough: qcms_bg.wasm is reached through QCMS.setOptions rather
  //    than the `_filename=` shape read above, so it never appears in `named`. Checking only the
  //    named modules' bytes let a deliberately corrupted qcms_bg.wasm pass this test — caught by
  //    breaking it on purpose, which is the only way that gap was ever going to show up.
  assert.deepEqual(
    readdirSync(servedWasmDir).sort(),
    readdirSync(vendorWasmDir).sort(),
    `public/pdfjs/wasm/ is not a mirror of pdfjs-dist ${installedVersion}'s wasm/ directory (licence files included — we redistribute those binaries). Run node scripts/sync-pdfjs-assets.mjs`,
  );
  for (const name of readdirSync(vendorWasmDir).sort()) {
    assert.deepEqual(
      readFileSync(join(servedWasmDir, name)),
      readFileSync(join(vendorWasmDir, name)),
      `public/pdfjs/wasm/${name} is not byte-identical to pdfjs-dist ${installedVersion}'s own copy. A decoder that is present but altered fails at WebAssembly.instantiate, which reads as "this one CV is broken". Run node scripts/sync-pdfjs-assets.mjs`,
    );
  }

  // 5. EVERY VIEWER POINTS AT THEM. A new call site that forgets `wasmUrl` is not a type error —
  //    the option is optional and its default is null — so nothing but this would catch it.
  const WASM_URL = `wasmUrl: "/pdfjs/wasm/"`;
  const srcRoot = join(process.cwd(), "src");
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) sources.push(full);
    }
  };
  walk(srcRoot);
  const callers = sources.filter((file) => readFileSync(file, "utf8").includes(".getDocument({"));
  assert.ok(
    callers.length > 0,
    "No file under src/ calls pdfjsLib.getDocument({ — this check has gone stale and is proving nothing.",
  );
  for (const file of callers) {
    const source = readFileSync(file, "utf8");
    const where = relative(process.cwd(), file).replace(/\\/g, "/");
    //    Read each CALL's own option object rather than the whole file: these files explain in
    //    prose why isEvalSupported went away, and a plain text search fails on the explanation.
    const options = [...source.matchAll(/\.getDocument\(\{([^}]*)\}/g)].map((match) => match[1]);
    assert.ok(
      options.length > 0,
      `${where} matched the caller scan but no getDocument({ ... }) option object could be read out of it — the pattern here has gone stale.`,
    );
    for (const option of options) {
      assert.ok(
        option.includes(WASM_URL),
        `${where} opens a PDF with pdf.js but that call never passes ${WASM_URL}. pdf.js ${installedVersion} fetches its JBIG2/CCITTFax, JPEG2000 and ICC decoders from that URL and defaults it to null, so scanned pages come up BLANK there while ordinary ones render perfectly.`,
      );
      assert.ok(
        !option.includes("isEvalSupported"),
        `${where} still passes isEvalSupported. pdf.js 6 removed both the option and the eval() it disabled, so it is now silently ignored — delete it rather than leaving a CSP guarantee that nothing enforces.`,
      );
    }
  }

  const syncScript = readFileSync(join(process.cwd(), "scripts", "sync-pdfjs-assets.mjs"), "utf8");
  assert.match(
    syncScript,
    /join\(pkgRoot, "legacy", "build", file\)/,
    "scripts/sync-pdfjs-assets.mjs must copy from legacy/build, or the next version bump reintroduces the modern build",
  );
  assert.match(
    syncScript,
    /PDFJS_BROWSER_POLYFILL \+ vendor/,
    "scripts/sync-pdfjs-assets.mjs must write the polyfill AHEAD of the vendor bytes, or the worker's global is left without it",
  );
  assert.match(
    syncScript,
    /cpSync\(wasmSrc, wasmOut, \{ recursive: true \}\)/,
    "scripts/sync-pdfjs-assets.mjs must copy the vendor's wasm/ directory, or the next bump leaves the JBIG2/CCITTFax decoder unserved and scanned CVs blank",
  );
}
