import { Platform } from "react-native";

export interface LocalFilePart {
  uri: string;
  name: string;
  type: string;
}

/**
 * Adds a local image to a multipart form.
 *
 * React Native's FormData reads the file itself from a {uri,name,type}
 * object. A browser's FormData would send that object as the text
 * "[object Object]", so in the web build the bytes are read from the blob: or
 * data: URI the picker returned and appended as a Blob.
 */
export async function appendLocalFile(form: FormData, field: string, part: LocalFilePart): Promise<void> {
  if (Platform.OS !== "web") {
    form.append(field, part as any);
    return;
  }
  const response = await fetch(part.uri);
  if (!response.ok) throw new Error("Receipt file is unavailable");
  const blob = await response.blob();
  form.append(field, blob.type === part.type ? blob : new Blob([blob], { type: part.type }), part.name);
}
