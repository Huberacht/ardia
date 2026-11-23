import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Platform, StyleSheet, View, type ScrollViewInstance } from "react-native";
import { BottomSheet, Button, ConfirmationDialog, Group, Host, RNHostView, Text, VStack } from "@expo/ui/swift-ui";
import { ignoreSafeArea, onAppear, onDisappear, presentationDetents, presentationDragIndicator } from "@expo/ui/swift-ui/modifiers";
import { askTranslation, cancelTranslationAsk, closePageMenu, confirmTranslation, pageMenuDismissed, pageMenuHostGone, pageMenuSheetAppeared, pageMenuSheetDisappeared } from "../../state/page/actions";
import { useMenuModel, useMenuOpen, useMenuPage, usePageQuiet, useTranslationAsk } from "../../state/page/hooks";
import { markMenuPhase } from "../../state/page/menuTiming";
import { settingsUIAvailable } from "../ui";
import type { Design } from "../../lib/design";
import { LibraryNavigation } from "../library/ExpoLibrary";
import { PageMenuWords, usePageMenuInk } from "./PageMenuWords";

const contentLaidOut = () => markMenuPhase("laidOut");
const SHEET_EVENTS = [onAppear(pageMenuSheetAppeared), onDisappear(pageMenuSheetDisappeared)];
const MENU_SHEET = [presentationDetents(["medium", "large"]), presentationDragIndicator("visible")];
const LIBRARY_SHEET = [presentationDetents(["large"], { selection: "large" }), presentationDragIndicator("automatic")];

export const usesSystemPageMenu = (design: Design) => design === "redesigned" && Platform.OS === "ios" && settingsUIAvailable();

export function SystemPageMenuHost({ tabId }: { tabId: string }) {
  const open = useMenuOpen();
  const [armed, setArmed] = useState(open);
  const quiet = usePageQuiet(tabId, armed);
  if (!armed && (open || quiet)) setArmed(true);
  useEffect(() => pageMenuHostGone, []);
  if (!armed && !open) return null;
  return <SystemPageMenu tabId={tabId} open={open} onDismissed={pageMenuDismissed} />;
}

export function SystemPageMenu({ tabId, open, onDismissed }: { tabId: string; open: boolean; onDismissed: () => void }) {
  const scroll = useRef<ScrollViewInstance | null>(null);
  useLayoutEffect(() => {
    if (open) markMenuPhase("rendered");
  }, [open]);
  const dismissed = () => {
    scroll.current?.scrollTo({ y: 0, animated: false });
    onDismissed();
  };
  return (
    <Host testID="systemPageMenuSheet" style={styles.anchor} pointerEvents="none">
      <BottomSheet isPresented={open} keepsContentMounted onIsPresentedChange={(presented) => (presented ? undefined : closePageMenu())} onDismiss={dismissed}>
        <Group modifiers={SHEET_EVENTS}>
          <SystemPageMenuContent tabId={tabId} scroll={scroll} />
        </Group>
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
    <ConfirmationDialog title="Translate with Google?" isPresented={ask !== null} onIsPresentedChange={(presented) => (presented ? undefined : cancelTranslationAsk())} titleVisibility="visible">
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
