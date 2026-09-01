import React from 'react';
import { Text } from 'react-native';

/**
 * Icon fonts cannot load in a test process. The stub renders a Text node and
 * forwards every prop the call site passed — including accessibility props —
 * so tests can assert that decorative icons are hidden from assistive tech.
 */
const makeIconSet = (family) => {
  const Icon = ({ name, ...rest }) =>
    React.createElement(Text, rest, `${family}:${name ?? ''}`);
  Icon.displayName = family;
  return Icon;
};

export const AntDesign = makeIconSet('AntDesign');
export const Entypo = makeIconSet('Entypo');
export const EvilIcons = makeIconSet('EvilIcons');
export const Feather = makeIconSet('Feather');
export const FontAwesome = makeIconSet('FontAwesome');
export const FontAwesome5 = makeIconSet('FontAwesome5');
export const FontAwesome6 = makeIconSet('FontAwesome6');
export const Fontisto = makeIconSet('Fontisto');
export const Foundation = makeIconSet('Foundation');
export const Ionicons = makeIconSet('Ionicons');
export const MaterialCommunityIcons = makeIconSet('MaterialCommunityIcons');
export const MaterialIcons = makeIconSet('MaterialIcons');
export const Octicons = makeIconSet('Octicons');
export const SimpleLineIcons = makeIconSet('SimpleLineIcons');
export const Zocial = makeIconSet('Zocial');

export const createIconSet = () => makeIconSet('Custom');
export const createIconSetFromFontello = () => makeIconSet('Fontello');
export const createIconSetFromIcoMoon = () => makeIconSet('IcoMoon');

export default {
  AntDesign,
  Entypo,
  EvilIcons,
  Feather,
  FontAwesome,
  FontAwesome5,
  FontAwesome6,
  Fontisto,
  Foundation,
  Ionicons,
  MaterialCommunityIcons,
  MaterialIcons,
  Octicons,
  SimpleLineIcons,
  Zocial,
  createIconSet,
};
