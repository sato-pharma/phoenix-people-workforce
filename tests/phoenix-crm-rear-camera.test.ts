import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { hasSecondCamera, openFrontCamera, openRearCamera } from "../src/lib/phoenix-crm/rear-camera.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The validation camera opens the REAR lens. On 19 Oct 2026 a medical rep validating a customer got
 * the selfie camera: `facingMode: { ideal: "environment" }` is a preference that Chrome ranks beside
 * the size wishes, and her Samsung ranked the front lens higher.
 */

type Constraints = MediaStreamConstraints & { video: MediaTrackConstraints };

function fakeStream(label: string, facingMode?: string) {
  let stopped = 0;
  const stream = {
    label,
    stopped: () => stopped,
    getTracks: () => [{ stop: () => (stopped += 1) }],
    getVideoTracks: () => [{ getSettings: () => ({ facingMode }) }],
  };
  return stream as unknown as MediaStream & { label: string; stopped: () => number };
}

function domError(name: string) {
  return new DOMException(name, name);
}

const IDEAL = { height: 1440, width: 2560 };

export async function runPhoenixCrmRearCameraTests(): Promise<void> {
  // ── The rear lens is asked for with `exact` first ─────────────────────────────
  {
    const asked: Constraints[] = [];
    const rear = fakeStream("rear", "environment");
    const stream = await openRearCamera(
      {
        getUserMedia: async (constraints) => {
          asked.push(constraints as Constraints);
          return rear;
        },
        enumerateDevices: async () => [],
      },
      IDEAL,
    );
    assert.equal(stream, rear);
    assert.equal(asked.length, 1, "a phone that has a rear lens is asked once");
    assert.deepEqual(asked[0].video.facingMode, { exact: "environment" }, "the rear lens is REQUIRED, not preferred");
    assert.deepEqual(asked[0].video.width, { ideal: 2560 });
    assert.equal(asked[0].audio, false);
  }

  // ── A device that cannot name a rear lens (a laptop) still opens its camera ─────
  {
    const asked: Constraints[] = [];
    const webcam = fakeStream("webcam");
    const stream = await openRearCamera(
      {
        getUserMedia: async (constraints) => {
          asked.push(constraints as Constraints);
          if ((asked[asked.length - 1].video.facingMode as { exact?: string }).exact) throw domError("OverconstrainedError");
          return webcam;
        },
        enumerateDevices: async () => [],
      },
      IDEAL,
    );
    assert.equal(stream, webcam);
    assert.deepEqual(asked[1].video.facingMode, { ideal: "environment" }, "the laptop falls back to the preference");
  }

  // ── A refused permission is the rep's answer and is never asked again ───────────
  {
    let calls = 0;
    await assert.rejects(
      openRearCamera(
        {
          getUserMedia: async () => {
            calls += 1;
            throw domError("NotAllowedError");
          },
          enumerateDevices: async () => [],
        },
        IDEAL,
      ),
      (error: unknown) => error instanceof DOMException && error.name === "NotAllowedError",
    );
    assert.equal(calls, 1, "a blocked camera is not retried through the looser constraint");
  }

  // ── A phone that still hands over the selfie lens is switched to the lens it names as the back ──
  {
    const asked: Constraints[] = [];
    const selfie = fakeStream("selfie", "user");
    const back = fakeStream("back", "environment");
    const stream = await openRearCamera(
      {
        getUserMedia: async (constraints) => {
          asked.push(constraints as Constraints);
          return (constraints as Constraints).video.deviceId ? back : selfie;
        },
        enumerateDevices: async () =>
          [
            { kind: "videoinput", label: "camera2 1, facing front", deviceId: "front-1" },
            { kind: "videoinput", label: "camera2 0, facing back", deviceId: "back-0" },
          ] as MediaDeviceInfo[],
      },
      IDEAL,
    );
    assert.equal(stream, back, "the back lens is what the rep gets");
    assert.deepEqual(asked[1].video.deviceId, { exact: "back-0" });
    assert.equal(selfie.stopped(), 1, "the selfie stream is released, or the camera light stays on");
  }

  // ── No lens named as a back one: keep what the phone gave rather than show nothing ──
  {
    const selfie = fakeStream("selfie", "user");
    const stream = await openRearCamera(
      {
        getUserMedia: async () => selfie,
        enumerateDevices: async () => [{ kind: "videoinput", label: "camera2 1, facing front", deviceId: "front-1" }] as MediaDeviceInfo[],
      },
      IDEAL,
    );
    assert.equal(stream, selfie);
    assert.equal(selfie.stopped(), 0);
  }

  // ── Switch camera (owner, 2026-11-02): the front lens is asked for exactly, then loosely ──
  {
    const asked: Constraints[] = [];
    const front = fakeStream("front", "user");
    const stream = await openFrontCamera(
      {
        getUserMedia: async (constraints) => {
          asked.push(constraints as Constraints);
          if ((asked[asked.length - 1].video.facingMode as { exact?: string }).exact) throw domError("OverconstrainedError");
          return front;
        },
        enumerateDevices: async () => [],
      },
      IDEAL,
    );
    assert.equal(stream, front);
    assert.deepEqual(asked[0].video.facingMode, { exact: "user" }, "the front lens is asked for exactly first");
    assert.deepEqual(asked[1].video.facingMode, { ideal: "user" });
  }
  {
    let calls = 0;
    await assert.rejects(
      openFrontCamera(
        {
          getUserMedia: async () => {
            calls += 1;
            throw domError("NotAllowedError");
          },
          enumerateDevices: async () => [],
        },
        IDEAL,
      ),
    );
    assert.equal(calls, 1, "a blocked camera is not retried on the switch either");
  }

  // ── The switch is offered only on a phone with a second lens ──
  {
    const lens = (deviceId: string) => ({ kind: "videoinput", label: "", deviceId }) as MediaDeviceInfo;
    const mic = { kind: "audioinput", label: "", deviceId: "mic" } as MediaDeviceInfo;
    assert.equal(await hasSecondCamera({ enumerateDevices: async () => [lens("a"), lens("b")] }), true);
    assert.equal(await hasSecondCamera({ enumerateDevices: async () => [lens("a"), mic] }), false, "a laptop's one webcam gets no switch");
    assert.equal(
      await hasSecondCamera({
        enumerateDevices: async () => {
          throw new Error("no list");
        },
      }),
      false,
      "an unreadable list draws no dead button",
    );
  }

  // ── The validation camera goes through it, and nothing asks for the rear lens loosely ──
  const capture = stripComments(readFileSync("src/components/phoenix-crm/live-photo-capture.tsx", "utf8"));
  assert.match(capture, /openRearCamera\(navigator\.mediaDevices/, "live-photo-capture opens its camera through openRearCamera");
  assert.doesNotMatch(capture, /getUserMedia\s*\(/, "live-photo-capture no longer calls getUserMedia itself with a mere preference");
  assert.match(capture, /useRef<CameraFacing>\("environment"\)/, "the camera always opens on the rear lens");
  assert.match(capture, /openFrontCamera\(navigator\.mediaDevices/, "the front lens is opened only through openFrontCamera");
  assert.match(capture, /onClick=\{\(\) => void switchCamera\(\)\}/, "the live camera carries a Switch camera button");
  assert.match(capture, /canSwitch \? \(/, "the switch is drawn only when the phone has a second lens");
}
