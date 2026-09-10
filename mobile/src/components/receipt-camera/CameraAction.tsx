import { Pressable, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { font, typeScale } from '../../theme/tokens';

export function CameraAction({ label, icon, onPress, disabled = false, primary = false }: {
  label: string; icon?: keyof typeof Ionicons.glyphMap; onPress: () => void; disabled?: boolean; primary?: boolean;
}) {
  const t = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, { minWidth: 48, minHeight: 48, backgroundColor: primary ? t.brandFill : t.cameraSurface, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 }]}>
    {icon ? <Ionicons name={icon} size={22} color={t.onCamera} /> : null}
    <Text numberOfLines={1} style={[styles.label, { color: t.onCamera }]}>{label}</Text>
  </Pressable>;
}
const styles = StyleSheet.create({
  action: { minWidth: 48, minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  label: { fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, flexShrink: 0 },
});
