// NOTE: image-picker involves OS permission dialogs. This stub exists only so
// that screens importing it can mount; it proves nothing about permission or
// picker behavior, which remains physical-device-only.
export const MediaTypeOptions = { Images: 'Images', All: 'All' };
export const launchImageLibraryAsync = async () => ({ canceled: true, assets: null });
export const launchCameraAsync = async () => ({ canceled: true, assets: null });
export const requestMediaLibraryPermissionsAsync = async () => ({
  status: 'granted',
  granted: true,
});
export const requestCameraPermissionsAsync = async () => ({
  status: 'granted',
  granted: true,
});

export default {
  MediaTypeOptions,
  launchImageLibraryAsync,
  launchCameraAsync,
  requestMediaLibraryPermissionsAsync,
  requestCameraPermissionsAsync,
};
