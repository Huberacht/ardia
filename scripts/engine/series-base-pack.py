#!/usr/bin/env python3
"""Packs a builder's series base into the archive series-zero-fuzz.py checks the series against, and publishes it.

  series-base-pack.py pack --platform linux|mac [--cpu CPU] [--base DIR] [--src DIR] [--dest DIR] [--no-verify]
  series-base-pack.py publish ARCHIVE [--repo OWNER/NAME]

pack runs on the builder, read-only on its tree. It takes from the series base (AC_SERIES_BASE, default
~/chromium-build/series-base for mac/arm64 and ~/chromium-build/series-base-<os>-<cpu> otherwise) only the files the
platform's series touches and writes series-base-<chromium>-<helium12>-<platform>-<helium-platform12>-<cpu>-<rev12>.tar.xz
(rev12: the digest of the files it holds, so a re-pack after capture-base gets a new name and the old archive stays
for the checkouts that pin it) into --dest (default: a new temporary directory), its .sha256, and its manifest: each
file's sha256, the pins, the
branding inputs' digest and the commit of this checkout (or, for a plain copy, of <copy>.commit). First it checks
that the tree is at the pins in engine/patches/build/env.sh and helium-pins.ini (chrome/VERSION, and the Helium
checkouts beside it when present) and that `series.py check` reproduces the tree from the base; --no-verify skips
both. A file a patch changes that the base lacks stops it: run `series.py capture-base` first.

publish runs where gh is signed in. It creates the prerelease series-base-<chromium>-<helium12> if needed, uploads
the archive, its .sha256 and manifest (each one already there must match; an archive of the same files packed
again keeps the one published), and writes the archive's row into scripts/engine/series-bases.tsv in place of the
row for the same pins, for you to commit.
"""

import argparse
import datetime
import json
import os
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import series_base  # noqa: E402


def chromium_build():
    return os.environ.get("AC_CHROMIUM_BUILD", os.path.expanduser("~/chromium-build"))


def default_base(platform, cpu):
    if "AC_SERIES_BASE" in os.environ:
        return os.environ["AC_SERIES_BASE"]
    name = "series-base" if (platform, cpu) == ("mac", "arm64") else f"series-base-{platform}-{cpu}"
    return os.path.join(chromium_build(), name)


def default_src():
    return os.environ.get("CHROMIUM_SRC", os.path.join(chromium_build(), "chromium_git/chromium/src"))


def tree_version(src):
    parts = dict(line.split("=", 1) for line in pathlib.Path(src, "chrome/VERSION").read_text().split() if "=" in line)
    return ".".join(parts.get(key, "") for key in ("MAJOR", "MINOR", "BUILD", "PATCH"))


def git_head(path):
    result = subprocess.run(["git", "-C", path, "rev-parse", "HEAD"], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


def verify_tree(ident, src, base, platform, cpu):
    version = tree_version(src)
    if version != ident["chromium"]:
        series_base.die(f"{src} is Chromium {version}, but the pins say {ident['chromium']}")
    helium_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(src))))
    for name, key in (("helium", "helium_chromium"), (series_base.PLATFORM_HELIUM[platform], "helium_platform")):
        checkout = os.path.join(helium_root, name)
        head = git_head(checkout) if os.path.isdir(checkout) else None
        if head is None:
            print(f"note: no git checkout at {checkout}; trusting the pins for {key}")
        elif head != ident[key]:
            series_base.die(f"{checkout} is at {head}, but helium-pins.ini pins {ident[key]}")
    marker = pathlib.Path(base, ".ardia-series-target")
    if marker.exists() and json.loads(marker.read_text()) != {"platform": platform, "cpu": cpu}:
        series_base.die(f"{base} is the base for {marker.read_text().strip()}, not {platform}/{cpu}")
    env = dict(os.environ, CHROMIUM_SRC=src, AC_SERIES_BASE=base)
    result = subprocess.run([sys.executable, str(series_base.REPO / "engine/patches/series.py"), "check",
                             "--platform", platform, "--cpu", cpu], env=env, capture_output=True, text=True)
    tail = (result.stdout + result.stderr).strip().splitlines()[-1:] or [""]
    if result.returncode:
        print((result.stdout + result.stderr).strip(), file=sys.stderr)
        series_base.die("series.py check doesn't reproduce the tree from this base; fix that before packing it")
    print(f"series.py check: {tail[0]}")


def source_commit():
    head = git_head(str(series_base.REPO)) if (series_base.REPO / ".git").exists() else None
    beside = pathlib.Path(str(series_base.REPO) + ".commit")
    return head or (beside.read_text().strip() if beside.exists() else "")


