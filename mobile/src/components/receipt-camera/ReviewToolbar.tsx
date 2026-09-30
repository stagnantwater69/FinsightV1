import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { font, typeScale } from '../../theme/tokens';
import { TAP_FLOOR } from '../touchTarget';
import { CameraAction } from './CameraAction';

/**
 * The edit bar under the review pager: four edits for the page on screen and
 * the one confirm action. `confirmLabel` says exactly what the check does
 * (keep this page, finish the batch, use this receipt), because the icon alone
 * cannot.
 */
export function ReviewToolbar({ busy, editsDisabled, showFilter, confirmLabel, confirmCount, confirmDisabled, onRetake, onRotate, onFilter, onCrop, onConfirm }: {
  busy: boolean;
  editsDisabled: boolean;
  showFilter: boolean;
  confirmLabel: string;
  /** Shown beside the check when confirming hands over several receipts. */
  confirmCount?: number;
  confirmDisabled: boolean;
  onRetake: () => void;
  onRotate: () => void;
  onFilter: () => void;
  onCrop: () => void;
  onConfirm: () => void;
}) {
  const t = useTheme();
  const editOff = busy || editsDisabled;
  return <View style={[styles.bar, { backgroundColor: 'rgba(255,255,255,0.06)' }]}>
    <CameraAction stacked label="Retake" icon="camera-reverse-outline" onPress={onRetake} disabled={editOff} />
    <CameraAction stacked label="Left" icon="arrow-undo-outline" onPress={onRotate} disabled={editOff} />
    {showFilter ? <CameraAction stacked label="Filter" icon="color-filter-outline" onPress={onFilter} disabled={editOff} /> : null}
    <CameraAction stacked label="Crop" icon="crop-outline" onPress={onCrop} disabled={editOff} />
    <Pressable accessibilityRole="button" accessibilityLabel={confirmLabel} accessibilityState={{ disabled: confirmDisabled }} disabled={confirmDisabled} onPress={onConfirm}
      style={({ pressed }) => [styles.confirm, { minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, backgroundColor: pressed ? t.brandFillPressed : t.brandFill, opacity: confirmDisabled ? 0.45 : 1 }]}>
      <Ionicons name="checkmark" size={28} color={t.onCamera} />
      {confirmCount !== undefined ? <Text style={[styles.count, { color: t.onCamera }]}>{confirmCount}</Text> : null}
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 8 },
  confirm: { minWidth: 72, height: 52, borderRadius: 8, marginLeft: 4, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  count: { fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg },
});
