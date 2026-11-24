import { useState } from "react";
import * as Reanimated from "react-native-reanimated";
import { getAnimatedStyle, KeyboardState, makeMutable } from "react-native-reanimated";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { Surfaces } from "../App";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { PullGhost } from "../components/browsing/PagePull";
import { SearchTray } from "../components/search/SearchTray";
import { DesignProvider, Favicon } from "../components/ui";
import { Dimensions, Image, Platform, StyleSheet, TextInput, View } from "react-native";
import { deckPull, pageBarPreviewShown, pageBarShown, pageBodyShown, previewPageBar, PULL_STAGE } from "../state/browse/deckPull";
import { currentPhoneGeneration, deckTurn, liftDeckControl, pressDeckControl, queueDeckHit, takeDeckHit, type DeckHitCommand, type PreparedDeck } from "../state/browse/deckTurn";
import { liftDestination } from "../state/browse/destination";
import { MenuTrigger } from "../components/ui/MenuTrigger";
import { neighbours } from "../lib/pagerPhysics";
import { sendDeckCommand } from "../state/browse/deckCommands";
import * as browse from "../state/browse/store";
import { cutTabSwitches } from "../state/browse/tabSwitch";
import { dismissSearch, presentSearch, searchState, setSearchText, useSearch } from "../state/search/store";
import { useTabs } from "../state/tabs/store";
import { display } from "../state/search/omnibox";
import { setPreference } from "../state/settings/store";
import { useSelectedTab } from "../state/tabs/hooks";
import { closeTabById, currentTabs, selectTabById, updateTabById } from "../state/tabs/store";
import { noteViewMoved, noteWarmPicture } from "../state/tabs/warmPictures";
import { findTab } from "../state/tabs/tabsState";
import * as pageStore from "../state/pages/store";
import * as perf from "../state/app/interactionPerf";
import { pageUi } from "../state/page/store";
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
  act(() => {
    deckTurn.live.value = 0;
    deckTurn.reconciled.value = 0;
    deckTurn.press.value = null;
    deckTurn.pressed.value = "";
    deckTurn.hitMark.value = "";
    deckPull.stage.value = PULL_STAGE.idle;
    deckPull.cut.value = false;
    pageBarShown.value = 1;
    pageBodyShown.value = 1;
  });
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  cutTabSwitches(false);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function Page() {
  const tab = useSelectedTab();
  return tab ? <BrowsingScreen tabId={tab.id} /> : null;
}

const toNeighbour = () => {
  const around = neighbours(browse.swipeOrder(), currentTabs().selectedId);
  return around.right ? { id: around.right, dx: -1 } : { id: around.left!, dx: 1 };
};

function releaseSwipe(root: ReactTestRenderer, dx: number, distance: number, velocity: number) {
  act(() =>
    fireGestureHandler(getByGestureTestId("tabPager"), [
      { state: State.BEGAN, translationX: 0, translationY: 0, velocityX: 0, velocityY: 0 },
      { state: State.ACTIVE, translationX: dx * 20, translationY: 0, velocityX: dx * velocity, velocityY: 0 },
      { state: State.ACTIVE, translationX: dx * distance, translationY: 0, velocityX: dx * velocity, velocityY: 0 },
      { state: State.END, translationX: dx * distance, translationY: 0, velocityX: dx * velocity, velocityY: 0 },
    ]),
  );
  return root;
}

const arrivalPose = (root: ReactTestRenderer) => {
  const arrival = root.root.findAll((node) => node.props.testID === "pagerArrival" && typeof node.type === "string")[0];
  expect(arrival).toBeDefined();
  return { node: arrival!, at: Object.assign({}, ...((getAnimatedStyle(arrival!).transform ?? []) as object[])) as { translateX?: number } };
};

const browsingNow = () => browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, leaving: null });

const outgoingPose = (root: ReactTestRenderer) => {
  const outgoing = root.root.findAll((node) => typeof node.type === "string" && getAnimatedStyle(node)?.transform !== undefined && (getAnimatedStyle(node).transform as object[]).some((step) => "scale" in step))[0];
  expect(outgoing).toBeDefined();
  return Object.assign({}, ...((getAnimatedStyle(outgoing!).transform ?? []) as object[])) as { translateX?: number };
};

test("an accepted bar swipe commits the neighbour within a frame of release, with no spring to wait out, and its arrival card sits full screen from that frame, hidden from TalkBack, and with no validated picture of that page it keeps touches off the page body under it", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  act(() => jest.advanceTimersByTime(16));
  expect(currentTabs().selectedId).toBe(id);
  act(() => jest.advanceTimersByTime(16));
  const arrival = arrivalPose(root);
  expect(arrival.at).toMatchObject({ translateX: 0 });
  expect(arrival.node.props.pointerEvents).toBe("auto");
  expect(arrival.node.props.importantForAccessibility).toBe("no-hide-descendants");
  unmount(root);
});

test("a refused bar swipe is back in place on its release frame and keeps the tab", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const before = currentTabs().selectedId;
  const root = renderSurface(<Page />);
  releaseSwipe(root, toNeighbour().dx, 40, 0);
  expect(currentTabs().selectedId).toBe(before);
  expect(outgoingPose(root)).toMatchObject({ translateX: 0 });
  unmount(root);
});

test("a swipe whose target closes before the commit arrives keeps the tab it started from and puts the page back", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const before = currentTabs().selectedId;
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  releaseSwipe(root, dx, 260, 1600);
  act(() => closeTabById(id));
  act(() => jest.advanceTimersByTime(32));
  expect(currentTabs().selectedId).toBe(before);
  expect(findTab(currentTabs(), id)).toBeFalsy();
  expect(outgoingPose(root)).toMatchObject({ translateX: 0 });
  unmount(root);
});

test("a swipe whose source is no longer selected when the commit arrives changes nothing", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  const elsewhere = currentTabs().open[0]!.id;
  act(() => selectTabById(elsewhere));
  act(() => jest.advanceTimersByTime(32));
  expect(currentTabs().selectedId).toBe(elsewhere);
  unmount(root);
});

test("an arrival's cover leaves only on its own acknowledgement: a late or unnamed one from an earlier arrival is ignored", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  act(() => jest.advanceTimersByTime(16));
  const cover = browse.useBrowse.getState().arrivalCover!;
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: id, covered: id });
  act(() => browse.pageCoverHidden(id, "drawn"));
  act(() => browse.pageCoverHidden(id, "drawn", `${browse.ARRIVAL_COVER_ID}-0`, true, 1));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: id, arrivalCover: cover });
  act(() => browse.pageCoverHidden(id, "drawn", cover, true, 1));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: null, arrivalCover: null });
  unmount(root);
});

