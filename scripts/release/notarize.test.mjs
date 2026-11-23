import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tool = join(root, "scripts/release/notarize.sh");
const FIRST = "11111111-2222-4333-8444-555555555555";
const SECOND = "66666666-7777-4888-9999-aaaaaaaaaaaa";

const XCRUN = `#!/usr/bin/env bash
set -u
stub="$NOTARY_STUB"
echo "$*" >> "$stub/calls"
next() { local f="$stub/$1"; [ -s "$f" ] || return 1; head -1 "$f"; tail -n +2 "$f" > "$f.rest"; mv "$f.rest" "$f"; }
case "$1 $2" in
  "notarytool submit")
    id="$(next submit)" || { echo "Error: upload cut off"; exit 1; }
    echo "Conducting pre-submission checks for $(basename "$3")"
    echo "Submission ID received"
    echo "  id: $id"
    printf 'In Progress\\n' > "$stub/status-$id"
    ;;
  "notarytool info")
    [ -f "$stub/status-$3" ] || { echo "Error: Submission does not exist or does not belong to your team."; exit 69; }
    echo "Successfully received submission info"
    echo "  createdDate: 2026-11-22T00:00:00.000Z"
    echo "  id: $3"
    echo "  name: notarize.zip"
    echo "  status: $(cat "$stub/status-$3")"
    ;;
  "notarytool wait")
    outcome="$(next "wait-$3")" || outcome=Accepted
    case "$outcome" in
      drop) echo "Error: The network connection was lost."; exit 1 ;;
      *) printf '%s\\n' "$outcome" > "$stub/status-$3"; echo "Current status: $outcome...Processing complete"; echo "  id: $3"; echo "  status: $outcome" ;;
    esac
    ;;
  "notarytool log") echo '{"status": "Invalid", "issues": [{"message": "The binary is not signed."}]}' ;;
  "stapler staple")
    [ -f "$stub/ticket" ] && grep -qxF "$(basename "$3")" "$stub/ticket" || { echo "Could not validate ticket for $3"; exit 65; }
    echo "The staple and validate action worked!"
    ;;
  *) echo "unexpected xcrun $*" >&2; exit 2 ;;
esac
`;

const CODESIGN = `#!/usr/bin/env bash
echo "Executable=$4/Contents/MacOS/Ardia" >&2
[ -f "$NOTARY_STUB/cdhash" ] && echo "CDHash=$(cat "$NOTARY_STUB/cdhash")" >&2
exit 0
`;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "ac-notarize-"));
  const bin = join(dir, "bin");
  const stub = join(dir, "stub");
  for (const d of [bin, stub, join(dir, "dist")]) mkdirSync(d);
  writeFileSync(join(bin, "xcrun"), XCRUN);
  chmodSync(join(bin, "xcrun"), 0o755);
  writeFileSync(join(bin, "codesign"), CODESIGN);
  chmodSync(join(bin, "codesign"), 0o755);
  const dmg = join(dir, "dist", "Ardia-1.2.3.dmg");
  writeFileSync(dmg, "a disk image");
  const state = join(dir, "state");
  const set = (name, lines) => writeFileSync(join(stub, name), lines.map((l) => `${l}\n`).join(""));
  const calls = () => (existsSync(join(stub, "calls")) ? readFileSync(join(stub, "calls"), "utf8").trim().split("\n").map((l) => l.split(" ").slice(0, 2).join(" ")) : []);
  const notarize = (target = dmg, extra = {}) => {
    const result = spawnSync("bash", [tool, target, join(dir, "dist")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NOTARY_STUB: stub,
        NOTARY_STATE_DIR: state,
        NOTARY_RETRY_DELAY: "0",
        NOTARY_KEY: join(dir, "AuthKey.p8"),
        NOTARY_KEY_ID: "KEYID",
        NOTARY_ISSUER: "issuer",
        ...extra,
      },
    });
    return { ...result, output: result.stdout + result.stderr };
  };
  const records = () => (existsSync(state) ? Object.fromEntries(readdirSync(state).map((f) => [f, readFileSync(join(state, f), "utf8").trim()])) : {});
  return { dir, dmg, state, stub, set, calls, notarize, records, ticket: (name = "Ardia-1.2.3.dmg") => writeFileSync(join(stub, "ticket"), `${name}\n`) };
}

function sha256(path) {
  const out = spawnSync("bash", ["-c", 'if command -v shasum >/dev/null; then shasum -a 256 "$1"; else sha256sum "$1"; fi', "sha", path], { encoding: "utf8" });
  return `sha256-${out.stdout.split(" ")[0]}`;
}

test("a first submission records its id under the file's sha256 before waiting, then staples", () => {
  const s = scratch();
  s.set("submit", [FIRST]);
  s.ticket();
  const run = s.notarize();
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(s.calls(), ["notarytool submit", "notarytool wait", "stapler staple"]);
  assert.deepEqual(s.records(), { [sha256(s.dmg)]: FIRST });
  assert.match(readFileSync(join(s.dir, "dist", "notary-Ardia-1.2.3.dmg.log"), "utf8"), /status: Accepted/);
});

