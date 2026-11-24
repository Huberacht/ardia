import { closeWindow, openWindow, setWindowShown } from "../../platform/windows";
import { isWebDemo } from "./demoSteps";
import { INTRO_WINDOW_ID } from "./introWindow";
import { goToStep, useOnboarding } from "./onboarding";

export const introCanCoverScreen = !isWebDemo;

const INTRO_WINDOW_LINGER_MS = 900;
const CARD_AFTER_WINDOW_MS = 300;

export function holdWindowHidden(browserWindowId: string) {
  void setWindowShown(browserWindowId, false);
}

export function coverScreenForIntro(browserWindowId: string) {
  void setWindowShown(browserWindowId, false);
  void openWindow(INTRO_WINDOW_ID, { kind: "intro", title: "Ardia" });
}

export function uncoverScreen(browserWindowId: string) {
  void setWindowShown(browserWindowId, true);
  setTimeout(closeIntroWindow, INTRO_WINDOW_LINGER_MS);
}

export function handOffFromIntro(burst: boolean) {
  const { windowId } = useOnboarding.getState();
  if (windowId) void setWindowShown(windowId, true, burst);
  setTimeout(() => {
    if (useOnboarding.getState().step === "intro") goToStep("source");
  }, CARD_AFTER_WINDOW_MS);
}

export function closeIntroWindow() {
  void closeWindow(INTRO_WINDOW_ID);
}
