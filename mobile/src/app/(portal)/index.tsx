import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PortalWebView } from "@/components/portal-web-view";
import { usePalette } from "@/theme/use-palette";

/** The portal landing — the same path the browser opens. */
const PORTAL_HOME = "/employee-portals";

/**
 * The Home tab IS the portal.
 *
 * It renders the production portal landing — the same page the browser opens, the same identity
 * card, the same modules — through the shared WebView, in app mode (the portal drops its own header
 * and bottom nav; the native tab bar navigates). This replaced a hand-drawn native command centre on
 * 2026-09-29 at the owner's instruction ("make the app a shell over the web portal"): the app wore
 * the portal's colours over a screen a fraction of its size, which read as a poor imitation of the
 * SaaS rather than the SaaS. Now it is the SaaS.
 *
 * 🔴 WHAT THIS TRADES. The native Home used to show a read-only cache of the rep's own numbers with
 * no signal; a web page needs a connection, so that offline READ is gone. The offline WORK is not:
 * Phoenix CRM stays native, and its outbox still queues a visit — photo, GPS, comment — with no
 * signal and sends it when signal returns. Reading a payslip can wait for a bar of signal; recording
 * a visit cannot, and that is the one this protects. Reversible in one file if the owner wants the
 * offline command centre back.
 *
 * A tab, so no back bar and no safe-area handling from a parent — the top inset is applied here so
 * the portal does not sit under the status bar.
 */
export default function PortalHomeScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();

  return (
    <View style={{ backgroundColor: palette.paper, flex: 1, paddingTop: insets.top }}>
      <PortalWebView href={PORTAL_HOME} />
    </View>
  );
}
