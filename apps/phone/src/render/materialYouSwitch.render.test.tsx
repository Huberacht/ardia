import { Platform, ScrollView, StyleSheet, Text } from "react-native";
import { getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { Surfaces } from "../App";
import { DesignProvider, Portal, useDesign } from "../components/ui";
import { MaterialBottomBar } from "../components/ui/MaterialBottomBar";
import { pages } from "../platform/pages";
import { closeArchive, markSheetFromSettings, openArchive, openSpaces, useBrowse } from "../state/browse/store";
import { handleSystemBack } from "../state/page/actions";
import { closeSettings, openSettings, pushSettings, settingsScroll, useSettingsNav } from "../state/settings/nav";
import { currentPreferences, usePreferences } from "../state/settings/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, textOf, unmount, updateSurface, withTabs } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;
const onIPhone = Platform.OS === "ios" ? test : test.skip;

let counted: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  usePreferences.setState({ materialYou: false });
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, leaving: null, veiled: null });
  jest.spyOn(pages, "listsSitePermissions").mockReturnValue(false);
  counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => closeSettings());
  act(() => jest.runOnlyPendingTimers());
  usePreferences.setState({ materialYou: false });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const materialYouRow = (root: Root): ReactTestInstance | undefined =>
  root.root.findAll((node) => node.props.accessibilityLabel === "Material You" && node.props.accessibilityRole === "switch" && typeof node.props.onPress === "function")[0];
const materialBars = (root: Root) => root.root.findAll((node) => node.type === MaterialBottomBar);
const fullSheet = (root: Root) => root.root.findAll((node) => node.props.testID === "fullSheet" && typeof node.type === "string")[0]!;
const hostById = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string")[0];
const flat = (found: ReactTestInstance | undefined) => StyleSheet.flatten(found?.props.style) ?? {};
const settle = () => {
  for (let frame = 0; frame < 30; frame++) act(() => jest.advanceTimersByTime(16));
};

const settingButton = (root: Root, label: string) =>
  root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!;

onAndroid("Material You is off by default and the switch lives in Appearance", () => {
  expect(currentPreferences().materialYou).toBe(false);
  const root = renderSurface(<Surfaces />);
  expect(materialBars(root)).toHaveLength(0);
  act(() => openSettings());
  settle();
  expect(materialYouRow(root)).toBeUndefined();
  act(() => settingButton(root, "Appearance").props.onPress());
  expect(materialYouRow(root)?.props.accessibilityState).toMatchObject({ checked: false });
  expect(textOf(root)).not.toContain("Dynamic Colors");
  unmount(root);
});

onAndroid("both flips keep the same Settings sheet, list and switch while changing the browser design", () => {
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  act(() => settingButton(root, "Appearance").props.onPress());
  const sheet = fullSheet(root);
  const sheetTop = flat(sheet).top;
  const content = hostById(root, "settingsPageContent");
  const scroll = hostById(root, "settingsPage")!.findAll((node) => node.type === ScrollView)[0]!;
  const toggle = materialYouRow(root)!;
  act(() => scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 100 } } }));

  for (const enabled of [true, false]) {
    act(() => toggle.props.onPress());
    settle();
    expect(useSettingsNav.getState().stack.at(-1)).toEqual({ page: "appearance" });
    expect(fullSheet(root)).toBe(sheet);
    expect(flat(sheet).top).toBe(sheetTop);
    expect(hostById(root, "settingsPageContent")).toBe(content);
    expect(settingsScroll("Appearance")).toBe(100);
    expect(materialYouRow(root)).toBe(toggle);
    expect(toggle.props.accessibilityState.checked).toBe(enabled);
    expect(currentPreferences().materialYou).toBe(enabled);
    expect(materialBars(root)).toHaveLength(enabled ? 1 : 0);
    expect(counted).toHaveBeenCalledWith(enabled ? "material_you_turned_on" : "material_you_turned_off");
  }

  act(() => toggle.props.onPress());
  act(() => void handleSystemBack());
  expect(hostById(root, "settingsTitle")!.props.children).toBe("Settings");
  expect(settingButton(root, "Appearance")).toBeDefined();
  expect(materialYouRow(root)).toBeUndefined();
  unmount(root);
});

onIPhone("iPhone Appearance has no Material You switch", () => {
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  act(() => pushSettings({ page: "appearance" }));
  settle();
  expect(textOf(root)).toContain("Interface style");
  expect(materialYouRow(root)).toBeUndefined();
  unmount(root);
});

onAndroid("rapid Material You flips and dismissal leave the browser in the final design", () => {
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  act(() => {
    usePreferences.setState({ materialYou: true });
    usePreferences.setState({ materialYou: false });
    usePreferences.setState({ materialYou: true });
    closeSettings();
  });
  settle();
  expect(materialBars(root)).toHaveLength(1);
  act(() => {
    openSettings();
    usePreferences.setState({ materialYou: false });
    closeSettings();
  });
  settle();
  expect(materialBars(root)).toHaveLength(0);
  unmount(root);
});

