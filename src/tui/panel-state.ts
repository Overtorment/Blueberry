import type { PanelVisualState } from "./theme.ts";

/** Progress tile chrome: idle at ≤0, active in (0,100), done at ≥100. */
export function progressPanelState(percent: number): PanelVisualState {
  if (percent >= 100) return "done";
  if (percent > 0) return "active";
  return "idle";
}
