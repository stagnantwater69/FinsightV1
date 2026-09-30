import { Pressable, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { font, typeScale } from '../../theme/tokens';

/**
 * `stacked` is the review toolbar's icon-over-label cell: it sits on the
 * toolbar's own plane, so it has no fill of its own.
 */
export function CameraAction({ label, icon, onPress, disabled = false, primary = false, iconOnly = false, stacked = false }: {
  label: string; icon?: keyof typeof Ionicons.glyphMap; onPress: () => void; disabled?: boolean; primary?: boolean; iconOnly?: boolean; stacked?: boolean;
}) {
  const t = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [stacked ? styles.stacked : styles.action, { minWidth: 48, minHeight: 48, backgroundColor: primary ? t.brandFill : stacked ? 'transparent' : t.cameraSurface, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 }]}>
    {icon ? <Ionicons name={icon} size={stacked ? 24 : 22} color={t.onCamera} /> : null}
    {!iconOnly ? <Text numberOfLines={stacked ? 1 : undefined} style={[stacked ? styles.stackedLabel : styles.label, { color: t.onCamera }]}>{label}</Text> : null}
  </Pressable>;
}
const styles = StyleSheet.create({
  action: { minWidth: 48, minHeight: 48, maxWidth: '100%', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  label: { fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, flexShrink: 1, textAlign: 'center' },
  stacked: { flex: 1, minWidth: 48, minHeight: 56, paddingHorizontal: 4, paddingVertical: 6, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 4 },
  stackedLabel: { fontFamily: font.sansMedium, fontSize: typeScale.caption, textAlign: 'center' },
});