test("a menu portal retains its opening design through its exit", () => {
  function DesignLabel() {
    return <Text testID="portalDesign">{useDesign()}</Text>;
  }
  const root = renderSurface(<DesignProvider design="material"><Portal exitMs={200}><DesignLabel /></Portal></DesignProvider>);
  expect(root.root.findAll((node) => node.props.testID === "portalDesign")[0]!.props.children).toBe("material");
  updateSurface(root, <DesignProvider design="redesigned">{null}</DesignProvider>);
  expect(root.root.findAll((node) => node.props.testID === "portalDesign")[0]!.props.children).toBe("material");
  act(() => jest.advanceTimersByTime(400));
  expect(root.root.findAll((node) => node.props.testID === "portalDesign")).toHaveLength(0);
  unmount(root);
});

onAndroid("Archive opened from Settings while Material You is on slides up as a sheet instead of appearing in place", () => {
  usePreferences.setState({ materialYou: true });
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  for (let pass = 0; pass < 4; pass++) settle();
  const sheet = fullSheet(root);
  expect(getAnimatedStyle(sheet)).toMatchObject({ transform: [{ translateY: 0 }] });
  act(() => {
    closeSettings();
    openArchive();
  });
  act(() => jest.advanceTimersByTime(16));
  const entering = getAnimatedStyle(fullSheet(root)) as { transform: [{ translateY: number }] };
  expect(entering.transform[0].translateY).toBeGreaterThan(200);
  for (let pass = 0; pass < 4; pass++) settle();
  expect(getAnimatedStyle(fullSheet(root))).toMatchObject({ transform: [{ translateY: 0 }] });
  act(() => useBrowse.setState({ sheet: null }));
  unmount(root);
});

for (const [name, open] of [["Archive", openArchive], ["Spaces", openSpaces]] as const) {
  onAndroid(`Back from ${name} opened in Material Settings brings Settings back opaque and in place`, () => {
    usePreferences.setState({ materialYou: true });
    const root = renderSurface(<Surfaces />);
    act(() => openSettings());
    for (let pass = 0; pass < 4; pass++) settle();
    act(() => {
      closeSettings();
      open();
      markSheetFromSettings();
    });
    for (let pass = 0; pass < 4; pass++) settle();
    expect(getAnimatedStyle(fullSheet(root))).toMatchObject({ transform: [{ translateY: 0 }] });
    act(() => void handleSystemBack());
    expect(hostById(root, "settingsTitle")!.props.children).toBe("Settings");
    for (let frame = 0; frame < 20; frame++) {
      act(() => jest.advanceTimersByTime(16));
      expect(getAnimatedStyle(fullSheet(root))).toMatchObject({ transform: [{ translateY: 0 }] });
    }
    act(() => {
      closeSettings();
      closeArchive();
    });
    unmount(root);
  });
}

onAndroid("reopening Settings during dismissal starts a fresh scroll view at the top", () => {
  usePreferences.setState({ materialYou: true });
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  const settingsList = () => root.root.findAll((node) => node.props.testID === "settingsPage" && typeof node.type === "string")[0]!.findAll((node) => node.type === ScrollView)[0]!;
  const previous = settingsList();
  act(() => previous.props.onScroll({ nativeEvent: { contentOffset: { y: 240 } } }));
  expect(settingsScroll("Settings")).toBe(240);
  act(() => closeSettings());
  act(() => openSettings());
  expect(settingsList()).not.toBe(previous);
  expect(settingsList().props.contentOffset).toEqual({ x: 0, y: 0 });
  unmount(root);
});

type DragHandlers = { handlers: { onTouchesDown: (event: unknown, manager: unknown) => void; onTouchesMove: (event: unknown, manager: unknown) => void } };

const dragsFromList = () => {
  const drag = getByGestureTestId("fullSheetDrag") as unknown as DragHandlers;
  const verdict = { activated: false, failed: false };
  const manager = { activate: () => void (verdict.activated = true), fail: () => void (verdict.failed = true), end: () => undefined, begin: () => undefined };
  const at = (y: number) => ({ id: 0, x: 200, y, absoluteX: 200, absoluteY: y });
  act(() => {
    drag.handlers.onTouchesDown({ allTouches: [at(400)], changedTouches: [at(400)] }, manager);
    drag.handlers.onTouchesMove({ allTouches: [at(440)], changedTouches: [at(440)] }, manager);
  });
  return verdict;
};

onAndroid("a final scroll event from the exiting Settings cannot seed the newly opened page or block dragging the sheet down from its list", () => {
  const root = renderSurface(<Surfaces />);
  act(() => openSettings());
  settle();
  const settingsList = () => root.root.findAll((node) => node.props.testID === "settingsPage" && typeof node.type === "string")[0]!.findAll((node) => node.type === ScrollView)[0]!;
  const exitingOnScroll = settingsList().props.onScroll;
  act(() => exitingOnScroll({ nativeEvent: { contentOffset: { y: 240 } } }));
  expect(dragsFromList()).toEqual({ activated: false, failed: true });
  act(() => closeSettings());
  act(() => openSettings());
  act(() => exitingOnScroll({ nativeEvent: { contentOffset: { y: 265 } } }));
  settle();
  expect(settingsList().props.contentOffset).toEqual({ x: 0, y: 0 });
  expect(settingsScroll("Settings")).toBe(0);
  expect(dragsFromList()).toEqual({ activated: true, failed: false });
  const currentOnScroll = settingsList().props.onScroll;
  act(() => currentOnScroll({ nativeEvent: { contentOffset: { y: 90 } } }));
  expect(settingsScroll("Settings")).toBe(90);
  expect(dragsFromList()).toEqual({ activated: false, failed: true });
  unmount(root);
});
