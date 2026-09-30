# android-phone

Operate a **physical** Android device over ADB from a Mac — wired or wireless: pair, connect,
bootstrap USB→TCP/IP, and mirror with scrcpy.

Always go through the `android-phone` wrapper rather than raw `adb`/`scrcpy`. It encodes several
live-diagnosed adb footguns that raw adb makes you re-learn every session.

## Command surface

| Command | What it does |
|---|---|
| `list` | Three labelled sections — USB, connected wireless, mDNS-discoverable — each row carrying the exact next command |
| `pair <ip:port> [code]` | Pair using the code from *Settings → Wireless debugging → Pair device with pairing code* |
| `connect [ip:port]` | Connect an already-paired device; with no argument it resolves the sole mDNS-advertised one |
| `tcpip [serial] [port]` | USB device → TCP/IP mode and connect, **no** mirror — for `adb shell` / install work |
| `wireless [serial]` | USB → wireless bootstrap **and** mirroring in one step |
| `mirror [serial] [-- args…]` | Start scrcpy; pass-through args after `--` |
| `doctor` | Tool paths, `adb mdns check`, then the full `list` — **run this first when anything misbehaves** |

## The footguns it absorbs

- **Pairing port ≠ connect port.** They are different ports advertised as distinct mDNS service
  types (`_adb-tls-pairing._tcp` vs `_adb-tls-connect._tcp`). Using one for the other fails
  confusingly.
- **The connect port changes** on Wi-Fi reconnect or reboot, so a hardcoded `ip:port` rots.
  `connect` with no argument re-resolves every time.
- **adb keeps its own mDNS cache, separate from macOS's.** `dns-sd -B` can see the phone while
  `adb mdns services` reports nothing. The wrapper retries through an adb server restart; if it
  still shows nothing, the honest causes are Wireless debugging off or a different Wi-Fi network
  — not a local mDNS block.
- **There is no scriptable unpair.** Trust is revoked only on the device. `unpair` gets the user
  to that screen; no adb flag exists, so do not hunt for one.
- **One phone can list twice** (ip:port serial plus raw mDNS instance = two transports). Expect
  duplicates if you parse `adb devices -l` yourself.

## Scope

This gets a device *connected*. Driving app UIs — tap, type, screenshot inside apps — is the
gateway's `mobile-mcp` server, afterwards. The virtual emulator is a different tool entirely.

## Requires

The `android-phone` CLI on `PATH` (packaged in
[`kattakath/nix-config`](https://github.com/kattakath/nix-config) as `packages/android-phone.nix`),
plus Homebrew's `android-platform-tools` and `scrcpy`, which the wrapper resolves dynamically.
