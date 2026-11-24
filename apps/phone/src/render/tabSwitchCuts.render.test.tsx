import * as Reanimated from "react-native-reanimated";
import { getAnimatedStyle, KeyboardState, makeMutable } from "react-native-reanimated";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestRenderer } from "react-test-renderer";
import { Surfaces } from "../App";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { SearchTray } from "../components/search/SearchTray";
import { DesignProvider } from "../components/ui";
import { neighbours } from "../lib/pagerPhysics";
import { sendDeckCommand } from "../state/browse/deckCommands";
import * as browse from "../state/browse/store";
import { cutTabSwitches } from "../state/browse/tabSwitch";
import { dismissSearch, presentSearch, searchState, setSearchText } from "../state/search/store";
import { display } from "../state/search/omnibox";
import { setPreference } from "../state/settings/store";
import { useSelectedTab } from "../state/tabs/hooks";
import { closeTabById, currentTabs, selectTabById } from "../state/tabs/store";
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