test("right after a swipe lands, the bar already belongs to the destination: its address and its Address button are the new tab's", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  act(() => jest.advanceTimersByTime(16));
  const host = root.root.findAll((node) => node.props.testID === "floatingBarHost" && typeof node.type === "string")[0]!;
  expect(host.props.children).toBe(display(findTab(currentTabs(), id)!.url).host);
  const address = root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")[0]!;
  act(() => address.props.onPress());
  expect(searchState().editsPage).toBeTruthy();
  expect(currentTabs().selectedId).toBe(id);
  unmount(root);
});

test("with cuts the page bar is one bar that stays mounted under the deck: hidden, untouchable and out of TalkBack there, it holds the pressed card's address, and the release shows it and hides the deck's own bar in one UI-thread step", () => {
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  const host = (id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
  const kept = () => host("keptPageBar")[0];
  expect(kept()).toBeDefined();
  expect(getAnimatedStyle(kept()!).opacity).toBe(0);
  const destination = currentTabs().open.find((tab) => tab.id !== currentTabs().selectedId)!;
  const renders: string[] = [];
  const counting = jest.spyOn(perf, "countRender").mockImplementation((component: string) => void renders.push(component));
  act(() => previewPageBar(destination.id));
  expect(renders.filter((name) => name === "BrowsingScreen")).toEqual([]);
  counting.mockRestore();
  const preview = host("floatingBarPreviewHost").map((node) => node.props.children).flat().join("");
  expect(preview).toContain(display(destination.url).host);
  const previewLeaf = host("floatingBarPreview")[0]!;
  expect(getAnimatedStyle(previewLeaf).opacity).toBe(0);
  act(() => liftDestination(destination.id));
  act(() => jest.advanceTimersByTime(16));
  expect(getAnimatedStyle(kept()!).opacity).toBe(1);
  expect(getAnimatedStyle(previewLeaf).opacity).toBe(1);
  const source = root.root.findAll((node) => node.props.testID === "pageFrostSource" && node.props.jestAnimatedProps !== undefined)[0]!;
  expect(source.props.jestAnimatedProps.value.heldFill).toEqual(expect.any(String));
  act(() => sendDeckCommand({ kind: "open", tabId: destination.id, tappedAt: Date.now() }));
  expect(currentTabs().selectedId).toBe(destination.id);
  expect(host("keptPageBar")[0]).toBeDefined();
  expect(root.root.findAll((node) => node.props.testID === "pageFrostSource" && typeof node.props.heldUntil === "string")).not.toHaveLength(0);
  expect(host("floatingBarHost").map((node) => node.props.children).flat().join("")).toContain(display(destination.url).host);
  act(() => previewPageBar(null));
  unmount(root);
});

test("with cuts a deck entrance renders neither the kept page body nor its bar: their visibility, touches and TalkBack follow one UI-thread owner", () => {
  withTabs(3);
  browsingNow();
  const root = renderSurface(<Surfaces />);
  const names: string[] = [];
  const counting = jest.spyOn(perf, "countRender").mockImplementation((component: string) => void names.push(component));
  act(() => browse.useBrowse.setState({ surface: "deck", deckEntrance: currentTabs().selectedId, frozenOrder: null }));
  expect(names.filter((name) => name === "BrowsingScreen")).toEqual([]);
  const body = root.root.findAll((node) => node.props.testID === "pageBody" && typeof node.type === "string")[0]!;
  expect(getAnimatedStyle(body).transform).toEqual([{ translateX: 100_000 }]);
  act(() => browse.useBrowse.setState({ surface: "browsing", deckEntrance: null }));
  expect(getAnimatedStyle(body).transform).toEqual([{ translateX: 0 }]);
  counting.mockRestore();
  unmount(root);
});

test("a tap on the page's Tabs button cuts to the waiting deck from its own UI-thread worklet, before any JS press handler runs", () => {
  if (Platform.OS !== "android") return;
  withTabs(3);
  browsingNow();
  const { setRootSize } = require("../state/app/rootSize") as typeof import("../state/app/rootSize");
  act(() => setRootSize(393, 873));
  const root = renderSurface(<Surfaces />, { flushTimers: false });
  for (let step = 0; step < 30; step++) act(() => jest.advanceTimersByTime(100));
  const selected = currentTabs().selectedId!;
  expect(deckPull.target.value?.id).toBe(selected);
  const press = jest.spyOn(browse, "showDeck");
  act(() => fireGestureHandler(getByGestureTestId("floatingBarTabsTap"), [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END }]));
  expect(deckPull.cut.value).toBe(true);
  expect(pageBarShown.value).toBe(0);
  expect(press).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  press.mockRestore();
  unmount(root);
});

test("switching to a Duo layout in the middle of a cut revokes the phone's deck turn and gives the page back its bar and body, and returning to the phone layout owns them again from the surface", () => {
  if (Platform.OS !== "android") return;
  const { reportScreenLayout } = require("../state/app/screenLayout") as typeof import("../state/app/screenLayout");
  withTabs(3);
  browsingNow();
  const { setRootSize } = require("../state/app/rootSize") as typeof import("../state/app/rootSize");
  act(() => setRootSize(393, 873));
  const root = renderSurface(<Surfaces />, { flushTimers: false });
  for (let step = 0; step < 30; step++) act(() => jest.advanceTimersByTime(100));
  const selected = currentTabs().selectedId!;
  expect(deckPull.target.value?.id).toBe(selected);
  act(() => fireGestureHandler(getByGestureTestId("floatingBarTabsTap"), [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END }]));
  expect(deckPull.cut.value).toBe(true);
  expect(pageBarShown.value).toBe(0);
  act(() => previewPageBar(currentTabs().open[0]!.id));
  pageBarPreviewShown.value = 1;
  act(() => reportScreenLayout({ layout: "wide" }));
  act(() => jest.advanceTimersByTime(0));
  expect(deckPull.cut.value).toBe(false);
  expect(deckPull.stage.value).toBe(PULL_STAGE.idle);
  expect(pageBarShown.value).toBe(1);
  expect(pageBodyShown.value).toBe(1);
  expect(pageBarPreviewShown.value).toBe(0);
  expect(deckTurn.live.value).toBe(0);
  for (let step = 0; step < 5; step++) act(() => jest.advanceTimersByTime(100));
  const pages = () => root.root.findAll((node) => node.props.testID === "keptPageBar" && typeof node.type === "string");
  expect(pages()).toHaveLength(0);
  expect(currentTabs().selectedId).toBe(selected);
  act(() => reportScreenLayout({ layout: "phone" }));
  for (let step = 0; step < 30; step++) act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  expect(pageBarShown.value).toBe(1);
  expect(pageBodyShown.value).toBe(1);
  expect(deckPull.target.value?.id).toBe(selected);
  act(() => fireGestureHandler(getByGestureTestId("floatingBarTabsTap"), [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END }]));
  expect(deckPull.cut.value).toBe(true);
  act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  unmount(root);
});

