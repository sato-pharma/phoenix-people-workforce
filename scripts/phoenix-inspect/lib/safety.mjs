/**
 * The explorer's guards that are not the network fence: which origins it may target, which controls it
 * may click, how far one run may go, and what the tool interface accepts as input. Pure, tested in
 * tests/phoenix-inspect-safety.test.ts.
 */
import { NEVER_TOUCH_PATHS, PRODUCTION_HOSTS, STAGING_ORIGIN } from "./fence.mjs";

/** The three viewports the kickoff asks for. Inputs name one of these; never a free size. */
export const VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ width: 1440, height: 900, mobile: false }),
  tablet: Object.freeze({ width: 768, height: 1024, mobile: false }),
  mobile: Object.freeze({ width: 390, height: 844, mobile: true }),
});

/** Hard limits for one run, whoever starts it. */
export const RUN_BOUNDS = Object.freeze({
  maxPagesPerRun: 160,
  maxPagesPerToolCall: 40,
  maxMinutesPerRun: 45,
  maxMinutesPerToolCall: 10,
  navigationTimeoutMs: 120_000,
  toolCallsPerMinute: 10,
});

/**
 * The origins a run may target. Staging always; a loopback origin only for the self-check's own
 * fixture page (`allowLoopback`). Production never, and nothing else.
 */
export function assertTargetOrigin(origin, { allowLoopback = false } = {}) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("target origin is not a URL");
  }
  if (PRODUCTION_HOSTS.includes(url.hostname)) throw new Error("refused: the production host is never a target");
  if (url.origin === STAGING_ORIGIN) return url.origin;
  if (allowLoopback && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.protocol === "http:") return url.origin;
  throw new Error(`refused: ${url.origin} is not an allowed target (staging only)`);
}

/**
 * Words whose control might change something. Matched against the control's accessible name BEFORE
 * masking, in the page; the name itself is never logged.
 */
export const REFUSED_CONTROL_WORDS =
  /\b(approve|approval|reject|decline|accept|send|submit|save|saving|delete|remove|archive|restore|export|download|upload|import|publish|unpublish|sign ?out|log ?out|confirm|apply|pay|payout|transfer|reset|revoke|grant|assign|unassign|cancel|close (?:month|period)|lock|unlock|create|add|new|edit|update|request|notify|email|message|whatsapp|print|clear)\b/i;

/**
 * Decide whether the explorer may click a control.
 * @param {{ tag: string, type?: string|null, role?: string|null, name?: string|null, href?: string|null,
 *           download?: boolean, inForm?: boolean, formMethod?: string|null }} control
 * @param {string} origin the run's target origin
 */
export function classifyControl(control, origin) {
  const tag = String(control.tag ?? "").toLowerCase();
  const type = String(control.type ?? "").toLowerCase();
  const name = String(control.name ?? "");
  if (control.download) return { allowed: false, reason: "downloads a file" };
  if (control.href) {
    let target;
    try {
      target = new URL(control.href, origin);
    } catch {
      return { allowed: false, reason: "unparseable link" };
    }
    if (target.origin !== new URL(origin).origin) return { allowed: false, reason: "leaves the target origin" };
    if (NEVER_TOUCH_PATHS.some((pattern) => pattern.test(target.pathname))) return { allowed: false, reason: "never-touch path" };
    if (target.pathname.startsWith("/api/")) return { allowed: false, reason: "an API address, not a page" };
  }
  if (type === "submit" || (tag === "input" && ["submit", "image", "reset"].includes(type))) {
    return { allowed: false, reason: "submits a form" };
  }
  if (control.inForm && tag === "button" && type !== "button") return { allowed: false, reason: "a form's default (submit) button" };
  if (control.formMethod && String(control.formMethod).toLowerCase() !== "get") return { allowed: false, reason: "inside a form that posts" };
  if (REFUSED_CONTROL_WORDS.test(name)) return { allowed: false, reason: "its name says it changes something" };
  if (tag === "input" && !["checkbox", "radio", ""].includes(type)) return { allowed: false, reason: "a typing field" };
  return { allowed: true, reason: null };
}

/** A sliding one-minute window. `take()` answers false once the limit is used up. */
export function createRateLimiter(limit = RUN_BOUNDS.toolCallsPerMinute, now = () => Date.now()) {
  const stamps = [];
  return {
    take() {
      const t = now();
      while (stamps.length > 0 && t - stamps[0] >= 60_000) stamps.shift();
      if (stamps.length >= limit) return false;
      stamps.push(t);
      return true;
    },
  };
}

/** One run at a time per process. */
export function createSingleFlight() {
  let busy = false;
  return {
    async run(task) {
      if (busy) throw new Error("refused: another capture is already running");
      busy = true;
      try {
        return await task();
      } finally {
        busy = false;
      }
    },
    get busy() {
      return busy;
    },
  };
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Validate a tool call's input against a module spec. Inputs are IDS ONLY: a module id, a persona id,
 * state ids, viewport names. No URL, selector, script, SQL or free text is accepted anywhere.
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
export function validateToolInput(input, { modules, allowedKeys }) {
  const errors = [];
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!value) return { ok: false, errors: ["input must be an object"] };
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) errors.push(`unknown field "${key}" (accepted: ${allowedKeys.join(", ")})`);
  }
  const moduleId = value.module;
  const spec = typeof moduleId === "string" && ID.test(moduleId) ? modules[moduleId] : undefined;
  if (allowedKeys.includes("module") && !spec) errors.push("module must be one of: " + Object.keys(modules).join(", "));
  if (spec && "persona" in value) {
    if (typeof value.persona !== "string" || !spec.personas.some((persona) => persona.id === value.persona)) {
      errors.push("persona must be one of: " + spec.personas.map((persona) => persona.id).join(", "));
    }
  }
  if (spec && "states" in value) {
    const ids = Array.isArray(value.states) ? value.states : null;
    if (!ids || ids.length === 0 || ids.length > RUN_BOUNDS.maxPagesPerToolCall) {
      errors.push(`states must be a list of 1 to ${RUN_BOUNDS.maxPagesPerToolCall} state ids`);
    } else {
      for (const id of ids) {
        if (typeof id !== "string" || !spec.states.some((state) => state.id === id)) errors.push(`unknown state "${String(id).slice(0, 40)}"`);
      }
    }
  }
  if (spec && "state" in value) {
    if (typeof value.state !== "string" || !spec.states.some((state) => state.id === value.state)) errors.push("state must be a state id of the module");
  }
  if ("viewports" in value) {
    const names = Array.isArray(value.viewports) ? value.viewports : null;
    if (!names || names.length === 0 || names.some((name) => !(name in VIEWPORTS))) errors.push("viewports must be a list from: desktop, tablet, mobile");
  }
  if ("viewport" in value && !(value.viewport in VIEWPORTS)) errors.push("viewport must be one of: desktop, tablet, mobile");
  if ("runId" in value && (typeof value.runId !== "string" || !/^\d{8}-\d{6}(?:-[a-z0-9]{1,12})?$/.test(value.runId))) {
    errors.push("runId must be a run folder name such as 20261114-210501");
  }
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string" && /[<>`$\\{}]|https?:|javascript:|select\s|;/i.test(field)) errors.push(`field "${key}" holds characters that no id contains`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}
