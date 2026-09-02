/**
 * ONE comment stripper for the source-pinning tests, and the detector that proves it is needed.
 *
 * ## Why this file exists
 *
 * A source-pinning test reads a file as text and asserts on it. The prose explaining WHY something
 * was removed necessarily QUOTES the thing that was removed, so a "must not appear" guard reading
 * raw source fails on its own documentation. Every such test therefore strips comments first, and
 * ~80 of them had each written the same one-liner:
 *
 *     source.replace(/\/\*[\s\S]*?\*\//g, "")
 *
 * That regex has no idea what a string literal is. It treats the `*` in a route pattern like
 * `"/api/auth/*"` as a comment opener and deletes everything up to the next close-comment
 * delimiter — hundreds of lines later, in a different function. Measured on 2026-09-02 across
 * the 3,173 source files in `src/`, `app/`, `scripts/` and `lib/`, it silently deletes real
 * code from 39 of them:
 *
 *     src/config/system-navigation.ts      114,555 of 217,431 chars   (53%)
 *     src/lib/security/access-registry.ts   99,615 of 161,466 chars   (62%)
 *     src/lib/auth/permissions.ts           36,959 of 102,050 chars   (36%)
 *
 * Those three are the navigation, route-authorization and permission registries — precisely the
 * files a future "must not appear" ratchet would be written against, and precisely the ones the
 * naive strip mutilates worst. A negative assertion against 38% of a file passes for the wrong
 * reason and reports it as a pin.
 *
 * This is not hypothetical. It cost a real session on 2026-09-02: a helper written to pin
 * `scripts/repo-doctor.mjs` swallowed the entire region under test, `indexOf` returned -1, and the
 * "RED" run was red for the wrong reason. It was caught only by asserting the baseline first.
 * `tests/direct-orders-invoice-prefill.test.ts` carries the same scar in a comment.
 *
 * `tests/comment-strip-ratchet.test.ts` fails if any test strips one of the 39. Reach for
 * {@link stripComments} and the question never arises.
 */

/**
 * The block-comment spans a JavaScript/TypeScript parser would actually see.
 *
 * A single left-to-right scan tracking string, template and line-comment state, so a `/*` inside
 * `"…"`, `'…'`, `` `…` `` or a `//` comment opens nothing. Those three are where every one of the
 * 39 false spans comes from.
 *
 * Regex literals are deliberately NOT tracked: telling `/` division from `/` regex needs the
 * preceding token, and every regex in this repo that contains the sequence writes it escaped
 * (`/\/\*…/`), which the scanner already steps over. A bare `/*` inside an unescaped regex would
 * be read as a comment — the same answer the naive strip gives, so it can never make the ratchet
 * quieter than it already was.
 */
export function blockCommentSpans(source: string): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  const n = source.length;
  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  let blockStart = -1;
  let i = 0;

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];

    if (state === "code") {
      if (c === "/" && d === "*") {
        state = "block";
        blockStart = i;
        i += 2;
      } else if (c === "/" && d === "/") {
        state = "line";
        i += 2;
      } else if (c === "'") {
        state = "sq";
        i += 1;
      } else if (c === '"') {
        state = "dq";
        i += 1;
      } else if (c === "`") {
        state = "tpl";
        i += 1;
      } else {
        i += 1;
      }
      continue;
    }

    if (state === "line") {
      if (c === "\n") state = "code";
      i += 1;
      continue;
    }

    if (state === "block") {
      if (c === "*" && d === "/") {
        spans.push([blockStart, i + 2] as const);
        state = "code";
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (state === "tpl") {
      // `${…}` interpolation is scanned as template text. A comment inside an interpolation is
      // vanishingly rare and treating it as text can only ever KEEP more source, never delete it.
      if (c === "\\") i += 2;
      else if (c === "`") {
        state = "code";
        i += 1;
      } else i += 1;
      continue;
    }

    // "sq" | "dq" — an unterminated literal recovers at the newline rather than eating the file,
    // which is the whole failure this module exists to prevent.
    if (c === "\\") i += 2;
    else if (c === "\n") {
      state = "code";
      i += 1;
    } else if ((state === "sq" && c === "'") || (state === "dq" && c === '"')) {
      state = "code";
      i += 1;
    } else i += 1;
  }

  return spans;
}

/** The `//` line-comment spans, by the same scan — so a `//` inside a URL or a string survives. */
export function lineCommentSpans(source: string): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  const n = source.length;
  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  let lineStart = -1;
  let i = 0;

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];

    if (state === "code") {
      if (c === "/" && d === "*") {
        state = "block";
        i += 2;
      } else if (c === "/" && d === "/") {
        state = "line";
        lineStart = i;
        i += 2;
      } else if (c === "'") {
        state = "sq";
        i += 1;
      } else if (c === '"') {
        state = "dq";
        i += 1;
      } else if (c === "`") {
        state = "tpl";
        i += 1;
      } else {
        i += 1;
      }
      continue;
    }

    if (state === "line") {
      if (c === "\n") {
        spans.push([lineStart, i] as const);
        state = "code";
      }
      i += 1;
      continue;
    }

    if (state === "block") {
      if (c === "*" && d === "/") {
        state = "code";
        i += 2;
      } else i += 1;
      continue;
    }

    if (state === "tpl") {
      if (c === "\\") i += 2;
      else if (c === "`") {
        state = "code";
        i += 1;
      } else i += 1;
      continue;
    }

    if (c === "\\") i += 2;
    else if (c === "\n") {
      state = "code";
      i += 1;
    } else if ((state === "sq" && c === "'") || (state === "dq" && c === '"')) {
      state = "code";
      i += 1;
    } else i += 1;
  }

  if (state === "line" && lineStart >= 0) spans.push([lineStart, n] as const);
  return spans;
}

/**
 * `source` with its comments replaced by spaces — the safe replacement for the naive one-liner.
 *
 * Spaces rather than "" so that offsets, line numbers and the gap between two tokens all survive:
 * a test matching a call whose argument is preceded by an inline comment must not be handed the
 * two tokens fused together and conclude they were written adjacent.
 */
export function stripComments(source: string): string {
  const drop = new Uint8Array(source.length);
  for (const [a, b] of blockCommentSpans(source)) drop.fill(1, a, b);
  for (const [a, b] of lineCommentSpans(source)) drop.fill(1, a, b);

  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    out += drop[i] && source[i] !== "\n" ? " " : source[i];
  }
  return out;
}

/** What the one-liner this module replaces would delete. Exported so the ratchet can measure it. */
export function naiveBlockStripSpans(source: string): ReadonlyArray<readonly [number, number]> {
  return [...source.matchAll(/\/\*[\s\S]*?\*\//g)].map(
    (m) => [m.index, m.index + m[0].length] as const,
  );
}

/**
 * Characters of REAL CODE the naive strip would delete from `source` — everything it removes that
 * is not inside a genuine block comment. `0` means the naive strip is safe on this file.
 */
export function codeEatenByNaiveStrip(source: string): number {
  const real = new Uint8Array(source.length);
  for (const [a, b] of blockCommentSpans(source)) real.fill(1, a, b);

  let eaten = 0;
  for (const [a, b] of naiveBlockStripSpans(source)) {
    for (let i = a; i < b; i += 1) if (!real[i]) eaten += 1;
  }
  return eaten;
}
