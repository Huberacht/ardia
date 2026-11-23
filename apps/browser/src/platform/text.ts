import type { CleanedUrl } from "@ardia/core";
import { copyFieldAs as copyNativeFieldAs, nativeModule } from "@ardia/shell";

export { completeInline, keepInlineWhileTyping, takeKeptInline, translation } from "@ardia/shell";

export const copyFieldAs = (shown: string | null, url: CleanedUrl | null) => copyNativeFieldAs(shown, url);

export const startDictation = () => nativeModule("ArdiaShell").startDictation();
export const dictationAvailable = () => nativeModule("ArdiaShell").dictationAvailable?.() !== false;
