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
  disabled = false,
  label,
  onPress,
}: {
  busy?: boolean;
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
      {busy ? (
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
