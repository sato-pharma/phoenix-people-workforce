/**
 * What the employee reads when a stop photo carries no position. It carries "required", which the
 * stop route maps to a 400 — refused like an arrival or departure photo with no GPS, before any
 * upload. Its own module so the portal's stop card can import it without pulling the journey
 * pricer (and the governorate tables behind it) into the browser bundle.
 */
export const JOURNEY_STOP_LOCATION_REQUIRED_MESSAGE =
  "Your location is required for a stop photo, and this device did not report one. Turn on location for Phoenix, then take the photo again.";
