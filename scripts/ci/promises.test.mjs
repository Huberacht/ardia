import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { add, check, formatLock, LOCK, parseLock, ROOT, update } from "./promises.mjs";
import { findTests, hashOf } from "./test-source.mjs";

const hashes = (path, source) => Object.fromEntries(findTests(path, source).map((found) => [found.path, hashOf(found)]));

const JS = `import { test, describe } from "node:test";
test("keeps the pins", () => {
  const pins = [1, 2, 3];
  assert.deepEqual(pins.filter((pin) => pin > 1), [2, 3]);
});
describe("a group", () => {
  it('drops nothing', async () => {
    const text = \`a \${"b"} c\`;
    assert.match(text, /a b c/);
  });
});
`;

test("whitespace, comments, semicolons, trailing commas and quote style don't change a test's hash", () => {
  const reformatted = `import { test, describe } from "node:test"
test('keeps the pins', () => {
  const pins = [1, 2, 3,]
  assert.deepEqual(
    pins.filter((pin) => pin > 1),
    [2, 3],
  )
})
describe("a group", () => {
  it("drops nothing", async () => {
    const text = \`a \${'b'} c\`
    assert.match(text, /a b c/)
  })
})
`;
  assert.deepEqual(hashes("x.test.mjs", reformatted), hashes("x.test.mjs", JS));
});

test("a change to a test's body, its name or the call it makes changes the hash, and leaves the other tests alone", () => {
  const before = hashes("x.test.mjs", JS);
  const changed = hashes("x.test.mjs", JS.replace("pin > 1", "pin > 0"));
  assert.notEqual(changed["keeps the pins"], before["keeps the pins"]);
  assert.equal(changed["a group › drops nothing"], before["a group › drops nothing"]);
  assert.notEqual(hashes("x.test.mjs", JS.replace("test(", "test.skip("))["keeps the pins"], before["keeps the pins"]);
  assert.equal(hashes("x.test.mjs", JS.replace('test("keeps the pins"', 'test("keeps pins"'))["keeps the pins"], undefined);
});

test("tests are found inside loops and describe blocks, by a template title and past regex and template braces", () => {
  const source = `for (const side of ["left", "right"]) {
  test(\`\${side} sidebar: the field follows\`, () => {
    const pattern = /[{}()]/g;
    const label = \`}\${side}{\`;
    assert.ok(pattern.test(label));
  });
}
suite("outer", () => {
  describe("inner", () => {
    test("twice", () => {});
  });
  test("twice", () => {});
});
t.test("a subtest", () => {});
`;
  assert.deepEqual(findTests("x.test.mjs", source).map((found) => found.path), ["${side} sidebar: the field follows", "outer › inner › twice", "outer › twice"]);
});

test("Swift tests are XCTest test methods and @Test functions, raw strings and interpolation included", () => {
  const source = `import XCTest
final class PacingTests: XCTestCase {
  func testAFrameWaits() throws {
    let note = #"a "quoted" \\#(value) note"#
    XCTAssertEqual(pacing.frame(now: 1), CGPoint(x: "\\(a + ")")".count, y: 0))
  }
  private func helper() {}
}
@Test(arguments: ["a.example"])
func \`listed hosts require HTTPS\`(host: String) {
  #expect(Preload.requires(host))
}
`;
  const found = findTests("PacingTests.swift", source);
  assert.deepEqual(found.map((item) => item.name), ["testAFrameWaits", "listed hosts require HTTPS"]);
  const reindented = source.replace(/\n {2,}/g, "\n");
  assert.deepEqual(hashes("PacingTests.swift", reindented), hashes("PacingTests.swift", source));
});

function scratch(files) {
  const root = mkdtempSync(join(tmpdir(), "promises-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("the check names a promise whose test changed, was renamed or whose file is gone, and --update records the new hash", () => {
  const root = scratch({ "a/x.test.mjs": JS });
  const promises = add(root, add(root, [], 12, "a/x.test.mjs", "keeps the pins"), 7, "a/x.test.mjs", "drops nothing");
  const sorted = parseLock(formatLock(promises));
  assert.deepEqual(sorted.map((promise) => promise.issue), [7, 12]);
  assert.deepEqual(check(root, sorted), []);

  writeFileSync(join(root, "a/x.test.mjs"), JS.replace("pin > 1", "pin >= 2"));
  const [changed] = check(root, sorted);
  assert.match(changed, /#12 a\/x\.test\.mjs › "keeps the pins": the test changed/);
  assert.match(changed, /--update 12/);
  const updated = update(root, sorted, 12);
  assert.deepEqual(check(root, updated), []);
  assert.equal(updated.find((promise) => promise.issue === 7).hash, sorted.find((promise) => promise.issue === 7).hash);

  writeFileSync(join(root, "a/x.test.mjs"), JS.replace('"keeps the pins"', '"keeps its pins"'));
  assert.match(check(root, updated)[0], /no test called "keeps the pins"/);
  assert.throws(() => update(root, updated, 12), /fix its file or name/);

  writeFileSync(join(root, "a/x.test.mjs"), "");
  assert.equal(check(root, updated).length, 2);
  assert.match(check(scratch({}), updated)[0], /the file is gone/);
});

test("the lock is one header and one sorted, tab-separated line per promise, with no test locked twice", () => {
  assert.throws(() => parseLock("issue\thash\n"), /header/);
  assert.throws(() => parseLock("issue\thash\tfile\ttest\n12\tnothex\ta.test.mjs\tx\n"), /16 hex digits/);
  assert.throws(() => parseLock("issue\thash\tfile\ttest\n#12\t0123456789abcdef\ta.test.mjs\tx\n"), /a number/);
  const root = scratch({ "a/x.test.mjs": JS });
  const one = add(root, [], 12, "a/x.test.mjs", "keeps the pins");
  assert.throws(() => add(root, one, 13, "a/x.test.mjs", "keeps the pins"), /locked already/);
  assert.throws(() => add(root, one, 13, "a/x.test.mjs", "is not there"), /no test called/);
  const unsorted = [{ ...one[0], issue: 30 }, { ...one[0], issue: 4, test: "a group › drops nothing", hash: hashes("x.test.mjs", JS)["a group › drops nothing"] }];
  assert.match(check(root, unsorted).join("\n"), /is sorted by issue/);
});

test("every promise in the lock still holds", () => {
  const promises = parseLock(readFileSync(join(ROOT, LOCK), "utf8"));
  assert.ok(promises.length >= 100, "the lock still holds the seeded promises");
  assert.deepEqual(check(ROOT, promises), []);
});

test("the command line checks the lock and says how to use it", () => {
  const script = fileURLToPath(new URL("./promises.mjs", import.meta.url));
  assert.match(execFileSync(process.execPath, [script], { encoding: "utf8" }), /promises hold/);
  assert.match(execFileSync(process.execPath, [script, "--help"], { encoding: "utf8" }), /--update <issue>/);
});
