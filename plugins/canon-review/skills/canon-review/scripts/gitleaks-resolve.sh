# GENERATED from plugins/ci-watch/scripts/gitleaks-resolve.sh by scripts/build-index.py; edit that file, not this one.
# gitleaks-resolve.sh: the ONE gitleaks resolver, sourced (not run) by ci-watch's ci-land and
# canon-review's scan.sh. canon-review ships a GENERATED copy (plugins install as separate
# subtrees, so one can't source the other's file); scripts/build-index.py writes it from this
# file and its --check fails CI if the copy drifts. Edit THIS file, then rerun build-index.py.
#
#   . gitleaks-resolve.sh; gl_resolve BINDIR || <refuse>; gl git --exit-code 42 ...
# Resolution order: gitleaks on PATH (the host's own, pinned by whatever installed it), else the
# release pinned below, downloaded into BINDIR and verified by sha256. GL_SRC says which ran.
# No `nix run nixpkgs#gitleaks` fallback: that follows whatever nixpkgs the registry serves,
# the floating pin canon-review flagged in ci-land (2026-11-28).
# shellcheck shell=bash disable=SC2034 # GL_SRC and GL_BIN are read by the scripts that source this

GL_VERSION=8.30.1 # bump with its three sums, from the release's gitleaks_<v>_checksums.txt
GL_SRC=

gl_sum() {
  case $1 in
    linux_x64) echo 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
    linux_arm64) echo e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
    darwin_arm64) echo b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  esac
}

gl_sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

gl_fetch() { # BINDIR -> prints the verified binary's path, or fails
  local os arch plat want tgz bin=$1/gitleaks
  [ -x "$bin" ] && { echo "$bin"; return 0; }
  os=$(uname -s | tr '[:upper:]' '[:lower:]') arch=$(uname -m)
  case $arch in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; esac
  plat=${os}_$arch
  want=$(gl_sum "$plat")
  [ -n "$want" ] || return 1
  mkdir -p "$1" || return 1
  tgz=$1/gitleaks.tgz
  curl -fsSL -o "$tgz" "https://github.com/gitleaks/gitleaks/releases/download/v$GL_VERSION/gitleaks_${GL_VERSION}_$plat.tar.gz" || return 1
  [ "$(gl_sha256 "$tgz")" = "$want" ] || { echo "gitleaks-resolve: the download failed its sha256 check" >&2; rm -f "$tgz"; return 1; }
  tar -xzf "$tgz" -C "$1" gitleaks && rm -f "$tgz" && echo "$bin"
}

gl_resolve() { # BINDIR -> defines gl() and sets GL_SRC, or returns 1
  local bin
  if command -v gitleaks >/dev/null 2>&1; then
    gl() { gitleaks "$@"; }
    GL_SRC=gitleaks
  elif bin=$(gl_fetch "$1"); then
    GL_BIN=$bin
    gl() { "$GL_BIN" "$@"; }
    GL_SRC="gitleaks $GL_VERSION (pinned download)"
  else
    return 1
  fi
}