function spyScreenReaderFocus() {
  const RN = require("react-native") as typeof import("react-native");
  const native = require("@ardia/phone-native") as typeof import("@ardia/phone-native");
  jest.spyOn(RN.AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(true);
  const views = new Map<number, unknown>();
  jest.spyOn(RN, "findNodeHandle").mockImplementation((view) => {
    const handle = 100 + views.size;
    views.set(handle, view);
    return handle;
  });
  const landed: unknown[] = [];
  jest.spyOn(RN.AccessibilityInfo, "setAccessibilityFocus").mockImplementation((handle) => void landed.push(views.get(handle)));
  jest.spyOn(native, "focusViewNatively").mockImplementation((handle) => {
    landed.push(views.get(handle));
    return () => undefined;
  });
  return landed;
}

const spokenValue = (node: ReactTestInstance) => ((node.props.jestAnimatedProps?.value?.accessibilityValue ?? node.props.accessibilityValue) as { text: string } | undefined)?.text;

const focusedAddress = (root: ReactTestRenderer, view: unknown) => {
  const nodes = root.root.findAll((node) => node.instance === view && node.props.accessibilityLabel === "Address");
  return nodes.length > 0 ? (spokenValue(nodes[0]!) ?? null) : null;
};

const settleFocus = async () => {
  for (let step = 0; step < 4; step += 1) {
    await act(async () => undefined);
    act(() => jest.advanceTimersByTime(200));
  }
};

test("after a swipe hands the page over, TalkBack focus moves to the destination's Address, which is the same node that was there before the swipe", async () => {
  const landed = spyScreenReaderFocus();
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const addressNode = () => root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityLabel === "Address")[0]!;
  const before = addressNode().instance;
  await settleFocus();
  expect(landed.length).toBe(0);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  await settleFocus();
  expect(currentTabs().selectedId).toBe(id);
  expect(addressNode().instance).toBe(before);
  expect(spokenValue(addressNode())).toBe(display(findTab(currentTabs(), id)!.url).host);
  expect(landed.length).toBe(1);
  expect(focusedAddress(root, landed[0])).toBe(display(findTab(currentTabs(), id)!.url).host);
  unmount(root);
});

test("a deck select moves TalkBack focus to the destination's Address once the deck has handed the page over", async () => {
  const landed = spyScreenReaderFocus();
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  await settleFocus();
  landed.length = 0;
  const wanted = currentTabs().open[0]!.id;
  act(() => sendDeckCommand({ kind: "open", tabId: wanted, tappedAt: Date.now() }));
  await settleFocus();
  expect(currentTabs().selectedId).toBe(wanted);
  const address = root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityLabel === "Address" && spokenValue(node) === display(findTab(currentTabs(), wanted)!.url).host);
  expect(address).toHaveLength(1);
  expect(landed.length).toBe(1);
  expect(focusedAddress(root, landed[0])).toBe(display(findTab(currentTabs(), wanted)!.url).host);
  unmount(root);
});

test("a card tapped in the deck is the open tab at once: the deck hands straight to the page, with no growth and no bar hand-over", () => {
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  const wanted = currentTabs().open[0]!.id;
  act(() => sendDeckCommand({ kind: "open", tabId: wanted, tappedAt: Date.now() }));
  expect(browse.useBrowse.getState()).toMatchObject({ surface: "browsing", opening: null });
  expect(currentTabs().selectedId).toBe(wanted);
  unmount(root);
});

test("a tray raised by + is at rest with its dim on its first frame, without waiting for the keyboard or a landing delay", () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  presentSearch("page", "");
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const panel = root.root.findAll((node) => node.props.testID === "trayPanel" && typeof node.type === "string")[0]!;
  const lift = ((getAnimatedStyle(panel).transform ?? []) as { translateY?: number }[]).find((step) => step.translateY !== undefined)?.translateY ?? 0;
  expect(lift).toBeLessThanOrEqual(0);
  const dim = root.root.findAll((node) => node.props.testID === "trayDim" && typeof node.type === "string")[0]!;
  expect(getAnimatedStyle(dim).opacity).toBe(1);
  unmount(root);
  keyboard.mockRestore();
});

test("a first-use sheet waits lifted where the soft keyboard will be with no timer to drop it, and starts at rest when a hardware keyboard is attached", () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const native = require("@ardia/phone-native") as { hardwareKeyboardShown: () => boolean };
  const lifted = (hardware: boolean) => {
    const attached = jest.spyOn(native, "hardwareKeyboardShown").mockImplementation(() => hardware);
    presentSearch("page", "");
    const root = renderSurface(
      <DesignProvider design="redesigned">
        <SearchTray />
      </DesignProvider>,
      { flushTimers: false },
    );
    const lift = () => {
      const panel = root.root.findAll((node) => node.props.testID === "trayPanel" && typeof node.type === "string")[0]!;
      return ((getAnimatedStyle(panel).transform ?? []) as { translateY?: number }[]).find((step) => step.translateY !== undefined)?.translateY ?? 0;
    };
    const resting = lift();
    act(() => jest.advanceTimersByTime(100));
    const early = lift();
    act(() => jest.advanceTimersByTime(1500));
    const late = lift();
    unmount(root);
    act(() => dismissSearch());
    act(() => jest.advanceTimersByTime(4000));
    attached.mockRestore();
    return { resting, early, late };
  };
  const soft = lifted(false);
  expect(soft.early).toBeLessThan(soft.resting);
  expect(soft.late).toBe(soft.early);
  const hard = lifted(true);
  expect(hard.late).toBe(hard.resting);
  keyboard.mockRestore();
});

