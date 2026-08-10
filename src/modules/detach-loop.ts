import { logError } from "../log.ts";
import type { ModuleContext } from "./types.ts";

/**
 * Attach a catch to a fire-and-forget module loop.
 * Emits `module:status` error and logs; does not rethrow.
 */
export function detachLoop(
  ctx: ModuleContext,
  module: string,
  task: Promise<void>,
): Promise<void> {
  return task.catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    ctx.bus.emit("module:status", {
      module,
      status: "error",
      detail,
    });
    logError(module, "background loop failed", err);
  });
}
