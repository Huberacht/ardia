#!/bin/bash
set -euo pipefail
V=$(cd "$(dirname "$0")/../.." && pwd)
SRC=${1:-$HOME/ardia-scratch/fold3660-work/film-final/after.mp4}
O=$V/public/footage/overnight-wave
mkdir -p "$O"
ffmpeg -v error -y -ss 1 -i "$SRC" -frames:v 1 -vf "crop=380:1110:0:296" "$O/sidebar.png"
echo "$O/sidebar.png"
