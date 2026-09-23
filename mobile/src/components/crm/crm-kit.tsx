import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useEffect, useSyncExternalStore } from "react";
import { Pressable, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from "react-native";

import { crmPost } from "@/lib/crm/client";
import { useSession } from "@/lib/session";
import { hairline, radius, space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";

/**
 * Phoenix CRM — the pieces the mobile CRM screens need beyond the app's shared primitives (ui.tsx).
 *
 * These are the native counterparts of the web module's own `CrmPill`, `CrmChoice`, `CrmNote` and
 * `CrmPhotoThumb` (src/components/phoenix-crm/ui.tsx and photo.tsx). Same words, same tones; square and
 * border-first like everything else here (radius is 0 by owner rule, and nothing takes a radius prop).
 * A CRM tone is one of four — good, warn, bad, info/neutral — and every screen reads them the same way.
 */

export type CrmTone = "good" | "warn" | "bad" | "info" | "neutral";

function toneColours(palette: ReturnType<typeof usePalette>, tone: CrmTone): { border: string; fill: string; ink: string } {
  switch (tone) {
    case "good":
      return { border: palette.success, fill: palette.surface, ink: palette.success };
    case "warn":
      return { border: palette.accentLine, fill: palette.accentSoft, ink: palette.accentPress };
    case "bad":
      return { border: palette.danger, fill: palette.dangerSoft, ink: palette.danger };
    case "info":
      return { border: palette.lineStrong, fill: palette.surface2, ink: palette.ink2 };
    case "neutral":
      return { border: palette.line, fill: palette.surface2, ink: palette.inkSoft };
  }
}

/** A small status word: "At the place", "Not validated yet". */
export function CrmPill({ children, tone = "neutral" }: { children: string; tone?: CrmTone }) {
  const palette = usePalette();
  const colours = toneColours(palette, tone === "good" ? "good" : tone);
  return (
    <View
      style={{
        alignSelf: "flex-start",
        backgroundColor: tone === "good" ? palette.accentSoft : colours.fill,
        borderColor: colours.border,
        borderRadius: radius,
        borderWidth: hairline,
        paddingHorizontal: space.sm,
        paddingVertical: 2,
      }}
    >
      <Text style={[type.micro, { color: tone === "good" ? palette.success : colours.ink, textTransform: "none" }]}>{children}</Text>
    </View>
  );
}

/**
 * The header of an entry screen (Add a visit, Validate a customer): a Back control that names where it
 * leads, and the screen's title. Back is a wide touch target, and the title wraps rather than truncates.
 */
export function CrmBackBar({ backLabel, onBack, title }: { backLabel: string; onBack: () => void; title: string }) {
  const palette = usePalette();
  return (
    <View style={{ gap: space.sm }}>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={onBack}
        style={{ alignItems: "center", alignSelf: "flex-start", flexDirection: "row", gap: space.xs, minHeight: 44 }}
      >
        <Ionicons color={palette.accent} name="chevron-back" size={18} />
        <Text style={[type.bodyStrong, { color: palette.accent }]}>{backLabel}</Text>
      </Pressable>
      <Text style={[type.title, { color: palette.ink }]}>{title}</Text>
    </View>
  );
}

/** An empty-state block: a heading and, when there is one, a line about what fills it. */
export function CrmEmpty({ message, title }: { message?: string | null; title: string }) {
  const palette = usePalette();
  return (
    <View
      style={{
        alignItems: "center",
        borderColor: palette.line,
        borderRadius: radius,
        borderStyle: "dashed",
        borderWidth: hairline,
        gap: space.xs,
        padding: space.lg,
      }}
    >
      <Text style={[type.bodyStrong, { color: palette.ink2, textAlign: "center" }]}>{title}</Text>
      {message ? <Text style={[type.meta, { color: palette.inkSoft, textAlign: "center" }]}>{message}</Text> : null}
    </View>
  );
}

/** A titled section of a screen, with a hairline rule above its heading. */
export function CrmSection({ children, title }: { children: React.ReactNode; title?: string }) {
  const palette = usePalette();
  return (
    <View style={{ gap: space.md }}>
      {title ? <Text style={[type.micro, { color: palette.inkSoft, textTransform: "uppercase" }]}>{title}</Text> : null}
      {children}
    </View>
  );
}

/** A boxed note: a fact, a warning, a refusal — the native `CrmNote`. */
export function CrmNote({ children, title, tone = "info" }: { children?: React.ReactNode; title?: string; tone?: CrmTone }) {
  const palette = usePalette();
  const colours = toneColours(palette, tone);
  return (
    <View
      style={{
        backgroundColor: colours.fill,
        borderColor: colours.border,
        borderLeftWidth: 3,
        borderRadius: radius,
        borderWidth: hairline,
        gap: space.xs,
        padding: space.md,
      }}
    >
      {title ? <Text style={[type.bodyStrong, { color: colours.ink }]}>{title}</Text> : null}
      {typeof children === "string" ? <Text style={[type.body, { color: palette.ink }]}>{children}</Text> : children}
    </View>
  );
}

export type CrmChoiceOption<T extends string> = {
  value: T;
  label: string;
  note?: string;
  disabled?: boolean;
};

/**
 * A single- or multi-choice group of square buttons that wrap rather than scroll — how the rep picks
 * AM/PM, a grade, who was on the visit, the products. `columns` is a hint honoured by flex-basis, so a
 * long label wraps its own text and the row never pushes the screen wider (the fits-the-screen rule).
 */
export function CrmChoice<T extends string>({
  columns = 2,
  disabled = false,
  onChange,
  options,
  value,
}: {
  columns?: number;
  disabled?: boolean;
  onChange: (value: T) => void;
  options: ReadonlyArray<CrmChoiceOption<T>>;
  /** An array selects several (products); a single value selects one. */
  value: T | ReadonlyArray<T> | null;
}) {
  const palette = usePalette();
  const selectedOf = (option: T) => (Array.isArray(value) ? value.includes(option) : value === option);
  const basis = `${Math.floor(100 / columns)}%`;

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      {options.map((option) => {
        const selected = selectedOf(option.value);
        const off = disabled || option.disabled;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: off, selected }}
            disabled={off}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={{
              backgroundColor: selected ? palette.accentSoft : palette.surface,
              borderColor: selected ? palette.accent : palette.line,
              borderRadius: radius,
              borderWidth: hairline,
              flexBasis: 0,
              flexGrow: 1,
              justifyContent: "center",
              minHeight: 48,
              minWidth: basis === "100%" ? "100%" : 96,
              opacity: off ? 0.5 : 1,
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
            }}
          >
            <Text style={[type.bodyStrong, { color: selected ? palette.accentPress : palette.ink }]}>{option.label}</Text>
            {option.note ? <Text style={[type.meta, { color: palette.inkSoft, marginTop: 2 }]}>{option.note}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** A search box with the CRM look. */
export function CrmSearch({ style, ...props }: TextInputProps & { style?: StyleProp<ViewStyle> }) {
  const palette = usePalette();
  return (
    <TextInput
      placeholderTextColor={palette.inkFaint}
      {...props}
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
        style,
      ]}
    />
  );
}

// ── Stored photos ─────────────────────────────────────────────────────────────────────────────────

/**
 * The clinic photos sit in a private bucket; a thumbnail asks /api/phoenix-crm/photos/sign for a
 * short-lived link. This is the mobile port of the web module's batched signer (photo.tsx): thumbnails
 * that mount within a few frames of each other join one batch, links are reused for eight minutes, and
 * a batch is kept per territory so one refusal never blanks another territory's photos.
 */
type PhotoState = { status: "loading" } | { status: "ready"; url: string } | { status: "missing" };

const LOADING: PhotoState = { status: "loading" };
const MISSING: PhotoState = { status: "missing" };
const LINK_REUSE_MS = 8 * 60 * 1000;
const BATCH_WAIT_MS = 30;
const BATCH_MAX = 120;

const entries = new Map<string, { state: PhotoState; at: number; inFlight: boolean }>();
const listeners = new Set<() => void>();
const queued = new Map<string, Set<string>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let signToken: string | null = null;

function notify() {
  for (const listener of listeners) listener();
}

function territoryGroup(path: string): string {
  const parts = path.split("/");
  return parts[0] === "test" ? `test/${parts[1] ?? ""}` : (parts[0] ?? "");
}

async function signBatch(paths: string[]) {
  let urls: Record<string, string> = {};
  try {
    urls = await crmPost<Record<string, string>>("/api/phoenix-crm/photos/sign", "urls", { paths }, signToken);
  } catch {
    urls = {};
  }
  const now = Date.now();
  for (const path of paths) {
    const url = urls[path];
    entries.set(path, { at: now, inFlight: false, state: url ? { status: "ready", url } : MISSING });
  }
  notify();
}

function flush() {
  flushTimer = null;
  const groups = [...queued.values()];
  queued.clear();
  for (const group of groups) {
    const paths = [...group];
    for (let start = 0; start < paths.length; start += BATCH_MAX) void signBatch(paths.slice(start, start + BATCH_MAX));
  }
}

function requestLink(path: string) {
  const entry = entries.get(path);
  const now = Date.now();
  if (entry?.inFlight) return;
  if (entry && entry.state.status === "ready" && now - entry.at < LINK_REUSE_MS) return;
  entries.set(path, { at: entry?.at ?? now, inFlight: true, state: entry?.state ?? LOADING });
  const group = territoryGroup(path);
  const bucket = queued.get(group) ?? new Set<string>();
  bucket.add(path);
  queued.set(group, bucket);
  if (!flushTimer) flushTimer = setTimeout(flush, BATCH_WAIT_MS);
}

function usePhotoLink(path: string | null): PhotoState {
  const { token } = useSession();
  useEffect(() => {
    signToken = token;
  }, [token]);
  useEffect(() => {
    if (path) requestLink(path);
  }, [path]);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (path ? (entries.get(path)?.state ?? LOADING) : MISSING),
  );
}

/** A stored photo as a square thumbnail. `path` null shows a plain tile (a row from before photos). */
export function CrmPhotoThumb({ path, size = 88 }: { path: string | null; size?: number }) {
  const palette = usePalette();
  const state = usePhotoLink(path);
  const box: ViewStyle = {
    alignItems: "center",
    backgroundColor: palette.surface2,
    borderColor: palette.line,
    borderRadius: radius,
    borderWidth: hairline,
    height: size,
    justifyContent: "center",
    overflow: "hidden",
    width: size,
  };
  if (state.status === "ready") {
    return (
      <View style={box}>
        <Image contentFit="cover" source={{ uri: state.url }} style={{ height: size, width: size }} transition={120} />
      </View>
    );
  }
  return (
    <View style={box}>
      <Text style={[type.micro, { color: palette.inkFaint }]}>{state.status === "loading" ? "…" : "No photo"}</Text>
    </View>
  );
}
