#!/bin/bash
# The stable release's perf gate, start to finish, under one perflab lock (docs/perf/README.md › Gating a release).
#
#   apps/browser/scripts/perf/gate.sh <version> <previous> [--out <dir>] [--port <n>] [--control-bundle <file>]
#
# The candidate is dist/<version>-rc/export/Ardia.app, the control dist/<previous>/export/Ardia.app. It takes the perflab
# lock for the whole run, and stops at once with the lock's status when it can't get it. Then:
#   1. side by side: smoke.sh <version> <previous> --rc, ratchet.mjs run --own, native-bench --only prepare
#      (logs in <out>/smoke.log, ratchet.log, prep.log)
#   2. two native-bench rounds (launch x6, session x2, windows x2), each in a new folder under <out>
#   3. gate-verdict.mjs on both rounds
#   4. on a pass, keeps the candidate's bench bundle as dist/<version>/bench/main.jsbundle: the next gate's control bundle
# Exit: the first failing step's status (smoke, ratchet, prepare, then the rounds in order), else the verdict's: 0 pass,
# 1 a row fails, 2 a round is invalid; 70 when it passed but the bundle couldn't be kept. Any exit, ^C or timeout stops the jobs it started and waits for them; the lock
# is held by this process, so it goes with it.
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=${GATE_ROOT:-$(cd "$here/../../../.." && pwd)}
perf=${GATE_PERF:-$here}
smoke=${GATE_SMOKE:-$root/.claude/skills/release/scripts/smoke.sh}

help() { sed -n '2,/^set -u/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
case ${1:-} in -h | --help) help; exit 0 ;; esac
[ $# -ge 2 ] || { help >&2; exit 64; }
version=$1 previous=$2
shift 2
out=$HOME/ardia-scratch/gate-$version port=9478 control_bundle=$root/dist/$previous/bench/main.jsbundle
while [ $# -gt 0 ]; do
  case $1 in
    --out) out=$2; shift 2 ;;
    --port) port=$2; shift 2 ;;
    --control-bundle) control_bundle=$2; shift 2 ;;
    *) echo "gate.sh: unknown option $1 (--help)" >&2; exit 64 ;;
  esac
done

if [ -z "${GATE_LOCKED:-}" ]; then
  exec "$root/scripts/agent/locked" perflab --wait "${GATE_LOCK_WAIT:-3600}" -- env GATE_LOCKED=1 "$0" "$version" "$previous" --out "$out" --port "$port" --control-bundle "$control_bundle"
fi

jobs_started=()
stop_jobs() {
  for pid in "${jobs_started[@]:-}"; do [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null; done
  for pid in "${jobs_started[@]:-}"; do [ -n "$pid" ] && wait "$pid" 2>/dev/null; done
}
trap stop_jobs EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

awake=()
command -v caffeinate >/dev/null && awake=(caffeinate -d -i)
candidate=$root/dist/$version-rc/export/Ardia.app control=$root/dist/$previous/export/Ardia.app
mkdir -p "$out" || exit 1

timeout "${GATE_PREP_TIMEOUT:-3600}" "$smoke" "$version" "$previous" --rc > "$out/smoke.log" 2>&1 &
smoke_pid=$!
timeout "${GATE_PREP_TIMEOUT:-3600}" node "$perf/ratchet.mjs" run --own --app "$candidate" > "$out/ratchet.log" 2>&1 &
ratchet_pid=$!
timeout "${GATE_PREP_TIMEOUT:-3600}" node "$perf/native-bench.mjs" --out "$out/prep" --port "$port" --only prepare \
  --app "$candidate" --label rc --control "$control" --control-label "$previous" --control-bundle "$control_bundle" > "$out/prep.log" 2>&1 &
prep_pid=$!
jobs_started=("$smoke_pid" "$ratchet_pid" "$prep_pid")
wait "$smoke_pid"; smoke_status=$?
wait "$ratchet_pid"; ratchet_status=$?
wait "$prep_pid"; prep_status=$?
jobs_started=()
echo "gate: smoke $smoke_status, ratchet $ratchet_status, prepare $prep_status"
for status in "$smoke_status" "$ratchet_status" "$prep_status"; do [ "$status" = 0 ] || exit "$status"; done

rounds=()
for r in 1 2; do
  dir=$(mktemp -d "$out/round$r.XXXXXX") || exit 1
  timeout "${GATE_ROUND_TIMEOUT:-3600}" ${awake[@]+"${awake[@]}"} node "$perf/native-bench.mjs" --out "$dir" --port "$port" --prepared \
    --app "$out/prep/rc/app/Ardia.app" --label rc --control "$out/prep/$previous/app/Ardia.app" --control-label "$previous" \
    --only launch,session,windows --launch-runs 6 --runs 2 > "$dir.log" 2>&1 &
  jobs_started=("$!")
  wait "$!"; status=$?
  jobs_started=()
  echo "gate: round $r exited $status ($dir)"
  [ "$status" = 0 ] || exit "$status"
  rounds+=("$dir")
done

node "$perf/gate-verdict.mjs" --control "$previous" --candidate rc "${rounds[@]}"
verdict=$?
if [ "$verdict" = 0 ]; then
  kept=$root/dist/$version/bench/main.jsbundle
  mkdir -p "$(dirname "$kept")" && cp "$out/prep/rc/bundle/main.jsbundle" "$kept" || { echo "gate: passed, but couldn't keep the bench bundle as $kept"; exit 70; }
  echo "gate: kept the bench bundle as $kept (the next gate's control bundle)"
fi
exit "$verdict"
