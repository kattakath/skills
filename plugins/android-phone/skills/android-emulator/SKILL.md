---
name: android-emulator
description: >-
  Unlock, and set up biometric unlock on, an Android Emulator AVD (Android Virtual Device)
  driven over adb from a Mac. Use when the user says "unlock the emulator", "the swipe is
  too sensitive", "hard to get to the PIN page", "does the emulator fingerprint work",
  "Touch Sensor says fingerprint not recognized", "enroll a fingerprint on the emulator",
  "does my Mac's Touch ID work in the emulator", or the emulator keeps asking for its PIN.
  Covers the GUI-vs-adb finger-ID mismatch, headless enrollment without leaking the PIN,
  and the lockout and strong-auth rules. NOT for a physical phone (that is the sibling
  `android-phone` skill).
---

# Android Emulator — unlock without the swipe

A screen-locked AVD can be unlocked three ways, and none of them needs the swipe-up gesture.
Fingerprint is the cheapest. It works only once a print is enrolled, and **only for the
route that enrolled it** (see step 3).

## Unlock routes

| Route | Who | Needs |
|---|---|---|
| Extended Controls → Fingerprint → **Touch Sensor** | Human, one click | A print enrolled **by clicking that button** |
| `adb -s <serial> emu finger touch <id>` then `emu finger remove` | Agent | A print enrolled **with that same `<id>`** (1–10; `0` is ignored) |
| `input keyevent 82` (MENU) → `input text "$PIN"` → ENTER | Agent | The PIN from the secret store |

**The Mac's Touch ID is NOT passed through.** The emulator's "Finger 1…10" are virtual IDs.
They have nothing to do with the fingers enrolled in macOS System Settings.

## Steps

1. **Check the state first.** Never guess.
   - `adb -s <serial> shell dumpsys window | grep -o 'isKeyguardShowing=[a-z]*'`
   - `adb -s <serial> shell dumpsys fingerprint` prints `"count"` (prints enrolled) plus
     `accept`, `reject` and `lockout` counters.
   - **`count: 0` means Touch Sensor silently does nothing.** Enroll first.

2. **PIN unlock (always works).** MENU raises the PIN pad directly. A swipe-up has failed when
   lock-screen notifications filled the middle of the screen. Read the PIN without printing
   it. In the kattakath fleet the Keychain handle is `android-emu:<avd>:pin`:
   ```sh
   secret exec PIN=android-emu:<avd>:pin -- sh -c '
     a(){ adb -s <serial> shell "$@"; }
     a input keyevent KEYCODE_WAKEUP; sleep 1; a input keyevent 82; sleep 1.5
     a input text "$PIN"; a input keyevent KEYCODE_ENTER'
   ```
   **Check:** `isKeyguardShowing=false`.

3. **Enroll a fingerprint.** Enroll **separately for each unlock route** you want.
   - **The GUI button and `adb emu finger touch N` send DIFFERENT finger IDs.** Measured on
     an Android 15 Play image, 2026-11: a print enrolled with `adb emu finger touch 1`
     rejected every GUI "Finger 1" click. A print with adb id 2 was rejected too.
   - For the human: run the wizard (below), then **the human clicks Touch Sensor** about
     10–15 times until "Fingerprint added". That guarantees the IDs match.
   - For the agent: run the same wizard and send about 20 cycles of
     `emu finger touch 1; sleep 0.6; emu finger remove; sleep 0.8`.
   - **The wizard, without leaking the PIN:**
     ```sh
     a(){ adb -s <serial> shell "$@"; }
     a am force-stop com.android.settings        # a stale Settings task swallows the intent
     a am start -a android.settings.FINGERPRINT_ENROLL
     # poll until the PIN screen really has focus, THEN type the PIN
     until a dumpsys window | grep mCurrentFocus | grep -q ConfirmLock; do sleep 1; done
     ```
     Then enter the PIN as in step 2, without the MENU key. Tap through the consent screen:
     "MORE" until "I agree". Find each button's bounds in `uiautomator dump`.
   - **Check:** `dumpsys fingerprint` `count` goes up by one, and the screen says "Fingerprint added".

4. **Prove it.** Lock with `input keyevent KEYCODE_SLEEP` then `KEYCODE_WAKEUP`, so
   `isKeyguardShowing=true`. Fire the route. It should read `false`, and `accept` should rise.

## Pitfalls

- **Five rejects lock biometrics out** (`lockout` counter). The next attempt shows the PIN pad
  instead. It looks like "fingerprint asks for PIN", but the cause is earlier mis-matched touches.
  Don't keep guessing IDs. Enroll by the route you will unlock with.
- **The PIN pad also comes back** after a reboot (a cold boot), or after about 72 h without a PIN
  entry. That is Android's strong-auth timeout, not a broken print. Use step 2.
- **Typing the PIN with no focus check is a leak.** Once, `am start` printed "intent has been
  delivered to currently running top-most instance". The PIN keystrokes and ENTER then went to
  the **launcher search**. Always force-stop Settings and poll `mCurrentFocus` first.
- **A Workspace account on the AVD may require a screen lock** (`DeviceManagementScreenlockRequired`).
  Setting a PIN alone does not clear the block. Removing and re-adding the account does.
- `mobile-mcp`'s device id is the AVD **name** (for example `pixel_play`), not `emulator-5554`.

## References

- Emulator console `finger` command: <https://developer.android.com/studio/run/emulator-console>
  (`finger touch <fingerprint-id>` / `finger remove`).
- Extended controls → Fingerprint: <https://developer.android.com/studio/run/emulator-extended-controls>.
- The fleet's `android-emu` launcher (provisions and boots the AVD): kattakath/nix-config `packages/android-emu.nix`.
