import { clientSafeErrorMessage } from "@/lib/http/api-errors";

// The outcome of confirming a Monthly Sales step AFTER its upload was already saved.
//
// The Office commit saves the allocation first and confirms the run's Office step second. The
// confirm used to run inside `.catch(() => {})`, so when it failed — no run for the period, the
// step missing, a zero-row update (the case updateStep now throws for) — the operator read "Office
// allocation saved." while the step stayed pending, and the period could not lock with nothing on
// screen saying why. The save is real and must not be reported as a failure; the unconfirmed step
// must not be silent either. So the confirm is settled into a value the reply carries.
export type StepConfirmation = { confirmed: true } | { confirmed: false; reason: string };

export async function settleStepConfirmation(
  confirm: () => Promise<unknown>,
  onFailure?: (error: unknown) => void,
): Promise<StepConfirmation> {
  try {
    await confirm();
    return { confirmed: true };
  } catch (error) {
    onFailure?.(error);
    return {
      confirmed: false,
      reason: clientSafeErrorMessage(error, "The Monthly Sales step could not be marked confirmed."),
    };
  }
}

/** What the operator reads after a saved Office commit. */
export function officeCommitMessage(stepConfirmation: StepConfirmation | null): string {
  if (stepConfirmation && !stepConfirmation.confirmed) {
    return `Office allocation saved, but the Office step was NOT marked confirmed: ${stepConfirmation.reason}`;
  }
  return "Office allocation saved.";
}
