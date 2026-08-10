import type { MessageBus } from "../bus/types.ts";
import type { Database } from "../db/types.ts";

export interface ModuleContext {
  bus: MessageBus;
  db: Database;
}

export interface Module {
  name: string;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}
