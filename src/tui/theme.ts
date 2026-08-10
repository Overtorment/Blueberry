import { RGBA } from "@opentui/core";

export const THEME = {
  bg: RGBA.fromIndex(234),
  fg: RGBA.fromIndex(252),
  fgDim: RGBA.fromIndex(240),
  accentCyan: RGBA.fromIndex(51),
  accentMagenta: RGBA.fromIndex(201),
  done: RGBA.fromIndex(46),
  error: RGBA.fromIndex(196),
  borderIdle: RGBA.fromIndex(238),
} as const;

export type PanelAccent = "cyan" | "magenta";
export type PanelVisualState = "idle" | "active" | "done";

function accent(accent: PanelAccent): RGBA {
  return accent === "cyan" ? THEME.accentCyan : THEME.accentMagenta;
}

export function borderColorFor(
  state: PanelVisualState,
  panelAccent: PanelAccent,
): RGBA {
  if (state === "done") return THEME.done;
  if (state === "active") return accent(panelAccent);
  return THEME.borderIdle;
}

export function titleColorFor(
  state: PanelVisualState,
  panelAccent: PanelAccent,
): RGBA {
  if (state === "done") return THEME.done;
  if (state === "idle") return THEME.fgDim;
  return accent(panelAccent);
}
