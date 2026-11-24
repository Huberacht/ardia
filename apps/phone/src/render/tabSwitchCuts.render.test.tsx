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
import { dismissSearch, presentSearch } from "../state/search/store";
import { setPreference } from "../state/settings/store";
import { useSelectedTab } from "../state/tabs/hooks";
import { currentTabs, selectTabById } from "../state/tabs/store";
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

test("an accepted bar swipe commits the neighbour within a frame of release, with no spring to wait out, and its arrival card sits full screen from that frame", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, leaving: null });
  const root = renderSurface(<Page />);
  const { id, dx } = toNeighbour();
  releaseSwipe(root, dx, 260, 1600);
  act(() => jest.advanceTimersByTime(16));
  expect(currentTabs().selectedId).toBe(id);
  act(() => jest.advanceTimersByTime(16));
  const arrival = root.root.findAll((node) => node.props.testID === "pagerArrival" && typeof node.type === "string")[0];
  if (arrival) expect(Object.assign({}, ...((getAnimatedStyle(arrival).transform ?? []) as object[]))).toMatchObject({ translateX: 0 });
  unmount(root);
});

test("a refused bar swipe goes back within 50 ms and keeps the tab", () => {
  withTabs(3);
  selectTabById(currentTabs().open[1]!.id);
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, leaving: null });
  const before = currentTabs().selectedId;
  const root = renderSurface(<Page />);
  releaseSwipe(root, toNeighbour().dx, 40, 0);
  act(() => jest.advanceTimersByTime(50));
  expect(currentTabs().selectedId).toBe(before);
  const outgoing = root.root.findAll((node) => typeof node.type === "string" && getAnimatedStyle(node)?.transform !== undefined && (getAnimatedStyle(node).transform as object[]).some((step) => "scale" in step))[0];
  if (outgoing) expect(Object.assign({}, ...((getAnimatedStyle(outgoing).transform ?? []) as object[]))).toMatchObject({ translateX: 0 });
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

test("the next search sheet waits laid out and hidden, with no field to take focus, and + turns that same sheet live instead of mounting one", () => {
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
  expect(host("trayFieldCapsule")).toHaveLength(0);
  const waiting = root.root.findAll((node) => node.props.testID === "trayPanel" && typeof node.type === "string")[0]!;
  act(() => presentSearch("page", ""));
  expect(host("trayRoot")).toHaveLength(1);
  expect(host("trayFieldCapsule")).toHaveLength(1);
  expect(root.root.findAll((node) => node.props.testID === "trayPanel" && typeof node.type === "string")).toContain(waiting);
  expect(host("trayStandby")).toHaveLength(1);
  unmount(root);
  keyboard.mockRestore();
});
