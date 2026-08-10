/**
 * Runtime load of echalote. The package ships TypeScript source (`src/index.ts`).
 * A static import pulls that tree into blueberry `tsc` (verbatimModuleSyntax / DOM
 * BufferSource mismatches).
 */
export type ExitDialerOptions = {
  meekUrl?: string;
  extendTimeoutMs?: number;
  openTimeoutMs?: number;
  circuitAttempts?: number;
  circuitRace?: number;
};

export type ExitDialer = {
  dial(
    host: string,
    port: number,
    signal?: AbortSignal,
  ): Promise<{
    outer: ReadableWritablePair<Uint8Array, Uint8Array>;
    close: () => void;
  }>;
  dispose(): Promise<void>;
};

type EchaloteNamespace = {
  createExitDialer: (options?: ExitDialerOptions) => ExitDialer;
};

type EchaloteModule = {
  Echalote: EchaloteNamespace;
};

const { Echalote } = require("@hazae41/echalote") as EchaloteModule;

export function createExitDialer(
  options: ExitDialerOptions = {},
): ExitDialer {
  return Echalote.createExitDialer(options);
}
