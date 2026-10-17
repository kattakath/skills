#!/usr/bin/env bash
# Functional cases for skills/pgp-ops/scripts/gpg-in-window.zsh, run WITHOUT a tty
# (the agent's-own-shell route) against throwaway GnuPG homes with passphrase-less
# keys. The clipboard is a file: pbcopy / pbpaste / pb-conceal are stand-ins on PATH,
# so the real pasteboard is never touched.
#
# What is asserted, because each one shipped broken or was measured once:
#   - decrypt from a file and from the clipboard ("-"), all three modes, byte-exact
#   - a binary .gpg file still streams (a shell variable cannot hold NUL bytes)
#   - decrypted text goes through pb-conceal WITH --clear, and the status says so;
#     PGP_CLEAR=0 drops --clear; with no pb-conceal the status says concealed=NO
#   - encrypt-for: recipient AND sender both decrypt it; unsigned by default; `sign`
#     adds exactly one Good signature; a missing key file and an ambiguous sender
#     refuse with the clipboard untouched
#   - no plaintext ever lands in a .status or .diag file
set -uo pipefail
command -v gpg >/dev/null || { echo "SKIP: gpg not installed"; exit 0; }
command -v zsh >/dev/null || { echo "FAIL: zsh not installed"; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
SCR="$here/../skills/pgp-ops/scripts/gpg-in-window.zsh"
[ -f "$SCR" ] || { echo "FAIL: script not found at $SCR"; exit 1; }

T=$(mktemp -d "${TMPDIR:-/tmp}/pgpops.XXXX")
SELF="$T/s" RCP="$T/r"
mkdir -m700 "$SELF" "$RCP"
cleanup() { GNUPGHOME="$SELF" gpgconf --kill all 2>/dev/null; GNUPGHOME="$RCP" gpgconf --kill all 2>/dev/null; }
trap cleanup EXIT
fail=0
ok() { printf 'ok   %s\n' "$1"; }
no() { printf 'FAIL %s\n' "$1"; fail=1; }
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

mk() { # <home> <uid> -> fingerprint (passphrase-less ed25519 + cv25519)
  GNUPGHOME=$1 gpg --batch --passphrase '' --quick-generate-key "$2" ed25519 sign,cert never 2>/dev/null
  local f; f=$(GNUPGHOME=$1 gpg --with-colons -K | grep -m1 '^fpr:' | cut -d: -f10)
  GNUPGHOME=$1 gpg --batch --passphrase '' --quick-add-key "$f" cv25519 encr never 2>/dev/null
  echo "$f"
}
FS=$(mk "$SELF" 'Self <s@example.invalid>')
FR=$(mk "$RCP" 'Rcpt <r@example.invalid>')
GNUPGHOME=$RCP gpg --armor --export "$FR" >"$T/rcpt.asc"
GNUPGHOME=$SELF gpg --armor --export "$FS" | GNUPGHOME=$RCP gpg --batch --import 2>/dev/null

# Clipboard stand-ins. pb-conceal records its argv so --clear can be asserted.
mkdir "$T/bin" "$T/bin-nopbc"
for d in bin bin-nopbc; do
  printf '#!/bin/sh\ncat > "%s/clip"\n' "$T" >"$T/$d/pbcopy"
  printf '#!/bin/sh\ncat "%s/clip"\n' "$T" >"$T/$d/pbpaste"
done
printf '#!/bin/sh\nprintf "%%s\\n" "$*" > "%s/pbc.args"\ncat > "%s/clip"\necho "pb-conceal: stand-in"\n' "$T" "$T" >"$T/bin/pb-conceal"
chmod +x "$T"/bin/* "$T"/bin-nopbc/*
# zsh is run by ABSOLUTE path and its directory is NOT on PATH: on a Nix/Home Manager
# Mac it shares a profile bin/ with the REAL pb-conceal, and putting that dir on PATH
# let the "no pb-conceal" case write test text to the real pasteboard (2026-10-17).
ZSH=$(command -v zsh)
sysp=$(dirname "$(command -v gpg)"):/usr/bin:/bin
for d in bin bin-nopbc; do
  got=$(PATH="$T/$d:$sysp" command -v pb-conceal || true)
  want=""; [ "$d" = bin ] && want="$T/bin/pb-conceal"
  [ "$got" = "$want" ] || { echo "FAIL: test PATH ($d) reaches a real pb-conceal: $got"; exit 1; }
  for real in pbcopy pbpaste; do
    [ "$(PATH="$T/$d:$sysp" command -v $real)" = "$T/$d/$real" ] || { echo "FAIL: $real is not the stand-in"; exit 1; }
  done
done

run() { GNUPGHOME=$SELF PATH="$T/bin:$sysp" "$ZSH" "$SCR" "$@" </dev/null >/dev/null 2>&1; }
run_nopbc() { GNUPGHOME=$SELF PATH="$T/bin-nopbc:$sysp" "$ZSH" "$SCR" "$@" </dev/null >/dev/null 2>&1; }
h() { shasum -a 256 | cut -c1-16; }

P=$(printf 'alpha-1\tbeta gamma\nsecond line')
HP=$(printf '%s\n' "$P" | h)
to_self() { printf '%s\n' "$P" | GNUPGHOME=$SELF gpg --batch -a -e -r "$FS" 2>/dev/null; }

echo "-- decrypt"
to_self >"$T/m.asc"
run all "$T/m.asc"
check "file -> all: byte-exact" '[ "$(h <"$T/clip")" = "$HP" ]'
check "file -> all: status concealed, clears in 90s" 'grep -q "concealed=yes clears-in=90s" "$T/m.asc.status"'
check "pb-conceal got --clear 90" 'grep -qx -- "--clear 90" "$T/pbc.args"'
to_self >"$T/clip"; run all - "$T/c1"
check "clipboard -> all: byte-exact" '[ "$(h <"$T/clip")" = "$HP" ]'
to_self >"$T/clip"; run first-word - "$T/c2"
check "clipboard -> first-word = alpha-1" '[ "$(cat "$T/clip")" = "alpha-1" ]'
to_self >"$T/clip"; run before-space - "$T/c3"
check "clipboard -> before-space stops at the space, keeps the tab" '[ "$(cat "$T/clip")" = "$(printf "alpha-1\tbeta")" ]'
printf '%s\n' "$P" | GNUPGHOME=$SELF gpg --batch -e -r "$FS" >"$T/bin.gpg" 2>/dev/null
run all "$T/bin.gpg"
check "binary .gpg file -> all: byte-exact" '[ "$(h <"$T/clip")" = "$HP" ]'
to_self >"$T/clip"; PGP_CLEAR=0 run all - "$T/c4"
check "PGP_CLEAR=0: no --clear, status clears-in=never" '! grep -q -- "--clear" "$T/pbc.args" && grep -q "clears-in=never" "$T/c4.status"'
to_self >"$T/clip"; run_nopbc all - "$T/c5"
check "no pb-conceal: still decrypts, status says concealed=NO" '[ "$(h <"$T/clip")" = "$HP" ] && grep -q "concealed=NO" "$T/c5.status"'
check "'-' without a prefix refuses (exit 64)" 'GNUPGHOME=$SELF PATH="$T/bin:$sysp" "$ZSH" "$SCR" all - </dev/null >/dev/null 2>&1; [ $? -eq 64 ]'

echo "-- encrypt-for"
printf 'Meet at 7.\n' >"$T/clip"; HM=$(h <"$T/clip")
run encrypt-for "$T/rcpt.asc" "$T/e1"
check "unsigned: OK, self-recipient=yes, signed=no" 'grep -q "^OK .*self-recipient=yes signed=no" "$T/e1.status"'
check "unsigned: recipient decrypts byte-exact" '[ "$(GNUPGHOME=$RCP gpg -d <"$T/clip" 2>/dev/null | h)" = "$HM" ]'
check "unsigned: sender decrypts byte-exact" '[ "$(GNUPGHOME=$SELF gpg -d <"$T/clip" 2>/dev/null | h)" = "$HM" ]'
check "unsigned: no signature" '! GNUPGHOME=$RCP gpg -d <"$T/clip" 2>&1 >/dev/null | grep -q "signature"'
printf 'Meet at 7.\n' >"$T/clip"
run encrypt-for "$T/rcpt.asc" "$T/e2" sign
check "sign: OK signed=yes" 'grep -q "^OK .*signed=yes" "$T/e2.status"'
check "sign: recipient sees one Good signature" '[ "$(GNUPGHOME=$RCP gpg -d <"$T/clip" 2>&1 >/dev/null | grep -c "Good signature")" = 1 ]'
printf 'untouched\n' >"$T/clip"; run encrypt-for "$T/missing.asc" "$T/e3"
check "missing key file: FAILED, clipboard untouched" 'grep -q "^FAILED" "$T/e3.status" && [ "$(cat "$T/clip")" = untouched ]'
GNUPGHOME=$SELF gpg --batch --passphrase '' --quick-generate-key 'Two <t@example.invalid>' ed25519 sign,cert never 2>/dev/null
printf 'untouched\n' >"$T/clip"; run encrypt-for "$T/rcpt.asc" "$T/e4"
check "two secret keys, no PGP_SELF: FAILED, clipboard untouched" 'grep -q "set-PGP_SELF" "$T/e4.status" && [ "$(cat "$T/clip")" = untouched ]'

echo "-- no plaintext in any status/diag file"
check "0 hits" '! cat "$T"/*.status "$T"/*.diag 2>/dev/null | grep -qE "alpha|beta|second line|Meet at"'

exit $fail
