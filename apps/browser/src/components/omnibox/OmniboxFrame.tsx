import type { SearchScope } from "@ardia/core";
import type { ReactNode, RefObject } from "react";
import { View } from "react-native";
import { Button, ContextMenuArea, useHover, useTheme } from "../ui";
import { ScopeChip } from "./ScopeChip";
import { BAR } from "./tokens";

type FrameProps = {
  rootRef: RefObject<View | null>;
  onContextMenu(): void;
  leadingIcon: ReactNode;
  scope: SearchScope | null;
  field: ReactNode;
  list: ReactNode;
  rowsHover: ReturnType<typeof useHover>["hoverProps"];
  pulse: ReactNode;
};

const ICON_SLOT = { width: BAR.iconSlot, alignItems: "center" } as const;

export function DropdownFrame({ rootRef, onContextMenu, leadingIcon, scope, field, list, rowsHover, pulse, onSiteControls }: FrameProps & { onSiteControls: (() => void) | null }) {
  const theme = useTheme();
  return (
    <View ref={rootRef}>
      {pulse}
      <ContextMenuArea captureDescendants onContextMenu={onContextMenu}>
        <View style={{ flexDirection: "row", alignItems: "center", height: BAR.dropdown.height, paddingLeft: BAR.dropdown.left, paddingRight: BAR.dropdown.right, gap: BAR.dropdown.gap }}>
          <View style={ICON_SLOT}>{leadingIcon}</View>
          {scope && <ScopeChip scope={scope} large={false} />}
          {field}
          {onSiteControls ? (
            <Button variant="icon"
              icon="info.circle"
              size="l"
              glyph={BAR.siteControls.glyph}
              capsule
              color={theme.textSecondary}
              tooltip="Site Controls"
              onPress={onSiteControls}
            />
          ) : null}
        </View>
      </ContextMenuArea>
      <View collapsable={false} {...rowsHover}>
        {list}
      </View>
    </View>
  );
}

export function PanelFrame({ rootRef, onContextMenu, leadingIcon, scope, field, list, rowsHover, pulse, hero, rowHeight }: FrameProps & { hero: boolean; rowHeight: number }) {
  return (
    <View ref={rootRef}>
      {pulse}
      <ContextMenuArea captureDescendants onContextMenu={onContextMenu}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            height: hero ? BAR.panel.heroHeight : rowHeight,
            paddingLeft: hero ? BAR.panel.heroIconLeft : BAR.panel.iconLeft,
            paddingRight: BAR.panel.right,
            gap: hero ? BAR.panel.heroGap : BAR.panel.gap,
          }}
        >
          <View style={ICON_SLOT}>{leadingIcon}</View>
          {scope && <ScopeChip scope={scope} large={hero} />}
          {field}
        </View>
      </ContextMenuArea>
      <View collapsable={false} {...rowsHover}>
        {list}
        {list ? <View style={{ height: hero ? BAR.panel.heroBelowList : BAR.panel.belowList }} /> : null}
      </View>
    </View>
  );
}
