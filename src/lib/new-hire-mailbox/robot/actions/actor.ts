/**
 * Who pressed a robot button — carried from the website to the robot service so the audit row the
 * robot service writes is attributed to the Super Admin who asked, exactly as before the split
 * (audit REC-075). The website resolves it from the session; the robot service has no session and
 * takes it from the forwarded body, which only a holder of CRON_SECRET can send.
 */
export type RobotActor = {
  hrId: string | null;
  loginId: string | null;
};

function optionalId(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : undefined;
}

/**
 * The actor named in a forwarded body, or null when it is missing or malformed. At least one of the
 * two ids must be present: an audit row with neither would record a mailbox reset as nobody's act.
 */
export function parseRobotActor(value: unknown): RobotActor | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const loginId = optionalId(record.loginId);
  const hrId = optionalId(record.hrId);
  if (loginId === undefined || hrId === undefined) return null;
  if (loginId === null && hrId === null) return null;
  return { hrId, loginId };
}
