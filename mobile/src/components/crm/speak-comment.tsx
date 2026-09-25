import { RecordingPresets, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";

import { CrmNote } from "@/components/crm/crm-kit";
import { PrimaryButton } from "@/components/ui";
import {
  VOICE_MAX_SECONDS,
  crmVoiceTranscriptionAvailable,
  describeMissingCrmMicrophone,
  prepareCrmMicrophone,
  storeCrmVoiceNote,
  type CrmVoiceNote,
} from "@/lib/crm/voice";
import { useSession } from "@/lib/session";
import { space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";

/**
 * Phoenix CRM — the microphone on the visit comment, on the phone.
 *
 * It is the native half of the owner's instruction of 2026-09-25: one microphone that both keeps the
 * recording AND writes what was said into the comment as Egyptian Arabic text. "It must work normally in
 * application, mobile application, and in all fucking browsers."
 *
 * 🔴 IT WRITES AFTER STOP, NEVER AS HE TALKS, AND THE COPY MUST KEEP SAYING SO. React Native has no Web
 * Speech API and there is no free on-device Arabic recogniser to put in its place, so this takes the same
 * route the web takes on Firefox: the finished recording goes to Phoenix's own server to be written out,
 * and the words land a few seconds after Stop. A rep told the words appear while he speaks watches an
 * empty box for a minute and presses Stop believing it failed — which is precisely the report that
 * started this feature. Do not add a live preview, an interim line, or a "listening" label here.
 *
 * THE RECORDING IS SAVED FIRST AND THE WORDS ARE ASKED FOR SECOND (`storeCrmVoiceNote`), so a speech
 * service that refuses costs him the typing he would have done anyway and can never cost him what he
 * said. That is why a failed transcription shows an ordinary note rather than an error: the recording is
 * safe, and reporting a failure over a half that worked teaches him to record it all again.
 *
 * 🔴 THE NOTE IS THE PARENT'S, NOT THIS COMPONENT'S, AND THAT IS WHY. A recording that is uploaded but not
 * named in the visit payload (`voiceNotePath`) is an orphan: the bytes sit in the private bucket, its slot
 * is never consumed, and the audio the rep believes he attached is attached to nothing. So the stored note
 * is handed straight out through `onChange` and lives in the form's state beside the photo — the same
 * shape `CrmLivePhoto` uses, for the same reason.
 *
 * AND THE WORDS ARE APPENDED, NEVER SUBSTITUTED (`appendCrmDictated`). He may have typed while waiting.
 */

/** The polling interval for the clock. Half a second is the hook's own default and is plenty for mm:ss. */
const CLOCK_MS = 500;

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function CrmSpeakComment({
  disabled = false,
  onAppend,
  onChange,
  seatId,
  test,
  value,
}: {
  disabled?: boolean;
  /** The Arabic the service made of the recording, to append to the comment — never to replace it. */
  onAppend: (spoken: string) => void;
  /** The stored recording, which the visit payload must carry as `voiceNotePath`. */
  onChange: (note: CrmVoiceNote | null) => void;
  seatId: string;
  test: boolean;
  value: CrmVoiceNote | null;
}) {
  const palette = usePalette();
  const { handleExpiredSession, token } = useSession();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, CLOCK_MS);

  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [silent, setSilent] = useState(false);
  /** Whether the words can be written out at all. Optimistic: only a definite "no" withdraws the promise. */
  const [canWrite, setCanWrite] = useState(true);
  // `finish` is reachable from the auto-stop effect as well as the button, and the two must not overlap:
  // a second `stop()` on an already-stopped recorder rejects, and an unhandled rejection here is a red
  // screen over a recording that was perfectly fine.
  const stopping = useRef(false);

  useEffect(() => {
    let alive = true;
    void crmVoiceTranscriptionAvailable(token).then((answer) => {
      if (alive) setCanWrite(answer);
    });
    return () => {
      alive = false;
    };
  }, [token]);

  async function finish() {
    if (stopping.current) return;
    stopping.current = true;
    // Read the length BEFORE stopping: the polled state resets once the recorder is closed, and a note
    // saved as "0:00" is the one thing on this control nobody can recover by listening.
    const seconds = Math.max(Math.round(state.durationMillis / 1000), Math.round(recorder.currentTime || 0));
    setWorking(true);
    try {
      await recorder.stop();
    } catch {
      stopping.current = false;
      setWorking(false);
      setProblem("The recording could not be closed on this phone. Press the microphone and speak again.");
      return;
    }
    const uri = recorder.uri;
    stopping.current = false;

    if (!uri) {
      setWorking(false);
      setProblem("Nothing was recorded. Press the microphone and speak again.");
      return;
    }

    const outcome = await storeCrmVoiceNote({ seatId, seconds, test, token, uri });
    setWorking(false);
    if (outcome.status === "session-expired") {
      await handleExpiredSession();
      return;
    }
    if (outcome.status === "failed") {
      setProblem(outcome.message);
      return;
    }
    onChange(outcome.note);
    // Empty text with the note stored is the ordinary "could not make it out" ending, not a failure: the
    // recording is saved and the only thing left is to type. It gets an ordinary note, never a red one.
    setSilent(outcome.text.length === 0);
    if (outcome.text) onAppend(outcome.text);
  }

  async function start() {
    if (working || state.isRecording) return;
    setProblem(null);
    setSilent(false);
    const access = await prepareCrmMicrophone();
    if (!access.granted) {
      setProblem(describeMissingCrmMicrophone(access));
      return;
    }
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch {
      setProblem("The microphone could not be opened. Type the comment instead.");
    }
  }

  // The cap the browser recorder keeps, so a note from either client is the same length of speech. Driven
  // by the polled clock rather than a `setTimeout`, because a timer keeps counting while the OS has the
  // recorder suspended for an incoming call and would cut a recording that had barely started.
  useEffect(() => {
    if (state.isRecording && state.durationMillis >= VOICE_MAX_SECONDS * 1000) void finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.durationMillis, state.isRecording]);

  if (state.isRecording) {
    return (
      <View style={{ gap: space.sm }}>
        <PrimaryButton label={`Stop — ${clock(state.durationMillis / 1000)} of ${clock(VOICE_MAX_SECONDS)}`} onPress={() => void finish()} />
        <Text style={[type.meta, { color: palette.inkSoft }]}>
          {canWrite ? "Keeping the recording. The words are written when you stop." : "Keeping the recording. The words are not being written."}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ gap: space.sm }}>
      <PrimaryButton
        busy={working}
        busyLabel="Writing out the words — this takes a few seconds."
        disabled={disabled}
        label={value ? "Speak again" : "Speak the comment"}
        onPress={() => void start()}
      />
      {value ? <Text style={[type.meta, { color: palette.inkSoft }]}>{`Recording saved — ${clock(value.seconds)}.`}</Text> : null}
      {canWrite ? (
        <>
          <Text style={[type.meta, { color: palette.inkSoft }]}>
            The app cannot turn speech into text on its own, so Phoenix sends the recording to Groq&apos;s speech service to be written out. Nothing else reads it.
          </Text>
          <Text style={[type.meta, { color: palette.inkSoft }]}>
            The text is what the speech service made of the recording, so read it before you save — the recording is what you actually said.
          </Text>
        </>
      ) : (
        <Text style={[type.meta, { color: palette.inkSoft }]}>
          The words cannot be written out right now, so the recording is kept and the comment is typed.
        </Text>
      )}
      {silent ? <CrmNote tone="info">Nothing could be made out in the recording. The recording is saved — type the comment instead.</CrmNote> : null}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </View>
  );
}
