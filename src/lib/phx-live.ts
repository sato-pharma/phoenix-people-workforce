/**
 * True only when this process is phx-live — the owner's dev server on the Hetzner box
 * (docs/agents-worktree-and-machine-limits.md, "phx-live"). Only `/home/phx/live-ctl.sh` sets
 * `PHX_LIVE=1`; production and staging never do, so nothing gated on this can reach a real user.
 */
export function isPhxLive(env: Record<string, string | undefined> = process.env): boolean {
  return env.PHX_LIVE === "1";
}

/** The PRODUCTION Supabase project — the one holding real payroll data (AGENTS.md §3). */
export const PHOENIX_PRODUCTION_PROJECT_REF = "ozucdzovmcqvepbozvqf";

/**
 * Which database phx-live is actually reading, said in the words the owner asks in: "is this data
 * real or not?"
 *
 * 🔴 THE STRIP MUST NEVER SAY "PRODUCTION" OVER STAGING ROWS. The box is installed with staging keys
 * for testing and switched to production by `phx-live -InstallEnv`, so a strip wired to `PHX_LIVE`
 * alone announces production data while showing a staging copy — and the one number he would act on
 * is wrong. The project ref is the only thing that knows, so the strip reads it.
 */
export function phxLiveDataSource(env: Record<string, string | undefined> = process.env):
  | { kind: "production"; label: string }
  | { kind: "other"; label: string } {
  const ref = env.SUPABASE_PROJECT_REF || env.NEXT_PUBLIC_SUPABASE_URL || "";
  if (ref.includes(PHOENIX_PRODUCTION_PROJECT_REF)) {
    return { kind: "production", label: "PRODUCTION DATA — real rows, and emails & notifications are NOT sent" };
  }
  return { kind: "other", label: "NOT production data — this is a copy, nothing here is the real system" };
}
