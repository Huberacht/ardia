import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { mount } from "../../test-hooks.mjs";
import { docs } from "../../test-native/index.ts";
import * as client from "../../state/telemetry/client.ts";
import { sessionEnding } from "../../state/telemetry/usage.ts";
const { setPageSelection } = await import("../../state/site/selection.ts");
const { SelectionPopover } = await import("./SelectionPopover.tsx");

const opens = async () => {
  sessionEnding();
  await client.saveQueueNow();
  const events = JSON.parse(docs.get("telemetry-queue.json") ?? '{"events":[]}').events.filter((event) => event.event === "usage_counts");
  return events.reduce((sum, event) => sum + (event.properties.pane_overlay_opens ?? 0), 0);
};

after(() => client.setSharing(false, "settings"));

const AREA = { width: 800, height: 600 };

function showBar(tabId, rect) {
  const popover = mount(() => SelectionPopover({ tabId }));
  setPageSelection(tabId, { text: "words", rect });
  void popover.value;
  mock.timers.tick(1000);
  popover.value.props.onLayout({ nativeEvent: { layout: AREA } });
  const bar = popover.value.props.children;
  return { popover, bar };
}

function layOut(barElement) {
  const bar = mount(() => barElement.type(barElement.props));
  bar.value?.props.onLayout({ nativeEvent: { layout: { width: 120 } } });
  void bar.value;
  return bar;
}

test("the selection search counts an opening only once its bar is laid out inside the pane", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  await opens();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const below = showBar("below", { x: 10, y: 5000, width: 40, height: 12 });
    assert.ok(below.bar, "the bar is placed once the delay passes");
    const offscreen = layOut(below.bar);
    assert.equal(offscreen.value, null, "a selection below the pane draws no bar");
    assert.equal(await opens(), 0, "and counts nothing");

    const quick = mount(() => SelectionPopover({ tabId: "quick" }));
    setPageSelection("quick", { text: "words", rect: { x: 10, y: 20, width: 40, height: 12 } });
    void quick.value;
    setPageSelection("quick", null);
    mock.timers.tick(1000);
    assert.equal(await opens(), 0, "a selection that clears before the delay counts nothing");

    const shown = showBar("shown", { x: 10, y: 200, width: 40, height: 12 });
    const bar = layOut(shown.bar);
    assert.ok(bar.value, "a selection in the pane draws its bar");
    bar.rerender();
    layOut(shown.popover.value.props.children);
    assert.equal(await opens(), 1, "one bar shown is one opening, however often it lays out");
  } finally {
    mock.timers.reset();
  }
});
