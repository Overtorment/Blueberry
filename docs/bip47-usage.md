# Using BIP47 payment codes

BIP47 is available to mnemonic wallets. WIF, address-only, and account-zpub
wallets do not contain the BIP47 account keys.

## Receive

Open **Receive** and press **P** to enable BIP47 and display your payment code
and QR. Enabling happens only in response to this action. Press **P** again to
display the ordinary Bitcoin receive address. Share the payment code with a
sender using a compatible BIP47 wallet. The sender establishes a channel with
an on-chain notification before their first payment.

Enabling the notification watch can require historical filter rematching.
Let synchronization and matching finish before relying on a completed restore.

## Establish a channel before sending

1. Open **Send**, select coins, and continue to the recipient form.
2. Paste or scan the recipient's BIP47 payment code (`PM…`). Camera scanning
   uses **Ctrl+R**, as described in [camera-qr.md](camera-qr.md).
3. Press **Ctrl+N** to prepare a notification. This explicitly chooses a
   **546 sat notification**, regardless of the payment amount field. An empty
   label defaults to `BIP47 notification`.
4. Enter a fee rate and inspect the **BIP47 notification ONLY** preview. Review
   the recipient code, notification address, 546 sat output, fee, and change.
5. Press Enter to broadcast the notification, then wait for confirmation and
   synchronization. A broadcast success alone is not confirmation.
6. Create a **separate send** to the same payment code with the amount you
   actually intend to pay. Use ordinary Enter in the recipient form. The wallet
   requires an established channel before constructing this payment.

The notification creates the channel; it does not pay an invoice or the amount
from a scanned payment request. Ordinary payments and notifications have
separate previews and transaction IDs. Avoid spending notification inputs again
while their transaction is pending.

## Wallet metadata

Preserve the wallet database as well as your seed backup. Outgoing payment
indexes must remain reserved across cancelled previews, uncertain broadcasts,
restarts, and reorganizations. Sharing a seed across independently operated
wallet instances requires coordinated BIP47 channel state to prevent reuse.

Protocol details and interoperability sources are in [bip47.md](bip47.md).
