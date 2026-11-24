import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const publishScript = join(root, "scripts/windows/publish-alpha.sh");
const verifierPath = process.env.ARDIA_UPDATE_VERIFY_BIN || join(root, "packages/core-rs/target/release/ardia-update-verify");
const publishedBase = "https://github.com/ardia-browser/ardia/releases/download/windows-alpha";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeFixture(dir, version, build) {
  const installers = join(dir, "installers");
  mkdirSync(installers, { recursive: true });
  writeFileSync(join(installers, "Ardia.build.json"), JSON.stringify({ version, build }) + "\n");
  const files = [
    [`Ardia-${version}-windows-x64-setup.exe`, Buffer.from(`x64-payload-${build}`)],
    [`Ardia-${version}-windows-arm64-setup.exe`, Buffer.from(`arm64-payload-${build}`)],
    [`Ardia-${version}-windows-source.tar.xz`, Buffer.from(`source-payload-${build}`)],
  ];
  for (const [name, data] of files) {
    writeFileSync(join(installers, name), data);
    writeFileSync(join(installers, `${name}.sha256`), `${sha256(data)}  ${name}\n`);
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privPem = join(dir, "priv.pem");
  const pubPem = join(dir, "pub.pem");
  writeFileSync(privPem, privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(pubPem, publicKey.export({ type: "spki", format: "pem" }));
  return { installers, privPem, pubPem, privateKey };
}

function makeFakeBin(dir, { liveJson = null, liveSig = null } = {}) {
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  const ghLog = join(state, "gh.log");
  writeFileSync(ghLog, "");
  if (liveJson !== null) writeFileSync(join(state, "live.json"), liveJson);
  if (liveSig !== null) writeFileSync(join(state, "live.sig"), liveSig);

  const curlBin = join(bin, "curl");
  writeFileSync(
    curlBin,
    `#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    --retry|--max-time) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
src=""
case "$url" in
  */windows-update.json) src="${join(state, "live.json")}" ;;
  */windows-update.json.sig) src="${join(state, "live.sig")}" ;;
esac
[ -n "$src" ] && [ -f "$src" ] || exit 22
if [ -n "$out" ]; then
  cp "$src" "$out"
else
  cat "$src"
fi
`,
  );
  chmodSync(curlBin, 0o755);

  const ghBin = join(bin, "gh");
  writeFileSync(
    ghBin,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${ghLog}"
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "view" ]; then
  for arg in "$@"; do
    if [ "$arg" = ".isPrerelease" ]; then
      echo "true"
      exit 0
    fi
    if [ "$arg" = ".assets[].name" ]; then
      exit 0
    fi
  done
  exit 0
fi
exit 0
`,
  );
  chmodSync(ghBin, 0o755);

  return { bin, ghLog };
}

function runPublish(args, { binDir, env = {} }) {
  return spawnSync("bash", [publishScript, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      WINDOWS_UPDATE_ED_PRIVATE_KEY: "",
      WINDOWS_UPDATE_KEY_FILE: "",
      ...env,
    },
  });
}

function signedManifest(version, build, privateKey) {
  const x64 = Buffer.from(`x64-payload-${build}`);
  const arm64 = Buffer.from(`arm64-payload-${build}`);
  const json =
    JSON.stringify(
      {
        version,
        build,
        x64: { url: `${publishedBase}/Ardia-Setup-x64-${build}.exe`, sha256: sha256(x64), bytes: x64.length },
        arm64: { url: `${publishedBase}/Ardia-Setup-arm64-${build}.exe`, sha256: sha256(arm64), bytes: arm64.length },
      },
      null,
      2,
    ) + "\n";
  const sig = sign(null, Buffer.from(json, "utf8"), privateKey);
  return { json, sig };
}

function ensureVerifier() {
  assert.ok(existsSync(verifierPath), `missing ${verifierPath}; build ardia-update-verify first`);
}

test("live publish uploads installers, then windows-update.json.sig alone, then windows-update.json alone", () => {
  ensureVerifier();
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-order-"));
  try {
    const { installers, privPem, pubPem } = makeFixture(dir, "0.2.99", 500);
    const { bin, ghLog } = makeFakeBin(dir);
    const out = join(dir, "out");
    const result = runPublish(["--installers", installers, "--out", out, "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath], { binDir: bin });
    assert.equal(result.status, 0, result.stderr + result.stdout);

    const uploads = readFileSync(ghLog, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("release upload "));
    assert.equal(uploads.length, 4, uploads.join("\n"));
    assert.match(uploads[0], /Ardia-Setup-x64-500\.exe.*Ardia-Setup-arm64-500\.exe.*ardia-windows-source-500\.tar\.xz/);
    assert.match(uploads[1], /windows-update\.json\.sig$/);
    assert.doesNotMatch(uploads[1], /windows-update\.json(?:\s|$)/);
    assert.match(uploads[2], /windows-update\.json$/);
    assert.doesNotMatch(uploads[2], /windows-update\.json\.sig/);
    assert.match(uploads[3], /Ardia-Setup-x64\.exe.*Ardia-Setup-arm64\.exe/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retrying the same build repairs a partial publish with missing or invalid windows-update.json.sig", () => {
  ensureVerifier();
  for (const mode of ["missing-sig", "corrupt-sig"]) {
    const dir = mkdtempSync(join(tmpdir(), `ardia-win-pub-repair-${mode}-`));
    try {
      const { installers, privPem, pubPem, privateKey } = makeFixture(dir, "0.2.99", 500);
      const { json } = signedManifest("0.2.99", 500, privateKey);
      const liveSig = mode === "corrupt-sig" ? Buffer.alloc(64, 0x42) : null;
      const { bin, ghLog } = makeFakeBin(dir, { liveJson: json, liveSig });
      const out = join(dir, "out");
      const result = runPublish(["--installers", installers, "--out", out, "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath], { binDir: bin });
      assert.equal(result.status, 0, `${mode}: ${result.stderr}${result.stdout}`);
      assert.match(result.stderr, /repairing incomplete publish/, mode);
      const uploads = readFileSync(ghLog, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("release upload "));
      assert.equal(uploads.length, 4, mode);
      assert.match(uploads[1], /windows-update\.json\.sig$/);
      assert.match(uploads[2], /windows-update\.json$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("an already validly signed same build and any lower build are refused", () => {
  ensureVerifier();
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-monotonic-"));
  try {
    const { installers, privPem, pubPem, privateKey } = makeFixture(dir, "0.2.99", 500);
    const same = signedManifest("0.2.99", 500, privateKey);
    const sameBin = makeFakeBin(join(dir, "same"), { liveJson: same.json, liveSig: same.sig });
    const sameRes = runPublish(["--installers", installers, "--out", join(dir, "out-same"), "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath], { binDir: sameBin.bin });
    assert.notEqual(sameRes.status, 0);
    assert.match(sameRes.stderr, /isn't above the live feed's build 500/);

    const higher = signedManifest("0.2.99", 501, privateKey);
    const lowerBin = makeFakeBin(join(dir, "lower"), { liveJson: higher.json, liveSig: null });
    const lowerRes = runPublish(["--installers", installers, "--out", join(dir, "out-lower"), "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath], { binDir: lowerBin.bin });
    assert.notEqual(lowerRes.status, 0);
    assert.match(lowerRes.stderr, /isn't above the live feed's build 501/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live publish fails closed without a signing key while --dry-run uses an ephemeral key", () => {
  ensureVerifier();
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-key-"));
  try {
    const { installers } = makeFixture(dir, "0.2.99", 500);
    const { bin } = makeFakeBin(dir);
    const liveNoKey = runPublish(["--installers", installers, "--out", join(dir, "out-live"), "--verify-bin", verifierPath], { binDir: bin });
    assert.notEqual(liveNoKey.status, 0);
    assert.match(liveNoKey.stderr, /a signing key is required to publish/);

    const dryOut = join(dir, "out-dry");
    const dryRes = runPublish(["--dry-run", "--installers", installers, "--out", dryOut, "--verify-bin", verifierPath], { binDir: bin });
    assert.equal(dryRes.status, 0, dryRes.stderr + dryRes.stdout);
    assert.equal(readFileSync(join(dryOut, "windows-update.json.sig")).length, 64);
    assert.ok(execFileSync("bash", ["-n", publishScript], { encoding: "utf8" }) === "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
