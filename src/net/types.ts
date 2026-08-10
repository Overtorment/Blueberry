import type { ByteDuplex } from "bip324";
import type { DnsResolver } from "./dns-seeds.ts";

export type TcpConnect = (
  host: string,
  port: number,
  signal?: AbortSignal,
) => Promise<ByteDuplex>;

/** Platform TCP + DNS — injected by the app entry into network modules only. */
export type PlatformNet = {
  connect: TcpConnect;
  dns: DnsResolver;
};
