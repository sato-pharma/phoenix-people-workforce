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
 *
 * ## Why it is a lexer and not a brace-aware rule
 *
 * The obvious improvement — treat an opening brace followed by a block comment as a JSX comment and
 * drop the pair — is worse, and `tests/portal-chrome-never-clips-text.test.ts` recorded the damage
 * before this module existed: that shape also matches a FUNCTION BODY brace, and the lazy quantifier
 * then swallows everything up to the next comment close. It ate a whole component, and the assertion
 * below it went on to read the wrong element entirely. Scanning for string and template state costs
 * nothing extra and cannot do that.
 *
 * ## Why comments are blanked rather than removed
 *
 * A comment becomes the same number of spaces, so every offset and line number in the stripped text
 * still matches the file on disk and a `file:line` a test prints is the real one. The cost is that a
 * byte-counted window around an offset no longer means what it did when a stripper deleted comment
 * text: on 2026-09-25 the 640 bytes before a table in `hr-shell-mobile-tables.test.ts` came back 639
 * whitespace, and its `hidden md:block` gate fell outside the window. Measure such a window in
 * non-whitespace characters, not bytes.
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
/**
 * Stripped source, remembered by the exact text that produced it.
 *
 * Thirty-six test files import this stripper and many of them sweep the whole tree, so the same
 * file is stripped over and over inside one suite run. The function is pure, so the second answer
 * can only be the first one. Keyed by the source text itself, which means the cache also collapses
 * two files that happen to hold identical content.
 *
 * Only real files are remembered. Every test that probes the stripper with a crafted one-liner
 * would otherwise grow this map without bound for no gain, so a short input is computed and
 * forgotten — which is also what keeps the memory here proportional to the tree and not to the
 * number of assertions in the suite.
 */
const stripped = new Map<string, string>();
const MEMOISE_FROM = 2_000;

export function stripComments(source: string): string {
  const cached = stripped.get(source);
  if (cached !== undefined) return cached;

  const drop = new Uint8Array(source.length);
  for (const [a, b] of blockCommentSpans(source)) drop.fill(1, a, b);
  for (const [a, b] of lineCommentSpans(source)) drop.fill(1, a, b);

  // Built run by run rather than character by character. The old loop did `out += …` once per
  // character — ~200,000 string concatenations for a file the size of system-navigation.ts — and a
  // whole-tree sweep of app/ + src/ spent ~10.8s in it. Copying a kept run whole, and replacing a
  // dropped run a line at a time, measured ~1.4s for the identical output: a dropped character
  // becomes a space, a dropped newline stays a newline, so every offset and line number survives.
  let out = "";
  let index = 0;
  while (index < source.length) {
    const start = index;
    const dropping = drop[index] === 1;
    while (index < source.length && (drop[index] === 1) === dropping) index += 1;
    const run = source.slice(start, index);
    out += dropping
      ? run
          .split("\n")
          .map((line) => " ".repeat(line.length))
          .join("\n")
      : run;
  }

  if (source.length >= MEMOISE_FROM) stripped.set(source, out);
  return out;
}

/** What the one-liner this module replaces would delete. Exported so the ratchet can measure it. */
/**
 * {@link stripComments}, with the blank lines it leaves behind removed.
 *
 * For a test that slices a fixed-SIZE window — `code.slice(index, index + 700)` — rather than
 * matching over the whole file. Blanking a comment in place is what keeps `file:line` honest, but it
 * also keeps the comment's bytes: a route handler carrying twenty lines of explanation between a
 * guard and its `status: 403` has them all inside that 700, and the thing the window was measured
 * to contain falls out of it. The hand-rolled strippers this module replaced collapsed each comment
 * to a single space, so a window sized against one of those is sized against compacted code.
 *
 * Measured 2026-09-25 on `distribution-lists-access`, whose 700-character windows pin five Telegram
 * gates: folded onto the offset-preserving strip, the first window lost its `403` and the test went
 * red on code that was perfectly correct. Nothing about the guard had changed — only the padding.
 *
 * Line numbers do NOT survive this. Use it to match, never to report a location.
 */
