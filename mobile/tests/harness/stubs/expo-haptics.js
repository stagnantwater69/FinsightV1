export const ImpactFeedbackStyle = {
  Light: 'light',
  Medium: 'medium',
  Heavy: 'heavy',
  Soft: 'soft',
  Rigid: 'rigid',
};

export const NotificationFeedbackType = {
  Success: 'success',
  Warning: 'warning',
  Error: 'error',
};

export const AndroidHaptics = {
  Confirm: 'confirm',
  Reject: 'reject',
  Clock_Tick: 'clock_tick',
};

/** Recorded so tests can assert feedback fired without needing a device. */
export const calls = [];

export async function impactAsync(style) {
  calls.push({ kind: 'impact', style });
}
export async function notificationAsync(type) {
  calls.push({ kind: 'notification', type });
}
export async function selectionAsync() {
  calls.push({ kind: 'selection' });
}
export async function performAndroidHapticsAsync(type) {
  calls.push({ kind: 'android', type });
}

export default {
  ImpactFeedbackStyle,
  NotificationFeedbackType,
  AndroidHaptics,
  impactAsync,
  notificationAsync,
  selectionAsync,
  performAndroidHapticsAsync,
};
