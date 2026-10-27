# Camera QR scanning

In **Send**, select coins and continue to the recipient form. Press **Ctrl+R** to
open the local camera and scan one QR code. Press **Ctrl+R** again to cancel, or
**Esc** to close the dialog. A scan stops automatically after 30 seconds.

Blueberry fills the editable destination, optional BTC amount, and label from a
Bitcoin mainnet address, BIP47 payment code, Silent Payments code, or BIP21 URI. Review these fields and the transaction
preview before broadcasting. Scanning never signs or broadcasts a transaction.
Unknown required URI parameters, invalid mainnet addresses, invalid amounts, and
control characters are rejected. A failed scan leaves the form values intact.

The optional local executable `zbarcam` must be available on `PATH`, with QR
support and permission to access a camera. For Debian/Ubuntu, it is supplied by
`zbar-tools`. The default camera is selected by ZBar. Set
`BLUEBERRY_CAMERA_DEVICE=/dev/video1` before starting Blueberry to select another
local V4L2 camera. Device settings cannot be URLs, options, or shell commands.

Linux camera capture requires a working video device. WSL requires the camera to
be exposed inside the Linux environment; Windows camera access alone is not
enough. Camera capture on macOS requires a camera-capable ZBar build; a package
containing only `zbarimg` cannot provide this feature. Missing executables,
unsupported capture backends, and denied camera access produce an error in the
recipient form; manual address entry remains available.

The scanner runs only in response to Ctrl+R. QR-only, raw, single-scan output is
read through a private pipe; video display, beeps, and ZBar DBus reporting are
disabled. Output is limited to 4096 bytes. No QR contents are logged or saved by
the scanner. Closing the form, cancelling, or timing out terminates the scanner,
with a forced kill if it does not exit promptly. Blueberry does not request a
network camera, launch a shell, or write captured frames to disk.

Backend options are based on [ZBar's zbarcam implementation](https://github.com/mchehab/zbar/blob/master/zbarcam/zbarcam.c).
