import React from 'react';
import { View } from 'react-native';

/**
 * react-native-svg draws through native views. The stub preserves the element
 * hierarchy and all props (including accessibility props) so gauges/charts can
 * still be inspected, without needing the native SVG implementation.
 */
const makeSvgComponent = (name) => {
  const Component = ({ children, ...rest }) =>
    React.createElement(View, rest, children);
  Component.displayName = name;
  return Component;
};

export const Svg = makeSvgComponent('Svg');
export const Circle = makeSvgComponent('Circle');
export const Ellipse = makeSvgComponent('Ellipse');
export const G = makeSvgComponent('G');
export const Line = makeSvgComponent('Line');
export const Path = makeSvgComponent('Path');
export const Polygon = makeSvgComponent('Polygon');
export const Polyline = makeSvgComponent('Polyline');
export const Rect = makeSvgComponent('Rect');
export const Defs = makeSvgComponent('Defs');
export const Stop = makeSvgComponent('Stop');
export const LinearGradient = makeSvgComponent('LinearGradient');
export const RadialGradient = makeSvgComponent('RadialGradient');
export const ClipPath = makeSvgComponent('ClipPath');
export const Mask = makeSvgComponent('Mask');
export const Use = makeSvgComponent('Use');
export const Symbol = makeSvgComponent('Symbol');
export const Marker = makeSvgComponent('Marker');
export const Pattern = makeSvgComponent('Pattern');
export const TSpan = makeSvgComponent('TSpan');
export const TextPath = makeSvgComponent('TextPath');
export const Text = makeSvgComponent('SvgText');
export const SvgXml = makeSvgComponent('SvgXml');

export default Svg;
