import { forwardRef, useEffect, useMemo, useRef } from "react";
import { Animated, Easing, type View } from "react-native";
import type { BreatheProps } from "@ardia/shell";

const STEPS = 24;
const inputRange = Array.from({ length: STEPS + 1 }, (_, i) => i / STEPS);
const level = (t: number) => (1 - Math.cos(2 * Math.PI * t)) / 2;

export const Breathe = forwardRef<View, Partial<BreatheProps>>(function Breathe({ running = false, cycleMs = 1420, opacityRange, scaleRange, style, children, ...rest }, ref) {
  const phase = useRef(new Animated.Value(0)).current;
  const ms = cycleMs > 0 ? cycleMs : 1420;
  const [lowOpacity, highOpacity] = opacityRange ?? [1, 1];
  const [lowScale, highScale] = scaleRange ?? [1, 1];
  useEffect(() => {
    if (!running) return;
    phase.setValue(0);
    const loop = Animated.loop(Animated.timing(phase, { toValue: 1, duration: ms, easing: Easing.linear, useNativeDriver: true, isInteraction: false }));
    loop.start();
    return () => {
      loop.stop();
      phase.stopAnimation();
      phase.setValue(0);
    };
  }, [ms, phase, running]);
  const motion = useMemo(() => {
    const along = (from: number, to: number) => phase.interpolate({ inputRange, outputRange: inputRange.map((t) => from + (to - from) * level(t)) });
    return { opacity: along(lowOpacity, highOpacity), transform: [{ scale: along(lowScale, highScale) }] };
  }, [highOpacity, highScale, lowOpacity, lowScale, phase]);
  return (
    <Animated.View {...rest} ref={ref} pointerEvents="none" style={[style, motion]}>
      {children}
    </Animated.View>
  );
});
