/**
 * The Turbify console driver — the contract between the runner and a real browser.
 *
 * WHY AN INTERFACE AND NOT JUST THE PUPPETEER CODE. Two reasons, and the second is the important
 * one. First, the runner's logic is then testable without a browser. Second, and this is what the
 * interface is really for: the real driver depends on the DOM of a third party's admin console,
 * which can change without notice and which no test in this repository can pin. Keeping that
 * dependency behind one small surface means a Turbify redesign breaks ONE file with four methods,
 * not the revocation pipeline.
 *
 * 🔴 THE RULE EVERY IMPLEMENTATION MUST OBEY: never resolve as success without having positively
 * observed the console confirm it. A browser automation that assumes success because it clicked
 * something is worse than no automation, because it writes a `revoked` row for a mailbox that is
 * still live — and a false `revoked` is precisely the state this whole register exists to prevent.
 * When in doubt, THROW. A thrown step leaves the task pending, the daily sweep keeps alerting, and
 * a person looks at it. That is the safe failure.
 */

/** What one console action did. `already` means the console reported nothing left to do. */
export type RobotStepResult = "done" | "already";

/**
 * The two actions the Turbify console actually offers per mailbox, and nothing else.
 *
 * 🔴 WHY NOT `clearAppPasswords`. The original design cleared app passwords after a reset, because
 * Yahoo app passwords survive a password change. But the admin console has NO control that clears
 * them — app passwords are managed by the mailbox's own user in their personal Yahoo security page,
 * which an admin cannot reach. The console's only per-mailbox actions are Reset password, Edit,
 * Transfer account and Delete user (confirmed against the live console, 2026-09-24). So the robot
 * cannot reach the register's `revoked` state by reset-plus-clear; the only way it closes the door
 * for good is to DELETE the mailbox — which is why the owner chose "reset now, delete after N days".
 *
 * `resetPassword` blocks web login and any NEW device immediately (the reversible, done-now step);
 * `deleteMailbox` is the permanent one, gated hard and only run after the grace period.
 */
export type TurbifyConsoleDriver = {
  /**
   * Sign in and prove it. Must throw if the session is not usable — a driver that silently
   * continues unauthenticated will "successfully" do nothing to every mailbox in the run.
   */
  signIn(): Promise<void>;
  /** Reset the mailbox password to something nobody holds. Reversible; the immediate step. */
  resetPassword(address: string): Promise<RobotStepResult>;
  /**
   * Delete the mailbox.
   *
   * 🔴 PERMANENT AND UNDOABLE. Turbify offers no restore and this company keeps no mail backup, so
   * an implementation must be certain it has the right mailbox and must positively observe the
   * console confirm the deletion before returning `done`. Only ever called after the grace period,
   * on a mailbox the robot itself already reset, past every gate in safety.ts re-run live.
   */
  deleteMailbox(address: string): Promise<RobotStepResult>;
  /** Release the browser. Must never throw — a failed close must not fail a completed run. */
  close(): Promise<void>;
};

/**
 * A driver that touches nothing and reports what it would have done.
 *
 * Not a test double — this is what `PHOENIX_TURBIFY_ROBOT_DRY_RUN` selects in production, so a run
 * can be proven end to end (gates, ordering, cap, reporting) against the real register before any
 * mailbox is touched. It reports `done` so the run exercises the same path a live one would; the
 * runner is told separately that it is a dry run and writes no attestation.
 */
export function createDryRunDriver(): TurbifyConsoleDriver {
  return {
    async signIn() {},
    async resetPassword() {
      return "done";
    },
    async deleteMailbox() {
      return "done";
    },
    async close() {},
  };
}