test("the next search sheet waits laid out and hidden, its field made but unfocused; + turns that same sheet and field live instead of mounting them, and no second sheet is made while it is up", () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const host = (id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
  expect(host("trayStandby")).toHaveLength(1);
  expect(host("trayRoot")).toHaveLength(0);
  const waitingField = host("trayFieldCapsule");
  expect(waitingField).toHaveLength(1);
  const waiting = root.root.findAll((node) => node.props.testID === "trayPanel" && typeof node.type === "string")[0]!;
  act(() => presentSearch("page", ""));
  expect(host("trayRoot")).toHaveLength(1);
  expect(host("trayFieldCapsule")).toContain(waitingField[0]);
  expect(root.root.findAll((node) => node.props.testID === "trayPanel" && typeof node.type === "string")).toContain(waiting);
  expect(host("trayStandby")).toHaveLength(0);
  unmount(root);
  keyboard.mockRestore();
});

test("+ shows and focuses the waiting sheet before React renders it live: the press itself reveals it, and the live commit changes nothing on screen", async () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const host = (id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
  const waiting = host("trayStandby")[0]!;
  expect(getAnimatedStyle(waiting).opacity).toBe(0);
  const input = waiting.findAll((node) => node.type === TextInput)[0]!;
  const focus = jest.spyOn(input.instance as { focus(): void }, "focus");
  presentSearch("page", "");
  expect(host("trayRoot")).toHaveLength(0);
  expect(getAnimatedStyle(waiting).opacity).toBe(1);
  expect(focus).toHaveBeenCalled();
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  expect(host("trayRoot")).toHaveLength(1);
  expect(host("trayRoot")[0] === waiting).toBe(true);
  expect(getAnimatedStyle(waiting).opacity).toBe(1);
  unmount(root);
  keyboard.mockRestore();
});

test("a keystroke in the frame right after + lands in the new search, before React has rendered the sheet live", async () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const waiting = root.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0]!;
  const typing = waiting.findAll((node) => typeof node.props.onTyped === "function")[0]!;
  presentSearch("page", "");
  typing.props.onTyped("o");
  expect(searchState().open).toBe(true);
  await act(async () => {
    jest.advanceTimersByTime(20);
  });
  expect(searchState().text).toBe("o");
  unmount(root);
  keyboard.mockRestore();
});

test("a field-version reset at the press keeps the input the reveal focused", async () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  act(() => useSearch.setState({ fieldVersion: 3 }));
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const waiting = root.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0]!;
  const focused = waiting.findAll((node) => node.type === TextInput)[0]!;
  presentSearch("page", "");
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  const live = root.root.findAll((node) => node.props.testID === "trayRoot" && typeof node.type === "string")[0]!;
  expect(live.findAll((node) => node.type === TextInput)[0] === focused).toBe(true);
  unmount(root);
  keyboard.mockRestore();
});

test("after an Address sheet is dismissed, the waiting + sheet carries no edit-this-page row", async () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const tab = currentTabs().open[0]!;
  act(() => presentSearch("page", tab.url, null, { currentUrl: tab.url, currentTabId: tab.id }));
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  act(() => dismissSearch());
  for (let step = 0; step < 40; step++)
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
  expect(searchState().editsPage).toBeTruthy();
  const waiting = root.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0]!;
  expect(waiting.findAll((node) => node.props.testID === "trayCurrentPageRow" && typeof node.type === "string")).toHaveLength(0);
  unmount(root);
  keyboard.mockRestore();
});

test("a tap on the dim of a sheet + revealed before React rendered it live closes that search", () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const waiting = root.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0]!;
  const dim = waiting.findAll((node) => node.props.accessibilityLabel === "Close Search" && typeof node.props.onPressIn === "function")[0]!;
  presentSearch("page", "");
  expect(searchState().open).toBe(true);
  dim.props.onPressIn();
  expect(searchState().open).toBe(false);
  unmount(root);
  keyboard.mockRestore();
});

test("the waiting + sheet carries no live frost behind the page: its panel shows the precomposited solid face until it goes live", () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const waiting = root.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0]!;
  const frosts = waiting.findAll((node) => typeof node.type !== "string" && /Frost/.test((node.type as { displayName?: string; name?: string }).displayName ?? (node.type as { name?: string }).name ?? ""));
  expect(frosts).toHaveLength(0);
  expect(waiting.findAll((node) => node.props.testID === "searchPanelFace" && typeof node.type === "string")).toHaveLength(1);
  unmount(root);
  keyboard.mockRestore();
});

test("while you browse, the waiting + sheet is a minimal shell with no rows mounted, and the bar's neighbour addresses are plain leaves, not buttons", () => {
  withTabs(3);
  browsingNow();
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const tray = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const waiting = tray.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0]!;
  expect(waiting.findAll((node) => node.props.testID === "searchPanelRowsScroll")).toHaveLength(0);
  unmount(tray);
  keyboard.mockRestore();
  const page = renderSurface(<Page />);
  const leaves = page.root.findAll((node) => (node.props.testID === "floatingBarLandedLeft" || node.props.testID === "floatingBarLandedRight") && typeof node.type === "string");
  expect(leaves.length).toBeGreaterThan(0);
  for (const leaf of leaves) expect(leaf.findAll((node) => node.props.accessibilityRole === "button")).toHaveLength(0);
  unmount(page);
});

test("a search that opens with text waits for its own commit: the waiting empty sheet is not shown early", async () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const waiting = root.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0]!;
  presentSearch("page", "example.com");
  expect(getAnimatedStyle(waiting).opacity).toBe(0);
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  unmount(root);
  keyboard.mockRestore();
});

test("a search that opens with text, such as editing the address, gets a field of its own rather than the waiting empty one", () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  const fields = () => root.root.findAll((node) => node.props.testID === "trayFieldCapsule" && typeof node.type === "string");
  const waiting = fields()[0]!;
  act(() => presentSearch("page", "example.com"));
  const live = root.root.findAll((node) => node.props.testID === "trayRoot" && typeof node.type === "string")[0]!;
  const liveField = live.findAll((node) => node.props.testID === "trayFieldCapsule" && typeof node.type === "string")[0]!;
  expect(liveField).not.toBe(waiting);
  unmount(root);
  keyboard.mockRestore();
});

test("a dismissed query never comes back in the next + sheet: the waiting field starts empty", async () => {
  withTabs(2);
  browse.useBrowse.setState({ surface: "browsing", sheet: null });
  const keyboard = jest.spyOn(Reanimated, "useAnimatedKeyboard").mockImplementation(() => ({ height: makeMutable(0), state: makeMutable(KeyboardState.CLOSED) }) as never);
  act(() => presentSearch("page", ""));
  act(() => setSearchText("otters"));
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <SearchTray />
    </DesignProvider>,
  );
  act(() => dismissSearch());
  for (let step = 0; step < 40; step++)
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
  const standby = root.root.findAll((node) => node.props.testID === "trayStandby" && typeof node.type === "string")[0];
  expect(standby).toBeDefined();
  const starts = standby!.findAll((node) => typeof node.props.start === "string").map((node) => node.props.start);
  expect(starts.length).toBeGreaterThan(0);
  for (const start of starts) expect(start).toBe("");
  unmount(root);
  keyboard.mockRestore();
});

