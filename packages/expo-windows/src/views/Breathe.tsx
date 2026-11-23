import { forwardRef, useEffect, useMemo } from "react";
import { Animated, Easing, type View } from "react-native";
import type { BreatheProps } from "@ardia/shell";

const STEPS = 24;
const inputRange = Array.from({ length: STEPS + 1 }, (_, i) => i / STEPS);
const level = (t: number) => (1 - Math.cos(2 * Math.PI * t)) / 2;

type Cycle = { phase: Animated.Value; loop: Animated.CompositeAnimation | null; users: number };
const cycles = new Map<number, Cycle>();

function cycleFor(ms: number): Cycle {
  let cycle = cycles.get(ms);
  if (!cycle) cycles.set(ms, (cycle = { phase: new Animated.Value(0), loop: null, users: 0 }));
  return cycle;
}

function startBreathing(ms: number) {
  const cycle = cycleFor(ms);
  cycle.users += 1;
  if (cycle.loop) return;
  cycle.phase.setValue(0);
  cycle.loop = Animated.loop(Animated.timing(cycle.phase, { toValue: 1, duration: ms, easing: Easing.linear, useNativeDriver: true, isInteraction: false }));
  cycle.loop.start();
}

function stopBreathing(ms: number) {
  const cycle = cycleFor(ms);
  cycle.users = Math.max(0, cycle.users - 1);
  if (cycle.users > 0 || !cycle.loop) return;
  cycle.loop.stop();
  cycle.loop = null;
}

export const Breathe = forwardRef<View, Partial<BreatheProps>>(function Breathe({ running = false, cycleMs = 1420, opacityRange, scaleRange, style, children, ...rest }, ref) {
  const ms = cycleMs > 0 ? cycleMs : 1420;
  const [lowOpacity, highOpacity] = opacityRange ?? [1, 1];
  const [lowScale, highScale] = scaleRange ?? [1, 1];
  useEffect(() => {
    if (!running) return;
    startBreathing(ms);
    return () => stopBreathing(ms);
  }, [ms, running]);
  const motion = useMemo(() => {
    if (!running) return { opacity: lowOpacity, transform: [{ scale: lowScale }] };
    const { phase } = cycleFor(ms);
    const along = (from: number, to: number) => phase.interpolate({ inputRange, outputRange: inputRange.map((t) => from + (to - from) * level(t)) });
    return { opacity: along(lowOpacity, highOpacity), transform: [{ scale: along(lowScale, highScale) }] };
  }, [highOpacity, highScale, lowOpacity, lowScale, ms, running]);
  return (
    <Animated.View {...rest} ref={ref} pointerEvents="none" style={[style, motion]}>
      {children}
    </Animated.View>
  );
});
