/**
 * The portal's one place for touch feedback.
 *
 * ANDROID ONLY, and that is not a defect to chase. `navigator.vibrate` has never been implemented
 * in iOS Safari, and the `<label>`-and-switch-input trick that fakes it is not something to ship on
 * the navigation bar. So the buzz reaches the Android share of the field force and the sliding
 * indicator reaches everyone; the bar is fully usable either way, because feedback is never the
 * thing that tells you the tap worked — the page changing is.
 *
 * Silenced by reduced motion: a request for no motion is the only signal a browser gives for
 * "do not move or vibrate at me", and honouring it is cheaper than being asked twice.
 */
export function tapHaptic(reducedMotion: boolean): void {
  if (reducedMotion) return;
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(10);
  } catch {
    // A refused vibration is never an error worth raising — some browsers throw when the page is
    // not visible or the user has blocked it, and the tap itself has already worked.
  }
}
