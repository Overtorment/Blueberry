import type { RGBA } from "@opentui/core";
import { splitBtc } from "../../parse/format.ts";
import { THEME } from "../theme.ts";

/** Significant digits + unit in `fg`; trailing fractional zeros dimmed. */
export function BtcAmount(props: {
  sats: bigint;
  plus?: boolean;
  fg?: RGBA;
}) {
  const p = splitBtc(props.sats, { plus: props.plus });
  const fg = props.fg ?? THEME.fg;
  return (
    <>
      <span fg={fg}>{`${p.sign}${p.whole}.${p.fracSignificant}`}</span>
      {p.fracTrailing ? <span fg={THEME.fgDim}>{p.fracTrailing}</span> : null}
      <span fg={fg}>{" BTC"}</span>
    </>
  );
}
