const Module = require("module");

/**
 * Loads `onesignal-expo-plugin` on Expo SDK 58.
 *
 * `onesignal-expo-plugin` 2.7.1 (the latest release) requires the specifier `expo/config-plugins.js`.
 * SDK 58's `expo` package gained an `exports` map whose catch-all `"./*"` entry appends `.js`, so that
 * specifier now resolves to `config-plugins.js.js`, which does not exist, and `expo config` fails
 * before any build starts. `expo/config-plugins` (no extension) resolves correctly, so this rewrites
 * only that one specifier while the plugin is being loaded, then puts the resolver back.
 *
 * Delete this file, and point app.json back at "onesignal-expo-plugin", once OneSignal publishes a
 * release that requires `expo/config-plugins` or Expo maps `./*.js` again.
 */
const resolve = Module._resolveFilename;

Module._resolveFilename = function resolveWithoutDoubledExtension(request, ...rest) {
  return resolve.call(this, request === "expo/config-plugins.js" ? "expo/config-plugins" : request, ...rest);
};

try {
  module.exports = require("onesignal-expo-plugin");
} finally {
  Module._resolveFilename = resolve;
}
