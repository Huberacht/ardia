#!/usr/bin/env python3
"""Runs step 3 (engine/patches/build/03-helium.py, every argument passed through) and records what it read.

  run-step3.py --apply [03-helium.py arguments]

series-base-pack.py packs only a base whose tree step 3 ran on through this script. Next to the stage marker
03-helium.py keeps (<tree's parent>/.helium-stages-<tree name>), it writes .ardia-step3-<tree name>.json: the tree's
inode, the platform, and the digest of every repo file step 3 reads (series_base.step3_digest).
- The first run on a fresh tree, with no mutating stage done yet, records that digest as running.
- A later run on that tree (--only, --from) must find the same digest, or it stops before step 3 starts.
- The run that finishes the last stage checks the digest again and records it as complete, with the stage marker's
  sha256 and the time.

A tree whose step 3 started without this script can't be stamped: start again from a fresh tree.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import series_base  # noqa: E402

sys.path.insert(0, str(series_base.BUILD))
from target_config import configuration  # noqa: E402


stamp_path = series_base.step3_stamp
marker_path = series_base.stage_marker


def marker_stages(tree):
    marker = marker_path(tree)
    if not marker.is_file():
        return set()
    tokens = marker.read_text().split()
    if tokens[:1] != [f"tree-inode={os.stat(tree).st_ino}"]:
        return set()
    return set(tokens[1:])


def read_stamp(tree):
    path = stamp_path(tree)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except ValueError as error:
        raise series_base.Problem(f"{path} is unreadable: {error}")


def write_stamp(tree, record):
    path = stamp_path(tree)
    partial = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    partial.write_text(json.dumps(record, indent=1, sort_keys=True) + "\n")
    os.replace(partial, path)


def begin(tree, platform, digest):
    done = marker_stages(tree) & set(series_base.STEP3_STAGES)
    stamp = read_stamp(tree)
    inode = os.stat(tree).st_ino
    if not done:
        write_stamp(tree, {"state": "running", "tree_inode": inode, "platform": platform, "inputs": digest})
        return
    if not stamp or stamp.get("tree_inode") != inode or stamp.get("platform") != platform:
        raise series_base.Problem(f"step 3 already ran stages {sorted(done)} on {tree} without run-step3.py, so what "
                                  "it read is unknown: start again from a fresh tree")
    if stamp.get("inputs") != digest:
        raise series_base.Problem(f"step 3 began on {tree} with inputs {stamp.get('inputs', '')[:12]}, and this "
                                  f"checkout's are {digest[:12]}: finish it from the checkout it began with, or start "
                                  "again from a fresh tree")


def finish(tree, platform, digest_before, digest_after):
    stamp = read_stamp(tree) or {}
    if digest_after != digest_before:
        write_stamp(tree, dict(stamp, state="invalid"))
        raise series_base.Problem("step 3's inputs changed while it ran: start again from a fresh tree")
    stages = marker_stages(tree)
    if not set(series_base.STEP3_STAGES) <= stages or f"platform={platform}" not in stages:
        return False
    marker = marker_path(tree)
    write_stamp(tree, {"state": "complete", "tree_inode": os.stat(tree).st_ino, "platform": platform,
                       "inputs": digest_before, "marker_sha256": hashlib.sha256(marker.read_bytes()).hexdigest(),
                       "recorded_at": time.time()})
    return True


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--tree")
    parser.add_argument("--platform", choices=("mac", "linux"))
    parser.add_argument("--cpu", choices=("arm64", "x64"))
    parser.add_argument("-h", "--help", action="store_true")
    known, _ = parser.parse_known_args()
    if known.help:
        print(__doc__)
        return 0
    platform = configuration(known.platform, known.cpu)["AC_TARGET_OS"]
    build = os.environ.get("AC_CHROMIUM_BUILD") or os.path.expanduser("~/chromium-build")
    tree = os.path.realpath(known.tree or os.environ.get("CHROMIUM_SRC") or
                            os.path.join(build, "chromium_git/chromium/src"))
    try:
        digest = series_base.step3_digest()
        begin(tree, platform, digest)
        result = subprocess.run([sys.executable, str(series_base.BUILD / "03-helium.py"), *sys.argv[1:]])
        if result.returncode:
            return result.returncode
        if finish(tree, platform, digest, series_base.step3_digest()):
            print(f"run-step3: recorded step 3's inputs {digest[:12]} in {stamp_path(tree)}")
    except series_base.Problem as error:
        series_base.die(str(error), 2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
