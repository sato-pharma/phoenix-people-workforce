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
 * The two destructive actions, and nothing else.
 *
 * Deliberately NOT `deleteMailbox` or `suspendMailbox`. Both are dispositions — decisions about
 * what becomes of a person's mail — and the owner has not delegated those to a robot. The robot
 * closes the door; a person decides what happens to the room.
 */
export type TurbifyConsoleDriver = {
  /**
   * Sign in and prove it. Must throw if the session is not usable — a driver that silently
   * continues unauthenticated will "successfully" do nothing to every mailbox in the run.
   */
  signIn(): Promise<void>;
  /** Reset the mailbox password to something nobody holds. */
  resetPassword(address: string): Promise<RobotStepResult>;
  /**
   * Revoke every app password on the mailbox.
   *
   * THE STEP THAT ACTUALLY CLOSES THE DOOR. Yahoo app passwords survive a password change, so a
   * reset alone leaves every phone and Outlook client the leaver configured still connected. The
   * database refuses to call a row `revoked` without this one, and so does the robot.
   */
  clearAppPasswords(address: string): Promise<RobotStepResult>;
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
    async clearAppPasswords() {
      return "done";
    },
    async close() {},
  };
}
