import type { ReactNode } from "react";
import { openDroppedInTab } from "../../state/drag/windowDrop";
import { FileDropArea, type DropUpdate } from "../ui";
import { LINGERING_PANE } from "./lingeringPane";

const SHOWN = { flex: 1 };
const KEPT = { flex: 1, opacity: 0 };

export function NewTabDropArea({ contentAreaOf: tabId, accepting, kept = false, children }: { contentAreaOf: string; accepting: boolean; kept?: boolean; children: ReactNode }) {
  const onDropUpdate = (e: DropUpdate) => {
    if (e.phase === "drop") openDroppedInTab(tabId, e.items);
  };
  return (
    <FileDropArea style={kept ? KEPT : SHOWN} pointerEvents={kept ? "none" : "auto"} nativeID={kept ? LINGERING_PANE : undefined} accepts="linksAndText" enabled={accepting} onDropUpdate={onDropUpdate}>
      {children}
    </FileDropArea>
  );
}
