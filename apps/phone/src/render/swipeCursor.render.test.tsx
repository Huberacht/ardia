import { getAnimatedStyle } from "react-native-reanimated";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { Dimensions, Platform } from "react-native";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { besideIn, heldPose, restOf, swipeRefusal, zeroArmedTurn } from "../components/browsing/TabPager";
import { landedBackHere, landedSpokenSide } from "../components/browsing/FloatingBar";
import * as browse from "../state/browse/store";
import { cutTabSwitches } from "../state/browse/tabSwitch";
import { traceLab } from "../platform/lab";
import { searchState, dismissSearch } from "../state/search/store";
import { setPreference } from "../state/settings/store";
import { useSelectedTab } from "../state/tabs/hooks";
import { currentTabs, selectTabById } from "../state/tabs/store";
import { findTab } from "../state/tabs/tabsState";
import { display } from "../state/search/omnibox";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual<typeof import("@ardia/phone-native")>("@ardia/phone-native");
  return { ...actual, pageReportsDrawn: () => true };
});

let lines: string[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  cutTabSwitches(true);
  setPreference("tabSwipeHintShown", true);
  lines = [];
  traceLab(true, (line) => void lines.push(line));
});

afterEach(() => {
  traceLab(false);
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

const browsingNow = () => browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, arriving: null, arrivalCover: null, leaving: null });

const width = () => Dimensions.get("window").width;

type Step = { state: State; translationX: number; velocityX: number };

function flick(dx: -1 | 1, distance = 200, velocity = 1800, ending: State = State.END) {
  const steps: Step[] = [
    { state: State.BEGAN, translationX: 0, velocityX: 0 },
    { state: State.ACTIVE, translationX: dx * 20, velocityX: dx * velocity },
    { state: State.ACTIVE, translationX: dx * distance * 0.6, velocityX: dx * velocity },
    { state: State.ACTIVE, translationX: dx * distance, velocityX: dx * velocity },
    { state: ending, translationX: dx * distance, velocityX: dx * velocity },
  ];
  act(() => fireGestureHandler(getByGestureTestId("tabPager"), steps.map((step) => ({ ...step, translationY: 0, velocityY: 0 }))));
}

const frames = (ms: number) => {
  for (let left = ms; left > 0; left -= 16) act(() => jest.advanceTimersByTime(Math.min(16, left)));
};

const opacityOf = (node: ReactTestInstance) => getAnimatedStyle(node).opacity;
const marksOf = (root: ReactTestRenderer, testID: string) => root.root.findAll((node) => node.props.testID === testID && node.props.jestAnimatedStyle !== undefined);
const outgoingX = (root: ReactTestRenderer) => {
  const outgoing = root.root.findAll((node) => typeof node.type === "string" && (getAnimatedStyle(node)?.transform as object[] | undefined)?.some((step) => "scale" in step) === true)[0]!;
  return (Object.assign({}, ...(getAnimatedStyle(outgoing).transform as object[])) as { translateX: number }).translateX;
};
const swipeLines = () => lines.filter((line) => line.startsWith("PAGELAB swipe"));
const order = () => browse.swipeOrder();

function startAt(count: number, index: number) {
  withTabs(count);
  selectTabById(currentTabs().open[index]!.id);
  browsingNow();
  return renderSurface(<Page />);
}

test("five rapid flicks 150 to 300 ms apart, before any page draws, each advance one tab from the one on screen", () => {
  const root = startAt(7, 0);
  const line = order();
  const start = line.indexOf(currentTabs().selectedId!);
  const dx: -1 | 1 = start === 0 ? -1 : 1;
  const step = dx < 0 ? 1 : -1;
  const gaps = [150, 220, 300, 180];
  const covers: string[] = [];
  for (let at = 0; at < 5; at++) {
    flick(dx);
    if (at < gaps.length) frames(gaps[at]!);
    else frames(48);
    covers.push(browse.useBrowse.getState().arrivalCover ?? "");
  }
  const wanted = line[start + step * 5]!;
  expect(currentTabs().selectedId).toBe(wanted);
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: wanted, covered: wanted });
  expect(new Set(covers).size).toBe(5);
  const accepted = swipeLines().filter((entry) => entry.includes("accepted"));
  expect(accepted).toHaveLength(5);
  accepted.forEach((entry, at) => {
    expect(entry).toContain(`source=${line[start + step * at]}`);
    expect(entry).toContain(`candidate=${line[start + step * (at + 1)]}`);
    expect(entry).toMatch(/projected=-?\d+/);
  });
  unmount(root);
});

