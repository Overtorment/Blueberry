import { isWellFormedEncryptedSecret } from "../wallet/encrypted-secret-format.ts";

export function requireNewWalletPassword(password: string): void {
  if (password.normalize("NFC").trim().length < 12) {
    throw new Error("Use a wallet password of at least 12 characters");
  }
}

type SetupDependencies = {
  parse: (secret: string) => string;
  encrypt: (secret: string, password: string) => Promise<string>;
  commit: (encrypted: string, year: number, created: boolean) => void;
};

/** Keep setup secrets in memory; the only persistence boundary accepts ciphertext. */
export function createWalletSetup(deps: SetupDependencies) {
  let staged: string | null = null;
  let generation = 0;
  let busy = false;
  return {
    stage(raw: string): void {
      if (busy) throw new Error("Wallet setup is already saving");
      staged = deps.parse(raw);
      generation++;
    },
    cancel(): void {
      staged = null;
      generation++;
    },
    async save(year: number, password: string, created = false): Promise<string> {
      if (busy) throw new Error("Wallet setup is already saving");
      if (staged === null) throw new Error("No wallet is staged");
      requireNewWalletPassword(password);
      const secret = staged;
      const current = generation;
      busy = true;
      try {
        const encrypted = await deps.encrypt(secret, password);
        if (generation !== current) throw new Error("Wallet setup was cancelled");
        if (!isWellFormedEncryptedSecret(encrypted)) throw new Error("Wallet encryption failed");
        deps.commit(encrypted, year, created);
        staged = null;
        generation++;
        return secret;
      } finally {
        busy = false;
      }
    },
  };
}
