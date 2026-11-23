import assert from "node:assert/strict";
import { test } from "node:test";
import { baseKeysWith, dropBase, putBase } from "./scopeKeys.ts";
import { emptyScope } from "./scopeState.ts";

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return (n: number) => (x = (x * 1103515245 + 12345) >>> 0) % n;
}

const PREFIXES = ["h:", "bm:", "tabs:", "pin", "pin:"];

test("each prefix's base keys stay those a full scan finds, once each, through puts, drops, re-puts and sweeps", () => {
  for (let seed = 1; seed <= 120; seed++) {
    const r = rng(seed);
    const state = emptyScope();
    const keys = Array.from({ length: 40 + r(400) }, (_, i) => `${PREFIXES[r(PREFIXES.length)]}${i % 97}-${r(7)}`);
    for (let step = 0; step < 3000; step++) {
      const key = keys[r(keys.length)]!;
      const op = r(10);
      if (op < 5) putBase(state, key, `v${r(3)}`);
      else if (op < 9) dropBase(state, key);
      else {
        const prefix = PREFIXES[r(PREFIXES.length)]!;
        const live = baseKeysWith(state, prefix).filter((k) => k in state.base);
        const expected = Object.keys(state.base).filter((k) => k.startsWith(prefix));
        assert.equal(new Set(live).size, live.length, `seed ${seed} step ${step}: a key listed twice under ${prefix}`);
        assert.deepEqual([...live].sort(), expected.sort(), `seed ${seed} step ${step}: ${prefix}`);
      }
    }
  }
});
