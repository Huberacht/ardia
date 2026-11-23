import type { ComponentProps, ReactNode } from "react";
import { Animated, StyleSheet, type LayoutChangeEvent } from "react-native";
import { WindowDragRegion } from "../ui";

type AnimatedStyle = ComponentProps<typeof Animated.View>["style"];

export function DockFrame({
  padding,
  clip,
  content,
  dragRegion,
  onLayout,
  children,
}: {
  padding: AnimatedStyle;
  clip: AnimatedStyle;
  content: AnimatedStyle;
  dragRegion: boolean;
  onLayout?: (e: LayoutChangeEvent) => void;
  children: ReactNode;
}) {
  return (
    <Animated.View style={padding}>
      {dragRegion && <WindowDragRegion style={StyleSheet.absoluteFill} />}
      <Animated.View style={clip}>
        <Animated.View style={content} onLayout={onLayout}>
          {children}
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}