test("flicks that land before JS has run the first commit still advance in order, and none invalidates the one before", () => {
  const root = startAt(5, 0);
  const line = order();
  const start = line.indexOf(currentTabs().selectedId!);
  const dx: -1 | 1 = start === 0 ? -1 : 1;
  const step = dx < 0 ? 1 : -1;
  flick(dx);
  flick(dx);
  flick(dx);
  frames(64);
  expect(currentTabs().selectedId).toBe(line[start + step * 3]);
  expect(swipeLines().filter((entry) => entry.includes("refused"))).toEqual([]);
  unmount(root);
});

test("a flick back before JS has run the first commit returns to the tab still on screen and leaves no arrival card waiting on its drawn page", () => {
  const root = startAt(4, 1);
  const first = currentTabs().selectedId!;
  act(() => browse.pageDrawn(first));
  const line = order();
  const start = line.indexOf(first);
  const dx: -1 | 1 = line[start + 1] ? -1 : 1;
  flick(dx);
  flick(dx === -1 ? 1 : -1);
  frames(64);
  expect(currentTabs().selectedId).toBe(first);
  expect(browse.useBrowse.getState()).toMatchObject({ arriving: null, arrivalCover: null });
  const back = marksOf(root, "pagerBackMark")[0];
  expect(back?.props.markWhenShown).toBe(`dest-face:${first}`);
  unmount(root);
});

test("a second flick from a landed tab starts at zero from it: its first travel toward the next tab holds the landed card, and travel back reveals the tab it left", () => {
  const w = width();
  expect(restOf("b", "a", "z", "b", w)).toBe(-w);
  expect(restOf("z", "a", "z", "b", w)).toBe(w);
  expect(restOf("a", "a", "z", "b", w)).toBe(0);
  expect(restOf("c", "a", "z", "b", w)).toBeNull();
  expect(heldPose(-w, -40, w)).toBe(-w);
  expect(heldPose(-w, 100, w)).toBe(-w + 100);
  expect(heldPose(-w, w * 3, w)).toBe(0);
  expect(heldPose(w, 40, w)).toBe(w);
  expect(heldPose(w, -100, w)).toBe(w - 100);
  expect(besideIn(["a", "b", "c"], "b", 1)).toBe("c");
  expect(besideIn(["a", "b", "c"], "a", -1)).toBe("");
});

test("each refused swipe logs why: no neighbour that way is an edge, too little travel is short, a lift moving back is opposed and a lost touch is cancelled", () => {
  expect(swipeRefusal("", 500, 400)).toBe("edge");
  expect(swipeRefusal("b", 120, 400)).toBe("short");
  expect(swipeRefusal("b", 260, 400)).toBe("opposed");
  const root = startAt(3, 0);
  const line = order();
  const atEdge = line.indexOf(currentTabs().selectedId!) === 0 ? 1 : -1;
  flick(atEdge as -1 | 1, 200, 1800);
  flick((-atEdge) as -1 | 1, 40, 0);
  flick((-atEdge) as -1 | 1, 200, 1800, State.CANCELLED);
  frames(32);
  const refused = swipeLines().filter((entry) => entry.includes("refused"));
  expect(refused.map((entry) => /reason=(\S+)/.exec(entry)?.[1])).toEqual(["edge", "short", "cancelled"]);
  expect(refused.every((entry) => /turn=\d+ source=\S+ candidate=\S+ projected=-?\d+/.test(entry))).toBe(true);
  unmount(root);
});

