import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { THEME } from "../theme.ts";
import { useUiRouteStore } from "../use-ui-route.ts";

const ACTIONS = [
  { label: "Receive", accent: "magenta" as const, route: "receive" as const },
  { label: "Send", accent: "cyan" as const, route: "send" as const },
];

const BUTTON_PAD_X = 3;
const LABEL_WIDTH = 14;
const INNER_WIDTH = LABEL_WIDTH + BUTTON_PAD_X * 2;
const OUTER_WIDTH = INNER_WIDTH + 2;

function ActionButton(props: {
  label: string;
  accent: "magenta" | "cyan";
  selected: boolean;
}) {
  const color =
    props.accent === "magenta" ? THEME.accentMagenta : THEME.accentCyan;

  return (
    <box
      border
      borderStyle={props.selected ? "double" : "single"}
      borderColor={props.selected ? color : THEME.borderIdle}
      backgroundColor={THEME.bg}
      paddingX={BUTTON_PAD_X}
      paddingY={1}
      width={OUTER_WIDTH}
      justifyContent="center"
      alignItems="center"
      shouldFill={false}
    >
      <text fg={props.selected ? color : THEME.fgDim}>
        {props.selected ? `▸ ${props.label}` : `  ${props.label}`}
      </text>
    </box>
  );
}

/** Floating bottom-center Receive / Send — App-stage sibling, not inside Transactions. */
export function ActionBar() {
  const store = useUiRouteStore();
  const [selected, setSelected] = useState(0);

  function activate(index: number) {
    const action = ACTIONS[index];
    if (!action) return;
    store?.open(action.route);
  }

  useKeyboard((key) => {
    if (key.name === "left") {
      setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (key.name === "right") {
      setSelected((i) => Math.min(ACTIONS.length - 1, i + 1));
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      activate(selected);
    }
  });

  return (
    <box
      position="absolute"
      left={0}
      right={0}
      bottom={1}
      height={5}
      zIndex={10}
      flexDirection="row"
      justifyContent="center"
      alignItems="flex-end"
      gap={3}
      shouldFill={false}
    >
      {ACTIONS.map((action, index) => (
        <ActionButton
          key={action.route}
          label={action.label}
          accent={action.accent}
          selected={selected === index}
        />
      ))}
    </box>
  );
}
