import { Directory, File, Paths } from "expo-file-system";

import { ApiError, NetworkError } from "@/lib/api";
import { crmPost, crmUpload } from "@/lib/crm/client";

/**
 * Phoenix CRM — visits waiting on the phone, on disk, until there is signal.
 *
 * ## Why this exists now and did not before
 *
 * `client.ts` states the old decision plainly: no offline cache for a CRM write, because "a rep
 * validates a customer or enters a visit only where there is a connection to take the photo". That was
 * correct while a visit could not be DATED without the server. The owner's ruling of 2026-09-27 and
 * the three phases behind it removed that obstacle — a server-minted anchor plus elapsed monotonic
 * time gives an honest Cairo capture time with no signal at all — so what is left of the old rule is
 * just a rep in a dead spot losing a real visit.
 *
 * ## 🔴 EVERY WORD A REP SEES IS GOLDEN RULE #1's
 *
 * A waiting visit is SAFE, never failed. No error count, no red, no retry button, no explanation of
 * why a send did not work. The wording lives in the shared rules module so there is one place to check
 * it. The queue is plumbing; his job is the door and the photograph.
 *
 * ## 🔴 A REP'S WORK IS NEVER DELETED TO TIDY UP
 *
 * An item leaves only when the server ACCEPTS it, or refuses it for a reason that can never change.
 * Everything else — every network failure, every 5xx — is kept and retried. When the queue is full the
 * NEWEST capture is refused at the door rather than an older one thrown away.
 *
 * ## The honest limitation, stated rather than hidden
 *
 * The elapsed time is measured with `performance.now()`, whose origin is THIS PROCESS. That is
 * stronger than a wall clock — no setting can move it — but it means an anchor does not survive the
 * app being force-closed. `runId` below is regenerated per process, so after a restart the server sees
 * a different id, refuses the delta (`rebooted`) and dates those visits at arrival instead. They are
 * still saved, still count, and are marked as offline; only the precision is lost. Re-anchoring on
 * every app open and after every successful request is what keeps that window small.
 */

/** One directory per waiting visit: the manifest beside its photo. */
const OUTBOX_DIR = "phoenix-crm-outbox";
const MANIFEST = "visit.json";
const PHOTO = "photo.jpg";

/**
 * This process's monotonic identity. A reboot always changes it; so does a force-close, which is the
 * conservative direction — see the header.
 */
