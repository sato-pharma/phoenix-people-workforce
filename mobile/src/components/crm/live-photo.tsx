import { Image } from "expo-image";
import { useState } from "react";
import { Text, View } from "react-native";

import { CrmNote } from "@/components/crm/crm-kit";
import { PrimaryButton, SecondaryButton } from "@/components/ui";
import { captureCrmPhoto, type CrmCapturedPhoto, type CrmPhotoStep } from "@/lib/crm/photo";
import { useSession } from "@/lib/session";
import { hairline, radius, space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";

/**
 * Phoenix CRM — the live-photo button, the native counterpart of the web `LivePhotoCapture`
 * (src/components/phoenix-crm/live-photo-capture.tsx).
 *
 * The camera only, never the gallery (see `camera.ts`): the whole worth of this photo is that it was
 * taken at the door, now. It hands the capture to `captureCrmPhoto`, which asks for location first,
 * opens the camera, stamps the frame with the time, the address and the coordinates, and uploads it —
 * and returns a `CrmCapturedPhoto` the save consumes. On a captured photo the button becomes a preview
 * with "Take another photo"; a session that expired mid-upload signs the app out.
 */

const STEP_LABELS: Record<CrmPhotoStep, string> = {
  address: "Looking up the address…",
  locating: "Finding your location…",
  opening: "Opening camera…",
  sending: "Saving the photo…",
  stamping: "Stamping the photo…",
};

export function CrmLivePhoto({
  allowOffline = false,
  disabled = false,
  hint,
  onChange,
  purpose,
  seatId,
  test,
  title,
  value,
}: {
  /**
   * Let a dropped connection keep the photo instead of refusing it. The visit camera passes this;
   * the place camera never can, because the server resolves a place's territory at capture.
   */
  allowOffline?: boolean;
  disabled?: boolean;
  /** A line under the camera, e.g. where to stand. Omitted on the visit camera (owner, 2026-09-23). */
  hint?: string;
  onChange: (photo: CrmCapturedPhoto | null) => void;
  purpose: "place" | "visit";
  seatId: string;
  test: boolean;
  /** The customer's name, burned onto the photo's reference line. */
  title: string;
  value: CrmCapturedPhoto | null;
}) {
  const palette = usePalette();
  const { handleExpiredSession, token, user } = useSession();
  const [step, setStep] = useState<CrmPhotoStep | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function take() {
    if (step) return;
    setProblem(null);
    setStep("opening");
    const outcome = await captureCrmPhoto({
      allowOffline,
      employeeHrId: user?.hrId ?? "",
      onStep: setStep,
      purpose,
      seatId,
      test,
      title,
      token,
    });
    setStep(null);
    switch (outcome.status) {
      case "captured":
        onChange(outcome.photo);
        return;
      case "cancelled":
        return;
      case "session-expired":
        await handleExpiredSession();
        return;
      case "failed":
        setProblem(outcome.message);
        return;
    }
  }

  if (value) {
    return (
      <View style={{ gap: space.sm }}>
        <View style={{ backgroundColor: palette.paper2, borderColor: palette.line, borderRadius: radius, borderWidth: hairline, overflow: "hidden" }}>
          <Image contentFit="contain" source={{ uri: value.previewUri }} style={{ height: 240, width: "100%" }} transition={120} />
        </View>
        <View style={{ alignItems: "center", flexDirection: "row", gap: space.xs }}>
          <Text style={[type.meta, { color: palette.inkSoft, flexShrink: 1 }]}>{value.locationLabel}</Text>
        </View>
        <SecondaryButton label="Take another photo" onPress={() => void take()} />
        {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
      </View>
    );
  }

  return (
    <View style={{ gap: space.sm }}>
      <PrimaryButton
        busy={step !== null}
        busyLabel={step ? STEP_LABELS[step] : undefined}
        disabled={disabled}
        label="Open camera"
        onPress={() => void take()}
      />
      {hint ? <Text style={[type.meta, { color: palette.inkSoft }]}>{hint}</Text> : null}
      <Text style={[type.meta, { color: palette.inkSoft }]}>Your location is recorded with the photo. Without it, the photo is refused.</Text>
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </View>
  );
}
