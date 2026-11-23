import assert from "node:assert/strict";
import { test } from "node:test";

const { layout } = await import("../ui/theme.ts");
const { groupMembersTop } = await import("./groupPlace.ts");
const { entryKey } = await import("../../state/sidebar/entryKey.ts");
const g = (id) => entryKey("group", id);

const ROW = 30;
const gap = layout.rowGap;
const state = (groups) => ({ groups, tabs: {} });
const members = { outer: ["tab:a", g("inner"), "tab:b"], inner: ["tab:c", "tab:d"], pinnedGroup: ["tab:e"] };
const places = (sections) => ({ sections, membersOf: (_s, id) => members[id] ?? [], membersTop: () => 10, height: () => ROW });

test("a top-level group's members start below its header, from the list it was in before the close", () => {
  const s = state({ outer: { id: "outer" } });
  const before = ["tab:x", "tab:y", g("outer")];
  assert.equal(groupMembersTop(s, "outer", places([{ list: before, base: 0 }])), 2 * (ROW + gap) + 10);
  assert.equal(groupMembersTop(s, "outer", places([{ list: [g("outer")], base: 0 }])), 10, "after the close the place differs");
});

test("a nested group resolves through its parent", () => {
  const s = state({ outer: { id: "outer" }, inner: { id: "inner", parentId: "outer" } });
  const outerTop = ROW + gap + 10;
  assert.equal(groupMembersTop(s, "inner", places([{ list: ["tab:x", g("outer")], base: 0 }])), outerTop + (ROW + gap) + 10);
});

test("a pinned group resolves in the pinned section, above the list", () => {
  const s = state({ pinnedGroup: { id: "pinnedGroup" } });
  assert.equal(groupMembersTop(s, "pinnedGroup", places([{ list: ["tab:x"], base: 0 }, { list: ["tab:p", g("pinnedGroup")], base: -200 }])), -200 + ROW + gap + 10);
  assert.equal(groupMembersTop(s, "missing", places([{ list: [], base: 0 }])), null);
});
