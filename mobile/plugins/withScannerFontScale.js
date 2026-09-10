const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

/**
 * Keep the React Activity alive when accessibility font size changes. The
 * installed Expo image-picker retains launchers whose registry is cleared on
 * Activity destruction. ReactActivity already forwards configuration changes
 * to React Native, including font-scale layout updates; this does NOT freeze
 * text size or disable accessibility scaling.
 *
 * Narrow mitigation for fontScale only, not a general process-death fix.
 */
function addFontScaleHandling(manifest) {
  const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
  const changes = new Set(
    (activity.$['android:configChanges'] || '').split('|').filter(Boolean),
  );
  changes.add('fontScale');
  activity.$['android:configChanges'] = [...changes].join('|');
  return manifest;
}

module.exports = function withScannerFontScale(config) {
  return withAndroidManifest(config, (mod) => {
    mod.modResults = addFontScaleHandling(mod.modResults);
    return mod;
  });
};
module.exports.addFontScaleHandling = addFontScaleHandling;
