import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ErrorNotice, Field, PrimaryButton } from "@/components/ui";
import { ApiError, NetworkError } from "@/lib/api";
import { apiBaseUrl, isProductionTarget } from "@/lib/config";
import { useSession } from "@/lib/session";
import { space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";

export default function LoginScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { signIn } = useSession();

  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = loginId.trim().length > 0 && password.length > 0 && !busy;

  async function handleSubmit() {
    if (!canSubmit) return;

    setBusy(true);
    setError(null);

    try {
      await signIn(loginId.trim(), password);
      // No navigation here on purpose — RouteGuard sees the session change and moves the app. One
      // place decides where a signed-in person lands, rather than every entry point having a view.
    } catch (caught) {
      // The server's own message is shown verbatim: it distinguishes a wrong password from a locked
      // account, a rate limit and a deactivated employee, and each of those needs a different action
      // from the person holding the phone. Replacing it with "Login failed" would throw that away.
      const message =
        caught instanceof ApiError || caught instanceof NetworkError
          ? caught.message
          : "Could not sign you in. Please try again.";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ backgroundColor: palette.paper, flex: 1 }}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          gap: space.xl,
          justifyContent: "center",
          paddingBottom: insets.bottom + space.xl,
          paddingHorizontal: space.lg,
          paddingTop: insets.top + space.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: space.sm }}>
          <Text style={[type.display, { color: palette.ink }]}>Phoenix</Text>
          <Text style={[type.body, { color: palette.inkSoft }]}>
            Sign in with the HR ID and password you use for the employee portal.
          </Text>
        </View>

        {!isProductionTarget ? (
          // A build pointed somewhere other than production says so, always. Not a debug nicety:
          // staging holds real names and real payroll, so knowing which system is answering is the
          // difference between a test and a change to somebody's pay.
          <View
            style={{
              backgroundColor: palette.accentSoft,
              borderColor: palette.accentLine,
              borderWidth: 1,
              padding: space.md,
            }}
          >
            <Text style={[type.meta, { color: palette.ink2 }]}>
              This build is connected to {apiBaseUrl}, not the live system.
            </Text>
          </View>
        ) : null}

        <View style={{ gap: space.lg }}>
          <Field
            autoCapitalize="characters"
            autoComplete="username"
            autoCorrect={false}
            editable={!busy}
            label="HR ID"
            onChangeText={setLoginId}
            placeholder="B-10"
            returnKeyType="next"
            value={loginId}
          />
          <Field
            autoCapitalize="none"
            autoComplete="current-password"
            autoCorrect={false}
            editable={!busy}
            label="Password"
            onChangeText={setPassword}
            onSubmitEditing={handleSubmit}
            returnKeyType="go"
            secureTextEntry
            value={password}
          />

          {error ? <ErrorNotice message={error} /> : null}

          <PrimaryButton busy={busy} disabled={!canSubmit} label="Sign in" onPress={handleSubmit} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
