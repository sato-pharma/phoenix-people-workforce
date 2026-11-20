
/** Why an offline time could not be established. A refusal is silent to the rep; see the header. */
type OfflineClockRefusal =
  | "no_anchor"
  | "anchor_not_his"
  | "anchor_too_old"
  | "elapsed_negative"
  | "elapsed_impossible"
  | "rebooted";

// ── Bounds ──────────────────────────────────────────────────────────────────────────────────────

/**
 * How long an anchor may be used for.
 *
 * A field day, plus enough slack for a rep who starts before dawn and syncs after dinner. Beyond
 * that the monotonic delta has had too long to drift against real time — cheap phone oscillators
 * wander by seconds a day, which is irrelevant over a morning and starts to matter over a week.
 * The app re-anchors on every successful request, so in practice an anchor is minutes old.
 */
export const ANCHOR_MAX_AGE_SECONDS = 20 * 60 * 60;

/**
 * Slack allowed when comparing the claimed elapsed time against the window the server can prove.
 *
 * The server's two readings (anchor issued, visit received) bracket the phone's two monotonic
 * readings, so an honest claim is always SMALLER than the window. This tolerance covers the
 * rounding of milliseconds and the few seconds a slow upload adds — not a discrepancy of minutes.
 */
export const ELAPSED_TOLERANCE_SECONDS = 120;

/**
 * Past this, an offline visit is still accepted and still counts — it is simply worth a manager's
 * eye. A rep in a dead spot all morning is ordinary; a phone that held a visit for two days is not
 * obviously anything, and the board is where a human decides which.
 */
export const OFFLINE_GAP_NOTABLE_SECONDS = 12 * 60 * 60;

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────

/** The anchor as the SERVER holds it. Nothing here comes from the phone. */
export type TimeAnchorRecord = {
  anchorId: string;
  /** The server's own clock when it wrote the row. The starting point of the whole calculation. */
  issuedAt: Date;
  hrId: string;
  seatId: string;
  /** Android's boot identity as the phone reported it when the anchor was taken, or null. */
  bootId: string | null;
  isTest: boolean;
};

/** What the phone sends. 🔴 Note what is absent: any timestamp at all. */
export type OfflineCaptureClaim = {
  anchorId: string;
  /** Monotonic milliseconds elapsed between taking the anchor and pressing the shutter. */
  elapsedMs: number;
  /**
   * The phone's boot identity at capture. A reboot resets the monotonic clock to zero, so a delta
   * measured across one is meaningless — this is how the server can tell.
   */
  bootId: string | null;
};

export type OfflineClockContext = {
  /** The server's clock when the queued visit finally arrived. The far end of the provable window. */
  receivedAt: Date;
  hrId: string;
  seatId: string;
};

export type OfflineClockVerdict =
  | { ok: true; capturedAt: Date; offlineSeconds: number; clamped: boolean; notable: boolean }
  | { ok: false; refusal: OfflineClockRefusal };

// ── The derivation ──────────────────────────────────────────────────────────────────────────────

const seconds = (ms: number): number => Math.round(ms / 1000);

/**
 * Turn an anchor and an elapsed duration into a capture time the server is willing to stand behind.
 *
 * 🔴 **Every failure here is SILENT to the rep** (Golden Rule #1). A refusal is not an error message
 * on his phone — the visit is still saved, by the caller, dated at arrival and marked for the board.
 * A rep whose phone was rebooted mid-queue has done nothing wrong and must not be told a check
 * exists; a rep who patched his build must not be told which check caught him.
 */
