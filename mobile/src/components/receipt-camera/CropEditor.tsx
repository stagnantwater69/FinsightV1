import { useEffect, useRef, useState } from 'react';
import { Image, PanResponder, StyleSheet, Text, View } from 'react-native';
import Svg, { Polygon } from 'react-native-svg';
import { useTheme } from '../../context/ThemeContext';
import { font, typeScale } from '../../theme/tokens';
import { clampToImage, fitImageInBox, fullFrameCorners, type Corners, type Point } from '../../lib/receiptCapture';
import { cropQuadIssue } from '../../lib/cropQuad';
import { CameraAction } from './CameraAction';

function Handle({ point, scale, offsetX, offsetY, width, height, label, onMove }: {
  point: Point; scale: number; offsetX: number; offsetY: number; width: number; height: number; label: string; onMove: (p: Point) => void;
}) {
  const latest = useRef({ point, scale, width, height, onMove });
  latest.current = { point, scale, width, height, onMove };
  const start = useRef(point);
  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { start.current = latest.current.point; },
    onPanResponderMove: (_, gesture) => {
      const c = latest.current;
      c.onMove(clampToImage({ x: start.current.x + gesture.dx / c.scale, y: start.current.y + gesture.dy / c.scale }, c.width, c.height));
    },
  })).current;
  return <View {...responder.panHandlers} accessible accessibilityLabel={label} accessibilityRole="adjustable"
    accessibilityHint="Drag this corner to the edge of the receipt. Accessibility actions move it in each direction."
    accessibilityActions={[{ name: 'left', label: 'Move left' }, { name: 'right', label: 'Move right' }, { name: 'up', label: 'Move up' }, { name: 'down', label: 'Move down' }]}
    onAccessibilityAction={event => { const a = event.nativeEvent.actionName; const step = Math.max(width, height) * 0.015;
      onMove(clampToImage({ x: point.x + (a === 'right' ? step : a === 'left' ? -step : 0), y: point.y + (a === 'down' ? step : a === 'up' ? -step : 0) }, width, height)); }}
    style={[styles.handle, { left: offsetX + point.x * scale - 24, top: offsetY + point.y * scale - 24 }]}>
    <View style={styles.dot} />
  </View>;
}

export function CropEditor({ uri, width, height, initial, busy, onApply, onCancel, onDetect }: {
  uri: string; width: number; height: number; initial?: Corners; busy: boolean;
  onApply: (corners: Corners) => void; onCancel: () => void; onDetect: () => Promise<Corners | null>;
}) {
  const t = useTheme();
  const [corners, setCorners] = useState(initial ?? fullFrameCorners(width, height));
  const [box, setBox] = useState({ width: 1, height: 1 });
  const [finding, setFinding] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Parent keeps the editor mounted while transform/detection completes.
  const fit = fitImageInBox(width, height, Math.max(1, box.width - 48), Math.max(1, box.height - 48));
  const ox = fit.offsetX + 24, oy = fit.offsetY + 24;
  const keys = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const;
  /*
   * The same rule the server applies to this quad (see lib/cropQuad.ts), run on
   * every drag. A crossed or collapsed selection can still be DRAWN — pinning
   * the handles to a valid shape would fight the finger that is moving them —
   * but it cannot be sent, so nobody spends an upload to be told no.
   */
  const issue = cropQuadIssue(corners, width, height);
  return <View style={{ flex: 1 }}>
    {/* White, like every other line on the viewfinder: the camera surface is a
        fixed dark in both themes, and the theme's critical ink is a light-theme
        red that does not carry on it. The hint is distinguished by what it
        says and by the disabled Apply action, not by colour alone. */}
    <Text accessibilityLiveRegion="polite" style={[styles.help, { color: t.onCamera }]}>
      {issue ?? 'Place all four corners on the receipt. Check that every item and the total stay inside.'}
    </Text>
    <View style={{ flex: 1, minHeight: 160 }} onLayout={e => setBox(e.nativeEvent.layout)}>
      {box.width > 1 && box.height > 1 ? <Image source={{ uri }} style={{ position: 'absolute', left: ox, top: oy, width: fit.width, height: fit.height }} resizeMode="contain" resizeMethod="scale" /> : null}
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width={box.width} height={box.height}>
        <Polygon points={keys.map(k => `${ox + corners[k].x * fit.scale},${oy + corners[k].y * fit.scale}`).join(' ')} fill="rgba(0,140,120,0.12)" stroke={t.onCamera} strokeWidth={2} />
      </Svg>
      {!busy && !finding ? keys.map(key => <Handle key={key} label={`${key.replace(/([A-Z])/g, ' $1')} crop corner`} point={corners[key]} scale={fit.scale} offsetX={ox} offsetY={oy} width={width} height={height} onMove={p => setCorners(prev => ({ ...prev, [key]: p }))} />) : null}
    </View>
    <View style={styles.actions}>
      <CameraAction label="Reset corners" onPress={() => setCorners(fullFrameCorners(width, height))} disabled={busy || finding} />
      <CameraAction label={finding ? 'Finding edges…' : 'Find edges'} onPress={() => { setFinding(true); void onDetect().then(result => { if (result && mounted.current) setCorners(result); }).finally(() => { if (mounted.current) setFinding(false); }); }} disabled={busy || finding} />
      <CameraAction label="Cancel crop" onPress={onCancel} disabled={busy || finding} />
      <CameraAction label={busy ? 'Correcting…' : 'Apply crop'} onPress={() => { if (!issue) onApply(corners); }} primary disabled={busy || finding || issue !== null} />
    </View>
  </View>;
}
const styles = StyleSheet.create({
  help: { fontFamily: font.sans, fontSize: typeScale.bodySm, padding: 16, textAlign: 'center' },
  handle: { position: 'absolute', width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: '#ffffff', backgroundColor: '#06675f' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, padding: 12 },
});
