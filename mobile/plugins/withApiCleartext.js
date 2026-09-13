const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

/**
 * Keep the generated Android manifest aligned with the API scheme embedded in
 * the JavaScript bundle. This exists for local, LAN-backed APKs; production
 * HTTPS builds explicitly keep cleartext disabled.
 */
function setApiCleartext(manifest, enabled) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  application.$['android:usesCleartextTraffic'] = enabled ? 'true' : 'false';
  return manifest;
}

module.exports = function withApiCleartext(config, { enabled = false } = {}) {
  return withAndroidManifest(config, (mod) => {
    mod.modResults = setApiCleartext(mod.modResults, enabled === true);
    return mod;
  });
};
module.exports.setApiCleartext = setApiCleartext;
