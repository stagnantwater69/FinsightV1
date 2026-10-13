import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { font, typeScale } from '../../theme/tokens';
import { TAP_FLOOR } from '../touchTarget';
import type { ReceiptSection } from '../../lib/receiptCapture';
import { pageIndexFromOffset, pagerPosition } from '../../lib/reviewPager';

export interface PageReviewerProps {
  /** Batch pages are parts of one long receipt. */
  noun?: 'page' | 'part';
  pages: readonly ReceiptSection[];
  /** Index of the selected page in `pages`. */
  index: number;
  /** The pager is resting on the Add Page card rather than a page. */
  onAddSlot: boolean;
  showAddPage: boolean;
  /** A capture waiting to be kept: swiping away from it is not allowed. */
  locked: boolean;
  busy: boolean;
  hint: string | null;
  onSelectPage: (index: number) => void;
  onAddSlotChange: (visible: boolean) => void;
  onAddPage: () => void;
  onDeletePage: () => void;
}

/**
 * The review pager: one captured page per screen width, then an Add Page card
 * in a Batch. Swiping and the chevrons move the same selection, so a person
 * who cannot swipe loses nothing.
 */
export function PageReviewer({ noun = 'page', pages, index, onAddSlot, showAddPage, locked, busy, hint, onSelectPage, onAddSlotChange, onAddPage, onDeletePage }: PageReviewerProps) {
  const t = useTheme();
  const scroller = useRef<ScrollView>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [comparing, setComparing] = useState(false);
  const slotCount = pages.length + (showAddPage ? 1 : 0);
  const slot = onAddSlot && showAddPage ? pages.length : index;
  const current = onAddSlot ? undefined : pages[index];
  const canCompare = Boolean(current && current.originalUri !== current.processedUri);

  useEffect(() => { setComparing(false); }, [slot, current?.processedUri]);
  useEffect(() => {
    if (box.width > 0) scroller.current?.scrollTo?.({ x: slot * box.width, animated: true });
  }, [slot, box.width]);

  function settle(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const next = pageIndexFromOffset(event.nativeEvent.contentOffset.x, box.width, slotCount);
    if (next === slot) return;
    if (next >= pages.length) onAddSlotChange(true);
    else onSelectPage(next);
  }
  function step(delta: -1 | 1) {
    const next = slot + delta;
    if (next < 0 || next >= slotCount) return;
    if (next >= pages.length) onAddSlotChange(true);
    else onSelectPage(next);
  }
  const imageLabel = (position: number) => pages.length === 1 ? 'Preview of receipt' : `Preview of ${noun} ${position + 1} of ${pages.length}`;

  return <View style={styles.root}>
    <View style={styles.stage} onLayout={event => setBox({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
      <ScrollView ref={scroller} horizontal pagingEnabled scrollEnabled={!locked && !busy && slotCount > 1} showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={settle} contentOffset={{ x: slot * box.width, y: 0 }}>
        {pages.map((page, position) => {
          const visible = position === slot;
          return <View key={page.localId} style={[styles.slot, { width: box.width || undefined, height: box.height || undefined }]}
            importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'} accessibilityElementsHidden={!visible}>
            <Image accessible accessibilityRole="image" accessibilityLabel={imageLabel(position)}
              source={{ uri: visible && comparing ? page.originalUri : page.processedUri }} style={styles.page} resizeMode="contain" />
            {visible ? <>
              <Pressable accessibilityRole="button" accessibilityLabel={`Delete ${noun}`} accessibilityState={{ disabled: busy }} disabled={busy} onPress={onDeletePage}
                hitSlop={6} style={({ pressed }) => [styles.chip, styles.chipStart, { minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, opacity: busy ? 0.45 : pressed ? 0.7 : 1 }]}>
                <View style={[styles.chipFace, { backgroundColor: t.scrimStrong }]}><Ionicons name="trash-outline" size={20} color={t.onCamera} /></View>
              </Pressable>
              {canCompare ? <Pressable accessibilityRole="button" accessibilityLabel={comparing ? 'Show the edited page' : 'Compare with the original photo'}
                accessibilityState={{ selected: comparing, disabled: busy }} disabled={busy} onPress={() => setComparing(value => !value)}
                style={({ pressed }) => [styles.chip, styles.chipEnd, { minHeight: TAP_FLOOR, opacity: busy ? 0.45 : pressed ? 0.7 : 1 }]}>
                <View style={[styles.pill, { backgroundColor: comparing ? t.brandFill : t.scrimStrong }]}>
                  <Ionicons name="contrast-outline" size={18} color={t.onCamera} />
                  <Text style={[styles.pillText, { color: t.onCamera }]}>{comparing ? 'Original' : 'Compare'}</Text>
                </View>
              </Pressable> : null}
            </> : null}
          </View>;
        })}
        {showAddPage ? <View style={[styles.slot, { width: box.width || undefined, height: box.height || undefined }]}
          importantForAccessibility={slot === pages.length ? 'auto' : 'no-hide-descendants'} accessibilityElementsHidden={slot !== pages.length}>
          <Pressable accessibilityRole="button" accessibilityLabel={noun === 'part' ? 'Add part' : 'Add page'} accessibilityHint={noun === 'part' ? 'Opens the camera for the next part of this receipt. Parts already captured stay.' : 'Opens the camera. Pages already captured stay.'}
            accessibilityState={{ disabled: busy }} disabled={busy} onPress={onAddPage}
            style={({ pressed }) => [styles.addCard, { minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, borderColor: t.onCamera, opacity: busy ? 0.45 : pressed ? 0.7 : 0.85 }]}>
            <Ionicons name="camera-outline" size={44} color={t.onCamera} />
            <Text style={[styles.addText, { color: t.onCamera }]}>{noun === 'part' ? 'Add next part' : 'Add page'}</Text>
          </Pressable>
        </View> : null}
      </ScrollView>
    </View>
    {hint && !onAddSlot ? <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: t.onCamera }]}>{hint}</Text> : null}
    <View style={styles.nav}>
      <NavButton label={`Previous ${noun}`} icon="chevron-back" disabled={busy || locked || slot <= 0} onPress={() => step(-1)} />
      <Text accessibilityLiveRegion="polite" accessibilityLabel={onAddSlot ? (noun === 'part' ? 'Add part' : 'Add page') : `${noun === 'part' ? 'Part' : 'Page'} ${index + 1} of ${pages.length}`} style={[styles.position, { color: t.onCamera }]}>
        {onAddSlot ? pagerPosition(pages.length - 1, pages.length) : pagerPosition(index, pages.length)}
      </Text>
      <NavButton label={`Next ${noun}`} icon="chevron-forward" disabled={busy || locked || slot >= slotCount - 1} onPress={() => step(1)} />
    </View>
  </View>;
}

