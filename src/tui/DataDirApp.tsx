import { useMemo, useState } from "react";
import { defaultDataDirIndex } from "../boot/data-dir.ts";
import { BlueberryArt } from "./components/BlueberryArt.tsx";
import { Panel } from "./chrome.tsx";
import { THEME } from "./theme.ts";

export type DataDirAppProps = {
  dirs: string[];
  onSelect: (dir: string) => void;
};

export function DataDirApp({ dirs, onSelect }: DataDirAppProps) {
  const [selectedIndex, setSelectedIndex] = useState(() =>
    defaultDataDirIndex(dirs),
  );
  const options = useMemo(
    () =>
      dirs.map((name) => ({
        name,
        description: "",
        value: name,
      })),
    [dirs],
  );

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      gap={1}
      padding={1}
      backgroundColor={THEME.bg}
    >
      <box width="100%" height={7} flexGrow={0}>
        <BlueberryArt />
      </box>

      <box width="80%" height={16} flexGrow={0}>
        <Panel title="Data" state="active" accent="magenta" height="100%">
          <text fg={THEME.fgDim}>Which data directory should we use?</text>
          <select
            focused
            options={options}
            selectedIndex={selectedIndex}
            showDescription={false}
            showScrollIndicator
            height={10}
            onChange={(index) => setSelectedIndex(index)}
            onSelect={(index) => {
              const dir = dirs[index];
              if (dir) onSelect(dir);
            }}
          />
          <text fg={THEME.fgDim}>↑/↓ to choose · Enter to confirm</text>
        </Panel>
      </box>
    </box>
  );
}
