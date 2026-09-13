import { MAX_SECTIONS, moveSection, newSectionId, type CaptureSource, type ReceiptSection, type SectionQuality } from './receiptCapture';

export function createReceiptSection(asset: { uri: string; width: number; height: number; mimeType?: string }, source: CaptureSource): ReceiptSection {
  if (!asset.uri.trim() || !Number.isFinite(asset.width) || !Number.isFinite(asset.height) || asset.width <= 0 || asset.height <= 0) throw new Error('This image could not be opened. Choose another photo.');
  const mimeType = asset.mimeType ?? 'image/jpeg';
  return { localId: newSectionId(), originalUri: asset.uri, originalMimeType: mimeType, processedUri: asset.uri, processedMimeType: mimeType, width: asset.width, height: asset.height, originalWidth: asset.width, originalHeight: asset.height, captureSource: source, processingMode: 'original', quality: null };
}

export function addSessionSections(current: ReceiptSection[], incoming: ReceiptSection[], replaceId?: string | null): ReceiptSection[] {
  if (replaceId) {
    const index = current.findIndex(section => section.localId === replaceId);
    if (index < 0 || incoming.length !== 1) throw new Error('Select one photo to replace this section.');
    if (current.some((section, i) => i !== index && (section.sourceAssetUri ?? section.originalUri) === (incoming[0]!.sourceAssetUri ?? incoming[0]!.originalUri))) throw new Error('This photo is already in your receipt.');
    return current.map((section, i) => i === index ? { ...incoming[0]!, localId: section.localId, receiptGroupId: section.receiptGroupId } : section);
  }
  const seen = new Set(current.map(section => section.sourceAssetUri ?? section.originalUri));
  const unique = incoming.filter(section => { const key = section.sourceAssetUri ?? section.originalUri; if (seen.has(key)) return false; seen.add(key); return true; });
  if (current.length + unique.length > MAX_SECTIONS) throw new Error(`A receipt can contain up to ${MAX_SECTIONS} sections.`);
  return [...current, ...unique.map(section => ({ ...section, receiptGroupId: section.receiptGroupId ?? current[0]?.receiptGroupId }))];
}

export const removeSessionSection = (current: ReceiptSection[], id: string) => current.filter(section => section.localId !== id);
export const moveSessionSection = (current: ReceiptSection[], id: string, delta: number) => moveSection(current, current.findIndex(section => section.localId === id), delta);

export function qualityHint(quality: SectionQuality | null): string | null {
  if (!quality) return null;
  if (quality.tooSmallToRead) return 'Text may be too small. Move closer or use more sections.';
  if (quality.tooBlurredToTrust) return 'This section may be blurry. Hold steady and retake it.';
  if (quality.brightness < 55) return 'This section looks dark. Try brighter, even lighting.';
  return null;
}
