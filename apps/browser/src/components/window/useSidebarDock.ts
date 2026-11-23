import { useEffect, useInsertionEffect, useMemo, useRef, useState } from "react";
import { Animated, StyleSheet } from "react-native";
import { switchOn } from "../../state/app/switches";
import { curve, keepAttached } from "../ui/motion";
import { reduceMotion } from "../ui";
import { useWindowId } from "../../state/browser/hooks";
import { consentToken } from "../../state/telemetry/consentPeriod";
import { noteSidebarSlide, noteSidebarSlideLandingOverdue } from "../../state/telemetry/dockCounts";
import { peekShown, setDockMoving } from "../../state/windows/dockMotion";
import { ARC_HIDE_MS, DOCK_SLIDE } from "./tokens";
import { dockMove, dockSlides, type CardMotion } from "./dockMotion";

export type DockLayout = { docked: boolean; sliding: boolean };

const clock = {
  later: (run: () => void, ms: number) => setTimeout(run, ms),
  cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function useSidebarDock(open: boolean, animate: boolean, arc: boolean, motion: CardMotion): { dock: Animated.Value; away: boolean; layout: DockLayout; laidOut: () => void } {
  const windowId = useWindowId();
  const was = useRef(open);
  const dock = useMemo(() => new Animated.Value(was.current ? 1 : 0), [motion]);
  const [away, setAway] = useState(!open);
  const [layout, setLayout] = useState<DockLayout>({ docked: open, sliding: false });
  const slides = useRef<ReturnType<typeof dockSlides>>(null);
  slides.current ??= dockSlides(clock, () => setDockMoving(windowId, false));
  const motionWas = useRef(motion);
  useInsertionEffect(() => keepAttached(dock), [dock]);
  useEffect(() => {
    if (motionWas.current === motion) return;
    motionWas.current = motion;
    slides.current!.end();
    setDockMoving(windowId, false);
    setLayout({ docked: was.current, sliding: false });
    setAway(!was.current);
  }, [motion]);
  useEffect(() => {
    if (was.current === open) return;
    was.current = open;
    const id = slides.current!.begin();
    const move = dockMove({ open, animated: animate && !reduceMotion() && switchOn("sidebarSlide"), arc, peekOut: peekShown(windowId) });
    if (move === "jump") {
      dock.stopAnimation();
      dock.setValue(open ? 1 : 0);
      setDockMoving(windowId, false);
      setLayout({ docked: open, sliding: false });
      setAway(!open);
      return;
    }
    const native = motion === "compositor";
    if (open) setAway(false);
    setLayout({ docked: open && !native, sliding: native });
    setDockMoving(windowId, true);
    let pastTarget = false;
    const watch = dock.addListener(({ value }) => {
      if (value > 1 || value < 0) pastTarget = true;
    });
    const consent = consentToken();
    const slideMs = move === "arcHide" ? ARC_HIDE_MS : DOCK_SLIDE.duration;
    const startedAt = Date.now();
    (move === "arcHide"
      ? Animated.timing(dock, { toValue: 0, duration: ARC_HIDE_MS, easing: curve.enter, useNativeDriver: native })
      : Animated.timing(dock, { toValue: open ? 1 : 0, ...DOCK_SLIDE, useNativeDriver: native })
    ).start(({ finished }) => {
      dock.removeListener(watch);
      if (!finished || !slides.current!.isCurrent(id)) return;
      noteSidebarSlide(consent, pastTarget, Date.now() - startedAt - slideMs);
      setLayout({ docked: open, sliding: false });
      if (!open) setAway(true);
      if (open && native) slides.current!.awaitLayout(id, () => noteSidebarSlideLandingOverdue(consent));
      else setDockMoving(windowId, false);
    });
  }, [open]);
  useEffect(
    () => () => {
      slides.current!.end();
      setDockMoving(windowId, false);
    },
    [],
  );
  return { dock, away, layout, laidOut: () => slides.current!.laidOut() };
}

export const dockStyles = StyleSheet.create({
  row: { flex: 1, flexDirection: "row" },
  column: { flex: 1 },
});

export function cardSlide(dock: Animated.Value, travel: number, radius: number) {
  const shift = dock.interpolate({ inputRange: [0, 1], outputRange: [0, travel] });
  const back = dock.interpolate({ inputRange: [0, 1], outputRange: [0, -travel] });
  return { clip: { overflow: "hidden" as const, borderRadius: radius, transform: [{ translateX: shift }] }, content: { transform: [{ translateX: back }] } };
}
