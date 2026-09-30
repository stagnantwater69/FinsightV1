import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { font, typeScale } from '../../theme/tokens';
import { TAP_FLOOR } from '../touchTarget';

/**
 * One line of guidance over the top of the viewfinder. It advises; it never
 * blocks: whether or not edges are found, the shutter stays live.
 */
export function CaptureStatusPill({ message, working }: { message: string; working: boolean }) {
  const t = useTheme();
  return <View pointerEvents="none" style={styles.pillRow}>
    <View style={[styles.pill, { backgroundColor: t.scrimStrong }]}>
      {working ? <ActivityIndicator size="small" color={t.onCamera} /> : null}
      <Text accessibilityLiveRegion="polite" numberOfLines={2} style={[styles.pillText, { color: t.onCamera }]}>{message}</Text>
    </View>
  </View>;
}

/**
 * Gallery on the left, the shutter in the middle, and the last captured page
 * on the right with the page count, which opens review.
 */
export function ShutterRow({ onGallery, galleryDisabled, onShutter, shutterDisabled, working, reviewUri, reviewCount, reviewNoun = 'receipt', showCount, onReview, reviewDisabled }: {
  onGallery: () => void;
  galleryDisabled: boolean;
  onShutter: () => void;
  shutterDisabled: boolean;
  /** A photo is being taken or processed: the shutter shows progress. */
  working: boolean;
  reviewUri?: string;
  reviewCount: number;
  /** What the count counts: separate receipts, or parts of one long receipt. */
  reviewNoun?: 'receipt' | 'part';
  showCount: boolean;
  onReview: () => void;
  reviewDisabled: boolean;
}) {
  const t = useTheme();
  return <View style={styles.row}>
    <View style={styles.side}>
      <Pressable accessibilityRole="button" accessibilityLabel="Gallery" accessibilityState={{ disabled: galleryDisabled }} disabled={galleryDisabled} onPress={onGallery}
        style={({ pressed }) => [styles.sideButton, { minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, opacity: galleryDisabled ? 0.45 : pressed ? 0.7 : 1 }]}>
        <Ionicons name="images-outline" size={28} color={t.onCamera} />
      </Pressable>
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="Capture receipt" accessibilityState={{ disabled: shutterDisabled, busy: working }} disabled={shutterDisabled} onPress={onShutter}
      style={({ pressed }) => [styles.shutter, { minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, borderColor: t.brand[400], opacity: shutterDisabled && !working ? 0.4 : pressed ? 0.7 : 1 }]}>
      {working ? <ActivityIndicator color={t.onCamera} /> : <View style={[styles.shutterCore, { backgroundColor: t.onCamera }]} />}
    </Pressable>
    <View style={[styles.side, styles.sideEnd]}>
      {reviewUri ? <Pressable accessibilityRole="button" accessibilityLabel={`Review ${reviewCount} ${reviewCount === 1 ? reviewNoun : `${reviewNoun}s`}`} accessibilityState={{ disabled: reviewDisabled }} disabled={reviewDisabled} onPress={onReview}
        style={({ pressed }) => [styles.review, { minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, opacity: reviewDisabled ? 0.45 : pressed ? 0.7 : 1 }]}>
        <View style={[styles.thumb, { borderColor: t.brand[400] }]}>
          <Image source={{ uri: reviewUri }} style={styles.thumbImage} resizeMode="cover" />
        </View>
        {showCount ? <View style={[styles.badge, { backgroundColor: t.brandFill }]}><Text style={[styles.badgeText, { color: t.onCamera }]}>{reviewCount}</Text></View> : null}
        <Ionicons name="chevron-forward" size={20} color={t.onCamera} />
      </Pressable> : <View style={styles.reviewPlaceholder} />}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  pillRow: { position: 'absolute', top: 12, left: 16, right: 16, alignItems: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, maxWidth: '100%' },
  pillText: { fontFamily: font.sansMedium, fontSize: typeScale.label, textAlign: 'center', flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  side: { flex: 1, alignItems: 'flex-start', justifyContent: 'center' },
  sideEnd: { alignItems: 'flex-end' },
  sideButton: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  shutter: { width: 78, height: 78, borderRadius: 39, borderWidth: 4, alignItems: 'center', justifyContent: 'center' },
  shutterCore: { width: 62, height: 62, borderRadius: 31 },
  review: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 64 },
  thumb: { width: 48, height: 64, borderWidth: 2, borderRadius: 4, overflow: 'hidden' },
  thumbImage: { width: '100%', height: '100%' },
  badge: { position: 'absolute', left: 32, top: -10, minWidth: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText: { fontFamily: font.sansSemibold, fontSize: typeScale.caption },
  reviewPlaceholder: { width: 64, height: 64 },
});
