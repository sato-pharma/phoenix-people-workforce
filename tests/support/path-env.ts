import { delimiter } from "node:path";

/**
 * A copy of `base` whose search path starts with `dirs`, held under the ONE key `PATH`.
 *
 * WHY. On Windows the variable is spelled `Path`. `process.env` itself ignores case there, but a plain
 * copy (`{ ...process.env }`) does not: `env.PATH` on the copy reads undefined, so `dir + env.PATH`
 * made the shim folder the WHOLE search path, and `{ ...process.env, PATH: … }` left the copy with
 * both `Path` and `PATH`, and the child may read either. On the spare laptop that made the bash-guard
 * C10 test read `allow` (2026-11-07): `findstr` had vanished with the rest of the path. Every
 * spelling of the key is removed here and one `PATH` is written, which is also what Linux reads.
 */
export function envWithPathFirst(base: NodeJS.ProcessEnv, ...dirs: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const keys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
  const existing = (keys.includes("PATH") ? env.PATH : keys.map((key) => env[key]).find((value) => value)) ?? "";
  for (const key of keys) delete env[key];
  env.PATH = [...dirs, existing].filter((part) => part !== "").join(delimiter);
  return env;
}
