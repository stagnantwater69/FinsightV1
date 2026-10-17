import type { DocumentPickerAsset } from "expo-document-picker";
import { Platform } from "react-native";

export function csvUploadForm(asset: Pick<DocumentPickerAsset, "uri" | "name" | "file">): FormData {
  const form = new FormData();
  if (Platform.OS === "web") {
    if (!asset.file) throw new Error("This browser couldn't read the selected file. Choose it again.");
    form.append("file", asset.file, asset.name);
  } else {
    form.append("file", { uri: asset.uri, name: asset.name, type: "text/csv" } as any);
  }
  return form;
}

export function releaseCsvObjectUrl(uri: string | undefined): void {
  if (Platform.OS === "web" && uri?.startsWith("blob:")) URL.revokeObjectURL(uri);
}
