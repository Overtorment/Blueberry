# Silent Payments

The wallet can send to mainnet BIP352 Silent Payments addresses through the normal send flow. The destination is resolved only after the user selects inputs. The generated `bc1p` address is a Taproot **output** key; it must not receive another TapTweak. The preview retains the recipient's Silent Payments address and shows the transaction destination.

`src/wallet/silent-payments.ts` provides mainnet address encoding and decoding, BIP352 mnemonic key derivation, sender output derivation, label derivation, and cryptographic receiver matching. Version 0 addresses must contain exactly two compressed keys. Following BIP352's forward compatibility rules, versions 1–30 use the first 66 payload bytes; version 31 is rejected. Checksums, malformed curve points, testnet addresses, and mixed case are rejected.

Sender derivation requires all selected transaction outpoints, including outpoints whose keys are ineligible. Every eligible input's private key must be available. Taproot inputs require the tweaked output private key, with even-Y normalization performed before aggregation. Missing keys, duplicate outpoints, a zero aggregate, and groups exceeding 2323 recipients fail. Inputs and derived outputs must remain fixed while signing; `ANYONECANPAY` must never be used. Watch-only Silent Payments PSBT construction requires a separate protocol for the missing ECDH computation and is unsupported.

## Receiving remains unfinished

Do not publish an address from `deriveSilentPaymentKeys` as a Blueberry receive address. Blueberry's existing compact-filter synchronization matches a precomputed set of scripts. Silent Payments creates scripts from transaction input keys, so this synchronization cannot discover incoming Silent Payments.

`scanSilentPaymentOutputs` is a cryptographic primitive, not a chain scanner. A future receiver must obtain and validate transaction prevouts, extract eligible input keys exactly as BIP352 prescribes (including malleated P2PKH scripts, Taproot NUMS exceptions, and annex handling), reject transactions spending unknown witness versions, and provide **all** outpoints to this primitive. It must scan chain history from the wallet birthday, persist discovered keys/tweaks and transaction state with reorganization recovery, add discovered outputs to coin selection and signing, and restore everything from the seed. A complete implementation must also select a privacy-preserving source of the required input data. Scanning automatically checks the reserved change label zero, even when no other labels are supplied.

The scan/spend derivation paths are `m/352'/0'/account'/1'/0` and `m/352'/0'/account'/0'/0`. `silentPaymentSpendPrivateKey` combines a discovered tweak with the spend private key and normalizes the resulting Schnorr key. These keys and tweaks must not be logged.

## Validation

The unit tests include unmodified cases from the official BIP352 vectors. They check sends and receiver primitives for serialized outpoint ordering, repeated input public keys, Taproot parity, mixed input types, multiple recipients, labels and change, unrelated outputs, infinity/zero aggregates, and annex-bearing Taproot inputs. Receiver tests receive pre-extracted eligible public keys from the official vector; they do not verify blockchain input extraction. Additional tests exercise address validation, future versions, derivation paths, input validation, group limits, and continuation after cryptographic matches.

References: [BIP352 specification](https://github.com/bitcoin/bips/blob/master/bip-0352.mediawiki), [official test vectors](https://github.com/bitcoin/bips/blob/master/bip-0352/send_and_receive_test_vectors.json).
