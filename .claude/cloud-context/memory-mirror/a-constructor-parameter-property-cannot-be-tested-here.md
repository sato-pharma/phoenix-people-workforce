---
name: a-constructor-parameter-property-cannot-be-tested-here
description: "a class written with `constructor(private readonly x: string)` throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX the moment any test imports its module, because tests/run-tests.ts loads source under Node type-STRIPPING — so the shorthand makes a whole module untestable, and lint and the editor both stay silent about it"
metadata:
  node_type: memory
  type: project
  originSessionId: 3372332a-74ec-47de-88a5-95015e09ec1f
  modified: 2026-10-13T10:17:02.647Z
---

`tests/run-tests.ts` runs under `node --experimental-strip-types`, which only ERASES types — it
compiles nothing. A constructor parameter property is the one common TypeScript shorthand that
cannot be erased (it *emits* an assignment), so Node refuses the file outright:
`SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in
strip-only mode`. The whole module fails at IMPORT, before a single assertion runs.

**Why:** nothing else catches it. `tsc` accepts it, eslint accepts it, the editor accepts it, and
Next's bundler compiles it fine — so a class written that way ships, works in production, and is
simply impossible to put under test. It surfaced on 2026-10-13 writing
`tests/closing-rep-ranking.test.ts` against `src/lib/sales/closing-rep-ranking-workbook.ts`, whose
`RankingWorkbook` class used `constructor(private readonly subtitlePrefix: string)`.

**How to apply:** in any module a test may import, declare the field and assign it in the
constructor body instead. The same strip-only limit rules out `enum`, `namespace` and
`declare`-less decorators in those modules. When a new test dies at import rather than at an
assertion, read the error for `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` before doubting the test.

See also [[verify-the-emitted-artifact-never-the-source]].
