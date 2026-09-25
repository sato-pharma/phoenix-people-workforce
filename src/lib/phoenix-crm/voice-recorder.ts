/**
 * Phoenix CRM — recording a visit voice note on the device.
 *
 * This is the OTHER half of the spoken visit and it is not dictation. Dictation
 * (`./dictation.ts`) sends audio to Google or Apple and gives back text, and what
 * saves is text in the `comment` column. This records audio, keeps it as audio, and
 * transcribes it NEVER — no speech API, no recogniser, no third party, so Egyptian
 * Arabic is stored exactly as it was spoken with nothing in between to mishear it.
 * The two features must not be described as one another, and a later change to one
 * is not a change to the other.
 *
 * It behaves the same on Chrome, Safari, Firefox and inside WhatsApp's in-app
 * browser, because `MediaRecorder` is the only thing it needs.
 *
 * Storage is the real constraint, so the size is bounded in three independent
 * places rather than one: the cap below, a low mono bitrate, and a column check in
 * the database. Sixty seconds of Opus at 24 kbps is about 180 KB.
 */

/** A minute is long for a spoken note and short enough that a pocket cannot fill a bucket. */
export const MAX_SECONDS = 60;

/** Mono, low bitrate. Speech does not need more and the bucket is finite. */
const BITS_PER_SECOND = 24_000;

/**
 * Each engine records a different container: Chrome and Firefox give webm/opus,
 * Safari gives mp4/aac. Whatever the browser offers is taken and its MIME type is
 * stored with it, rather than converting on a phone that would pay for it.
 */
const CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export function isRecordingSupported(): boolean {
  return (
    typeof window !== "undefined"
    && typeof MediaRecorder !== "undefined"
    && Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const type of CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // Safari has historically thrown here rather than returning false.
    }
  }
  return undefined; // let the browser choose its own default
}

/**
 * The extension for what actually got recorded.
 *
 * The slot is issued before the recording exists, so the server cannot know which
 * container the phone will produce — which is why a voice slot's path carries the
 * extension the CLIENT asks for, and the server validates it against this same
 * list rather than hardcoding one the way the photo slot hardcodes `.jpg`.
 */
export function extensionFor(mimeType: string): string {
  if (mimeType.includes("mp4") || mimeType.includes("aac")) return ".m4a";
  if (mimeType.includes("ogg")) return ".ogg";
  if (mimeType.includes("mpeg")) return ".mp3";
  return ".webm";
}

export type Recording = { blob: Blob; mimeType: string; seconds: number };

export type VoiceRecorder = {
  stop: () => Promise<Recording>;
  cancel: () => void;
};

/**
 * Starts recording and resolves with a controller. The caller decides when to stop;
 * it also stops itself at MAX_SECONDS.
 */
export async function startRecording(onTick?: (seconds: number) => void): Promise<VoiceRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(
    stream,
    mimeType ? { mimeType, audioBitsPerSecond: BITS_PER_SECOND } : { audioBitsPerSecond: BITS_PER_SECOND },
  );

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const startedAt = Date.now();
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
  const ticker = window.setInterval(() => onTick?.(elapsed()), 250);

  /**
   * Hand the microphone back.
   *
   * Every exit goes through here and none may skip it: a live track is a microphone
   * the phone still considers in use, and the OS says so in the status bar long
   * after this form thinks it has finished. Safe to call twice.
   */
  const release = () => {
    window.clearInterval(ticker);
    window.clearTimeout(limit);
    for (const track of stream.getTracks()) track.stop();
  };

  let stopResolver: ((value: Recording) => void) | null = null;

  recorder.onstop = () => {
    const seconds = Math.max(1, elapsed());
    const type = recorder.mimeType || mimeType || "audio/webm";
    release();
    stopResolver?.({ blob: new Blob(chunks, { type }), mimeType: type, seconds });
  };

  // Hard cap. Without this, one forgotten recording is the storage budget.
  const limit = window.setTimeout(() => {
    if (recorder.state === "recording") recorder.stop();
  }, MAX_SECONDS * 1000);

  // getUserMedia has already granted the microphone, so a recorder that refuses to
  // start would otherwise leave it granted to nobody — open, with no controller in
  // anyone's hands to close it.
  try {
    recorder.start();
  } catch (error) {
    release();
    throw error;
  }

  return {
    stop: () =>
      new Promise<Recording>((resolve) => {
        stopResolver = resolve;
        // Anything not already inactive still holds the microphone, and PAUSED is the
        // case that matters: a phone that backgrounds the tab mid-recording pauses it
        // rather than stopping it. Treating that as "nothing to stop" is what leaves
        // the mic open. Stopping properly also flushes the last chunk.
        if (recorder.state !== "inactive") recorder.stop();
        else {
          release();
          resolve({
            blob: new Blob(chunks),
            mimeType: recorder.mimeType || mimeType || "audio/webm",
            seconds: elapsed(),
          });
        }
      }),
    cancel: () => {
      stopResolver = null;
      recorder.onstop = null;
      if (recorder.state === "recording") recorder.stop();
      release();
    },
  };
}

export function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The bucket refuses anything larger; a minute of mono Opus is about 180 KB. */
export const VOICE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Whether a finished recording is worth keeping.
 *
 * A tap that opens and closes the microphone produces a container header and no
 * speech. Saving it costs a row, a storage object and a reviewer's time opening
 * silence, so it is refused here with a sentence that says what to do instead.
 */
export function rejectRecording(result: Recording): string | null {
  if (result.seconds < 1 || result.blob.size < 1024) {
    return "That was too short to save. Hold the button a little longer.";
  }
  if (result.blob.size > VOICE_MAX_BYTES) {
    return "That recording is larger than Phoenix accepts. Record a shorter note.";
  }
  return null;
}
