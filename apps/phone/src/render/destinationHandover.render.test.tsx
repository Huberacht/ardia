import { getAnimatedStyle } from "react-native-reanimated";
import { getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { StyleSheet } from "react-native";
import { Surfaces } from "../App";
import { sendDeckCommand } from "../state/browse/deckCommands";
import { pageBarPreviewShown, pageBarShown } from "../state/browse/deckPull";
import { destination, liftDestination, releaseDestination, useDestination } from "../state/browse/destination";
import * as browse from "../state/browse/store";
import { cutTabSwitches } from "../state/browse/tabSwitch";
import { display } from "../state/search/omnibox";
import { dismissSearch, searchState } from "../state/search/store";
import { setPreference } from "../state/settings/store";
import { currentTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual<typeof import("@ardia/phone-native")>("@ardia/phone-native");
  return { ...actual, pageReportsDrawn: () => true };
});

beforeEach(() => {
  jest.useFakeTimers();
  cutTabSwitches(true);
  setPreference("tabSwipeHintShown", true);
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => releaseDestination());
  act(() => jest.runOnlyPendingTimers());
  cutTabSwitches(false);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const hosts = (root: ReactTestRenderer, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const host = (root: ReactTestRenderer, id: string) => hosts(root, id)[0];
const flush = () => act(() => jest.advanceTimersByTime(0));
const deckUp = () => browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
const otherTab = () => currentTabs().open.find((tab) => tab.id !== currentTabs().selectedId)!;
const hostOf = (id: string) => display(currentTabs().open.find((tab) => tab.id === id)!.url).host;
const animatedProp = (node: ReactTestInstance, key: string) => (node.props.jestAnimatedProps?.value as Record<string, unknown> | undefined)?.[key];
const marks = (root: ReactTestRenderer) =>
  root.root.findAll((node) => typeof animatedProp(node, "mark") === "string").map((node) => animatedProp(node, "mark") as string);
const lift = (id: string) => {
  act(() => {
    liftDestination(id);
  });
  act(() => jest.advanceTimersByTime(16));
};
const commit = (id: string) => act(() => sendDeckCommand({ kind: "open", tabId: id, tappedAt: Date.now() }));

test("a card pressed in the deck gets its destination face ready under the kept bar before lift: mounted, opaque title first, hidden and untouchable until the lift's own UI turn shows it with the bar", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  act(() => require("../state/browse/destination").pressDestination(wanted.id));
  const face = host(root, "destinationFace")!;
  expect(face).toBeDefined();
  expect(host(root, "destinationTitle")).toBeDefined();
  expect(getAnimatedStyle(face).opacity).toBe(0);
  expect(animatedProp(face, "pointerEvents")).toBe("none");
  expect(face.props.importantForAccessibility).toBe("no-hide-descendants");
  lift(wanted.id);
  expect(getAnimatedStyle(face).opacity).toBe(1);
  expect(animatedProp(face, "pointerEvents")).toBe("auto");
  expect(pageBarShown.value).toBe(1);
  expect(marks(root)).toEqual(expect.arrayContaining([`dest-face:${wanted.id}`, `dest-bar:${wanted.id}`]));
  unmount(root);
});

test("the destination face is one view from the lift to the page's first drawn frame: the commit keeps it, names it as the page's cover, mounts no second cover, and only the matching drawn acknowledgement releases it", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  act(() => require("../state/browse/destination").pressDestination(wanted.id));
  const before = host(root, "destinationFace")!.instance;
  lift(wanted.id);
  commit(wanted.id);
  flush();
  expect(currentTabs().selectedId).toBe(wanted.id);
  const face = host(root, "destinationFace")!;
  expect(face.instance).toBe(before);
  const cover = useDestination.getState().cover!;
  expect(cover).toMatch(/^destinationCover-/);
  expect(face.props.nativeID).toBe(cover);
  expect(getAnimatedStyle(face).opacity).toBe(1);
  expect(hosts(root, "pageCover")).toHaveLength(0);
  const surface = root.root.findAll((node) => node.props.pageId === wanted.id && node.props.coverNativeId !== undefined)[0]!;
  expect(surface.props.coverNativeId).toBe(cover);
  act(() => browse.pageCoverHidden(wanted.id, "drawn", "destinationCover-0", true, 1));
  expect(host(root, "destinationFace")).toBeDefined();
  act(() => browse.pageCoverHidden(wanted.id, "drawn", cover, true, 1));
  flush();
  expect(host(root, "destinationFace")).toBeUndefined();
  expect(destination.id.value).toBe("");
  unmount(root);
});

