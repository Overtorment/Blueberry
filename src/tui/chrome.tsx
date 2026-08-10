import type { ReactNode } from "react";
import {
  borderColorFor,
  THEME,
  titleColorFor,
  type PanelAccent,
  type PanelVisualState,
} from "./theme.ts";

export type PanelProps = {
  title: string;
  state: PanelVisualState;
  accent: PanelAccent;
  flexGrow?: number;
  flexShrink?: number;
  width?: number | "auto" | `${number}%`;
  height?: number | "auto" | `${number}%`;
  /** Horizontal inset; defaults to 1. */
  paddingX?: number;
  /**
   * Vertical inset; defaults to 1. Strip panels pass 0 so content can use the
   * full interior height (border only).
   */
  paddingY?: number;
  children?: ReactNode;
};

export function Panel({
  title,
  state,
  accent,
  flexGrow = 1,
  flexShrink,
  width,
  height = "100%",
  paddingX = 1,
  paddingY = 1,
  children,
}: PanelProps) {
  return (
    <box
      title={`◆ ${title}`}
      titleColor={titleColorFor(state, accent)}
      border
      borderStyle={state === "idle" ? "single" : "double"}
      borderColor={borderColorFor(state, accent)}
      backgroundColor={THEME.bg}
      flexGrow={flexGrow}
      flexShrink={flexShrink}
      width={width}
      height={height}
      flexDirection="column"
      paddingX={paddingX}
      paddingY={paddingY}
    >
      {children}
    </box>
  );
}