test("TalkBack's next and previous tab go through the swipe's own checks: a page that is no longer the selected tab can't switch tabs", () => {
  withTabs(3);
  const shown = currentTabs().open[1]!.id;
  selectTabById(shown);
  browsingNow();
  const root = renderSurface(<BrowsingScreen tabId={shown} />);
  const stepper = root.root.findAll((node) => typeof node.props.onStep === "function")[0]!;
  const elsewhere = currentTabs().open[0]!.id;
  act(() => selectTabById(elsewhere));
  act(() => stepper.props.onStep(1));
  act(() => stepper.props.onStep(-1));
  expect(currentTabs().selectedId).toBe(elsewhere);
  unmount(root);
});

test("an Address tap in the frames between a swipe landing and its commit opens search for the destination, not the tab it left", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  const address = root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")[0]!;
  act(() => address.props.onPress());
  expect(searchState().open).toBe(false);
  act(() => jest.advanceTimersByTime(32));
  expect(currentTabs().selectedId).toBe(id);
  expect(searchState().open).toBe(true);
  expect(searchState().editsPage).toBeTruthy();
  unmount(root);
});

test("a More tap between a swipe landing and its commit opens the destination's page menu with the switch, and its two sites differ", async () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const from = currentTabs().selectedId!;
  const { id, dx } = toNeighbour();
  expect(findTab(currentTabs(), id)!.url).not.toBe(findTab(currentTabs(), from)!.url);
  releaseSwipe(root, dx, 260, 1600);
  const more = root.root.findAll((node) => node.props.accessibilityLabel === "Page Menu" && typeof node.props.onPress === "function")[0]!;
  act(() => more.props.onPress());
  expect(pageUi().menuOpen).toBe(false);
  for (let step = 0; step < 4; step++)
    await act(async () => {
      jest.advanceTimersByTime(16);
    });
  expect(currentTabs().selectedId).toBe(id);
  expect(pageUi().menuOpen).toBe(true);
  unmount(root);
});

test("a Plus tap between a swipe landing and its commit is held for that turn and opens the new-tab sheet with the switch", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  const plus = root.root.findAll((node) => node.props.accessibilityLabel === "New Tab" && typeof node.props.onPress === "function")[0]!;
  act(() => plus.props.onPress());
  expect(searchState().open).toBe(false);
  act(() => jest.advanceTimersByTime(32));
  expect(currentTabs().selectedId).toBe(id);
  expect(searchState().open).toBe(true);
  unmount(root);
});

test("an Address tap that arrives in the same JS turn as the deck's release acts on the destination, because the release opens it first", () => {
  withTabs(3);
  browse.useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  const root = renderSurface(<Surfaces />);
  const destination = currentTabs().open.find((tab) => tab.id !== currentTabs().selectedId)!;
  act(() => previewPageBar(destination.id));
  const address = root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")[0]!;
  act(() => {
    pageBarShown.value = 1;
    browse.openTab(destination.id);
    address.props.onPress();
  });
  expect(currentTabs().selectedId).toBe(destination.id);
  expect(searchState().open).toBe(true);
  expect(searchState().initialText).toContain(display(destination.url).host);
  act(() => previewPageBar(null));
  unmount(root);
});

test("the deck-to-page cover re-checks its warm picture: once the page's view moves, it drops the picture and blocks touches to the page under it", () => {
  if (Platform.OS !== "android") return;
  withTabs(2);
  const tab = currentTabs().open[0]!;
  const uri = `file:///cover-${tab.id}.jpg`;
  act(() => updateTabById(tab.id, { snapshotFileName: uri }));
  const window = Dimensions.get("window");
  noteWarmPicture(tab.id, { uri, url: findTab(currentTabs(), tab.id)!.url, window, frame: { x: 0, y: 0, width: window.width, height: window.height }, settled: true, view: 2, viewId: 21 });
  act(() => pageStore.storeNavigation(tab.id, { isLive: true, isLoading: true, url: tab.url, title: "Site", failure: null, progress: 0 } as never));
  browse.noteCutCard(tab.id, 200);
  const root = renderSurface(<BrowsingScreen tabId={tab.id} />, { flushTimers: false });
  const coverNode = () => root.root.findAll((node) => node.props.testID === "pageCover" && typeof node.type === "string")[0];
  expect(coverNode()).toBeDefined();
  {
    expect(root.root.findAll((node) => node.props.testID === "pageCoverWarmPicture" && typeof node.type === "string")).toHaveLength(1);
    expect(coverNode()!.props.pointerEvents).toBe("none");
    act(() => noteViewMoved(tab.id, 21, 3));
    expect(root.root.findAll((node) => node.props.testID === "pageCoverWarmPicture" && typeof node.type === "string")).toHaveLength(0);
    expect(coverNode()!.props.pointerEvents).toBe("auto");
  }
  unmount(root);
});

test("an action held for a swipe is dropped by any other navigation before its commit, so it never fires on a later visit", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  browse.holdBarAction(currentTabs().open[2]!.id, "address", "swipe:999");
  act(() => browse.openTab(currentTabs().open[0]!.id));
  expect(browse.takeBarAction("swipe:999", currentTabs().open[2]!.id)).toBeNull();
});

test("a page counts as drawn only for the document it is showing now: a draw of an earlier document doesn't let a cover go", () => {
  withTabs(2);
  const id = currentTabs().open[0]!.id;
  act(() => pageStore.storeNavigation(id, { ...pageStore.pageNavigation(id), isLive: true, isLoading: false, url: "https://site0.example/", document: 4 } as never));
  act(() => browse.pageDrawn(id, 3));
  expect(browse.documentWasDrawn(id)).toBe(false);
  act(() => browse.pageDrawn(id, 4));
  expect(browse.documentWasDrawn(id)).toBe(true);
});

test("on Android a cover acknowledgement must name the document whose drawn frame hid it; one without leaves the cover up", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  act(() => jest.advanceTimersByTime(16));
  const cover = browse.useBrowse.getState().arrivalCover!;
  act(() => browse.pageCoverHidden(id, "drawn", cover, true));
  if (Platform.OS === "android") expect(browse.useBrowse.getState()).toMatchObject({ arriving: id, arrivalCover: cover });
  act(() => browse.pageCoverHidden(id, "drawn", cover, true, 7));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: null });
  unmount(root);
});

