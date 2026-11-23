#!/usr/bin/env python3
"""Runs `series.py capture-base` (every argument passed through unchanged) and records what it captured.

  run-capture.py [--platform linux|mac] [--cpu arm64|x64] [--force]

Run it after run-step3.py and before step 4 (04-series.sh runs capture-base again, which then adds nothing). It deletes
the base's record (<base>/.ardia-capture.json) first. It needs a complete step-3 stamp for the tree, and a base that is
either new or exactly what an earlier record listed: a file put there by hand stops it. After capture-base exits 0, it
writes a new record: the step-3 stamp's sha256 and the sha256 of every file in the base. The child's exit code and
output pass through unchanged. series-base-pack.py packs only a base whose files and stamp match its record exactly.
Tree and base come from CHROMIUM_SRC, AC_SERIES_BASE and AC_CHROMIUM_BUILD, as for series.py.
"""

import json
import os
import pathlib
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import series_base  # noqa: E402

sys.path.insert(0, str(series_base.BUILD))
from target_config import configuration  # noqa: E402


def option(argv, name):
    for index, token in enumerate(argv):
        if token == name and index + 1 < len(argv):
            return argv[index + 1]
        if token.startswith(name + "="):
            return token.split("=", 1)[1]
    return None


def complete_stamp(src):
    stamp = series_base.step3_stamp(src)
    if not stamp.is_file():
        return None
    try:
        record = json.loads(stamp.read_text())
    except ValueError:
        return None
    return stamp if record.get("state") == "complete" else None


def earlier_files(record, stamp_sha):
    if not record.is_file():
        return {}
    try:
        earlier = json.loads(record.read_text())
    except ValueError:
        return {}
    return earlier.get("files", {}) if earlier.get("step3_stamp_sha256") == stamp_sha else {}


def write_record(base, stamp_sha, files):
    path = os.path.join(base, series_base.CAPTURE_RECORD)
    partial = f"{path}.{os.getpid()}.tmp"
    with open(partial, "w", encoding="utf-8") as handle:
        handle.write(json.dumps({"step3_stamp_sha256": stamp_sha, "files": files}, indent=1, sort_keys=True) + "\n")
    os.replace(partial, path)


def run(argv, series=None):
    try:
        target = configuration(option(argv, "--platform"), option(argv, "--cpu"))
    except ValueError as error:
        series_base.die(str(error), 2)
    src = os.path.realpath(series_base.default_src())
    base = series_base.default_base(target["AC_TARGET_OS"], target["AC_TARGET_CPU"])
    stamp = complete_stamp(src)
    if stamp is None:
        series_base.die(f"no complete step-3 stamp for {src}: run step 3 through scripts/engine/run-step3.py on a fresh "
                        "tree first", 2)
    stamp_sha = series_base.sha256_file(stamp)
    record = pathlib.Path(base, series_base.CAPTURE_RECORD)
    present = series_base.base_file_hashes(base) if os.path.isdir(base) else {}
    earlier = earlier_files(record, stamp_sha)
    record.unlink(missing_ok=True)
    if any(earlier.get(path) != digest for path, digest in present.items()):
        series_base.die(f"{base} holds files no capture after this step 3 recorded: set it aside and run run-capture.py "
                        "again on a fresh base", 2)
    code = subprocess.run([sys.executable, str(series or series_base.REPO / "engine/patches/series.py"), "capture-base",
                           *argv]).returncode
    if code:
        return code
    if series_base.sha256_file(stamp) != stamp_sha:
        series_base.die(f"{stamp} changed while capture-base ran: run step 3 again on a fresh tree", 2)
    write_record(base, stamp_sha, series_base.base_file_hashes(base))
    print(f"run-capture: recorded {base}/{series_base.CAPTURE_RECORD}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] in (["-h"], ["--help"]):
        print(__doc__)
        sys.exit(0)
    sys.exit(run(sys.argv[1:]))
