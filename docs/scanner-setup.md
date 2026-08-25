# Front-desk scanner setup (Zebra DS2208)

What the voucher hub needs from the scanner, how to check it, and what to do
when a scan does nothing. The design behind it is
[ADR 0006](adr/0006-voucher-scanning-is-a-keyboard-wedge.md).

## What the hub actually requires

Two things, and deliberately nothing else:

1. **USB HID keyboard mode.** The DS2208 ships this way. The browser sees a
   keyboard, not a device — there is no driver to install and no permission
   prompt.
2. **An Enter suffix.** The scanner must press Enter after typing the code.
   That keypress is what tells the hub the code is complete.

Everything else is left at the factory default on purpose. The hub trims and
uppercases whatever arrives before testing it, so Caps Lock on the till, or a
replacement unit somebody else programmed, does not break scanning.

**Do not** disable symbologies, set a prefix, or change the keyboard country to
"tidy things up". None of it helps — the hub rejects a non-voucher scan on the
shape of the code — and a keyboard country that stops matching Windows turns the
hyphens in `UJ-XXXX-XXXX` into something else, which looks exactly like the
scanner being broken.

## Setting the Enter suffix

Either route works; both write to the scanner's own flash and survive being
unplugged.

- **Zebra 123Scan** (Windows) — connect the scanner, set the suffix to Enter,
  write the configuration to the device. This is what was used on 2026-08-25.
- **The DS2208 Product Reference Guide** — scan the programming barcode that
  adds an Enter key (carriage return) as the suffix. Zebra publishes the guide
  as a PDF; the barcode is in the USB / "Scan Options" section.

A factory reset clears it. If the scanner is ever reset or replaced, this is the
one setting to put back.

## Checking it in thirty seconds

Open Notepad and scan a voucher QR off a phone screen.

You should see the code and then **the cursor drop to a new line**:

```
UJ-TQYH-F8PW
|
```

- Code appears, cursor stays on the same line → **no Enter suffix.** Set it.
- Nothing appears → the scanner is not in HID keyboard mode, or is not powered.
- Code appears with the hyphens missing or replaced → keyboard country mismatch.
- Code appears in lowercase → harmless. The hub uppercases it.

Then scan into the voucher hub with nothing focused. An active voucher should
open the redeem form with the cursor in the amount box.

## What a real scan looks like

Measured 2026-08-25 on the front-desk unit, scanning `UJ-TQYH-F8PW`:

| | |
|---|---|
| Keydown events | **22**, for a 12-character code |
| Why 22 | every letter is preceded by its own `Shift` keydown; digits and hyphens are not |
| Terminator | `Enter` (`keyCode` 13), one, at the end |
| Prefix | none |
| Hyphen | arrives intact on the Australian Windows layout |
| Whole burst | 40 ms, 0–5 ms between characters |

The Shift detail is why the hub collects only single-character keys. It is
recorded here as well as in the ADR because it is the thing that looks like a
bug when someone re-reads the code.

## When a scan does nothing

Work down this list; it is ordered by how often each one is the answer.

1. **A modal is open.** Scanning is switched off entirely while any dialog is
   up, so an in-progress redeem or an unsaved type edit cannot be blown away.
   Close it and scan again.
2. **The cursor is in a text box.** Scanning is suppressed so a scan cannot
   hijack someone mid-typing. Click a blank part of the page first. (Scanning
   into the *search box* is fine — the code submits the form and lands in the
   same place.)
3. **No Enter suffix.** Check with Notepad, above.
4. **It is not an emailed voucher.** Physical cards carry a printed code and no
   QR — there is nothing to scan. Type the code into the search box instead; it
   goes to the same place.
5. **It is a pre-2026 voucher.** Vouchers migrated from the old Google system
   kept long UUID codes and their emails never carried a QR. Search for them by
   customer name or receipt.
6. **The page says "That isn't a voucher code".** The scanner fired and the hub
   read something that is not a `UJ-XXXX-XXXX` code — usually the wrong barcode
   on the same page, or a product barcode.