test("a refused or cancelled swipe is back at zero on its release, and its zero mark is armed for that very turn before the release and raised by it", () => {
  const root = startAt(3, 1);
  const before = currentTabs().selectedId!;
  const line = order();
  const dx: -1 | 1 = line[line.indexOf(before) + 1] ? -1 : 1;
  const zero = () => marksOf(root, "pagerZeroMark")[0]!;
  const armed = () => zero().props.jestAnimatedProps?.value?.markWhenShown as string;
  expect(armed()).toBe("swipe-zero:1");
  expect(opacityOf(zero())).toBe(0);
  flick(dx, 40, 0);
  expect(opacityOf(zero())).toBe(1);
  expect(armed()).toBe("swipe-zero:1");
  expect(outgoingX(root)).toBe(0);
  act(() => jest.advanceTimersByTime(0));
  expect(swipeLines().at(-1)).toContain("turn=1");
  flick(dx, 200, 1800, State.CANCELLED);
  expect(opacityOf(zero())).toBe(1);
  expect(outgoingX(root)).toBe(0);
  expect(armed()).toBe("swipe-zero:2");
  expect(currentTabs().selectedId).toBe(before);
  frames(32);
  expect(currentTabs().selectedId).toBe(before);
  expect(zeroArmedTurn(4, 2, 0)).toBe(5);
  expect(zeroArmedTurn(4, 4, 0)).toBe(4);
  expect(zeroArmedTurn(4, 4, 1)).toBe(5);
  unmount(root);
});

test("an accepted flick raises the landed card's face mark and the bar's mark for its destination on the release, and the bar speaks the destination before the commit", () => {
  const root = startAt(3, 1);
  const line = order();
  const from = currentTabs().selectedId!;
  const right = line[line.indexOf(from) + 1];
  const dx: -1 | 1 = right ? -1 : 1;
  const wanted = right ?? line[line.indexOf(from) - 1]!;
  const face = () => marksOf(root, "pagerFaceMark").find((node) => node.props.markWhenShown === `dest-face:${wanted}`)!;
  const bar = () => marksOf(root, "landedBarMark").find((node) => node.props.markWhenShown === `dest-bar:${wanted}`)!;
  expect(opacityOf(face())).toBe(0);
  expect(opacityOf(bar())).toBe(0);
  flick(dx);
  expect(currentTabs().selectedId).toBe(from);
  expect(opacityOf(face())).toBe(1);
  expect(opacityOf(bar())).toBe(1);
  const spoken = root.root.findAll((node) => typeof node.props.jestAnimatedProps?.value?.accessibilityValue?.text === "string").map((node) => node.props.jestAnimatedProps.value.accessibilityValue.text as string);
  expect(spoken.length > 0).toBe(Platform.OS === "android");
  expect(spoken.every((text) => text.includes(display(findTab(currentTabs(), wanted)!.url).host))).toBe(true);
  expect(landedSpokenSide(wanted, from, from, "", wanted, 0, 400)).toBe(1);
  expect(landedSpokenSide(from, from, from, wanted, "", 0, 400)).toBe(0);
  expect(landedSpokenSide("", from, from, wanted, "", 400, 400)).toBe(-1);
  expect(landedBackHere(from, from, from, 0)).toBe(true);
  expect(landedBackHere(from, from, from, 12)).toBe(false);
  frames(48);
  expect(currentTabs().selectedId).toBe(wanted);
  unmount(root);
});

test("an Address tap after the second of two quick flicks is held for the latest destination, not dropped by the first commit", () => {
  const root = startAt(5, 0);
  const line = order();
  const start = line.indexOf(currentTabs().selectedId!);
  const dx: -1 | 1 = start === 0 ? -1 : 1;
  const step = dx < 0 ? 1 : -1;
  flick(dx);
  flick(dx);
  const address = root.root.findAll((node) => node.props.accessibilityLabel === "Address" && typeof node.props.onPress === "function")[0]!;
  act(() => address.props.onPress());
  expect(searchState().open).toBe(false);
  frames(64);
  expect(currentTabs().selectedId).toBe(line[start + step * 2]);
  expect(searchState().open).toBe(true);
  unmount(root);
});
