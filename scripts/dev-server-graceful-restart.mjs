/*
 * The dev server's memory restart, made to wait until no request is in flight.
 *
 * WHY THIS EXISTS (2026-10-31). Next restarts its dev server by itself once the heap passes 80% of
 * the cap scripts/dev-server.mjs gives it (4,096 MB). It decides in the `finally` of EVERY request
 * (next/dist/server/lib/start-server.js, requestListener) and calls process.exit there and then — so
 * every OTHER request still running dies with it. On a streamed page that is React's
 * "The server could not finish this Suspense boundary ... Switched to client rendering" (error 419),
 * a Command Center stuck on "Loading System Administrator Overview", and ERR_CONNECTION_RESET in the
 * console: measured twice in one session on /admin and /sales/vs-target, dev.log lines 36 and 108.
 *
 * The restart itself is right — under a 4 GB cap on a 16 GB laptop it is what stands between the
 * server and a V8 out-of-memory crash (exit 134), and a lower cap only made it more frequent. What
 * changes here is WHEN: the same 80% trigger, but the exit waits for the moment no request is open.
 * Next's own check is switched off for that process (`experimental.devMemoryThresholdRestart: false`
 * in next.config.ts) and this exits with Next's own restart code, 77, so `next dev` respawns the
 * server on the same port exactly as before.
 *
 * Two limits keep the wait from becoming the out-of-memory crash it exists to avoid:
 *   - past 92% of the cap it restarts at once, whatever is in flight (V8 dies near 100%);
 *   - after 90 s of waiting it restarts anyway, for a page that never goes quiet (a poller).
 *
 * Only ever active inside the dev server's own process (start-server.js), only when the launcher
 * asked for it (PHOENIX_DEV_GRACEFUL_RESTART=1), never in production. Pinned by
 * tests/dev-server-graceful-restart.test.ts.
 */
import http from "node:http";
import https from "node:https";
import v8 from "node:v8";

/** Next's own trigger (getMemoryRestartStats, next/dist/server/lib/utils.js): 80% of the heap limit. */
export const RESTART_AT = 0.8;
/** Past this, waiting risks the very out-of-memory crash the restart is for. */
export const HARD_STOP_AT = 0.92;
/** The longest a restart waits for the server to go quiet. */
export const MAX_WAIT_MS = 90_000;
/** Next's RESTART_EXIT_CODE: `next dev` respawns the server when its child exits with it. */
export const NEXT_RESTART_EXIT_CODE = 77;

const INSTALLED = Symbol.for("phoenix.devGracefulRestart");

/**
 * @param {{ usedBytes: number, limitBytes: number, inFlight: number, waitingSinceMs: number | null, nowMs: number }} reading
 * @returns {{ action: "none" | "wait" | "restart", reason: string }}
 */
export function decideRestart({ usedBytes, limitBytes, inFlight, waitingSinceMs, nowMs }) {
  const share = limitBytes > 0 ? usedBytes / limitBytes : 0;
  if (share <= RESTART_AT) return { action: "none", reason: "heap under the restart line" };
  if (share > HARD_STOP_AT) return { action: "restart", reason: `heap past ${Math.round(HARD_STOP_AT * 100)}% of the cap` };
  if (inFlight <= 0) return { action: "restart", reason: "no request in flight" };
  if (waitingSinceMs !== null && nowMs - waitingSinceMs >= MAX_WAIT_MS) {
    return { action: "restart", reason: `still ${inFlight} request(s) in flight after ${MAX_WAIT_MS / 1000} s` };
  }
  return { action: "wait", reason: `${inFlight} request(s) in flight` };
}

/**
 * Whether this process is the dev server the launcher asked to restart gracefully.
 * @param {Record<string, string | undefined>} [env]
 * @param {readonly string[]} [argv]
 */
export function shouldInstall(env = process.env, argv = process.argv) {
  return (
    env.PHOENIX_DEV_GRACEFUL_RESTART === "1" &&
    env.NODE_ENV !== "production" &&
    argv.some((arg) => /start-server(\.js)?$/.test(String(arg).replace(/\\/g, "/")))
  );
}

/**
 * Counts open requests on every HTTP(S) server in this process and exits with Next's restart code
 * once the heap is over the line and nothing is open. Returns null when it was already installed.
 * @param {{
 *   serverPrototypes?: Array<{ emit: (...args: any[]) => any }>,
 *   getHeapStatistics?: () => { used_heap_size: number, heap_size_limit: number },
 *   exit?: (code: number) => unknown,
 *   log?: (line: string) => unknown,
 *   now?: () => number,
 *   intervalMs?: number,
 * }} [options]
 */
export function installGracefulRestart({
  serverPrototypes = [http.Server.prototype, https.Server.prototype],
  getHeapStatistics = () => v8.getHeapStatistics(),
  exit = (code) => process.exit(code),
  log = (line) => console.warn(line),
  now = () => Date.now(),
  intervalMs = 2_000,
} = {}) {
  const host = serverPrototypes[0];
  if (host[INSTALLED]) return null;

  /** @type {{ inFlight: number, waitingSinceMs: number | null, exited: boolean }} */
  const state = { inFlight: 0, waitingSinceMs: null, exited: false };
  const mb = (bytes) => Math.round(bytes / 1048576).toLocaleString("en-US");

  const check = () => {
    if (state.exited) return;
    const { used_heap_size: usedBytes, heap_size_limit: limitBytes } = getHeapStatistics();
    const decision = decideRestart({ usedBytes, limitBytes, inFlight: state.inFlight, waitingSinceMs: state.waitingSinceMs, nowMs: now() });
    if (decision.action === "none") {
      state.waitingSinceMs = null;
      return;
    }
    if (decision.action === "wait") {
      if (state.waitingSinceMs === null) {
        state.waitingSinceMs = now();
        log(`[dev-server] heap ${mb(usedBytes)} of ${mb(limitBytes)} MB — restarting once the ${decision.reason} finish`);
      }
      return;
    }
    state.exited = true;
    log(`[dev-server] heap ${mb(usedBytes)} of ${mb(limitBytes)} MB — restarting now (${decision.reason})`);
    exit(NEXT_RESTART_EXIT_CODE);
  };

  const originals = serverPrototypes.map((proto) => [proto, Object.prototype.hasOwnProperty.call(proto, "emit") ? proto.emit : undefined]);
  for (const proto of serverPrototypes) {
    const inherited = proto.emit;
    proto.emit = function emitCountingRequests(event, ...args) {
      if (event === "request" && args[1] && typeof args[1].once === "function") {
        state.inFlight += 1;
        args[1].once("close", () => {
          state.inFlight -= 1;
          check();
        });
      }
      return inherited.call(this, event, ...args);
    };
  }
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  host[INSTALLED] = true;

  return {
    state,
    check,
    uninstall() {
      clearInterval(timer);
      for (const [proto, own] of originals) {
        if (own === undefined) delete proto.emit;
        else proto.emit = own;
      }
      delete host[INSTALLED];
    },
  };
}