test("a retry after the wait gave up picks the same submission up and never uploads again", () => {
  const s = scratch();
  s.set("submit", [FIRST]);
  s.set(`wait-${FIRST}`, ["drop", "drop", "drop", "drop", "drop"]);
  const first = s.notarize();
  assert.notEqual(first.status, 0);
  assert.match(first.output, /kept failing while waiting on 11111111.*running this again picks it up/);
  assert.deepEqual(s.records(), { [sha256(s.dmg)]: FIRST });
  rmSync(join(s.dir, "dist"), { recursive: true });
  mkdirSync(join(s.dir, "dist"));
  writeFileSync(s.dmg, "a disk image");
  writeFileSync(join(s.stub, "calls"), "");
  s.ticket();
  const retry = s.notarize();
  assert.equal(retry.status, 0, retry.output);
  assert.match(retry.output, /still in Apple's queue; waiting on it instead of uploading again/);
  assert.deepEqual(s.calls().filter(Boolean), ["notarytool info", "notarytool wait", "stapler staple"]);
});

test("a submission Apple already accepted is stapled without a wait or an upload", () => {
  const s = scratch();
  mkdirSync(s.state);
  writeFileSync(join(s.state, sha256(s.dmg)), `${FIRST}\n`);
  writeFileSync(join(s.stub, `status-${FIRST}`), "Accepted\n");
  s.ticket();
  const run = s.notarize();
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(s.calls(), ["notarytool info", "stapler staple"]);
});

test("a rejected submission fails with Apple's log and doesn't resubmit the same file", () => {
  const s = scratch();
  mkdirSync(s.state);
  writeFileSync(join(s.state, sha256(s.dmg)), `${FIRST}\n`);
  writeFileSync(join(s.stub, `status-${FIRST}`), "Invalid\n");
  const run = s.notarize();
  assert.notEqual(run.status, 0);
  assert.match(run.output, /The binary is not signed/);
  assert.match(run.output, /Apple rejected submission 11111111-2222-4333-8444-555555555555 of Ardia-1.2.3.dmg/);
  assert.deepEqual(s.calls(), ["notarytool info", "notarytool log"]);
});

test("a rejection while waiting fails with the log too", () => {
  const s = scratch();
  s.set("submit", [FIRST]);
  s.set(`wait-${FIRST}`, ["Rejected"]);
  const run = s.notarize();
  assert.notEqual(run.status, 0);
  assert.match(run.output, /Apple rejected submission/);
  assert.deepEqual(s.calls(), ["notarytool submit", "notarytool wait", "notarytool log"]);
});

test("an id Apple doesn't know, a record that isn't an id, or new bytes each submit fresh", () => {
  const unknown = scratch();
  mkdirSync(unknown.state);
  writeFileSync(join(unknown.state, sha256(unknown.dmg)), `${FIRST}\n`);
  unknown.set("submit", [SECOND]);
  unknown.ticket();
  const a = unknown.notarize();
  assert.equal(a.status, 0, a.output);
  assert.deepEqual(unknown.calls(), ["notarytool info", "notarytool submit", "notarytool wait", "stapler staple"]);
  assert.deepEqual(unknown.records(), { [sha256(unknown.dmg)]: SECOND });

  const tampered = scratch();
  mkdirSync(tampered.state);
  writeFileSync(join(tampered.state, sha256(tampered.dmg)), "$(touch /tmp/pwned)\n");
  tampered.set("submit", [SECOND]);
  tampered.ticket();
  const b = tampered.notarize();
  assert.equal(b.status, 0, b.output);
  assert.match(b.output, /isn't a submission id/);
  assert.deepEqual(tampered.calls(), ["notarytool submit", "notarytool wait", "stapler staple"]);

  const rebuilt = scratch();
  mkdirSync(rebuilt.state);
  writeFileSync(join(rebuilt.state, sha256(rebuilt.dmg)), `${FIRST}\n`);
  writeFileSync(join(rebuilt.stub, `status-${FIRST}`), "Accepted\n");
  writeFileSync(rebuilt.dmg, "a different disk image");
  rebuilt.set("submit", [SECOND]);
  rebuilt.ticket();
  const c = rebuilt.notarize();
  assert.equal(c.status, 0, c.output);
  assert.deepEqual(rebuilt.calls(), ["notarytool submit", "notarytool wait", "stapler staple"]);
  assert.equal(Object.keys(rebuilt.records()).length, 2);
});

test("an accepted id whose ticket doesn't fit this file submits fresh instead of trusting the record", () => {
  const s = scratch();
  mkdirSync(s.state);
  writeFileSync(join(s.state, sha256(s.dmg)), `${FIRST}\n`);
  writeFileSync(join(s.stub, `status-${FIRST}`), "Accepted\n");
  s.set("submit", [SECOND]);
  const run = s.notarize();
  assert.notEqual(run.status, 0);
  assert.match(run.output, /Apple accepted 11111111.* but has no ticket for this file; submitting again/);
  assert.deepEqual(s.calls().slice(0, 7), ["notarytool info", ...Array(5).fill("stapler staple"), "notarytool submit"]);
});

test("a cut-off upload is submitted again, up to three times", () => {
  const s = scratch();
  s.set("submit", ["", "", FIRST]);
  s.ticket();
  const run = s.notarize();
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(s.calls(), ["notarytool submit", "notarytool submit", "notarytool submit", "notarytool wait", "stapler staple"]);
});

test("an app Apple already has a ticket for is stapled with no upload at all", () => {
  const s = scratch();
  const app = join(s.dir, "dist", "Ardia.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  s.ticket("Ardia.app");
  const run = s.notarize(app);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /already notarized .*nothing uploaded/);
  assert.deepEqual(s.calls(), ["stapler staple"]);
});

test("when notarytool can't answer about a recorded id, it stops and keeps the record instead of uploading again", () => {
  const s = scratch();
  mkdirSync(s.state);
  writeFileSync(join(s.state, sha256(s.dmg)), `${FIRST}\n`);
  writeFileSync(join(s.stub, `status-${FIRST}`), "In Progress\n");
  const xcrun = join(s.dir, "bin", "xcrun");
  writeFileSync(xcrun, readFileSync(xcrun, "utf8").replace('"notarytool info")', '"notarytool info")\n    echo "Error: HTTP status code: 503. Service Unavailable"; exit 1'));
  const run = s.notarize();
  assert.notEqual(run.status, 0);
  assert.match(run.output, /couldn't ask Apple about submission 11111111.*stays recorded/);
  assert.deepEqual(s.calls(), ["notarytool info", "notarytool info", "notarytool info"]);
  assert.deepEqual(s.records(), { [sha256(s.dmg)]: FIRST });
});

test("the wait stops at NOTARY_WAIT_SECONDS with the id recorded, so a job deadline can't lose it", () => {
  const s = scratch();
  s.set("submit", [FIRST]);
  s.set(`wait-${FIRST}`, ["drop"]);
  const xcrun = join(s.dir, "bin", "xcrun");
  writeFileSync(xcrun, readFileSync(xcrun, "utf8").replace('drop) echo', 'drop) sleep 4; echo'));
  const run = s.notarize(s.dmg, { NOTARY_WAIT_SECONDS: "3" });
  assert.notEqual(run.status, 0);
  assert.match(run.output, /hasn't finished 11111111.* within NOTARY_WAIT_SECONDS \(3 s\).*waits on it instead of uploading/);
  assert.deepEqual(s.records(), { [sha256(s.dmg)]: FIRST });
  assert.match(readFileSync(join(s.stub, "calls"), "utf8"), /notarytool wait 11111111-2222-4333-8444-555555555555 .*--timeout [1-3]$/m);
});

test("a symlinked state directory is refused", () => {
  const s = scratch();
  mkdirSync(join(s.dir, "elsewhere"));
  spawnSync("ln", ["-s", join(s.dir, "elsewhere"), s.state]);
  const run = s.notarize();
  assert.notEqual(run.status, 0);
  assert.match(run.output, /is a symlink/);
  assert.deepEqual(s.calls(), []);
});

test("an app signed again, its zip's bytes changed, resumes the pending submission by its code's CDHash", { skip: process.platform !== "darwin" && "ditto is macOS's" }, () => {
  const s = scratch();
  const app = join(s.dir, "dist", "Ardia.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "MacOS", "Ardia"), "signed at 10:00");
  writeFileSync(join(s.stub, "cdhash"), "c0c480061bc60ca0bdb4e8a609fabb4168eebd52");
  s.set("submit", [FIRST]);
  s.set(`wait-${FIRST}`, ["drop", "drop", "drop", "drop", "drop"]);
  const first = s.notarize(app);
  assert.notEqual(first.status, 0);
  assert.deepEqual(s.records(), { "cdhash-c0c480061bc60ca0bdb4e8a609fabb4168eebd52": FIRST });
  writeFileSync(join(app, "Contents", "MacOS", "Ardia"), "signed again at 10:40, same code");
  writeFileSync(join(s.stub, "calls"), "");
  const xcrun = join(s.dir, "bin", "xcrun");
  writeFileSync(xcrun, readFileSync(xcrun, "utf8").replace('"stapler staple")', '"stapler staple")\n    [ "$(cat "$stub/status-11111111-2222-4333-8444-555555555555")" = Accepted ] && { echo ok; exit 0; }'));
  const retry = s.notarize(app);
  assert.equal(retry.status, 0, retry.output);
  assert.deepEqual(s.calls().filter(Boolean), ["stapler staple", "notarytool info", "notarytool wait", "stapler staple"]);
  assert.ok(!existsSync(join(s.dir, "dist", "notarize.zip")));
});
