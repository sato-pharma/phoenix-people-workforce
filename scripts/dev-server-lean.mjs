/*
 * `--lean`: the dev server set up the way it was measured to fit on the owner's 16 GB laptop.
 *
 * Measured 2026-10-29, /admin from cold, everything else on the machine left as it was:
 *     launcher defaults                      peak 4,862 MB private, free RAM fell to 64 MB
 *     --lean (both switches + 2,560 MB heap) peak 2,800-3,400 MB, about 1.5 GB less
 * The two switches live in next.config.ts (read the block above its `webpack` hook): the server and
 * edge compilers stop building a source map per module, and webpack's cache stops being gzipped to
 * disk after each compile (that write alone held 1.1 GB outside the heap). Neither touches
 * `next build`. What --lean gives up: a server error's stack names the compiled `.next/server`
 * file rather than the `src/` line, and every new server start compiles cold.
 *
 * Pure on purpose, like dev-server-heap-cap.mjs: the launcher hands over its arguments and
 * environment, this decides what the Next child receives, and tests/dev-server-lean.test.ts pins it.
 */

export const LEAN_FLAG = "--lean";

/** The heap the measured runs used; their heap peaked at 1.6 GB, inside it. */
export const LEAN_HEAP_CAP_MB = 2560;

/**
 * @param {string[]} argv the launcher's own arguments (process.argv.slice(2))
 * @param {Record<string, string | undefined>} env the launcher's own environment
 * @returns {{ lean: boolean, passthrough: string[], env: Record<string, string | undefined>, note: string | null }}
 *   passthrough: the arguments Next must receive (never `--lean`, which Next would refuse)
 *   env: the environment the rest of the launcher works from
 */
export function resolveLeanMode(argv, env) {
  const passthrough = argv.filter((arg) => arg !== LEAN_FLAG);
  const lean = passthrough.length !== argv.length || String(env.PHOENIX_DEV_LEAN ?? "").trim() === "1";
  if (!lean) return { lean: false, passthrough, env: { ...env }, note: null };

  const out = { ...env };
  // A value the caller set is the caller's choice, including "0" to keep one of them off.
  if (out.PHOENIX_DEV_LEAN_SERVER_MAPS === undefined) out.PHOENIX_DEV_LEAN_SERVER_MAPS = "1";
  if (out.PHOENIX_DEV_NO_DISK_CACHE === undefined) out.PHOENIX_DEV_NO_DISK_CACHE = "1";
  if (!String(out.PHOENIX_DEV_HEAP_MB ?? "").trim()) out.PHOENIX_DEV_HEAP_MB = String(LEAN_HEAP_CAP_MB);

  const parts = [];
  if (out.PHOENIX_DEV_LEAN_SERVER_MAPS === "1") parts.push("server source maps off");
  if (out.PHOENIX_DEV_NO_DISK_CACHE === "1") parts.push("no disk cache");
  return { lean: true, passthrough, env: out, note: `lean: ${parts.join(", ") || "both switches kept off by the caller"}` };
}
