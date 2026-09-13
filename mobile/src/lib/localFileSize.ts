import { File } from "expo-file-system";

/** Reads metadata only. Receipt bytes remain on the device until upload starts. */
export async function localFileByteSize(uri: string): Promise<number> {
  const file = new File(uri);
  if (!file.exists) throw new Error("Receipt file is unavailable");
  return file.size;
}