function NavButton({ label, icon, disabled, onPress }: { label: string; icon: 'chevron-back' | 'chevron-forward'; disabled: boolean; onPress: () => void }) {
  const t = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.navButton, { minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, opacity: disabled ? 0.35 : pressed ? 0.7 : 1 }]}>
    <View style={[styles.navFace, { backgroundColor: 'rgba(255,255,255,0.14)' }]}><Ionicons name={icon} size={20} color={t.onCamera} /></View>
  </Pressable>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  stage: { flex: 1, minHeight: 160 },
  slot: { flex: 1, paddingHorizontal: 20, paddingVertical: 12 },
  page: { flex: 1, width: '100%' },
  chip: { position: 'absolute', top: 4, alignItems: 'center', justifyContent: 'center' },
  chipStart: { left: 8 },
  chipEnd: { right: 8 },
  chipFace: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 18, paddingHorizontal: 12, height: 36 },
  pillText: { fontFamily: font.sansMedium, fontSize: typeScale.label },
  addCard: { flex: 1, borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 4, alignItems: 'center', justifyContent: 'center', gap: 12 },
  addText: { fontFamily: font.sansMedium, fontSize: typeScale.body },
  hint: { fontFamily: font.sans, fontSize: typeScale.label, textAlign: 'center', paddingHorizontal: 24, paddingTop: 4 },
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20, paddingVertical: 6 },
  navButton: { alignItems: 'center', justifyContent: 'center' },
  navFace: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  position: { fontFamily: font.sansMedium, fontSize: typeScale.bodyLg, minWidth: 48, textAlign: 'center' },
});
