/**
 * A small copy of a capture, made for the endpoints that only inspect it.
 *
 * WHY THIS IS ITS OWN FILE. `receiptCapture.ts` deliberately imports nothing
 * from React Native or Expo — that is what keeps its geometry runnable under
 * plain vitest — so the arithmetic lives there (`analysisResize`) and the one
 * native call lives here. Two callers need it: the camera's readability and
 * edge-detection actions, and the scan screen's per-page readability check.
 *
 * WHAT IT IS NOT FOR. Never put the result of this on a page the owner keeps.
 * The scan upload, the crop transform's input and the retained original all
 * stay at full capture resolution; see ANALYSIS_MAX_WIDTH.
 */
import * as Manipulator from "expo-image-manipulator";
import { ANALYSIS_QUALITY, analysisResize } from "./receiptCapture";

/**
 * The URI to upload for an analysis-only request.
 *
 * Returns the ORIGINAL uri unchanged when the image is already within budget,
 * when its dimensions are unknown, or when the manipulator fails. Failing open
 * is the right trade here: these calls are advisory — a readability hint, a
 * suggested crop outline — and refusing to run one because a resize did not
 * work would remove the help rather than make it cheaper.
 */
export async function analysisImageUri(
  uri: string,
  width: number | undefined,
  height: number | undefined,
): Promise<string> {
  const resize = analysisResize(width ?? 0, height ?? 0);
  if (!resize) return uri;
  try {
    const smaller = await Manipulator.manipulateAsync(uri, [{ resize }], {
      compress: ANALYSIS_QUALITY,
      format: Manipulator.SaveFormat.JPEG,
    });
    return smaller.uri;
  } catch {
    return uri;
  }
}