def cmd_pack(args):
    cpu = args.cpu or series_base.DEFAULT_CPU[args.platform]
    ident = series_base.identity(args.platform, cpu)
    base = os.path.abspath(args.base or default_base(args.platform, cpu))
    src = os.path.abspath(args.src or default_src())
    if not os.path.isdir(base):
        series_base.die(f"no series base at {base}: run `series.py capture-base --platform {args.platform}` on a tree "
                        "Helium and the branding just left (docs/engine-build.md)")
    if not args.no_verify:
        verify_tree(ident, src, base, args.platform, cpu)
    series = series_base.load_series()
    steps = series.read_series(args.platform)
    required, optional = series_base.base_paths(steps)
    missing = sorted(path for path in required if not os.path.lexists(os.path.join(base, path)))
    if missing:
        for path in missing:
            print(f"error: {path} (changed by {required[path]}) isn't in {base}", file=sys.stderr)
        series_base.die(f"the base lacks {len(missing)} files the series changes: run `series.py capture-base "
                        f"--platform {args.platform}` first")
    commit = source_commit()
    dest = os.path.abspath(args.dest or tempfile.mkdtemp(prefix="ac-series-base-"))
    os.makedirs(dest, exist_ok=True)
    fields = dict(ident, branding=series_base.branding_digest(), series_commit=commit,
                  packed_at=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                  steps=len(steps))
    manifest, out = series_base.write_tarball(base, set(required) | set(optional), fields, dest)
    digest = series_base.sha256_file(out)
    pathlib.Path(out + ".sha256").write_text(f"{digest}  {os.path.basename(out)}\n")
    pathlib.Path(out + ".manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    print(f"packed {len(manifest['files'])} files ({len(manifest['absent'])} layer paths absent from the base)")
    print(out)
    print("\t".join([ident["platform"], ident["cpu"], ident["chromium"], ident["helium_chromium"],
                     ident["helium_platform"], series_base.tag_name(ident), os.path.basename(out), digest]))


def gh(*args, check=True):
    result = subprocess.run(["gh", *args], capture_output=True, text=True)
    if check and result.returncode:
        series_base.die(f"gh {' '.join(args)}: {result.stderr.strip() or result.stdout.strip()}")
    return result


def sidecars(name, digest, manifest, scratch):
    sha_file = os.path.join(scratch, name + ".sha256")
    pathlib.Path(sha_file).write_text(f"{digest}  {name}\n")
    manifest_file = os.path.join(scratch, name + ".manifest.json")
    pathlib.Path(manifest_file).write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    return [sha_file, manifest_file]


def download(tag, repo, name, directory):
    gh("release", "download", tag, "-R", repo, "-p", name, "-D", directory)
    return os.path.join(directory, name)


def cmd_publish(args):
    archive = os.path.abspath(args.archive)
    manifest = series_base.read_manifest(archive)
    ident = {key: manifest[key] for key in series_base.IDENTITY}
    name = series_base.asset_name(ident, series_base.content_revision(manifest))
    if os.path.basename(archive) != name:
        series_base.die(f"{archive} should be named {name} for its manifest")
    digest = series_base.sha256_file(archive)
    tag = series_base.tag_name(ident)
    with tempfile.TemporaryDirectory(prefix="ac-series-publish-") as scratch:
        os.mkdir(os.path.join(scratch, "files"))
        series_base.extract(archive, os.path.join(scratch, "files"))
        if gh("release", "view", tag, "-R", args.repo, "--json", "tagName", check=False).returncode:
            gh("release", "create", tag, "-R", args.repo, "--prerelease", "--latest=false", "--title", tag, "--notes",
               f"The series base for Chromium {ident['chromium']} on Helium {ident['helium_chromium'][:12]}: the files "
               "engine/patches/series touches, as step 3 leaves them, for scripts/engine/series-zero-fuzz.py. "
               "Not an app release.")
        assets = json.loads(gh("release", "view", tag, "-R", args.repo, "--json", "assets").stdout)["assets"]
        names = {asset["name"] for asset in assets}
        existing = os.path.join(scratch, "existing")
        os.mkdir(existing)
        uploads = []
        if name in names:
            published = download(tag, args.repo, name, existing)
            manifest = series_base.read_manifest(published)
            if series_base.content_revision(manifest) != series_base.content_revision(series_base.read_manifest(archive)):
                series_base.die(f"{tag} holds a {name} with other files under the same name")
            digest = series_base.sha256_file(published)
            print(f"{name} is already on {tag} with the same files; keeping it")
        else:
            uploads.append(archive)
        for sidecar in sidecars(name, digest, manifest, scratch):
            sidecar_name = os.path.basename(sidecar)
            if sidecar_name not in names:
                uploads.append(sidecar)
            elif pathlib.Path(download(tag, args.repo, sidecar_name, existing)).read_bytes() != \
                    pathlib.Path(sidecar).read_bytes():
                series_base.die(f"{tag}'s {sidecar_name} doesn't describe {name}: delete that sidecar and publish again")
        if uploads:
            gh("release", "upload", tag, "-R", args.repo, *uploads)
    row = dict(ident, tag=tag, asset=name, sha256=digest)
    series_base.write_row(row)
    print(f"https://github.com/{args.repo}/releases/download/{tag}/{name}")
    print(f"wrote its row into {series_base.TABLE.relative_to(series_base.REPO)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    pack = sub.add_parser("pack")
    pack.add_argument("--platform", choices=("linux", "mac"), required=True)
    pack.add_argument("--cpu", choices=("arm64", "x64"))
    pack.add_argument("--base")
    pack.add_argument("--src")
    pack.add_argument("--dest")
    pack.add_argument("--no-verify", action="store_true")
    publish = sub.add_parser("publish")
    publish.add_argument("archive")
    publish.add_argument("--repo", default=os.environ.get("ARDIA_SERIES_BASE_REPO", "ardia-browser/ardia"))
    args = parser.parse_args()
    try:
        {"pack": cmd_pack, "publish": cmd_publish}[args.command](args)
    except series_base.Problem as error:
        series_base.die(str(error), 2)


if __name__ == "__main__":
    main()