export function stripCommentsCompact(source: string): string {
  return stripComments(source)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n");
}

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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The other two languages these tests read
//
// `stripComments` above is a JavaScript/TypeScript lexer, and that is the only thing it may be
// handed. The two rules below exist because a test that strips comments out of SQL or CSS with the
// JS lexer gets a WRONG answer quietly, in the direction that makes a pin pass for no reason:
//
//   SQL   `--` is the line comment and `//` is not. Running SQL through the JS lexer therefore
//         leaves every `--` comment in place, so commented-out DDL is read as real.
//   CSS   there is no `//` comment at all, so the JS lexer reads the `//` in an unquoted
//         `url(https://…)` as a line comment and deletes the rest of that line.
//
// Both are scans rather than regexes for the same reason the JS one is: a comment delimiter inside
// a string is not a comment. Measured over this repo's own 608 migration files on 2026-09-25, the
// `--[^\n]*` one-liner that 11 tests had each written deletes 3,545 characters of real SQL out of
// 25 of them — always from inside a string literal, and mostly from the middle of a
// `COMMENT ON … IS '…'` body. The worst is `20260821100000_crm_plan_entries.sql`, where a table's
// own 278-character description contains the words ` -- one row per planned call` and the naive
// strip removes everything from there to the end of the line. The `(^|[^:])` guard several copies
// carry makes no difference to any of the 25: it was copied across from the JavaScript version,
// where it is a half-measure against `https://`, and SQL has no `//` for it to guard.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The comment spans a PostgreSQL parser would see: `--` to end of line, and a block comment, which
 * NESTS in Postgres unlike in JavaScript.
 *
 * A `$tag$ … $tag$` body is scanned as CODE, not as a string. That is deliberate: every caller
 * strips comments so commented-out DDL is never read as real, and a commented-out statement inside
 * a function body is still commented-out DDL. Single-quoted strings and "quoted identifiers" ARE
 * strings, and both escape by doubling the quote.
 *
 * Unlike the JavaScript scanner, an unterminated `'…'` does NOT recover at the newline: a SQL string
 * legitimately spans lines, so recovering there would re-open the hole this closes.
 */
export function sqlCommentSpans(source: string): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  const n = source.length;
  let i = 0;
  let state: "code" | "line" | "block" | "sq" | "dq" | "dollar" = "code";
  let depth = 0;
  let start = -1;
  let tag = "";
  // Which state a comment or string inside a `$tag$` body returns to when it ends.
  let resume: "code" | "dollar" = "code";

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];

    if (state === "code" || state === "dollar") {
      if (state === "dollar" && source.startsWith(tag, i)) {
        state = "code";
        i += tag.length;
        continue;
      }
      if (c === "-" && d === "-") {
        resume = state;
        state = "line";
        start = i;
        i += 2;
        continue;
      }
      if (c === "/" && d === "*") {
        resume = state;
        state = "block";
        depth = 1;
        start = i;
        i += 2;
        continue;
      }
      if (c === "'") {
        resume = state;
        state = "sq";
        i += 1;
        continue;
      }
      if (c === '"') {
        resume = state;
        state = "dq";
        i += 1;
        continue;
      }
      if (state === "code" && c === "$") {
        const opener = /^\$[A-Za-z_]\w*\$|^\$\$/.exec(source.slice(i));
        if (opener) {
          tag = opener[0];
          state = "dollar";
          i += tag.length;
          continue;
        }
      }
      i += 1;
      continue;
    }

    if (state === "line") {
      if (c === "\n") {
        spans.push([start, i] as const);
        state = resume;
      }
      i += 1;
      continue;
    }

    if (state === "block") {
      if (c === "/" && d === "*") {
        depth += 1;
        i += 2;
        continue;
      }
      if (c === "*" && d === "/") {
        depth -= 1;
        i += 2;
        if (depth === 0) {
          spans.push([start, i] as const);
          state = resume;
        }
        continue;
      }
      i += 1;
      continue;
    }

    // "sq" | "dq" — doubling the quote escapes it (`'it''s'`, `"a""b"`).
    const quote = state === "sq" ? "'" : '"';
    if (c === quote && d === quote) i += 2;
    else if (c === quote) {
      state = resume;
      i += 1;
    } else i += 1;
  }

  if (state === "line" || state === "block") spans.push([start, n] as const);
  return spans;
}