export function deriveOfflineCaptureTime(
  anchor: TimeAnchorRecord | null,
  claim: OfflineCaptureClaim,
  context: OfflineClockContext,
): OfflineClockVerdict {
  if (!anchor) return { ok: false, refusal: "no_anchor" };

  // An anchor belongs to one person in one territory. Lending one is how a rep at home dates a
  // visit from a colleague's morning.
  if (anchor.hrId.toUpperCase() !== context.hrId.toUpperCase() || anchor.seatId !== context.seatId) {
    return { ok: false, refusal: "anchor_not_his" };
  }

  // 🔴 A reboot resets the monotonic clock, so a delta spanning one measures nothing. Null on
  // either side is unknown, not equal — an old build that cannot report it is not evidence of a
  // reboot, and treating unknown as a match would let a real reboot through.
  if (anchor.bootId !== null && claim.bootId !== null && anchor.bootId !== claim.bootId) {
    return { ok: false, refusal: "rebooted" };
  }

  const anchorAgeSeconds = seconds(context.receivedAt.getTime() - anchor.issuedAt.getTime());
  if (anchorAgeSeconds < 0) return { ok: false, refusal: "elapsed_impossible" };
  if (anchorAgeSeconds > ANCHOR_MAX_AGE_SECONDS) return { ok: false, refusal: "anchor_too_old" };

  if (!Number.isFinite(claim.elapsedMs) || claim.elapsedMs < 0) return { ok: false, refusal: "elapsed_negative" };
  const elapsedSeconds = seconds(claim.elapsedMs);

  // 🔴 THE BOUND THAT DOES THE WORK. The server wrote the anchor and the server received the visit,
  // so it knows both ends of the window first-hand. An honest phone's elapsed time always falls
  // INSIDE it. A claim beyond it is impossible rather than merely suspicious.
  if (elapsedSeconds > anchorAgeSeconds + ELAPSED_TOLERANCE_SECONDS) {
    return { ok: false, refusal: "elapsed_impossible" };
  }

  // Inside tolerance but past the window: honest rounding. Pull it back to the window's edge rather
  // than refuse — the correction is at most the tolerance, and it only ever moves the claim TOWARDS
  // the truth. Nothing here can ever push a capture time later than the server's own receipt.
  const clamped = elapsedSeconds > anchorAgeSeconds;
  const usedSeconds = clamped ? anchorAgeSeconds : elapsedSeconds;

  const capturedAt = new Date(anchor.issuedAt.getTime() + usedSeconds * 1000);
  const offlineSeconds = Math.max(0, seconds(context.receivedAt.getTime() - capturedAt.getTime()));

  return {
    ok: true,
    capturedAt,
    offlineSeconds,
    clamped,
    notable: offlineSeconds > OFFLINE_GAP_NOTABLE_SECONDS,
  };
}

/**
 * The Cairo day a derived capture time files under.
 *
 * Stated here rather than left to the caller because this is where an offline visit most easily
 * lands on the wrong day: the whole point of the anchor is that a visit captured at 19:00 and
 * synced at 02:00 belongs to the 19:00 day, and a caller reaching for the arrival time would undo
 * every line above.
 */
export function cairoDayOf(when: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
}

/**
 * Plain wording for the board. The audience is the Super Admin and the SFE Manager; a rep never
 * sees any of this, and no refusal above ever reaches his screen.
 */
export const OFFLINE_CLOCK_LABELS: Record<OfflineClockRefusal, string> = {
  no_anchor: "The phone had no server time to measure from",
  anchor_not_his: "The server time it measured from was issued to somebody else",
  anchor_too_old: "The server time it measured from was more than a day old",
  elapsed_negative: "The phone reported time running backwards",
  elapsed_impossible: "The phone claimed more elapsed time than had actually passed",
  rebooted: "The phone restarted while the visit was waiting, so its stopwatch had reset",
};

// ── Reading the claim off a request body ────────────────────────────────────────────────────────

/**
 * The claim, parsed from whatever the phone sent — in ONE place, so there is exactly one answer to
 * "what may a phone say about time".
 *
 * 🔴 **It reads three fields and there is no fourth.** An anchor id, an elapsed duration and a boot
 * id. A body carrying a timestamp is not partially honoured: the timestamp is simply never looked
 * at, because no line here looks for one. That is the structural form of the owner's requirement,
 * and it is what the test asserts rather than trusting a comment.
 *
 * Returns null for an online save, which is every save that names no anchor. An unusable claim also
 * returns null rather than an error: the visit is then dated by the photo slot as it always was, and
 * the rep is told nothing.
 */
export function parseOfflineCaptureClaim(raw: Record<string, unknown>): OfflineCaptureClaim | null {
  const source = raw.offline && typeof raw.offline === "object" ? (raw.offline as Record<string, unknown>) : null;
  if (!source) return null;
  const anchorId = typeof source.anchorId === "string" ? source.anchorId.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(anchorId)) return null;
  const elapsed = Number(source.elapsedMs);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const bootId = typeof source.bootId === "string" && source.bootId.trim() ? source.bootId.trim().slice(0, 120) : null;
  return { anchorId, elapsedMs: Math.round(elapsed), bootId };
}
