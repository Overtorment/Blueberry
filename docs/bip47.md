# BIP47 protocol support

Blueberry supports sending and receiving mainnet BIP47 version 1 payments in
unlocked mnemonic wallets. See [Using BIP47 payment codes](bip47-usage.md) for
the receive-code toggle, notification action, confirmation wait, and separate
payment flow.

`src/wallet/bip47.ts` implements Bitcoin mainnet BIP47 version 1 payment
codes with on-chain notifications. It supports the code codec, identity
derivation at `m/47'/0'/account'`, notification public keys and P2PKH addresses,
notification payload blinding and recovery, and matching sender/recipient
P2PKH payment derivation. The recipient API returns the private key needed to
spend a derived payment. Keys remain in memory; this module does not save them.

The supported format has zero feature bits and zero reserved bytes. Other
versions, Bitmessage features, malformed points, incorrect checksums, and
hardened payment indexes are rejected. These APIs use non-hardened BIP32
payment indexes from 0 through 2,147,483,647. Invalid child keys or shared
scalars throw rather than silently returning a different persisted index.

The implementation follows [BIP47](https://github.com/bitcoin/bips/blob/master/bip-0047.mediawiki)
and the [interoperability vectors linked by the BIP](https://gist.github.com/SamouraiDev/6aad669604c5930864bd).
Tests reproduce both identities, notification addresses, the notification
mask and payload, and all ten published payment addresses. They also prove
that the corresponding recipient private keys sign for those public keys.
The notification mask uses the serialized outpoint as the HMAC-SHA512 key
and ECDH shared-point x coordinate as its message, as required by those
vectors. `serializeBip47Outpoint` converts a displayed transaction ID and vout
to the 36-byte Bitcoin wire format.

## Notification transactions and channel storage

`buildBip47Notification` in `src/wallet/bip47-notification.ts` builds and signs
an on-chain notification funded by selected BIP84 native SegWit inputs. It
includes a 546-sat P2PKH notification output by default, a zero-value standard
OP_RETURN containing the blinded payload, and owned change when it exceeds
the P2WPKH dust threshold. The mask binds to the first input in the actual
transaction order. Fee selection reserves enough for maximum-size input
witnesses and checks the requested fee rate against the signed transaction;
the result reports its actual fee and virtual size. Excess below the change
dust threshold becomes fee. No broadcast occurs inside the builder.

`createBip47Channels` in `src/wallet/bip47-channels.ts` stores public channel
metadata in the database under `bip47_channels_v1`, bound to the local payment
code. The send flow records the prepared notification before returning its
preview. Before constructing a payment, it checks the notification transaction
against the active header at its stored height, then reserves the next index
within a database transaction. The reservation returns only after its write
commits. Cancelling the preview, a failed send, an uncertain broadcast, or a
restart does not release the index. The notification's active-chain inclusion
is checked again before broadcasting a payment preview. Reorgs and replaced
notifications preserve the counter. Every mutation rereads the latest state;
malformed state and wallet-identity mismatches fail closed.

`discoverBip47Notification` in `src/wallet/bip47-discovery.ts` recognizes
compressed public keys exposed in supported legacy scriptSigs and native or
wrapped P2WPKH witnesses. Unsupported or ambiguous earlier inputs fail closed:
P2PK and bare multisig designated-key selection need previous output scripts
that the current block parser does not have. Multiple OP_RETURN outputs are
rejected. This helper discovers candidate channels; blinding does not
authenticate a sender, and the caller must supply validated confirmed
transactions through the confirmed-block parsing path.

## Receiving and spending

Displaying the payment code or constructing an outgoing notification enables
BIP47 watching for the mnemonic wallet. Enabling adds the notification script
to compact-filter matching, queues historical filters from the configured
wallet birthday or available scan floor, invalidates parsed block markers, and
wakes matching. Repeatedly displaying an already enabled code does not restart
this scan.

Confirmed notifications add the recovered sender code to incoming channel
metadata. The wallet derives and watches a P2PKH receive lookahead for each
channel. Observed payments advance the window; new channels and window growth
rematch filters and reparse downloaded blocks, including the case where a
notification and payment arrive in the same block. The initial window uses
`config.gapLimit`, currently 100 indexes, and subsequent windows extend that
far beyond the highest observed index. Skipped indexes from many cancelled
previews can exceed this lookahead; such payments require a wider scan window.

Notification outputs are excluded from spendable balances and selectable
coins, and the transaction builder rejects attempts to spend them. Received
payment outputs use their ECDH-tweaked private keys for signing. Their full
previous transactions are loaded from the wallet database for legacy-input
validation. Derived private keys remain in memory rather than becoming
plaintext channel metadata. Ordinary receive-address selection continues to
use BIP84 addresses.

## Supported limits and recovery

- The integrated wallet flow requires a mnemonic. Account-zpub, WIF, and
  address-only wallets lack the BIP47 account keys.
- Payments use version 1 P2PKH destinations. Version 2 codes and Bitmessage
  notifications are not supported.
- Outgoing notifications are funded by owned native BIP84 P2WPKH coins. The
  receiving wallet must support designated public keys in SegWit witnesses.
  Blueberry's incoming discovery supports compressed keys in the legacy,
  native P2WPKH, and wrapped P2WPKH forms described above; previous-output-based
  P2PK and bare-multisig discovery remains unsupported.
- Notification blinding does not authenticate the sender. Notification
  transactions and their change also have privacy implications; the wallet
  does not mix notification change.

Preserve and back up the wallet database together with the seed. The database
contains outgoing notification records and reserved per-recipient indexes;
the seed alone does not preserve them. Reusing a stale database backup or
operating independent instances from the same seed can reuse destinations
unless their channel state is coordinated.

Incoming recovery scans historical notification transactions, including spent
notifications, then scans each recovered channel through its receive window.
Choose a wallet birthday early enough to include those notifications and let
filter matching finish. A later birthday or a gap beyond the configured
lookahead can omit payments. Existing incoming channels remain available on
wallet recreation from the same database.

Offline wallet-flow tests exercise notification creation, active-chain gates,
same-block channel discovery and payment reparsing, restart, filter rematching,
notification-output exclusion, tweaked-key spending, and reorgs. They verify
legacy payment signatures independently with Bitcoin transaction hashes.
These tests do not establish compatibility with every external BIP47 wallet
or prove real-network payment confirmation.
