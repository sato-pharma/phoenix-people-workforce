// The module loader `scripts/measure-needs-you-fit.mjs` needs to server-render a real `.tsx`
// component outside Next.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS AND WHY IT IS NOT tests/alias-loader.mjs. That loader is what the whole unit suite
// runs under, and it is deliberately narrow: Node's `--experimental-strip-types` erases TypeScript
// types but does NOT transform JSX, so a `.tsx` file fails there with ERR_UNKNOWN_FILE_EXTENSION.
// Widening the suite's loader to transpile JSX would put a compiler in front of 1,900 tests to serve
// one measurement script, so this wraps it instead and adds exactly two capabilities:
//
//   1. `.tsx` is transpiled with the repository's OWN TypeScript (5.9.3, already a dependency),
//      through `ts.transpileModule` with `jsx: react-jsx` — the same automatic runtime Next uses.
//   2. `next/link` is stubbed to a plain `<a>`. Outside a Next app there is no router context for it
//      to read, and the harness measures GEOMETRY: a link's box is an inline anchor's box either way.
//
// Nothing else is substituted. Every class, every string and every element in the measured page is
// the component's own, which is the whole point — the house rule is to verify the emitted artifact,
// never the source, and a hand-copied harness is a copy of the source wearing the artifact's clothes.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { load as aliasLoad, resolve as aliasResolve } from "../tests/alias-loader.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

/**
 * A `<Link>` that is an `<a>`. Same box, same classes, no router.
 *
 * It reads React off a global the measurement script sets, rather than importing it: this module is
 * served from a `data:` URL, and a data URL has no hierarchical base, so Node cannot resolve a BARE
 * specifier from inside one (ERR_UNSUPPORTED_RESOLVE_REQUEST). One global is cheaper than teaching
 * the resolve hook to invent a base for data URLs.
 */
const LINK_STUB = `
function Link({ href, children, ...rest }) {
  return globalThis.__needsYouFitReact.createElement(
    "a",
    { href: typeof href === "string" ? href : "#", ...rest },
    children,
  );
}
export default Link;
`;

const LINK_STUB_URL = `data:text/javascript,${encodeURIComponent(LINK_STUB)}`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/link" || specifier === "next/link.js") {
    return { shortCircuit: true, url: LINK_STUB_URL };
  }
  return aliasResolve(specifier, context, nextResolve);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".tsx")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(source, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        // Names, not numbers, in a stack trace from inside the component.
        inlineSourceMap: false,
      },
      fileName: fileURLToPath(url),
    });
    return { format: "module", shortCircuit: true, source: out.outputText };
  }
  return aliasLoad(url, context, nextLoad);
}
