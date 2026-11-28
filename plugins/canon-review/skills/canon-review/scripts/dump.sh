#!/usr/bin/env bash
# canon-review step 2's reading, as ONE file per repo instead of a git call per commit:
# for each listed commit, its header, `--stat`, then the diff capped at 400 lines (with a
# "[truncated: N of M lines]" marker when cut). Binary files show only their stat line, as git
# prints them.
#
#   dump.sh OUTDIR [--cap N]    reads OUTDIR/commits.json, writes OUTDIR/rev/<owner>_<repo>.txt
# Exit: 0 written; 1 unreadable inputs or a commit git can't show; 2 usage.
set -u -o pipefail
case ${1:-} in -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; '' | -*) echo "usage: dump.sh OUTDIR [--cap N]" >&2; exit 2 ;; esac
out=$1 cap=400
if [ $# -eq 3 ] && [ "$2" = --cap ] && [ "$3" -gt 0 ] 2>/dev/null; then cap=$3; elif [ $# -ne 1 ]; then echo "usage: dump.sh OUTDIR [--cap N]" >&2; exit 2; fi
jq -e 'type == "array"' "$out/commits.json" >/dev/null 2>&1 || { echo "dump.sh: no readable $out/commits.json" >&2; exit 1; }
mkdir -p "$out/rev" || exit 1
total=0
while IFS=$'\t' read -r repo dir; do
  f=$out/rev/$(printf '%s' "$repo" | tr '/' '_').txt
  : >"$f"
  while IFS= read -r sha; do
    {
      echo "=== $repo@$sha"
      git -C "$dir" show --stat --format='%s%n%n%b' "$sha" || exit 1
      echo "--- diff"
      git -C "$dir" show --format= "$sha" >"$f.diff" || exit 1
      n=$(grep -c '' "$f.diff")
      head -n "$cap" "$f.diff"
      [ "$n" -le "$cap" ] || echo "[truncated: $cap of $n lines]"
      echo
    } >>"$f" || { echo "dump.sh: cannot show $repo@$sha" >&2; rm -f "$f.diff"; exit 1; }
    total=$((total + 1))
  done < <(jq -r --arg r "$repo" '.[] | select(.repo == $r) | .commits[].sha' "$out/commits.json")
  rm -f "$f.diff"
done < <(jq -r '.[] | select((.commits | length) > 0) | [.repo, .dir] | @tsv' "$out/commits.json")
echo "dump.sh: $total commit(s) into $out/rev/" >&2