test("a short press whose JS touch-down never ran before the lift still shows the destination's address: the bar's leaf for another card stays hidden and the UI-thread leaf reads the lifted card's address", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const selected = currentTabs().selectedId!;
  const [stale, wanted] = currentTabs().open.filter((tab) => tab.id !== selected);
  act(() => require("../state/browse/deckPull").previewPageBar(stale!.id));
  lift(wanted!.id);
  expect(getAnimatedStyle(host(root, "floatingBarPreview")!).opacity).toBe(0);
  const fallback = host(root, "floatingBarDestinationLeaf")!;
  expect(getAnimatedStyle(fallback).opacity).toBe(1);
  const text = root.root.findAll((node) => node.props.testID === "floatingBarDestinationHost" && node.props.jestAnimatedProps !== undefined)[0]!;
  expect(animatedProp(text, "text")).toBe(hostOf(wanted!.id));
  expect(getAnimatedStyle(host(root, "floatingBarAddressStack")!).opacity).toBe(0);
  unmount(root);
});

test("a pressed card's own leaf is the one shown on its lift, and the fallback stays hidden", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  act(() => require("../state/browse/destination").pressDestination(wanted.id));
  lift(wanted.id);
  expect(getAnimatedStyle(host(root, "floatingBarPreview")!).opacity).toBe(1);
  expect(getAnimatedStyle(host(root, "floatingBarDestinationLeaf")!).opacity).toBe(0);
  unmount(root);
});

test("while the kept bar shows over the deck, its Address press is fenced from the tab it left and held for the destination, then runs there on the commit", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  lift(wanted.id);
  const address = root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")[0]!;
  act(() => address.props.onPress());
  expect(searchState().open).toBe(false);
  commit(wanted.id);
  flush();
  expect(currentTabs().selectedId).toBe(wanted.id);
  expect(searchState().open).toBe(true);
  expect(searchState().initialText).toContain(hostOf(wanted.id));
  unmount(root);
});

test("a card opened by a screen reader takes the same hand-over: it lifts its destination, shows its face and names it as the arriving page's cover", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  commit(wanted.id);
  flush();
  expect(destination.id.value).toBe(wanted.id);
  const face = host(root, "destinationFace")!;
  expect(getAnimatedStyle(face).opacity).toBe(1);
  expect(face.props.nativeID).toBe(useDestination.getState().cover);
  unmount(root);
});

test("a cut back to the deck before the page draws hides the destination face on that same UI turn", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  commit(wanted.id);
  flush();
  const face = host(root, "destinationFace")!;
  expect(getAnimatedStyle(face).opacity).toBe(1);
  act(() => {
    pageBarShown.value = 0;
    pageBarPreviewShown.value = 0;
  });
  expect(getAnimatedStyle(face).opacity).toBe(0);
  unmount(root);
});

test("a destination whose page fails is released instead of waiting on a drawn frame that never comes", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  commit(wanted.id);
  flush();
  expect(host(root, "destinationFace")).toBeDefined();
  act(() => require("../state/pages/store").storeNavigation(wanted.id, { isLive: true, isLoading: false, url: wanted.url, title: "", failure: { code: "offline" }, progress: 1 }));
  act(() => jest.advanceTimersByTime(4_100));
  expect(host(root, "destinationFace")).toBeUndefined();
  unmount(root);
});

test("the deck's own tap prepares the pressed card at touch-down and its lift publishes it", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const tap = getByGestureTestId("deckTap") as unknown as { handlers: { onTouchesDown: (event: unknown, manager: unknown) => void } };
  const card = root.root.findAll((node) => node.props.testID === "deckCard" && typeof node.type === "string")[0]!;
  const pose = Object.assign({}, ...((getAnimatedStyle(card).transform ?? []) as object[])) as { translateX: number; translateY: number };
  const box = StyleSheet.flatten(card.props.style) as { width: number; height: number };
  const touch = { id: 0, x: pose.translateX + box.width / 2, y: pose.translateY + box.height / 2 };
  const manager = { fail: () => undefined };
  act(() => tap.handlers.onTouchesDown({ allTouches: [touch], changedTouches: [touch] }, manager));
  flush();
  expect(useDestination.getState().prepared).not.toBeNull();
  unmount(root);
});

