# BIP352 fixtures

`bip352-send-receive.json` contains unmodified cases 0–18, 23, 25, 26, and 28 from the official [BIP352 send/receive test vectors](https://github.com/bitcoin/bips/blob/master/bip-0352/send_and_receive_test_vectors.json), retrieved 2026-10-27. Source Git blob SHA: `b915113acc8130bb0e7347fa4485af25906123bd`.

The BIP and its accompanying implementation/vectors use the [BSD 2-Clause license](https://github.com/bitcoin/bips/blob/master/bip-0352.mediawiki#copyright). Authors: josibake, Ruben Somsen, Sebastian Falbesoner. The omitted cases concern raw transaction input extraction, which is outside the cryptographic primitive's interface, and the very large maximum-output fixture; the limit is covered separately by a focused test.
