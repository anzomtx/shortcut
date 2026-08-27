#!/bin/bash
# Seek-speed diagnostic — compare two MP4 files, 4 tasks each with progress.
# Usage: drag two MP4 files onto this script in Terminal (or run:
#   ./seek-diagnose.sh "/path/file1.mp4" "/path/file2.mp4")
# Notes: task 3 (keyframe scan) reads the whole file and can take minutes on
#        very long videos; the other tasks are header-only and fast.

if [ "$#" -lt 2 ]; then
  echo "Drag TWO MP4 files onto this script."
  exit 1
fi

A="$1"
B="$2"

for f in "$A" "$B"; do
  if [ ! -f "$f" ]; then
    echo "Not a file: $f"
    exit 1
  fi
done

printf '\nComparing:\n  1) %s\n  2) %s\n\n' "$A" "$B"

analyze() {
  local f="$1"
  echo ">>> $f"

  echo "  [1/4] Reading stream header..."
  local header
  header=$(python3 - "$f" <<'PYEOF'
import json, subprocess, sys
f = sys.argv[1]
out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                      "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,codec_name",
                      "-of", "json", f], capture_output=True, text=True)
try:
    s = json.loads(out.stdout)["streams"][0]
except Exception:
    print("(no video stream)")
    raise SystemExit
w, h = s.get("width","?"), s.get("height","?")
fps = s.get("avg_frame_rate", s.get("r_frame_rate","?"))
frames = s.get("nb_frames","?")
print(f"{w}x{h}, {fps} fps, {frames} frames")
PYEOF
  )
  echo "  [1/4] done -> $header"

  echo "  [2/4] Reading codec profile..."
  local codec
  codec=$(python3 - "$f" <<'PYEOF'
import json, subprocess, sys
f = sys.argv[1]
out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                      "-show_entries", "stream=codec_name,profile,level",
                      "-of", "json", f], capture_output=True, text=True)
try:
    s = json.loads(out.stdout)["streams"][0]
except Exception:
    print("(n/a)")
    raise SystemExit
print(f"{s.get('codec_name','?')} ({s.get('profile','?')}, level {s.get('level','?')})")
PYEOF
  )
  echo "  [2/4] done -> $codec"

  echo "  [3/4] Scanning keyframes (may take a while on long videos)..."
  local gaps
  gaps=$(python3 - "$f" <<'PYEOF'
import json, subprocess, sys
f = sys.argv[1]
out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                      "-skip_frame", "nokey", "-show_frames",
                      "-show_entries", "frame=best_effort_timestamp_time",
                      "-of", "json", f], capture_output=True, text=True)
try:
    frames = json.loads(out.stdout).get("frames", [])
except Exception:
    print("(no keyframe data)")
    raise SystemExit
ts = [float(x["best_effort_timestamp_time"]) for x in frames if x.get("best_effort_timestamp_time") is not None]
gaps = [round(ts[i+1]-ts[i], 2) for i in range(len(ts)-1)]
if gaps:
    longest = max(gaps)
    short = sum(1 for g in gaps if g <= 1.2)
    print(f"{len(ts)} keyframes; {short}/{len(gaps)} gaps <=1.2s; longest {longest}s")
else:
    print("no keyframes found")
PYEOF
  )
  echo "  [3/4] done -> $gaps"

  echo "  [4/4] Locating moov atom..."
  local moov
  moov=$(python3 - "$f" <<'PYEOF'
import struct, sys
f = sys.argv[1]
pos, total = 0, 0
try:
    with open(f, "rb") as fh:
        fh.seek(0, 2); total = fh.tell(); fh.seek(0)
        while pos + 8 <= total:
            fh.seek(pos); hdr = fh.read(8)
            sz = struct.unpack(">I", hdr[:4])[0]
            typ = hdr[4:8]
            if sz == 1:
                fh.seek(pos+8); sz = struct.unpack(">Q", fh.read(8))[0]
            if typ == b"moov":
                pct = pos/total*100
                print(f"moov at {pct:.1f}% ({'fast-start' if pct < 10 else 'at END -> slow first seek'})")
                break
            if sz == 0: break
            pos += sz
except OSError:
    pass
if not total:
    print("(cannot read file)")
PYEOF
  )
  echo "  [4/4] done -> $moov"
  echo ""
}

analyze "$A"
analyze "$B"
echo "Verdict: task 3 (keyframe gaps) is the main seek factor. Short gaps (~1s) = fast seeking."
echo "Longest-gap file decodes that many seconds of frames after each seek, so it feels slow."