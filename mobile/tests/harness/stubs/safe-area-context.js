import React from 'react';
import { View } from 'react-native';

const INSETS = { top: 44, bottom: 34, left: 0, right: 0 };
const FRAME = { x: 0, y: 0, width: 390, height: 844 };

export const SafeAreaInsetsContext = React.createContext(INSETS);
export const SafeAreaFrameContext = React.createContext(FRAME);

export const SafeAreaProvider = ({ children, ...rest }) =>
  React.createElement(View, rest, children);

export const SafeAreaView = ({ children, ...rest }) =>
  React.createElement(View, rest, children);

export const useSafeAreaInsets = () => INSETS;
export const useSafeAreaFrame = () => FRAME;
export const initialWindowMetrics = { insets: INSETS, frame: FRAME };

export default {
  SafeAreaProvider,
  SafeAreaView,
  SafeAreaInsetsContext,
  SafeAreaFrameContext,
  useSafeAreaInsets,
  useSafeAreaFrame,
  initialWindowMetrics,
};
