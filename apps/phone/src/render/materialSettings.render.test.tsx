import { Platform, StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { Surfaces } from "../App";
import { MaterialBottomBar } from "../components/ui/MaterialBottomBar";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import { closeArchive, openArchive } from "../state/browse/store";
import { closeSettings, openSettings, pushSettings } from "../state/settings/nav";
import { currentPreferences, loadPreferences, setPreference } from "../state/settings/store";
import { renderSurface, unmount, withTabs, withMaterialYou } from "../../test/render/harness";

withMaterialYou();

const onAndroid = Platform.OS === "android" ? test : test.skip;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  setDynamicScheme(null);
  openSettings();
});

afterEach(() => {
  act(() => closeSettings());
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;
const row = (root: Root, label: string) => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!;

type Detected = { toGestureArray?: () => { config: { testId?: string; enabled?: boolean } }[] };

const sheetDragEnabled = (root: Root) =>
  root.root
    .findAll((found) => typeof (found.props.gesture as Detected | undefined)?.toGestureArray === "function")
    .flatMap((found) => (found.props.gesture as Required<Detected>).toGestureArray())
    .filter((gesture) => gesture.config.testId === "fullSheetDrag")
    .map((gesture) => gesture.config.enabled !== false)
    .pop();

onAndroid("Archive keeps the Material bottom sheet, with its top gap, corners and drag", () => {
  closeSettings();
  openArchive();
  const root = renderSurface(<Surfaces />);
  const sheet = root.root.findAll((node) => node.props.testID === "fullSheet" && typeof node.type === "string")[0]!;
  expect(StyleSheet.flatten(sheet.props.style)).toMatchObject({ top: 40, borderTopLeftRadius: 28 });
  expect(sheetDragEnabled(root)).toBe(true);
  act(() => closeArchive());
  unmount(root);
});

onAndroid("Dynamic Colors still changes the browser palette and saves the preference through Appearance", () => {
  setDynamicScheme(SEEDED_SCHEMES.green);
  setPreference("colorChoice", "blue");
  setPreference("dynamicColors", true);
  pushSettings({ page: "appearance" });
  const root = renderSurface(<Surfaces />);
  const toggle = row(root, "Dynamic Colors");
  const scheme = () => root.root.findAll((node) => node.type === MaterialBottomBar)[0]!.props.scheme;
  expect(toggle.props.accessibilityState.checked).toBe(true);
  expect(row(root, "Custom").props.accessibilityState.disabled).toBe(true);
  expect(row(root, "Blue").props.accessibilityState.disabled).toBe(true);
  expect(row(root, "Glass").props.accessibilityState.disabled).toBe(true);
  expect(scheme()).toEqual(SEEDED_SCHEMES.green.light);
  act(() => toggle.props.onPress());
  expect(scheme()).toEqual(SEEDED_SCHEMES.blue.light);
  expect(row(root, "Blue").props.accessibilityState.disabled).toBeUndefined();
  act(() => loadPreferences());
  expect(currentPreferences().dynamicColors).toBe(false);
  expect(currentPreferences().colorChoice).toBe("blue");
  unmount(root);
});

onAndroid("Site Settings still controls Collapse Bottom Bar with Material You on", () => {
  setPreference("collapsesBottomBar", null);
  pushSettings({ page: "siteSettings" });
  const root = renderSurface(<Surfaces />);
  const collapse = row(root, "Collapse Bottom Bar");
  expect(collapse.props.accessibilityState.checked).toBe(true);
  act(() => collapse.props.onPress());
  expect(collapse.props.accessibilityState.checked).toBe(false);
  expect(currentPreferences().collapsesBottomBar).toBe(false);
  act(() => setPreference("collapsesBottomBar", null));
  unmount(root);
});

onAndroid("My Filters keeps the Settings sheet open and Tabs shows the layout Material You supports", () => {
  pushSettings({ page: "myFilters" });
  const root = renderSurface(<Surfaces />);
  expect(sheetDragEnabled(root)).toBe(false);
  act(() => pushSettings({ page: "tabs" }));
  expect(sheetDragEnabled(root)).toBe(true);
  expect(row(root, "Stack").props.accessibilityState).toMatchObject({ selected: true, disabled: true });
  expect(row(root, "Grid").props.accessibilityState).toMatchObject({ selected: false, disabled: true });
  unmount(root);
});
