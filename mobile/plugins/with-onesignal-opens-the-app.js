const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

/**
 * A tapped notification opens THE APP, never the phone's browser.
 *
 * Every Phoenix push carries a link to the web portal (`resolvePushActionUrl` in
 * `src/lib/notifications/push.ts`), because the same send reaches browsers. Left to its default,
 * OneSignal's Android SDK opens that link in the browser, so a tap on a phone would leave the app
 * for a web page. This manifest flag (`com.onesignal.suppressLaunchURLs`, read by the SDK's
 * `OSNotificationOpenAppSettings`) makes the tap open the app instead, with the link still on the
 * click event, where `mobile/src/lib/push-link.ts` decides what to show.
 *
 * A config plugin rather than an edit to AndroidManifest.xml because this app has no `android/`
 * folder: EAS generates it on every build, and anything written there by hand would be thrown away.
 */
module.exports = function withOneSignalOpensTheApp(config) {
  return withAndroidManifest(config, (modConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(modConfig.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(application, "com.onesignal.suppressLaunchURLs", "true");
    return modConfig;
  });
};
