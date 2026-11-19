// tests/phase27-alias-loader.mjs, registered through `module.register` — the route Node itself recommends in the warning it
// prints for `--experimental-loader`. Written the same way as tests/register-alias-loader.mjs; the
// measurement behind it is there and in docs/perf/2026-11-20-commit-push-pr-slowness.md.
//
// 🔴 NOT A STYLE CHOICE: `--experimental-loader` makes every allocating regular-expression call in
// the MAIN thread 50-90x slower on Node 24, even with an empty hooks file. Use it as
// `node --import ./tests/register-phase27-alias-loader.mjs …`, never `--experimental-loader ./tests/phase27-alias-loader.mjs`.
import { register } from "node:module";

register("./phase27-alias-loader.mjs", import.meta.url);
