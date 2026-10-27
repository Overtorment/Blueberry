# Security status

This fork includes targeted wallet hardening reviewed on 2026-10-21. It is suitable for continued development with disposable fixtures. The review and tests do not establish production safety for real funds, a complete cryptographic audit, or guaranteed anonymity.

## Implemented protections

- New and imported wallet secrets remain in memory until encrypted. The encrypted secret and onboarding metadata are committed together. Cancellation and encryption failure do not persist a new plaintext secret.
- Encryption is mandatory before opening a signing session. New passwords require at least 12 characters. The existing AES-256-GCM format uses random salt/nonce and scrypt with N=32768, r=8, p=1.
- Wallet directories use mode 0700; database and existing SQLite sidecars use 0600. Storage checks reject another owner's files, symbolic-link targets, and hard-linked database files. Native Windows fails explicitly; use WSL on a filesystem that enforces POSIX permissions.
- The application's synchronization and broadcast connectors only dial the local Tor SOCKS proxy. Peer hostnames are resolved through Tor. Proxy failure stops connectivity rather than falling back to direct connections. Sync and broadcast use different SOCKS isolation credentials; circuit isolation also depends on the Tor service configuration.
- Transaction construction rejects a change address absent from the wallet's derived address set. Submission messages no longer imply network acceptance or confirmation.
- Dependency lifecycle scripts are disabled in `bunfig.toml`. The explicit Echalote trusted-install entry was removed. `shell-quote` is pinned to 1.11.0 to address the reported advisory.
- Security regression tests run in CI. Pull-request workflows have read-only repository contents access. Native Windows release artifacts are disabled because private storage currently requires POSIX permissions.

## Validation

The wallet-hardening baseline passed **549 tests across 94 files**, with zero failures. The camera and payment-code update passed **687 unit and security tests across 106 files**, with zero failures; type checking and standalone compilation passed. New checks cover official BIP47/BIP352 vectors, notification and payment signatures, persisted channel indexes, incoming filter rematching, same-block discovery, reorganization guards, scanner cancellation and actual terminal interactions. Camera hardware capture and a live Tor handshake were unavailable in this session; the live test requires a listening Tor SOCKS proxy.

A standalone terminal smoke test used a public BIP39 fixture in a temporary directory. It reached the encryption screen with an empty secrets table, persisted an encrypted envelope, opened the wallet dashboard, and displayed the expected receive address. No plaintext fixture seed was found in the active database or sidecars. The compiled executable also reached the unlock screen after restart.

The live Tor test was reported passing by the operator outside the restricted test environment. It tests remote seed resolution and an encrypted Bitcoin peer handshake, not a payment. The operator's final `bun audit --json` output was `{}`. The installed package and lockfile were independently checked for `shell-quote` 1.11.0, and its quoting function rejected the advisory input without executing a shell command.

No real funds were transferred. End-to-end payment acceptance, confirmation, recovery of a funded wallet, complete dependency review, and runtime network capture remain unverified.

## Payment codes and camera input

BIP47 support is limited to mnemonic wallets and the v1 protocol forms documented in [bip47.md](docs/bip47.md). Notification outputs are watched for discovery but excluded from spendable balances and coin selection. Outgoing indexes are reserved transactionally before a signed preview is released, including cancelled previews. Notification confirmation is checked against active header identity when building and broadcasting a payment. Incoming channels extend the watched scripts and trigger historical filter rematching and block reparsing. Channel metadata is public derivation data stored in the existing private database; it must be preserved to avoid outgoing address reuse after restore.

Silent Payments supports sending with locally controlled eligible input keys. Inputs are fixed before ECDH output derivation, and externally mutable SP PSBT export is rejected. Receiving remains explicitly unimplemented. Official protocol vectors and disposable Alice/Bob transaction fixtures exercise derivation and signing; no real-funds payment has been tested.

Camera access starts only after Ctrl+R in Send. An optional local `zbarcam` process has bounded output and duration, is cancelled when the form closes, and receives fixed argument arrays without a shell. Scanned data is validated before entering editable fields; it cannot directly trigger signing or broadcasting. Camera hardware capture was not available for local testing.

## Remaining boundaries

- **Key control:** signing happens locally, and recovery depends on the seed/private key. Disk encryption does not protect an unlocked process from malware, a compromised dependency, root access, swap, or memory capture. JavaScript strings are not reliably erasable. Keep recovery material offline and private.
- **Legacy data:** encrypting an older plaintext wallet can clean the current SQLite database/WAL, but cannot remove historical backups, snapshots, or copies.
- **Recovery compatibility:** an additional BIP39 passphrase is unsupported. Importing such a seed without its passphrase derives a different wallet. The storage password does not change this. Select a sync start year early enough to include the wallet's history.
- **Light-client trust:** this is a compact-filter wallet with checkpoint and peer assumptions, not a full consensus-validating node. Block downloads check the requested block hash and transaction Merkle root. Hostile or unavailable peers can still affect discovery, completeness, and availability.
- **Payment state:** submission alone is not acceptance. Pending spend tracking and unconfirmed-payment behavior have not been established as safe for repeated real-funds use. Confirm a payment before reusing its inputs. Address selection does not reserve a fresh address for every unpaid request; imported single keys/addresses also have limited address privacy.
- **Privacy:** Tor reduces exposure of the client's network address, but does not hide the public Bitcoin transaction graph, amounts, counterparties, address reuse, or external identity links. Tor and the operating system remain trusted parts of the environment. No absolute anonymity claim is made.
- **Supply chain:** several Bitcoin protocol dependencies are pinned GitHub sources. A clean vulnerability-database scan does not audit their implementations or detect all malicious behavior. Workflow actions still use version tags, and release signing/attestation is not implemented.

## Reporting and repository hygiene

Never post recovery phrases, private keys, passwords, wallet databases, personal transaction details, or access tokens in a public issue. Use GitHub's private vulnerability reporting option when it is available. Otherwise arrange a private reporting channel with the maintainer before sending sensitive details. Do not publish a working exploit against an unresolved issue.

Runtime data directories, SQLite files, environment files, logs, dependencies, and build artifacts are excluded from normal Git additions. Ignore rules do not protect a file deliberately force-added or already tracked; review the exact staged file list before publishing. Test seeds and keys are public disposable fixtures and must never receive funds.

References: [Tor SOCKS behavior](https://spec.torproject.org/socks-extensions.html), [Bitcoin privacy](https://bitcoin.org/en/protect-your-privacy), and the [shell-quote advisory](https://github.com/advisories/GHSA-pqg4-j6r4-53mv).