const pageViewOf = (root: ReactTestRenderer, id: string) => root.root.findAll((node) => node.props.pageId === id && typeof node.props.onPageError === "function")[0]!;
const frostSource = (root: ReactTestRenderer) => root.root.findAll((node) => node.props.testID === "pageFrostSource" && node.props.jestAnimatedProps !== undefined)[0]!;

test("a destination page that native refuses to bind, so it never draws, releases its face and the frost hold at once instead of keeping both up and taking the page's touches", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  commit(wanted.id);
  flush();
  expect(host(root, "destinationFace")).toBeDefined();
  act(() => pageViewOf(root, wanted.id).props.onPageError({ code: "savedStateUnreadable", message: "bind refused" }));
  flush();
  act(() => jest.advanceTimersByTime(16));
  expect(host(root, "destinationFace")).toBeUndefined();
  expect(useDestination.getState().arriving).toBeNull();
  expect(destination.id.value).toBe("");
  expect(animatedProp(frostSource(root), "heldFill") ?? null).toBeNull();
  unmount(root);
});

test("a destination page that fails to load releases its face on the failure itself, not after the long wait", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  commit(wanted.id);
  flush();
  act(() => require("../state/pages/store").storeNavigation(wanted.id, { isLive: true, isLoading: false, url: wanted.url, title: "", failure: { code: "offline" }, progress: 1 }));
  flush();
  expect(host(root, "destinationFace")).toBeUndefined();
  unmount(root);
});

test("reopening the deck before one destination draws and pressing another hands the face and the frost hold to the new card: the old arrival can't refuse it or keep its cover over the new hold", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const selected = currentTabs().selectedId!;
  const [first, second] = currentTabs().open.filter((tab) => tab.id !== selected);
  commit(first!.id);
  flush();
  const firstCover = useDestination.getState().cover;
  expect(firstCover).not.toBeNull();
  act(() => {
    pageBarShown.value = 0;
    pageBarPreviewShown.value = 0;
  });
  deckUp();
  flush();
  act(() => require("../state/browse/destination").pressDestination(second!.id));
  expect(useDestination.getState().prepared).toBe(second!.id);
  expect(useDestination.getState().arriving).toBeNull();
  const face = host(root, "destinationFace")!;
  lift(second!.id);
  expect(getAnimatedStyle(face).opacity).toBe(1);
  expect(animatedProp(frostSource(root), "heldUntil") ?? null).toBeNull();
  unmount(root);
});

test("a deck select of a tab whose swipe arrival is still waiting keeps the deck cover's own acknowledgement: the arrival's re-wait can't take its slot", () => {
  withTabs(3);
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, leaving: null });
  const root = renderSurface(<Surfaces />);
  const wanted = otherTab();
  act(() => browse.arriveAtNeighbour(wanted.id));
  act(() => jest.advanceTimersByTime(1_000));
  deckUp();
  flush();
  commit(wanted.id);
  flush();
  const cover = useDestination.getState().cover!;
  expect(cover).toMatch(/^destinationCover-/);
  act(() => jest.advanceTimersByTime(3_100));
  act(() => browse.pageCoverHidden(wanted.id, "drawn", cover, true, 1));
  flush();
  expect(useDestination.getState().arriving).toBeNull();
  expect(host(root, "destinationFace")).toBeUndefined();
  unmount(root);
});

test("an Address press after lifting the card that is already the shown tab is held until that card commits, so search isn't opened and then dismissed by the commit", () => {
  withTabs(3);
  deckUp();
  const root = renderSurface(<Surfaces />);
  const selected = currentTabs().selectedId!;
  lift(selected);
  const address = root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")[0]!;
  act(() => address.props.onPress());
  expect(searchState().open).toBe(false);
  commit(selected);
  flush();
  act(() => jest.advanceTimersByTime(16));
  expect(currentTabs().selectedId).toBe(selected);
  expect(searchState().open).toBe(true);
  expect(searchState().initialText).toContain(hostOf(selected));
  unmount(root);
});

test("without tab-switch cuts the Address stays the plain Pressable, with no UI-thread value over its own", () => {
  cutTabSwitches(false);
  withTabs(3);
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, leaving: null });
  const root = renderSurface(<Surfaces />);
  const nodes = root.root.findAll((node) => node.props.accessibilityLabel === "Address");
  expect(nodes.length).toBeGreaterThan(0);
  expect(nodes.every((node) => node.props.jestAnimatedProps === undefined && node.props.animatedProps === undefined)).toBe(true);
  unmount(root);
});