test("on a cut to the deck the page bar's Search Tabs ghost never draws, so only the deck's own field shows that label", () => {
  const root = renderSurface(<PullGhost style={undefined}><Image source={{ uri: "file:///ghost.png" }} /></PullGhost>);
  const ghost = () => root.root.findAll((node) => node.props.testID === "pullGhost" && typeof node.type === "string")[0]!;
  act(() => {
    deckPull.target.value = { id: "t0" } as never;
    deckPull.stage.value = PULL_STAGE.landed;
    deckPull.cut.value = true;
  });
  expect(getAnimatedStyle(ghost()).opacity).toBe(0);
  act(() => {
    deckPull.cut.value = false;
    deckPull.stage.value = PULL_STAGE.idle;
    deckPull.target.value = null;
  });
  unmount(root);
});

test("a menu's opener opens it at once when its trigger is live, and holds the open until a disabled trigger comes live", () => {
  if (Platform.OS !== "android") return;
  const opened = jest.fn();
  const opener: { current: (() => void) | null } = { current: null };
  const items = [{ title: "One", onPress: () => undefined }] as never;
  let enable: () => void = () => undefined;
  function Host() {
    const [disabled, setDisabled] = useState(true);
    enable = () => setDisabled(false);
    return (
      <MenuTrigger opener={opener} items={items} trigger="tap" disabled={disabled} onOpen={opened}>
        {() => <View />}
      </MenuTrigger>
    );
  }
  const root = renderSurface(<Host />);
  act(() => opener.current?.());
  expect(opened).not.toHaveBeenCalled();
  act(() => enable());
  expect(opened).toHaveBeenCalledTimes(1);
  act(() => opener.current?.());
  expect(opened).toHaveBeenCalledTimes(2);
  unmount(root);
});

test("a cover acknowledgement that names the arrival's cover but found no view leaves the cover up", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  act(() => jest.advanceTimersByTime(16));
  const cover = browse.useBrowse.getState().arrivalCover!;
  act(() => browse.pageCoverHidden(id, "drawn", cover, false, 1));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: id, arrivalCover: cover });
  act(() => jest.advanceTimersByTime(1000));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: id, arrivalCover: cover });
  act(() => browse.pageCoverHidden(id, "drawn", cover, true, 1));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: null });
  unmount(root);
});

test("a cut card width is used once: the next open of the same tab doesn't inherit it, and opening the deck forgets it", () => {
  browse.noteCutCard("t1", 200);
  expect(browse.takeCutCardWidth("t1")).toBe(200);
  expect(browse.takeCutCardWidth("t1")).toBeNull();
  browse.noteCutCard("t1", 200);
  browse.clearCutCard();
  expect(browse.takeCutCardWidth("t1")).toBeNull();
});

test("a favicon another view already resolved shows its icon on its own first frame, never the letter tile first", () => {
  const icon = (root: ReactTestRenderer) => root.root.findAll((node) => node.type === Image).length;
  const first = renderSurface(<Favicon iconUrl="https://site.example/favicon.ico" pageUrl="https://site.example/" size={32} />);
  act(() => jest.advanceTimersByTime(16));
  expect(icon(first)).toBe(1);
  const second = renderSurface(<Favicon iconUrl="https://site.example/favicon.ico" pageUrl="https://site.example/" size={32} />);
  expect(icon(second)).toBe(1);
  unmount(first);
  unmount(second);
});

test("a swipe's neighbour shows its own last picture at the geometry it was captured at, and only its title card once that page's view has moved", () => {
  withTabs(3);
  browsingNow();
  const { id } = toNeighbour();
  const uri = `file:///warm-${id}.jpg`;
  act(() => updateTabById(id, { snapshotFileName: uri }));
  const neighbour = findTab(currentTabs(), id)!;
  const window = Dimensions.get("window");
  const frame = { x: 0, y: 0, width: window.width, height: window.height - 40 };
  noteWarmPicture(id, { uri, url: neighbour.url, window, frame, settled: true, view: 3, viewId: 11 });
  const pictures = (root: ReactTestRenderer) => root.root.findAll((node) => node.props.testID === "pagerWarmPicture" && typeof node.type === "string");
  const warm = renderSurface(<Page />);
  expect(pictures(warm)).toHaveLength(1);
  expect(pictures(warm)[0]!.props.source).toEqual({ uri });
  expect(StyleSheet.flatten(pictures(warm)[0]!.props.style)).toMatchObject({ top: 0, height: window.height - 40 });
  act(() => noteViewMoved(id, 11, 4));
  expect(pictures(warm)).toHaveLength(0);
  const inNeighbour = (node: ReactTestInstance) => {
    for (let at = node.parent; at; at = at.parent) if ((at.type as { name?: string }).name === "PagerNeighbour") return true;
    return false;
  };
  const rasters = warm.root.findAll((node) => typeof node.type === "string" && JSON.stringify(node.props.source ?? null).includes(uri) && inNeighbour(node));
  expect(rasters).toHaveLength(0);
  unmount(warm);
});

const standbyDeck = () => {
  withTabs(3);
  browsingNow();
  const { setRootSize } = require("../state/app/rootSize") as typeof import("../state/app/rootSize");
  act(() => setRootSize(393, 873));
  const root = renderSurface(<Surfaces />, { flushTimers: false });
  for (let step = 0; step < 30; step++) act(() => jest.advanceTimersByTime(100));
  return root;
};

const tapTabs = () => act(() => fireGestureHandler(getByGestureTestId("floatingBarTabsTap"), [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END }]));

const hostWith = (root: ReactTestRenderer, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.type === "string")[0];

const animatedProp = (node: ReactTestInstance, name: string) => (node.props.jestAnimatedProps?.value as Record<string, unknown> | undefined)?.[name] ?? node.props[name];

const markOf = (root: ReactTestRenderer, id: string) => {
  const node = root.root.findAll((each) => each.props.testID === id && each.props.jestAnimatedProps !== undefined)[0];
  expect(node).toBeDefined();
  return animatedProp(node!, "mark");
};

const CONTROL_BOXES = {
  more: { x: 330, y: 0, width: 44, height: 44 },
  search: { x: 70, y: 0, width: 250, height: 48 },
  plus: { x: 330, y: 0, width: 48, height: 48 },
  privacy: { x: 16, y: 0, width: 48, height: 48 },
} as const;