/**
 * `source` with the given spans blanked, keeping every newline inside them.
 *
 * A dropped character becomes a space and a dropped NEWLINE STAYS A NEWLINE, so both offsets and
 * line numbers survive — the same rule {@link stripComments} uses.
 *
 * Shared on 2026-09-25 because the SQL and CSS strippers did not follow it: each replaced a whole
 * span with `" ".repeat(b - a)`, which flattens a multi-line `/* … *\/` comment onto one line and
 * moves every line after it up. Measured on a 4-line fixture: SQL and CSS both returned 3 lines
 * where the JS stripper returned 4. Both docblocks promised the opposite, and 20 more SQL call
 * sites were folded onto them the same day — a promise that is read and relied on has to be true.
 */
function blankSpans(source: string, spans: ReadonlyArray<readonly [number, number]>): string {
  if (spans.length === 0) return source;

  const out: string[] = [];
  let at = 0;
  for (const [a, b] of spans) {
    out.push(
      source.slice(at, a),
      source
        .slice(a, b)
        .split("\n")
        .map((line) => " ".repeat(line.length))
        .join("\n"),
    );
    at = b;
  }
  out.push(source.slice(at));
  return out.join("");
}

/**
 * `source` with every SQL comment replaced by spaces, and its newlines kept.
 *
 * Blanked rather than removed, for the reason in this file's header: a `file:line` a test prints
 * still points at the real line. Reach for this — never a `--` regex — whenever a test reads a
 * migration, a policy or a function body as text.
 *
 * A `--` filter is not a weaker version of this, it is a different thing: it drops a line only when
 * the line STARTS with the marker, so a trailing comment after real code and every line of a
 * `/* … *\/` block survive it. Measured across the 608 migrations on 2026-09-25, that left 2,653
 * non-space characters of comment text standing in 34 files, each of them prose a pin can match.
 */
export function stripSqlComments(source: string): string {
  return blankSpans(source, sqlCommentSpans(source));
}

/**
 * The comment spans a CSS parser would see. Block comments are the whole rule — CSS has no line
 * comment — and a delimiter inside a `"…"`, `'…'` or unquoted `url(…)` is not one.
 *
 * An unquoted `url(https://…)` is why this cannot be {@link stripComments}: that `//` is not a
 * comment in any stylesheet, and deleting the rest of the line makes a "this declaration must be
 * present" pin fail on a correct file.
 */
export function cssCommentSpans(source: string): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  const n = source.length;
  let i = 0;
  let state: "code" | "block" | "sq" | "dq" = "code";
  let start = -1;

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];

    if (state === "code") {
      if (c === "/" && d === "*") {
        state = "block";
        start = i;
        i += 2;
        continue;
      }
      if (c === "'") {
        state = "sq";
        i += 1;
        continue;
      }
      if (c === '"') {
        state = "dq";
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (state === "block") {
      if (c === "*" && d === "/") {
        spans.push([start, i + 2] as const);
        state = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    // "sq" | "dq" — recover at the newline, since a CSS string cannot span one unescaped.
    if (c === "\\") i += 2;
    else if (c === "\n") {
      state = "code";
      i += 1;
    } else if ((state === "sq" && c === "'") || (state === "dq" && c === '"')) {
      state = "code";
      i += 1;
    } else i += 1;
  }

  if (state === "block") spans.push([start, n] as const);
  return spans;
}

/** `source` with every CSS comment replaced by spaces, and its newlines kept — {@link blankSpans}. */
export function stripCssComments(source: string): string {
  return blankSpans(source, cssCommentSpans(source));
}
