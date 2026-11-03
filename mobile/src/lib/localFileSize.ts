import { File } from "expo-file-system";
import { Platform } from "react-native";

/** Reads metadata only. Receipt bytes remain on the device until upload starts. */
export async function localFileByteSize(uri: string): Promise<number> {
  // expo-file-system has no web implementation; the web picker hands back a
  // blob: or data: URI, which the browser can measure itself.
  if (Platform.OS === "web") {
    const response = await fetch(uri);
    if (!response.ok) throw new Error("Receipt file is unavailable");
    return (await response.blob()).size;
  }
  const file = new File(uri);
  if (!file.exists) throw new Error("Receipt file is unavailable");
  return file.size;
}
