import Constants, { AppOwnership } from "expo-constants";
import { Platform } from "react-native";
import { receiptScannerEnabledFor } from "./receiptScannerConfig";

/** Explicit internal-rollout switch; custom camera is the default on both platforms. */
export const USE_NATIVE_RECEIPT_CAMERA = Constants.expoConfig?.extra?.receiptCameraMode === "native";

export const ANDROID_RECEIPT_SCANNER_ENABLED = receiptScannerEnabledFor(
  Platform.OS,
  Constants.expoConfig?.extra?.receiptScannerEnabled,
  Constants.appOwnership === AppOwnership.Expo,
);