const RUN_ID = `run-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

export function outboxRunId(): string {
  return RUN_ID;
}

/** Milliseconds on the clock a "change my time" app cannot touch. Never `Date.now()`. */
export function monotonicNow(): number {
  return Math.round(performance.now());
}

export type OutboxAnchor = { anchorId: string; takenAtMonotonic: number; runId: string };

export type QueuedVisit = {
  visitId: string;
  queuedAtIso: string;
  /** The save payload, exactly as an online save would have sent it, minus the photo path. */
  payload: Record<string, unknown>;
  /**
   * The anchor and the elapsed reading, so the SERVER can work out when the door was photographed.
   *
   * Null when the phone never got an anchor — it went offline before one could be taken, or the app
   * restarted and the old one died with the process. The visit is still queued, still sent and still
   * counted; the server simply dates it when it arrives and marks it for the manager's board. 🔴 A
   * missing anchor is never a reason to refuse a rep's visit, and he is never told about it.
   */
  offline: { anchorId: string; elapsedMs: number; bootId: string } | null;
  /** Set once the photo has reached storage, so a retry never burns a second upload slot. */
  photoPath: string | null;
  attempts: number;
};

function root(): Directory {
  return new Directory(Paths.document, OUTBOX_DIR);
}

function ensureRoot(): Directory {
  const dir = root();
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function itemDir(visitId: string): Directory {
  return new Directory(Paths.document, OUTBOX_DIR, visitId);
}

function readManifest(visitId: string): QueuedVisit | null {
  try {
    const file = new File(itemDir(visitId), MANIFEST);
    if (!file.exists) return null;
    const parsed = JSON.parse(file.textSync()) as QueuedVisit;
    return parsed && typeof parsed.visitId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeManifest(item: QueuedVisit): void {
  const dir = itemDir(item.visitId);
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, MANIFEST);
  if (file.exists) file.delete();
  file.create();
  file.writeSync(JSON.stringify(item));
}

/** Every waiting visit, unordered. Anything unreadable is skipped rather than throwing. */
export function listOutbox(): QueuedVisit[] {
  try {
    const dir = root();
    if (!dir.exists) return [];
    return dir
      .list()
      .flatMap((entry) => (entry instanceof Directory ? [entry.name] : []))
      .flatMap((name) => {
        const item = readManifest(name);
        return item ? [item] : [];
      });
  } catch {
    return [];
  }
}

export function outboxCount(): number {
  return listOutbox().length;
}

/**
 * Hold a visit and its photo until there is signal.
 *
 * `photoBase64` is the stamped JPEG the camera produced — the same bytes an online save would have
 * PUT to its upload slot. It is written to disk here and uploaded on the drain, which is why the
 * slot's 2-hour life never applies to a queued visit: the slot is minted fresh at sync.
 */
export function queueVisit(input: {
  visitId: string;
  payload: Record<string, unknown>;
  offline: { anchorId: string; elapsedMs: number; bootId: string } | null;
  photoBase64: string;
}): void {
  ensureRoot();
  const dir = itemDir(input.visitId);
  if (!dir.exists) dir.create({ intermediates: true });
  const photo = new File(dir, PHOTO);
  if (photo.exists) photo.delete();
  photo.create();
  photo.writeSync(input.photoBase64);
  writeManifest({
    visitId: input.visitId,
    queuedAtIso: new Date().toISOString(),
    payload: input.payload,
    offline: input.offline,
    photoPath: null,
    attempts: 0,
  });
}

function photoBase64Of(visitId: string): string | null {
  try {
    const file = new File(itemDir(visitId), PHOTO);
    return file.exists ? file.textSync() : null;
  } catch {
    return null;
  }
}

function forget(visitId: string): void {
  try {
    const dir = itemDir(visitId);
    if (dir.exists) dir.delete();
  } catch {
    // A file the OS will not release is not worth failing a drain over; the next drain tries again.
  }
}

export type DrainOutcome = { sent: number; settled: number; waiting: number };

/**
 * Send what is waiting, oldest first.
 *
 * 🔴 It NEVER throws. A drain runs in the background, after a save, on app open — nowhere a rep is
 * watching — and a thrown error there would surface as a crash on a screen he did not touch. Every
 * failure either keeps the item (the normal case) or, for a refusal that can never change, drops it.
 *
 * The verdict itself is the shared pure rule, so the phone and the test agree on what "final" means.
 */
export async function drainOutbox(
  token: string | null,
  rules: {
    order: (items: QueuedVisit[]) => QueuedVisit[];
    verdict: (outcome: { ok: boolean; kind?: "offline" | "api"; code?: string | null; status?: number }) => "retry" | "settled" | "sent";
    isStale: (item: QueuedVisit, nowIso: string) => boolean;
  },
): Promise<DrainOutcome> {
  const result: DrainOutcome = { sent: 0, settled: 0, waiting: 0 };
  const nowIso = new Date().toISOString();
  let items: QueuedVisit[];
  try {
    items = rules.order(listOutbox());
  } catch {
    return result;
  }

  for (const item of items) {
    if (rules.isStale(item, nowIso)) {
      // Kept on disk, not deleted — see the header. It simply stops being retried.
      result.waiting += 1;
      continue;
    }
    try {
      let photoPath = item.photoPath;
      if (!photoPath) {
        const base64 = photoBase64Of(item.visitId);
        if (!base64) {
          // The manifest outlived its photo. Nothing can be sent, and there is nothing to retry.
          forget(item.visitId);
          result.settled += 1;
          continue;
        }
        // Exactly the four fields `photo.ts` sends on the live path — NOT the whole visit payload.
        // The slot is issued from `purpose`, `seatId` and `test`, and sending a visit's other fields
        // here would be noise that the next change to either route could trip over.
        const uploaded = await crmUpload<{ path: string; issuedAt: string }>(
          "/api/phoenix-crm/photos/upload",
          "photo",
          {
            imageDataUrl: `data:image/jpeg;base64,${base64}`,
            purpose: "visit",
            seatId: item.payload.seatId,
            test: item.payload.test,
          },
          token,
        );
        photoPath = uploaded.path;
        writeManifest({ ...item, photoPath, attempts: item.attempts + 1 });
      }

      await crmPost("/api/phoenix-crm/visits", "visit", { ...item.payload, photoPath, offline: item.offline }, token);
      forget(item.visitId);
      result.sent += 1;
    } catch (error) {
      const verdict = rules.verdict({
        ok: false,
        kind: error instanceof ApiError ? "api" : error instanceof NetworkError ? "offline" : "offline",
        code: error instanceof ApiError ? error.code : null,
        status: error instanceof ApiError ? error.status : undefined,
      });
      if (verdict === "settled") {
        forget(item.visitId);
        result.settled += 1;
      } else {
        writeManifest({ ...item, attempts: item.attempts + 1 });
        result.waiting += 1;
        // One dead connection means the rest will fail too; stop rather than burn the battery.
        if (!(error instanceof ApiError)) break;
      }
    }
  }

  return result;
}
