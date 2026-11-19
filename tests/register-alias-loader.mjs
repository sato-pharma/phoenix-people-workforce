// tests/alias-loader.mjs, registered through `module.register` — the route Node itself recommends
// in the warning it prints for `--experimental-loader`.
//
// 🔴 NOT A STYLE CHOICE: `--experimental-loader` makes every allocating regular-expression call in
// the MAIN thread many times slower. Measured 20 Nov 2026 on Node 24.15.0 with the hooks file EMPTY:
// splitting 41 MB on /\r?\n/ took 9.5-11.6 s under `--experimental-loader` and 98-127 ms with no
// loader, with this file, or with `module.registerHooks`; a /g replace went 6x slower. The
// neutral-wording gate spent 5.7 of its 7.2 s in that one split. Same hooks, same thread layout —
// only the flag differs. Use it as `node --import ./tests/register-alias-loader.mjs …`.
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);
