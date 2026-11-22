import { useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { BottomSheet, Button, ConfirmationDialog, Group, Host, RNHostView, Text, VStack } from "@expo/ui/swift-ui";
import { ignoreSafeArea, presentationDetents, presentationDragIndicator } from "@expo/ui/swift-ui/modifiers";
import { closePageMenu, pageMenuHidden, translatePage } from "../../state/page/actions";
import { useMenuModel, useMenuOpen, useMenuPage, usePageQuiet, useTranslationConfirmed } from "../../state/page/hooks";
import { translationAsks } from "../../state/page/pageMenu";
import { useTab } from "../../state/tabs/hooks";
import { settingsUIAvailable } from "../ui";
import type { Design } from "../../lib/design";
import { LibraryNavigation } from "../library/ExpoLibrary";
import { PageMenuWords, usePageMenuInk } from "./PageMenuWords";

const MENU_SHEET = [presentationDetents(["medium", "large"]), presentationDragIndicator("visible")];
const LIBRARY_SHEET = [presentationDetents(["large"], { selection: "large" }), presentationDragIndicator("automatic")];

export const usesSystemPageMenu = (design: Design) => design === "redesigned" && Platform.OS === "ios" && settingsUIAvailable();

export function SystemPageMenuHost({ tabId }: { tabId: string }) {
  const open = useMenuOpen();
  const [armed, setArmed] = useState(open);
  const quiet = usePageQuiet(tabId, armed);
  if (!armed && (open || quiet)) setArmed(true);
  if (!armed && !open) return null;
  return <SystemPageMenu tabId={tabId} open={open} onDismissed={pageMenuHidden} />;
}

export function SystemPageMenu({ tabId, open, onDismissed }: { tabId: string; open: boolean; onDismissed: () => void }) {
  return (
    <Host testID="systemPageMenuSheet" style={styles.anchor} pointerEvents="none">
      <BottomSheet isPresented={open} onIsPresentedChange={(presented) => (presented ? undefined : closePageMenu())} onDismiss={onDismissed}>
        <SystemPageMenuContent tabId={tabId} />
      </BottomSheet>
    </Host>
  );
}

function SystemPageMenuContent({ tabId }: { tabId: string }) {
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
      <PageMenuSheetWords tabId={tabId} />
    </Group>
  );
}

function PageMenuSheetWords({ tabId }: { tabId: string }) {
  const ink = usePageMenuInk();
  const model = useMenuModel(tabId);
  const isPrivate = useTab(tabId)?.isPrivate ?? false;
  const confirmed = useTranslationConfirmed();
  const [asksTranslation, setAsksTranslation] = useState(false);
  const translate = () => (translationAsks(isPrivate, confirmed) ? setAsksTranslation(true) : translatePage());
  return (
    <ConfirmationDialog title="Translate with Google?" isPresented={asksTranslation} onIsPresentedChange={setAsksTranslation} titleVisibility="visible">
      <ConfirmationDialog.Trigger>
        <VStack modifiers={[ignoreSafeArea({ edges: "bottom" })]}>
          <RNHostView>
            <View testID="systemPageMenuFill" style={[styles.fill, { backgroundColor: ink.solid }]}>
              <PageMenuWords tabId={tabId} model={model} onTranslate={translate} systemSheet />
            </View>
          </RNHostView>
        </VStack>
      </ConfirmationDialog.Trigger>
      <ConfirmationDialog.Actions>
        <Button label="Translate" onPress={translatePage} />
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
