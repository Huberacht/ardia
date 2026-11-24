import * as Reanimated from "react-native-reanimated";
import { getAnimatedStyle, KeyboardState, makeMutable } from "react-native-reanimated";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestRenderer } from "react-test-renderer";
import { Surfaces } from "../App";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { SearchTray } from "../components/search/SearchTray";
import { DesignProvider, Favicon } from "../components/ui";
import { Dimensions, Image, StyleSheet, TextInput } from "react-native";
import { deckPull, PULL_STAGE, queueDeckTapAfterCut } from "../state/browse/deckPull";
import { neighbours } from "../lib/pagerPhysics";
import { sendDeckCommand } from "../state/browse/deckCommands";
import * as browse from "../state/browse/store";
import { cutTabSwitches } from "../state/browse/tabSwitch";
import { dismissSearch, presentSearch, searchState, setSearchText } from "../state/search/store";
import { display } from "../state/search/omnibox";
import { setPreference } from "../state/settings/store";
import { useSelectedTab } from "../state/tabs/hooks";
import { closeTabById, currentTabs, selectTabById, updateTabById } from "../state/tabs/store";
import { noteSettledScroll, noteWarmPicture } from "../state/tabs/warmPictures";
import { findTab } from "../state/tabs/tabsState";
import * as pageStore from "../state/pages/store";
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

test("an accepted bar swipe commits the neighbour within a frame of release, with no spring to wait out, and its arrival card sits full screen from that frame, hidden from TalkBack and holding touches until the page draws", () => {
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
  act(() => browse.pageCoverHidden(id, "drawn", `${browse.ARRIVAL_COVER_ID}-0`));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: id, arrivalCover: cover });
  act(() => browse.pageCoverHidden(id, "drawn", cover));
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
  expect(StyleSheet.flatten(waiting.props.style)?.opacity ?? 1).toBe(1);
  unmount(root);
  keyboard.mockRestore();
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

test("a cover acknowledgement that names the arrival's cover but found no view leaves the cover up", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browsingNow();
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  act(() => jest.advanceTimersByTime(16));
  const cover = browse.useBrowse.getState().arrivalCover!;
  act(() => browse.pageCoverHidden(id, "drawn", cover, false));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: id, arrivalCover: cover });
  act(() => jest.advanceTimersByTime(1000));
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: id, arrivalCover: cover });
  act(() => browse.pageCoverHidden(id, "drawn", cover, true));
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

test("a tap on the deck during the cut is latched to the card it touched down on, and dropped if the deck's hit data changed before it lifted", () => {
  deckPull.stage.value = PULL_STAGE.handed;
  deckPull.openAfter.value = "";
  const latched = { id: "t2", hitTurn: deckPull.hitTurn.value };
  expect(queueDeckTapAfterCut(latched)).toBe(true);
  expect(deckPull.openAfter.value).toBe("t2");
  deckPull.openAfter.value = "";
  deckPull.hitTurn.value += 1;
  expect(queueDeckTapAfterCut(latched)).toBe(false);
  expect(deckPull.openAfter.value).toBe("");
  expect(queueDeckTapAfterCut(null)).toBe(false);
  deckPull.stage.value = PULL_STAGE.idle;
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

test("a swipe's neighbour shows its own last picture while it still matches the tab, and only its title card once that page's scroll or document moved on", () => {
  withTabs(3);
  browsingNow();
  const { id } = toNeighbour();
  const uri = `file:///warm-${id}.jpg`;
  act(() => updateTabById(id, { snapshotFileName: uri }));
  const neighbour = findTab(currentTabs(), id)!;
  noteWarmPicture(id, uri, neighbour.url, Dimensions.get("window"), { width: 600, height: 1333 });
  const pictures = (root: ReactTestRenderer) => root.root.findAll((node) => node.props.testID === "pagerWarmPicture" && typeof node.type === "string");
  const warm = renderSurface(<Page />);
  expect(pictures(warm)).toHaveLength(1);
  expect(pictures(warm)[0]!.props.source).toEqual({ uri });
  unmount(warm);
  noteSettledScroll(id, 900);
  const scrolled = renderSurface(<Page />);
  expect(pictures(scrolled)).toHaveLength(0);
  unmount(scrolled);
  noteWarmPicture(id, uri, neighbour.url, Dimensions.get("window"), { width: 600, height: 1333 });
  act(() => updateTabById(id, { url: "https://example.com/moved" }));
  const moved = renderSurface(<Page />);
  expect(pictures(moved)).toHaveLength(0);
  unmount(moved);
});
