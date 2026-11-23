import { forwardRef, useEffect, useMemo, useRef } from "react";
import { Animated, Easing, type View } from "react-native";
import type { BreatheProps } from "@ardia/shell";

const level = (t: number) => (1 - Math.cos(2 * Math.PI * t)) / 2;

export const Breathe = forwardRef<View, Partial<BreatheProps>>(function Breathe({ running = false, cycleMs = 1420, opacityRange = [1, 1], scaleRange = [1, 1], style, children, ...rest }, ref) {
  const phase = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!running || !(cycleMs > 0)) return;
    phase.setValue(0);
    const loop = Animated.loop(Animated.timing(phase, { toValue: 1, duration: cycleMs, easing: Easing.linear, useNativeDriver: true, isInteraction: false }));
    loop.start();
    return () => {
      loop.stop();
      phase.setValue(0);
    };
  }, [cycleMs, phase, running]);
  const motion = useMemo(() => {
    const inputRange = Array.from({ length: 25 }, (_, i) => i / 24);
    const along = (from: number, to: number) => phase.interpolate({ inputRange, outputRange: inputRange.map((t) => from + (to - from) * level(t)) });
    return { opacity: along(opacityRange[0], opacityRange[1]), transform: [{ scale: along(scaleRange[0], scaleRange[1]) }] };
  }, [opacityRange, phase, scaleRange]);
  return (
    <Animated.View {...rest} ref={ref} pointerEvents="none" style={[style, motion]}>
      {children}
    </Animated.View>
  );
});
