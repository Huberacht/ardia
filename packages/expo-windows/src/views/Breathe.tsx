import { forwardRef } from "react";
import { View } from "react-native";
import type { BreatheProps } from "@ardia/shell";

export const Breathe = forwardRef<View, Partial<BreatheProps>>(function Breathe({ running: _running, cycleMs: _cycleMs, opacityRange, scaleRange, style, children, ...rest }, ref) {
  const resting = { opacity: opacityRange?.[0] ?? 1, transform: [{ scale: scaleRange?.[0] ?? 1 }] };
  return (
    <View {...rest} ref={ref} pointerEvents="none" style={[style, resting]}>
      {children}
    </View>
  );
});
