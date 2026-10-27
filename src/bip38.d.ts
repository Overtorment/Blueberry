declare module "bip38" {
  const bip38: {
    decryptAsync(
      encrypted: string,
      password: string,
      progress?: (status: { percent: number }) => void,
      scryptParams?: { N: number; r: number; p: number },
    ): Promise<{ privateKey: Uint8Array; compressed: boolean }>;
  };
  export default bip38;
}
