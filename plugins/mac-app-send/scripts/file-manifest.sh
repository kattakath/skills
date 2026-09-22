#!/usr/bin/env bash
# Deterministic facts about files about to be sent — and the same facts to check
# a sent message against. Chat apps show "<pages> pages · <KB> KB" on a sent
# document; matching that to disk is the only real proof the right file went.
# A thumbnail is not proof, and the preview carousel can label one file while
# showing another.
#
# Usage:  file-manifest.sh FILE [FILE...]
set -uo pipefail

# GNU coreutils shadows BSD `stat` on this fleet's PATH and has no -f.
STAT=/usr/bin/stat

if [ "$#" -eq 0 ]; then
  echo "usage: file-manifest.sh FILE [FILE...]" >&2
  exit 64
fi

missing=0
total=0

printf '%-46s %12s %10s %7s  %s\n' "FILE" "BYTES" "SHOWS AS" "PAGES" "TYPE"
for f in "$@"; do
  if [ ! -f "$f" ]; then
    printf '%-46s %12s %10s %7s  %s\n' "$(basename "$f")" "-" "-" "-" "MISSING"
    missing=1
    continue
  fi
  bytes=$($STAT -f %z "$f")
  total=$((total + bytes))
  # Chat apps round to whole KB on the 1000-byte scale.
  kb=$(( (bytes + 500) / 1000 ))
  pages=$(mdls -name kMDItemNumberOfPages -raw "$f" 2>/dev/null)
  [ "$pages" = "(null)" ] || [ -z "$pages" ] && pages="-"
  type=$(mdls -name kMDItemContentType -raw "$f" 2>/dev/null)
  [ "$type" = "(null)" ] && type="-"
  printf '%-46s %12s %9sKB %7s  %s\n' \
    "$(basename "$f")" "$bytes" "$kb" "$pages" "$type"
done

echo
echo "total: ${total} bytes across $# file(s)"
[ "$total" -gt 10485760 ] && echo "WARNING: over 10 MB — some upload paths cap there."
[ "$missing" -eq 1 ] && exit 1
exit 0
