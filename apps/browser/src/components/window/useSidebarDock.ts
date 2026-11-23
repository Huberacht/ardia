import { useEffect, useInsertionEffect, useRef, useState } from "react";
import { Animated, StyleSheet } from "react-native";
import { switchOn } from "../../state/app/switches";
import { curve, keepAttached } from "../ui/motion";
import { reduceMotion } from "../ui";
import { useWindowId } from "../../state/browser/hooks";
import { consentToken, type ConsentToken } from "../../state/telemetry/consentPeriod";
import { noteSidebarSlide, noteSidebarSlideLandingOverdue } from "../../state/telemetry/dockCounts";
import { peekShown, setDockMoving } from "../../state/windows/dockMotion";
import { ARC_HIDE_MS, DOCK_SLIDE } from "./tokens";
import { dockMove } from "./dockMotion";

type DockLayout = { docked: boolean; sliding: boolean };

const DOCKED_LAYOUT_DEADLINE_MS = 250;

export function useSidebarDock(open: boolean, animate: boolean, arc: boolean): { dock: Animated.Value; away: boolean; layout: DockLayout; laidOut: () => void } {
  const windowId = useWindowId();
  const dock = useRef(new Animated.Value(open ? 1 : 0)).current;
  const was = useRef(open);
  const [away, setAway] = useState(!open);
  const [layout, setLayout] = useState<DockLayout>({ docked: open, sliding: false });
  const landing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const land = (overdue?: ConsentToken | null) => {
    if (landing.current === null) return;
    if (overdue !== undefined) noteSidebarSlideLandingOverdue(overdue);
    clearTimeout(landing.current);
    landing.current = null;
    setTimeout(() => setDockMoving(windowId, false), 0);
  };
  const stopLanding = () => {
    if (landing.current !== null) clearTimeout(landing.current);
    landing.current = null;
  };
  useInsertionEffect(() => keepAttached(dock), [dock]);
  useEffect(() => {
    if (was.current === open) return;
    was.current = open;
    stopLanding();
    const move = dockMove({ open, animated: animate && !reduceMotion() && switchOn("sidebarSlide"), arc, peekOut: peekShown(windowId) });
    if (move === "jump") {
      dock.stopAnimation();
      dock.setValue(open ? 1 : 0);
      setDockMoving(windowId, false);
      setLayout({ docked: open, sliding: false });
      setAway(!open);
      return;
    }
    if (open) setAway(false);
    setLayout({ docked: false, sliding: true });
    setDockMoving(windowId, true);
    let pastTarget = false;
    const watch = dock.addListener(({ value }) => {
      if (value > 1 || value < 0) pastTarget = true;
    });
    const consent = consentToken();
    const slideMs = move === "arcHide" ? ARC_HIDE_MS : DOCK_SLIDE.duration;
    const startedAt = Date.now();
    (move === "arcHide"
      ? Animated.timing(dock, { toValue: 0, duration: ARC_HIDE_MS, easing: curve.enter, useNativeDriver: true })
      : Animated.timing(dock, { toValue: open ? 1 : 0, ...DOCK_SLIDE, useNativeDriver: true })
    ).start(({ finished }) => {
      dock.removeListener(watch);
      if (!finished) return;
      noteSidebarSlide(consent, pastTarget, Date.now() - startedAt - slideMs);
      setLayout({ docked: open, sliding: false });
      if (!open) {
        setDockMoving(windowId, false);
        setAway(true);
        return;
      }
      landing.current = setTimeout(() => land(consent), DOCKED_LAYOUT_DEADLINE_MS);
    });
  }, [open]);
  useEffect(
    () => () => {
      stopLanding();
      setDockMoving(windowId, false);
    },
    [],
  );
  return { dock, away, layout, laidOut: () => land() };
}

export const dockStyles = StyleSheet.create({
  row: { flex: 1, flexDirection: "row" },
  column: { flex: 1 },
});

export function cardSlide(dock: Animated.Value, travel: number, vertical: boolean, radius: number) {
  const shift = dock.interpolate({ inputRange: [0, 1], outputRange: [0, travel] });
  if (vertical) return { clip: { overflow: "hidden" as const, borderRadius: radius }, content: { transform: [{ translateY: shift }] } };
  const back = dock.interpolate({ inputRange: [0, 1], outputRange: [0, -travel] });
  return { clip: { overflow: "hidden" as const, borderRadius: radius, transform: [{ translateX: shift }] }, content: { transform: [{ translateX: back }] } };
}
