import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  Avatar,
  Card,
  ErrorNotice,
  MicroLabel,
  OfflineNotice,
  PrimaryButton,
  SecondaryButton,
} from "@/components/ui";
import { ApiError, apiUpload } from "@/lib/api";
import { capturePhoto, describeCaptureFailure } from "@/lib/camera";
import { apiBaseUrl, isProductionTarget } from "@/lib/config";
import { describeCachedAt } from "@/lib/offline-cache";
import { useSession } from "@/lib/session";
import { hairline, space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";
import { usePhoenixQuery } from "@/lib/use-phoenix-query";
import type { PortalHome } from "@/types/portal";

/**
 * Two letters for the avatar when there is no photo. First and last name rather than the first two
 * letters of the first name, so "Omar Gawish" reads OG and not OM.
 */
function initialsFor(fullName: string | null | undefined, fallback: string): string {
  const parts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

function Row({ label, value }: { label: string; value: string }) {
  const palette = usePalette();
  return (
    <View
      style={{
        borderTopColor: palette.line,
        borderTopWidth: hairline,
        flexDirection: "row",
        gap: space.md,
        paddingVertical: space.md,
      }}
    >
      <Text style={[type.meta, { color: palette.inkSoft, flexBasis: 0, flexGrow: 1, minWidth: 0 }]}>
        {label}
      </Text>
      {/* flexShrink with a right alignment rather than a fixed width: a long line or area name
          wraps onto a second line here. It never truncates — no ellipsis anywhere in this system —
          and it never widens the screen. */}
      <Text
        style={[
          type.body,
          { color: palette.ink, flexBasis: 0, flexGrow: 2, minWidth: 0, textAlign: "right" },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

export default function ProfileScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { handleExpiredSession, signOut, token, user } = useSession();
  const { cachedAt, data, refresh } = usePhoenixQuery<PortalHome>("/api/employee-portals/home");

  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const employee = data?.shell?.employee ?? null;

  /**
   * Take a new profile photo and send it.
   *
   * The order matters: capture first, upload second, refresh third. Refreshing is what puts the new
   * picture on screen — the photo route's URL carries the upload timestamp as a cache-buster, so the
   * snapshot has to be re-read for the <Image> to point anywhere new. Without it the upload succeeds
   * and the old photo stays, which reads as a failure.
   */
  const onTakePhoto = useCallback(async () => {
    setPhotoError(null);

    const outcome = await capturePhoto({ allowsEditing: true, aspect: [1, 1] });
    if (outcome.status !== "captured") {
      // `describeCaptureFailure` returns null for a plain cancel — backing out of the camera is not
      // something to report back at the person.
      setPhotoError(describeCaptureFailure(outcome));
      return;
    }

    setPhotoBusy(true);
    try {
      await apiUpload("/api/employee-portal/profile-photo", {
        file: {
          name: outcome.photo.fileName,
          type: outcome.photo.mimeType,
          uri: outcome.photo.uri,
        },
        token,
      });
      refresh();
    } catch (error) {
      if (error instanceof ApiError && error.isSessionExpired) {
        await handleExpiredSession();
        return;
      }
      setPhotoError(
        error instanceof Error ? error.message : "The photo could not be sent. Try again.",
      );
    } finally {
      setPhotoBusy(false);
    }
  }, [handleExpiredSession, refresh, token]);

  // The photo route is server-relative and authenticated, so it needs both the base URL and the
  // bearer token — see the note on `Avatar`.
  const photoSource =
    employee?.photoUrl && token
      ? {
          headers: { authorization: `Bearer ${token}` },
          uri: `${apiBaseUrl}${employee.photoUrl}`,
        }
      : null;

  return (
    <ScrollView
      contentContainerStyle={{
        gap: space.lg,
        paddingBottom: insets.bottom + space.xl,
        paddingHorizontal: space.lg,
        paddingTop: insets.top + space.lg,
      }}
      style={{ backgroundColor: palette.paper }}
    >
      <Text style={[type.display, { color: palette.ink }]}>Profile</Text>

      {/* The same rule as the home screen: these details are cached too, so their age is stated
          before they are read. A stale job title or manager is exactly the kind of thing someone
          would otherwise trust without question. */}
      {cachedAt ? <OfflineNotice takenAt={describeCachedAt(cachedAt)} /> : null}

      <Card>
        <View style={{ alignItems: "center", flexDirection: "row", gap: space.lg }}>
          <Avatar
            initials={initialsFor(employee?.fullName, user?.loginId ?? "")}
            source={photoSource}
          />
          {/* flexBasis/flexGrow with minWidth 0, so a long name wraps instead of widening the row.
              No ellipsis anywhere in this system. */}
          <View style={{ flexBasis: 0, flexGrow: 1, gap: space.xs, minWidth: 0 }}>
            <MicroLabel>Your photo</MicroLabel>
            <Text style={[type.meta, { color: palette.inkSoft }]}>
              {employee?.photoUrl
                ? "This is what colleagues see beside your name."
                : "You have not added one yet."}
            </Text>
          </View>
        </View>

        <View style={{ marginTop: space.lg }}>
          <PrimaryButton
            busy={photoBusy}
            label={employee?.photoUrl ? "Take a new photo" : "Take a photo"}
            onPress={() => void onTakePhoto()}
          />
        </View>

        {photoError ? (
          <View style={{ marginTop: space.md }}>
            <ErrorNotice message={photoError} />
          </View>
        ) : null}
      </Card>

      <Card style={{ paddingTop: 0 }}>
        <Row label="Name" value={employee?.fullName ?? "—"} />
        <Row label="HR ID" value={employee?.hrId ?? user?.hrId ?? user?.loginId ?? "—"} />
        <Row label="Job title" value={employee?.roleLabel ?? user?.role ?? "—"} />
        <Row label="Line" value={employee?.line ?? "—"} />
        <Row label="Area" value={employee?.area ?? "—"} />
        <Row label="Reports to" value={employee?.manager ?? "—"} />
      </Card>

      {!isProductionTarget ? (
        <Card>
          <MicroLabel>Connected to</MicroLabel>
          <Text style={[type.body, { color: palette.ink2, marginTop: space.sm }]}>{apiBaseUrl}</Text>
        </Card>
      ) : null}

      <SecondaryButton label="Sign out" onPress={() => void signOut()} />
    </ScrollView>
  );
}
