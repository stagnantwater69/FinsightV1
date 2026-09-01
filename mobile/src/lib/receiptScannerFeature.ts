import Constants, { AppOwnership } from "expo-constants";
import { Platform } from "react-native";
import { receiptScannerEnabledFor } from "./receiptScannerConfig";

export const ANDROID_RECEIPT_SCANNER_ENABLED = receiptScannerEnabledFor(
  Platform.OS,
  Constants.expoConfig?.extra?.receiptScannerEnabled,
  Constants.appOwnership === AppOwnership.Expo,
);
