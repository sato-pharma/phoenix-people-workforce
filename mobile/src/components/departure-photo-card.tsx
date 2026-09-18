import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";

import { ErrorNotice, PrimaryButton } from "@/components/ui";
import { captureDeparturePhoto, type DeparturePhotoStep } from "@/lib/evidence-photo";
import { useSession } from "@/lib/session";
import { hairline, radius, space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";
import type { DeparturePhotoDue } from "@/types/portal";

/**
 * "Departure photo needed" — the native counterpart of the portal's `DeparturePhotoCard`
 * (`src/components/outstation/departure-photo-card.tsx`). Same words, same list, same two routes;
 * the capture itself lives in `evidence-photo.ts`.
 *
 * Camera only, like the portal: there is no gallery button, because the whole value of this photo
 * is that it was taken at the destination.
 *
 * THE SAVED MESSAGE OUTLIVES THE ROW. A save refreshes the list, and the refreshed list no longer
 * holds the trip — so a message kept inside the trip's row would vanish the moment it appeared,
 * taking the server's review of the pair with it. It is kept at the card level instead, naming the
 * destination, until the next capture starts.
 */

const STEP_LABELS: Record<DeparturePhotoStep, string> = {
  address: "Looking up the address…",
  locating: "Finding your location…",
  opening: "Opening camera…",
  sending: "Saving…",
  stamping: "Stamping the photo…",
};

type CaptureState =
  | { kind: "idle" }
  | { kind: "busy"; requestId: number; step: DeparturePhotoStep }
  | { kind: "error"; message: string; requestId: number }
  | { destination: string; kind: "saved"; locationNote: string | null; message: string; requestId: number };

/**
 * "Tuesday 17 October 2026" — the portal's `formatPhoenixLongDate`, for a calendar date.
 *
 * Built at noon UTC and formatted in UTC, so the day printed is the day the trip was booked for on
 * a phone set to any zone; a trip date is a date, not an instant, and has no zone of its own.
 */
function formatTripDate(value: string): string {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
  }).format(date);
}

export function DeparturePhotoCard({
  onSaved,
  requests,
}: {
  /** Called after a photo is accepted, so the screen re-reads the list. */
  onSaved: () => void;
  requests: DeparturePhotoDue[];
}) {
  const palette = usePalette();
  const { handleExpiredSession, token, user } = useSession();
  const [state, setState] = useState<CaptureState>({ kind: "idle" });

  const capture = useCallback(
    async (request: DeparturePhotoDue) => {
      setState({ kind: "busy", requestId: request.id, step: "opening" });

      const outcome = await captureDeparturePhoto({
        // The same value the portal stamps: the session's own HR ID.
        employeeHrId: user?.hrId ?? "",
        onStep: (step) => setState({ kind: "busy", requestId: request.id, step }),
        requestId: request.id,
        token,
      });

      switch (outcome.status) {
        case "saved":
          setState({
            destination: request.destination,
            kind: "saved",
            locationNote: outcome.locationNote,
            message: outcome.message,
            requestId: request.id,
          });
          onSaved();
          return;
        case "cancelled":
          setState({ kind: "idle" });
          return;
        case "session-expired":
          await handleExpiredSession();
          return;
        case "failed":
          setState({ kind: "error", message: outcome.message, requestId: request.id });
          return;
      }
    },
    [handleExpiredSession, onSaved, token, user?.hrId],
  );

  const saved = state.kind === "saved" ? state : null;
  // The trip just photographed leaves at once, before the refresh lands — a second "Open camera"
  // on it would only invite a needless retake, which the approver's summary then counts.
  const pending = requests.filter((request) => request.id !== saved?.requestId);

  if (pending.length === 0 && !saved) return null;

  return (
    <View
      style={{
        backgroundColor: palette.accentSoft,
        borderColor: palette.accentLine,
        borderRadius: radius,
        borderWidth: hairline,
        gap: space.md,
        padding: space.lg,
      }}
    >
      <View style={{ alignItems: "center", flexDirection: "row", gap: space.sm }}>
        <Ionicons color={palette.accent} name="camera-outline" size={18} />
        <Text style={[type.micro, { color: palette.accent, flexShrink: 1, textTransform: "uppercase" }]}>
          {pending.length > 0 ? "Departure photo needed" : "Departure photo saved"}
        </Text>
      </View>

      {pending.length > 0 ? (
        <Text style={[type.body, { color: palette.ink }]}>
          {`${pending.length === 1 ? "One expense request is" : `${pending.length} expense requests are`} waiting for a departure photo. Capture it before you leave the destination — the request does not reach payroll until it is taken.`}
        </Text>
      ) : null}

      {saved ? (
        <View
          style={{
            backgroundColor: palette.surface,
            borderColor: palette.success,
            borderLeftWidth: 3,
            borderRadius: radius,
            borderWidth: hairline,
            gap: space.xs,
            padding: space.md,
          }}
        >
          <View style={{ alignItems: "flex-start", flexDirection: "row", gap: space.sm }}>
            <Ionicons color={palette.success} name="checkmark-circle-outline" size={18} />
            <Text style={[type.bodyStrong, { color: palette.success, flexShrink: 1 }]}>
              {`${saved.destination} — departure photo saved`}
            </Text>
          </View>
          <Text style={[type.body, { color: palette.ink }]}>{saved.message}</Text>
          {saved.locationNote ? (
            <Text style={[type.meta, { color: palette.inkSoft }]}>{saved.locationNote}</Text>
          ) : null}
        </View>
      ) : null}

      {pending.map((request) => {
        const isActive = (state.kind === "busy" || state.kind === "error") && state.requestId === request.id;
        const step = isActive && state.kind === "busy" ? state.step : null;

        return (
          <View
            key={request.id}
            style={{
              backgroundColor: palette.surface,
              borderColor: palette.line,
              borderRadius: radius,
              borderWidth: hairline,
              gap: space.md,
              padding: space.md,
            }}
          >
            <View style={{ gap: space.xs }}>
              <Text style={[type.bodyStrong, { color: palette.ink }]}>{request.destination}</Text>
              <Text style={[type.meta, { color: palette.inkSoft }]}>
                {`${formatTripDate(request.tripStartDate)} – ${formatTripDate(request.tripEndDate)}`}
              </Text>
            </View>

            {/* Every button stops while any capture runs: one camera, one fix, one upload at a time. */}
            <PrimaryButton
              busy={step !== null}
              busyLabel={step ? STEP_LABELS[step] : undefined}
              disabled={state.kind === "busy"}
              label="Open camera"
              onPress={() => void capture(request)}
            />

            {isActive && state.kind === "error" ? <ErrorNotice message={state.message} /> : null}

            {!isActive ? (
              <View style={{ alignItems: "center", flexDirection: "row", gap: space.xs }}>
                <Ionicons color={palette.inkSoft} name="location-outline" size={14} />
                <Text style={[type.meta, { color: palette.inkSoft, flexShrink: 1 }]}>
                  Your location is recorded with the photo.
                </Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
