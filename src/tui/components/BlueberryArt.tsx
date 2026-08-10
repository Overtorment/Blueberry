import { THEME } from "../theme.ts";

const LETTERS = [
  " ____  _     _   _  _____  ____  _____  ____   ____  __   __",
  "| __ )| |   | | | || ____|| __ )| ____||  _ \\ |  _ \\ \\ \\ / /",
  "|  _ \\| |   | | | ||  _|  |  _ \\|  _|  | |_) || |_) | \\ V / ",
  "| |_) | |___| |_| || |___ | |_) | |___ |  _ < |  _ <   | |  ",
  "|____/|_____| \___/ |_____||____/|_____||_| \\_\\|_| \\_\\  |_|  ",
] as const;

export function BlueberryArt() {
  return (
    <box
      flexGrow={1}
      height="100%"
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      overflow="hidden"
    >
      {LETTERS.map((line) => (
        <text key={line} fg={THEME.accentMagenta}>
          {line}
        </text>
      ))}
    </box>
  );
}
