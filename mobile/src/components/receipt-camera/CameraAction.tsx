import { Pressable, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { font, typeScale } from '../../theme/tokens';

export function CameraAction({ label, icon, onPress, disabled = false, primary = false, iconOnly = false }: {
  label: string; icon?: keyof typeof Ionicons.glyphMap; onPress: () => void; disabled?: boolean; primary?: boolean; iconOnly?: boolean;
}) {
  const t = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, { minWidth: 48, minHeight: 48, backgroundColor: primary ? t.brandFill : t.cameraSurface, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 }]}>
    {icon ? <Ionicons name={icon} size={22} color={t.onCamera} /> : null}
    {!iconOnly ? <Text style={[styles.label, { color: t.onCamera }]}>{label}</Text> : null}
  </Pressable>;
}
const styles = StyleSheet.create({
  action: { minWidth: 48, minHeight: 48, maxWidth: '100%', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  label: { fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, flexShrink: 1, textAlign: 'center' },
});
