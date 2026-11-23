import { useCallback, useEffect, useMemo, useReducer, useRef, type Ref } from "react";
import type { Animated, View } from "react-native";

export type ClipSource = { clipped: () => boolean; subscribe: (changed: () => void) => () => void };
export type EntryMotion = { shift: Animated.Value | null; clip: ClipSource };

type AnimatedPropsHook = (props: object) => [Record<string, unknown>, (instance: View | null) => void];
const useAnimatedProps: AnimatedPropsHook = require("react-native/Libraries/Animated/useAnimatedProps").default;

export function useClipped(source: ClipSource | null | undefined) {
  const [, changed] = useReducer((n: number) => n + 1, 0);
  useEffect(() => source?.subscribe(changed), [source]);
  return !!source?.clipped();
}


export function useAnimatedStyle(style: object | null, own?: (view: View | null) => void): [Record<string, unknown>, Ref<View>] {
  const props = useMemo(() => (style ? { style } : {}), [style]);
  const [animated, attach] = useAnimatedProps(props);
  const ref = useCallback(
    (view: View | null) => {
      attach(view);
      own?.(view);
    },
    [attach, own],
  );
  return [animated, ref];
}

const sliding = new WeakSet<Animated.Value>();
const appearing = new WeakMap<Animated.Value, Animated.Value>();

export const setSliding = (shift: Animated.Value, on: boolean) => void (on ? sliding.add(shift) : sliding.delete(shift));
export const setAppearing = (shift: Animated.Value, opacity: Animated.Value) => void appearing.set(shift, opacity);
export const appearOf = (shift: Animated.Value) => appearing.get(shift) ?? null;

export function useShift(shift: Animated.Value | null, own?: (view: View | null) => void): [Record<string, unknown>, Ref<View>] {
  const style = useMemo(() => {
    if (!shift) return null;
    const opacity = appearing.get(shift);
    return opacity ? { transform: [{ translateY: shift }], opacity } : { transform: [{ translateY: shift }] };
  }, [shift]);
  const [moved, ref] = useAnimatedStyle(style, own);
  const drawn = useRef(moved);
  if (!shift || !sliding.has(shift)) drawn.current = moved;
  return [drawn.current, ref];
}