const layOutControls = async (root: ReactTestRenderer) => {
  for (const [control, layout] of Object.entries(CONTROL_BOXES)) {
    const host = hostWith(root, `deckHit-${control}`);
    expect(host).toBeDefined();
    act(() => host!.props.onLayout({ nativeEvent: { layout } }));
  }
  await act(async () => undefined);
  act(() => jest.advanceTimersByTime(16));
};

const centreOf = (control: keyof typeof CONTROL_BOXES) => {
  const bounds = deckTurn.prepared.value!.controls[control]!;
  return { absoluteX: (bounds.left + bounds.right) / 2, absoluteY: (bounds.top + bounds.bottom) / 2, x: 1, y: 1 };
};

const pressControl = (control: keyof typeof CONTROL_BOXES) => {
  const at = centreOf(control);
  act(() => fireGestureHandler(getByGestureTestId(`deckHit:${control}`), [{ state: State.BEGAN, ...at }, { state: State.ACTIVE, ...at }, { state: State.END, ...at }]));
};

test("while the page owns input the deck waits laid out under it with one prepared snapshot: the selected tab, the order, a privacy and space revision, the phone layout and the real bounds of each control it has, and no Spaces control when there is no switcher", async () => {
  if (Platform.OS !== "android") return;
  const root = standbyDeck();
  const selected = currentTabs().selectedId!;
  const prepared = deckTurn.prepared.value as PreparedDeck;
  expect(prepared.tabId).toBe(selected);
  expect(prepared.order.includes(selected)).toBe(true);
  expect(prepared.phone).toBe(currentPhoneGeneration());
  expect(typeof prepared.revision).toBe("string");
  expect(deckTurn.live.value).toBe(0);
  expect(animatedProp(hostWith(root, "tabDeck")!, "pointerEvents")).toBe("none");
  expect(animatedProp(hostWith(root, "tabDeck")!, "importantForAccessibility")).toBe("no-hide-descendants");
  const before = prepared.layout;
  await layOutControls(root);
  const laid = deckTurn.prepared.value!;
  expect(laid.layout).toBeGreaterThan(before);
  const header = hostWith(root, "deckHeader")!;
  const headerTop = (StyleSheet.flatten(header.props.style) as { top: number }).top;
  expect(laid.controls.more).toEqual({ left: 330, top: headerTop, right: 374, bottom: headerTop + 44 });
  expect(laid.controls.plus!.right - laid.controls.plus!.left).toBe(48);
  expect(laid.controls.search!.left).toBe(70);
  expect(laid.controls.spaces).toBeUndefined();
  expect(hostWith(root, "deckHit-spaces")).toBeUndefined();
  unmount(root);
});

test("the Tabs worklet sets the deck's final pose and its input turn in one step: the deck takes touches and TalkBack, the page body and the pull blocker let go, and that frame is marked deck-live, before any JS runs", () => {
  if (Platform.OS !== "android") return;
  const root = standbyDeck();
  tapTabs();
  expect(deckTurn.live.value).toBeGreaterThan(0);
  expect(deckPull.cut.value).toBe(true);
  expect(pageBodyShown.value).toBe(0);
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  const deck = hostWith(root, "tabDeck")!;
  expect(animatedProp(deck, "pointerEvents")).toBe("auto");
  expect(animatedProp(deck, "importantForAccessibility")).toBe("auto");
  expect(markOf(root, "deckLiveMark")).toBe("deck-live");
  expect(animatedProp(hostWith(root, "pageBody")!, "pointerEvents")).toBe("none");
  expect(getAnimatedStyle(deck).transform).toEqual([{ translateX: 0 }]);
  const blocker = hostWith(root, "pagePullBlocker")!;
  expect(getAnimatedStyle(blocker).transform).toEqual([{ translateX: 100_000 }]);
  const cards = hostWith(root, "deckCards")!;
  expect(getAnimatedStyle(cards).opacity).toBe(1);
  act(() => jest.advanceTimersByTime(100));
  act(() => jest.advanceTimersByTime(16));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  expect(deckTurn.reconciled.value).toBe(deckTurn.live.value);
  expect(animatedProp(hostWith(root, "tabDeck")!, "pointerEvents")).toBe("auto");
  unmount(root);
});

