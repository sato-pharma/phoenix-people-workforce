import { Image } from "expo-image";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";

import { hairline, radius, space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";

/**
 * The app's shared primitives.
 *
 * Border-first and square, matching the portal: structure comes from hairlines rather than from
 * shadows or fills, and every corner is 0 by owner rule. Nothing here takes a `borderRadius` prop —
 * making rounding un-expressible is the point, because a rounded corner has re-entered this system
 * from a "premium polish" restore more than once.
 */

/** Uppercase tracked caption above a group. The portal's section label, transcribed. */
export function MicroLabel({ children }: { children: string }) {
  const palette = usePalette();
  return (
    <Text style={[type.micro, { color: palette.inkSoft, textTransform: "uppercase" }]}>{children}</Text>
  );
}

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = usePalette();
  return (
    <View
      style={[
        {
          backgroundColor: palette.surface,
          borderColor: palette.line,
          borderRadius: radius,
          borderWidth: hairline,
          padding: space.lg,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * An employee's photo, or their initials when there is none.
 *
 * SQUARE, like everything else here. An avatar is a circle almost everywhere in the industry, and
 * that is exactly why this note exists: the owner's square-edge rule has no exception for one, and
 * "it is an avatar" is the reasoning that would quietly reintroduce a radius into a file whose whole
 * point is that rounding is un-expressible. It takes no `borderRadius` prop for the same reason.
 *
 * `headers` is passed through to the image request because the photo route authenticates the same
 * way every other Phoenix route does — an <Image> pointed at it without the bearer token silently
 * renders nothing, which looks exactly like "this employee has no photo".
 */
export function Avatar({
  initials,
  size = 72,
  source,
}: {
  initials: string;
  size?: number;
  source?: { headers?: Record<string, string>; uri: string } | null;
}) {
  const palette = usePalette();

  return (
    <View
      style={{
        alignItems: "center",
        backgroundColor: palette.surface2,
        borderColor: palette.line,
        borderRadius: radius,
        borderWidth: hairline,
        height: size,
        justifyContent: "center",
        overflow: "hidden",
        width: size,
      }}
    >
      {source ? (
        <Image contentFit="cover" source={source} style={{ height: size, width: size }} />
      ) : (
        <Text style={[type.figure, { color: palette.inkSoft }]}>{initials}</Text>
      )}
    </View>
  );
}

/**
 * A single figure with its label.
 *
 * `flexBasis` with `flexGrow` rather than a fixed width: tiles have to share a row at 360dp and at
 * tablet width without ever pushing the row wider than the screen. Horizontal scroll is banned in
 * this system, so a tile that cannot shrink is a defect, not a layout choice.
 */
export function StatTile({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "accent";
}) {
  const palette = usePalette();
  return (
    <View
      style={{
        backgroundColor: tone === "accent" ? palette.accentSoft : palette.surface,
        borderColor: tone === "accent" ? palette.accentLine : palette.line,
        borderRadius: radius,
        borderWidth: hairline,
        flexBasis: 0,
        flexGrow: 1,
        minWidth: 0,
        padding: space.md,
      }}
    >
      <Text style={[type.figure, { color: tone === "accent" ? palette.accent : palette.ink }]}>
        {value}
      </Text>
      <Text style={[type.meta, { color: palette.inkSoft, marginTop: space.xs }]}>{label}</Text>
    </View>
  );
}

export function PrimaryButton({
  busy = false,
  busyLabel,
  disabled = false,
  label,
  onPress,
}: {
  busy?: boolean;
  /**
   * Said next to the spinner while `busy`. For work that goes through stages long enough to notice
   * — a departure photo waits on the GPS, then the address, then the upload — where a bare spinner
   * for half a minute reads as the app having frozen.
   */
  busyLabel?: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) {
  const palette = usePalette();
  const inactive = disabled || busy;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: inactive }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => ({
        alignItems: "center",
        backgroundColor: pressed ? palette.accentPress : palette.accent,
        borderRadius: radius,
        justifyContent: "center",
        // 48 is the Android minimum touch target. A rep taps this with a thumb, in a car.
        minHeight: 48,
        opacity: inactive ? 0.6 : 1,
        paddingHorizontal: space.lg,
      })}
    >
      {busy && busyLabel ? (
        <View style={{ alignItems: "center", flexDirection: "row", gap: space.sm }}>
          <ActivityIndicator color={palette.accentInk} />
          <Text style={[type.bodyStrong, { color: palette.accentInk, flexShrink: 1 }]}>{busyLabel}</Text>
        </View>
      ) : busy ? (
        <ActivityIndicator color={palette.accentInk} />
      ) : (
        <Text style={[type.bodyStrong, { color: palette.accentInk }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        alignItems: "center",
        backgroundColor: pressed ? palette.surface2 : "transparent",
        borderColor: palette.lineStrong,
        borderRadius: radius,
        borderWidth: hairline,
        justifyContent: "center",
        minHeight: 48,
        paddingHorizontal: space.lg,
      })}
    >
      <Text style={[type.bodyStrong, { color: palette.ink2 }]}>{label}</Text>
    </Pressable>
  );
}

export function Field({
  label,
  ...inputProps
}: TextInputProps & { label: string }) {
  const palette = usePalette();
  return (
    <View style={{ gap: space.sm }}>
      <MicroLabel>{label}</MicroLabel>
      <TextInput
        placeholderTextColor={palette.inkFaint}
        {...inputProps}
        style={[
          type.body,
          {
            backgroundColor: palette.surface,
            borderColor: palette.line,
            borderRadius: radius,
            borderWidth: hairline,
            color: palette.ink,
            minHeight: 48,
            paddingHorizontal: space.md,
          },
        ]}
      />
    </View>
  );
}

/** Inline failure notice. Never an alert dialog — a rep should not have to dismiss a network blip. */
export function ErrorNotice({ message }: { message: string }) {
  const palette = usePalette();
  return (
    <View
      style={{
        backgroundColor: palette.dangerSoft,
        borderColor: palette.danger,
        borderRadius: radius,
        borderLeftWidth: 3,
        borderWidth: hairline,
        padding: space.md,
      }}
    >
      <Text style={[type.body, { color: palette.danger }]}>{message}</Text>
    </View>
  );
}

/**
 * Says the figures below were taken earlier, because the phone could not reach Phoenix.
 *
 * DELIBERATELY NOT RED. Being offline with labelled data is not a failure — the app is working, and
 * a rep standing in a pharmacy basement with no signal is having an ordinary day, not an incident.
 * `ErrorNotice` is for something that went wrong and needs acting on; this is a statement of fact
 * about what is on screen, so it takes the quiet surface treatment and a left rule for structure.
 *
 * It is not dismissable, on purpose. The one thing that makes a cache honest is that its age is
 * always visible, so a tap must not be able to hide it while the stale numbers stay.
 */
export function OfflineNotice({ takenAt }: { takenAt: string }) {
  const palette = usePalette();
  return (
    <View
      style={{
        backgroundColor: palette.surface2,
        borderColor: palette.lineStrong,
        borderLeftWidth: 3,
        borderRadius: radius,
        borderWidth: hairline,
        gap: space.xs,
        padding: space.md,
      }}
    >
      <Text style={[type.bodyStrong, { color: palette.ink2 }]}>No connection</Text>
      <Text style={[type.meta, { color: palette.inkSoft }]}>
        {`Showing what was last loaded, at ${takenAt}. Pull down to try again.`}
      </Text>
    </View>
  );
}

export function LoadingScreen({ label = "Loading…" }: { label?: string }) {
  const palette = usePalette();
  return (
    <View style={[styles.centre, { backgroundColor: palette.paper }]}>
      <ActivityIndicator color={palette.accent} size="large" />
      <Text style={[type.meta, { color: palette.inkSoft, marginTop: space.md }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centre: { alignItems: "center", flex: 1, justifyContent: "center" },
});
