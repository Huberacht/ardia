#!/usr/bin/env python3
"""Runs step 3 (engine/patches/build/03-helium.py, every argument passed through unchanged) and stamps a full run.

  run-step3.py --apply [--platform linux|mac] [--tree DIR] [other 03-helium.py arguments]

It deletes the tree's stamp (<tree's parent>/.ardia-step3-<tree name>.json) first, then runs 03-helium.py. The child's
exit code and output pass through unchanged. It writes a new stamp only when all of these hold:
- that one run started on a tree no step-3 stage had touched;
- the run finished every stage and exited 0;
- it used only arguments that don't narrow or change step 3 (no --only, --from or --no-brand);
- the step-3 input digest (series_base.step3_digest) was the same before and after.

The stamp holds the tree's inode, the platform, the digest, the stage marker's sha256 and an id of its own, so a capture
recorded against one run never matches another. Any other run leaves no
stamp, and series-base-pack.py packs only from a stamped tree.
"""

import hashlib
import json
import os
import subprocess
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import series_base  # noqa: E402

sys.path.insert(0, str(series_base.BUILD))
from target_config import configuration  # noqa: E402

PLAIN_OPTIONS = {"--apply", "--tree", "--helium", "--platform", "--cpu", "--helium-linux", "--helium-macos",
                 "--domsub-cache", "--work", "--report", "--guard-extra"}
VALUED = PLAIN_OPTIONS - {"--apply"}


def plain_arguments(argv):
    values = {}
    index = 0
    while index < len(argv):
        token = argv[index]
        name, has_value, value = token.partition("=")
        if name not in PLAIN_OPTIONS:
            return None
        if name in VALUED and not has_value:
            if index + 1 >= len(argv):
                return None
            index += 1
            value = argv[index]
        values[name] = value
        index += 1
    return values


def stages_done(tree):
    marker = series_base.stage_marker(tree)
    if not os.path.isdir(tree) or not marker.is_file():
        return set()
    tokens = marker.read_text().split()
    if tokens[:1] != [f"tree-inode={os.stat(tree).st_ino}"]:
        return set()
    return set(tokens[1:])


def write_stamp(tree, platform, digest):
    path = series_base.step3_stamp(tree)
    record = {"state": "complete", "tree_inode": os.stat(tree).st_ino, "platform": platform, "inputs": digest,
              "marker_sha256": hashlib.sha256(series_base.stage_marker(tree).read_bytes()).hexdigest(),
              "run": uuid.uuid4().hex}
    partial = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    partial.write_text(json.dumps(record, indent=1, sort_keys=True) + "\n")
    os.replace(partial, path)


def stampable(before, after, platform, digest_before, digest_after, arguments):
    mutating = set(series_base.STEP3_STAGES)
    return (arguments is not None and not (before & mutating) and mutating <= after and
            f"platform={platform}" in after and digest_before == digest_after)


def run(argv, helium=None):
    arguments = plain_arguments(argv)
    values = arguments or {}
    try:
        platform = configuration(values.get("--platform"), values.get("--cpu"))["AC_TARGET_OS"]
    except ValueError:
        platform = None
    build = os.environ.get("AC_CHROMIUM_BUILD") or os.path.expanduser("~/chromium-build")
    tree = os.path.realpath(values.get("--tree") or os.environ.get("CHROMIUM_SRC") or
                            os.path.join(build, "chromium_git/chromium/src"))
    series_base.step3_stamp(tree).unlink(missing_ok=True)
    try:
        digest_before = series_base.step3_digest()
    except series_base.Problem:
        digest_before = None
    before = stages_done(tree)
    code = subprocess.run([sys.executable, str(helium or series_base.BUILD / "03-helium.py"), *argv]).returncode
    if code:
        return code
    try:
        digest_after = series_base.step3_digest()
    except series_base.Problem:
        digest_after = None
    if platform and digest_before and stampable(before, stages_done(tree), platform, digest_before, digest_after,
                                                arguments):
        write_stamp(tree, platform, digest_before)
        print(f"run-step3: stamped {series_base.step3_stamp(tree)} (inputs {digest_before[:12]})", file=sys.stderr)
    else:
        print(f"run-step3: no stamp: only one full run on a fresh tree with plain arguments is stamped, so "
              f"series-base-pack.py won't pack {tree}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] in (["-h"], ["--help"]):
        print(__doc__)
        sys.exit(0)
    sys.exit(run(sys.argv[1:]))
