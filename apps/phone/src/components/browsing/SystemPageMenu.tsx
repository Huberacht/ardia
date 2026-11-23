import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Platform, StyleSheet, View, type ScrollViewInstance } from "react-native";
import { BottomSheet, Button, ConfirmationDialog, Group, Host, RNHostView, Text, VStack } from "@expo/ui/swift-ui";
import { ignoreSafeArea, presentationDetents, presentationDragIndicator } from "@expo/ui/swift-ui/modifiers";
import { askTranslation, confirmTranslation, pageMenuHostGone, pageMenuPresentation, releaseTranslationAsk, type MenuPresentation } from "../../state/page/actions";
import { useMenuModel, useMenuOpen, useMenuOpening, useMenuPage, usePageQuiet, useTranslationAsk } from "../../state/page/hooks";
import { markMenuPhase } from "../../state/page/menuTiming";
import { settingsUIAvailable } from "../ui";
import type { Design } from "../../lib/design";
import { LibraryNavigation } from "../library/ExpoLibrary";
import { PageMenuWords, usePageMenuInk } from "./PageMenuWords";

const contentLaidOut = () => markMenuPhase("laidOut");
const presentationIgnored = () => undefined;
const MENU_SHEET = [presentationDetents(["medium", "large"]), presentationDragIndicator("visible")];
const LIBRARY_SHEET = [presentationDetents(["large"], { selection: "large" }), presentationDragIndicator("automatic")];

export const usesSystemPageMenu = (design: Design) => design === "redesigned" && Platform.OS === "ios" && settingsUIAvailable();

export function SystemPageMenuHost({ tabId }: { tabId: string }) {
  const open = useMenuOpen();
  const [armed, setArmed] = useState(open);
  const quiet = usePageQuiet(tabId, armed);
  if (!armed && (open || quiet)) setArmed(true);
  const shownToken = useRef<number | null>(null);
  useEffect(() => () => pageMenuHostGone(shownToken.current), []);
  if (!armed && !open) return null;
  return <SystemPageMenu tabId={tabId} open={open} shownToken={shownToken} onPresentation={pageMenuPresentation} />;
}

type SystemPageMenuProps = { tabId: string; open: boolean; shownToken?: RefObject<number | null>; onPresentation: (presentation: MenuPresentation) => void };

export function SystemPageMenu({ tabId, open, shownToken, onPresentation }: SystemPageMenuProps) {
  const scroll = useRef<ScrollViewInstance | null>(null);
  const token = useMenuOpening();
  useLayoutEffect(() => {
    if (open) markMenuPhase("rendered");
  }, [open]);
  const presentation = (event: MenuPresentation) => {
    if (event.phase === "appear" && shownToken) shownToken.current = event.token;
    if (event.phase === "dismiss") scroll.current?.scrollTo({ y: 0, animated: false });
    onPresentation(event);
  };
  return (
    <Host testID="systemPageMenuSheet" style={styles.anchor} pointerEvents="none">
      <BottomSheet isPresented={open} keepsContentMounted presentationToken={token} onIsPresentedChange={presentationIgnored} onPresentation={presentation}>
        <SystemPageMenuContent tabId={tabId} scroll={scroll} />
      </BottomSheet>
    </Host>
  );
}

function SystemPageMenuContent({ tabId, scroll }: { tabId: string; scroll: RefObject<ScrollViewInstance | null> }) {
  const page = useMenuPage();
  if (page === "library") {
    return (
      <Group modifiers={LIBRARY_SHEET}>
        <LibraryNavigation />
      </Group>
    );
  }
  return (
    <Group modifiers={MENU_SHEET}>
      <PageMenuSheetWords tabId={tabId} scroll={scroll} />
    </Group>
  );
}

function PageMenuSheetWords({ tabId, scroll }: { tabId: string; scroll: RefObject<ScrollViewInstance | null> }) {
  const ink = usePageMenuInk();
  const model = useMenuModel(tabId);
  const ask = useTranslationAsk();
  return (
    <ConfirmationDialog title="Translate with Google?" isPresented={ask !== null} onIsPresentedChange={(presented) => (presented ? undefined : releaseTranslationAsk(ask))} titleVisibility="visible">
      <ConfirmationDialog.Trigger>
        <VStack modifiers={[ignoreSafeArea({ edges: "bottom" })]}>
          <RNHostView>
            <View testID="systemPageMenuFill" style={[styles.fill, { backgroundColor: ink.solid }]} onLayout={contentLaidOut}>
              <PageMenuWords tabId={tabId} model={model} onTranslate={askTranslation} systemSheet scrollRef={scroll} />
            </View>
          </RNHostView>
        </VStack>
      </ConfirmationDialog.Trigger>
      <ConfirmationDialog.Actions>
        <Button label="Translate" onPress={() => confirmTranslation(ask)} />
      </ConfirmationDialog.Actions>
      <ConfirmationDialog.Message>
        <Text>Google will see this page’s address.</Text>
      </ConfirmationDialog.Message>
    </ConfirmationDialog>
  );
}

const styles = StyleSheet.create({
  anchor: { position: "absolute", width: 0, height: 0 },
  fill: { flex: 1 },
});