test("More, Plus and the privacy switch pressed in the frames after the cut answer on the UI thread with a deck-hit mark, and JS applies the deck's entrance and that command in one dispatch", async () => {
  if (Platform.OS !== "android") return;
  for (const control of ["plus", "privacy", "more"] as const) {
    const root = standbyDeck();
    await layOutControls(root);
    const wasIncognito = useTabs.getState().incognito;
    tapTabs();
    pressControl(control);
    expect(deckTurn.hitMark.value).toBe(`deck-hit:${control}`);
    expect(markOf(root, "deckHitMark")).toBe(`deck-hit:${control}`);
    expect(browse.useBrowse.getState().surface).toBe("browsing");
    act(() => jest.advanceTimersByTime(0));
    expect(browse.useBrowse.getState().surface).toBe("deck");
    act(() => jest.advanceTimersByTime(100));
    if (control === "plus") expect(searchState().open).toBe(true);
    if (control === "privacy") expect(useTabs.getState().incognito).toBe(!wasIncognito);
    if (control === "more") expect(root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string").length).toBeGreaterThan(0);
    act(() => dismissSearch());
    act(() => useTabs.setState({ incognito: false }));
    unmount(root);
    act(() => browse.useBrowse.setState({ surface: "browsing" }));
  }
});

test("a deck control pressed once the deck's entrance has committed is left to the control itself, so nothing runs twice", async () => {
  if (Platform.OS !== "android") return;
  const root = standbyDeck();
  await layOutControls(root);
  tapTabs();
  act(() => jest.advanceTimersByTime(100));
  act(() => jest.advanceTimersByTime(16));
  expect(deckTurn.reconciled.value).toBe(deckTurn.live.value);
  pressControl("plus");
  expect(deckTurn.hitMark.value).toBe("");
  act(() => jest.advanceTimersByTime(100));
  expect(searchState().open).toBe(false);
  unmount(root);
});

const preparedAt = (controls: PreparedDeck["controls"], layout: number): PreparedDeck => ({ tabId: "t0", order: ["t0", "t1"], revision: "0:0::0", layout, phone: currentPhoneGeneration(), controls });

test("a press that touches down before a standby republish and lifts after it keeps its target when the control didn't move, and is revoked when the control moved or the turn changed", () => {
  const more = { left: 330, top: 40, right: 374, bottom: 84 };
  deckTurn.prepared.value = preparedAt({ more }, 1);
  deckTurn.live.value = 7;
  deckTurn.reconciled.value = 0;
  expect(pressDeckControl("more", 350, 60)).toBe(true);
  expect(deckTurn.pressed.value).toBe("more");
  deckTurn.prepared.value = preparedAt({ more: { ...more } }, 2);
  deckTurn.reconciled.value = 7;
  const kept = liftDeckControl("more", 352, 62);
  expect(kept).not.toBeNull();
  expect(kept!.turn).toBe(7);
  expect(kept!.label).toBe("deck-hit:more");
  expect(deckTurn.pressed.value).toBe("");
  deckTurn.reconciled.value = 0;
  expect(pressDeckControl("more", 350, 60)).toBe(true);
  deckTurn.prepared.value = preparedAt({ more: { ...more, left: 300, right: 344 } }, 3);
  expect(liftDeckControl("more", 350, 60)).toBeNull();
  deckTurn.prepared.value = preparedAt({ more }, 4);
  expect(pressDeckControl("more", 350, 60)).toBe(true);
  deckTurn.live.value = 8;
  expect(liftDeckControl("more", 350, 60)).toBeNull();
  expect(pressDeckControl("more", 200, 400)).toBe(false);
  expect(pressDeckControl("spaces", 60, 60)).toBe(false);
  deckTurn.reconciled.value = 8;
  expect(pressDeckControl("more", 350, 60)).toBe(false);
  deckTurn.live.value = 0;
  deckTurn.prepared.value = null;
});

test("a deck command is consumed exactly once, and one stamped with an earlier screen layout is dropped", () => {
  const hit: DeckHitCommand = { seq: 9001, turn: 3, phone: currentPhoneGeneration(), control: "plus", label: "deck-hit:plus", deck: "t0" };
  expect(queueDeckHit(hit)).toBe(true);
  expect(takeDeckHit(hit)).toBe(true);
  expect(takeDeckHit(hit)).toBe(false);
  expect(queueDeckHit(hit)).toBe(false);
  const stale: DeckHitCommand = { ...hit, seq: 9002, phone: currentPhoneGeneration() - 1 };
  expect(queueDeckHit(stale)).toBe(true);
  expect(takeDeckHit(stale)).toBe(false);
});

test("a card command that reaches JS before the deck's entrance opens that card in the same dispatch as the entrance", () => {
  if (Platform.OS !== "android") return;
  const root = standbyDeck();
  const selected = currentTabs().selectedId!;
  const destination = currentTabs().open.find((tab) => tab.id !== selected)!.id;
  tapTabs();
  const turn = deckTurn.live.value;
  act(() => browse.deckHitAccepted({ seq: 9100, turn, phone: currentPhoneGeneration(), control: "card", label: "deck-hit:card", deck: selected, tabId: destination }));
  act(() => jest.advanceTimersByTime(0));
  act(() => jest.advanceTimersByTime(100));
  expect(currentTabs().selectedId).toBe(destination);
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  unmount(root);
});

test("a cut JS refuses because its page is no longer in front gives the page its bar and body back and ends the deck's turn", () => {
  deckPull.cut.value = true;
  deckPull.stage.value = PULL_STAGE.handed;
  deckTurn.live.value = 11;
  pageBarShown.value = 0;
  pageBodyShown.value = 0;
  withTabs(3);
  browse.useBrowse.setState({ surface: "start" });
  act(() => browse.deckPullSettled(currentTabs().selectedId!, true, 0, "", 11, currentPhoneGeneration()));
  act(() => jest.advanceTimersByTime(16));
  expect(pageBarShown.value).toBe(1);
  expect(pageBodyShown.value).toBe(1);
  expect(deckTurn.live.value).toBe(0);
  expect(deckPull.stage.value).toBe(PULL_STAGE.idle);
  expect(deckPull.cut.value).toBe(false);
});

test("a cut made before a phone, Duo and back to phone round trip and delivered after it is dropped at dispatch: the page keeps its bar and body, and the next tap cuts again", () => {
  if (Platform.OS !== "android") return;
  const { reportScreenLayout } = require("../state/app/screenLayout") as typeof import("../state/app/screenLayout");
  const root = standbyDeck();
  const selected = currentTabs().selectedId!;
  tapTabs();
  expect(deckTurn.live.value).toBeGreaterThan(0);
  act(() => {
    reportScreenLayout({ layout: "wide" });
    reportScreenLayout({ layout: "phone" });
  });
  for (let step = 0; step < 30; step++) act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("browsing");
  expect(currentTabs().selectedId).toBe(selected);
  expect(pageBarShown.value).toBe(1);
  expect(pageBodyShown.value).toBe(1);
  expect(deckTurn.live.value).toBe(0);
  expect(deckTurn.prepared.value?.phone).toBe(currentPhoneGeneration());
  tapTabs();
  expect(deckPull.cut.value).toBe(true);
  act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  unmount(root);
});

test("a Tabs tap right after an accepted swipe lands, before its commit, doesn't cut to the deck of the tab it left: it is held for the destination", () => {
  if (Platform.OS !== "android") return;
  const root = standbyDeck();
  const from = currentTabs().selectedId!;
  expect(deckPull.target.value?.id).toBe(from);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  tapTabs();
  expect(deckPull.cut.value).toBe(false);
  expect(deckTurn.live.value).toBe(0);
  for (let step = 0; step < 30; step++) act(() => jest.advanceTimersByTime(100));
  expect(currentTabs().selectedId).toBe(id);
  expect(browse.useBrowse.getState().surface).toBe("deck");
  unmount(root);
});

test("an accepted upward pull with cuts hands the deck its input turn on the release itself, with no frame wait or landing spring", () => {
  if (Platform.OS !== "android") return;
  const root = standbyDeck();
  act(() =>
    fireGestureHandler(getByGestureTestId("barSwipeUp"), [
      { state: State.BEGAN, translationX: 0, translationY: 0, velocityX: 0, velocityY: 0 },
      { state: State.ACTIVE, translationX: 0, translationY: -60, velocityX: 0, velocityY: -900 },
      { state: State.ACTIVE, translationX: 0, translationY: -320, velocityX: 0, velocityY: -900 },
      { state: State.END, translationX: 0, translationY: -320, velocityX: 0, velocityY: -900 },
    ]),
  );
  expect(deckTurn.live.value).toBeGreaterThan(0);
  expect(deckPull.cut.value).toBe(true);
  expect(deckPull.stage.value).toBe(PULL_STAGE.handed);
  expect(pageBodyShown.value).toBe(0);
  act(() => jest.advanceTimersByTime(100));
  expect(browse.useBrowse.getState().surface).toBe("deck");
  unmount(root);
});
