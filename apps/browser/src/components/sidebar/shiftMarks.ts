import type { Animated } from "react-native";

const sliding = new WeakSet<Animated.Value>();
const appearing = new WeakMap<Animated.Value, Animated.Value>();
const isNative = (value: Animated.Value | undefined) => !!(value as { __isNative?: boolean } | undefined)?.__isNative;

export const setSliding = (shift: Animated.Value, on: boolean) => void (on ? sliding.add(shift) : sliding.delete(shift));
export const setAppearing = (shift: Animated.Value, opacity: Animated.Value) => void appearing.set(shift, opacity);
export const appearOf = (shift: Animated.Value) => appearing.get(shift) ?? null;
export const holdsDrawn = (shift: Animated.Value) => sliding.has(shift) && (isNative(shift) || isNative(appearing.get(shift)));
