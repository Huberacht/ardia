import { useEffect, useRef } from "react";
import { Animated, View } from "react-native";
import { Button } from "./Button";
import { curve, duration } from "./motion";
import { Symbol } from "./native";
import { Panel } from "./Panel";
import { Text } from "./Text";
import { useHover } from "./useHover";
import { useTheme } from "./theme";
import { radius, shadow, space, toastLayout } from "./tokens";

const DOCK = { position: "absolute", left: 0, right: 0, bottom: toastLayout.bottom, alignItems: "center" } as const;
const BODY = { paddingHorizontal: space.xl, paddingVertical: space.ml, flexDirection: "row", alignItems: "center", gap: space.ml, maxWidth: toastLayout.maxWidth } as const;
const TWO_ACTION_BODY = { ...BODY, maxWidth: toastLayout.twoActionMaxWidth } as const;
const ICON = { width: 20, height: 20 } as const;
const TEXT = { flexShrink: 1 } as const;
const TOAST_FADE = { in: { duration: duration.base, easing: curve.enter }, out: { duration: duration.slow, easing: curve.exit } } as const;

export function Toast({
  title,
  message,
  icon,
  action,
  onAction,
  secondary,
  onSecondary,
  onHeld,
  closing = false,
  onClosed,
}: {
  title: string;
  message?: string;
  icon?: string;
  action?: string;
  onAction?: () => void;
  secondary?: string;
  onSecondary?: () => void;
  onHeld?: (held: boolean) => void;
  closing?: boolean;
  onClosed?: () => void;
}) {
  const theme = useTheme();
  const appear = useRef(new Animated.Value(0)).current;
  const closed = useRef(onClosed);
  closed.current = onClosed;
  const { hovered, hoverProps } = useHover();
  const focused = useRef(new Set<string>());
  const held = useRef(onHeld);
  held.current = onHeld;
  const report = () => held.current?.(hovered || focused.current.size > 0);
  useEffect(report, [hovered]);
  const focusOf = (which: string) => (on: boolean) => {
    if (on) focused.current.add(which);
    else focused.current.delete(which);
    report();
  };
  useEffect(() => {
    const run = Animated.timing(appear, { toValue: closing ? 0 : 1, ...(closing ? TOAST_FADE.out : TOAST_FADE.in), useNativeDriver: true });
    run.start(({ finished }) => finished && closing && closed.current?.());
    return () => run.stop();
  }, [closing]);
  return (
    <View pointerEvents={(action || secondary) && !closing ? "box-none" : "none"} style={DOCK}>
      <Animated.View {...(onHeld ? hoverProps : null)} style={{ opacity: appear }}>
        <Panel fill={theme.toastFill} border={theme.popoverBorder} radius={radius.panel} shadow={shadow.card} material="hudWindow" style={secondary ? TWO_ACTION_BODY : BODY}>
          {icon ? <Symbol name={icon} size={15} color={theme.icon} style={ICON} /> : null}
          <View style={TEXT}>
            <Text weight="semibold">{title}</Text>
            {message ? (
              <Text size="small" tone="textSecondary">
                {message}
              </Text>
            ) : null}
          </View>
          {secondary && onSecondary ? <Button variant="pill" tone="chip" title={secondary} onPress={onSecondary} onFocusChange={onHeld ? focusOf("secondary") : undefined} /> : null}
          {action && onAction ? <Button variant="pill" tone="chip" title={action} onPress={onAction} onFocusChange={onHeld ? focusOf("action") : undefined} /> : null}
        </Panel>
      </Animated.View>
    </View>
  );
}
