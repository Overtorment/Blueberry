import { useState } from "react";
import { BlueberryArt } from "./components/BlueberryArt.tsx";
import { Panel } from "./chrome.tsx";
import {
  maskPassword,
  nextPasswordFromMaskedInput,
} from "./onboarding-import.ts";
import { THEME } from "./theme.ts";

export type UnlockAppProps = {
  onUnlock: (password: string) => void | Promise<void>;
};

export function UnlockApp({ onUnlock }: UnlockAppProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    if (!password) {
      setError("password is required");
      return;
    }
    setBusy(true);
    setError(null);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      await onUnlock(password);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

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

      <box width="80%" height={8} flexGrow={0}>
        <Panel title="Unlock" state="active" accent="magenta" height="100%">
          <text fg={THEME.fgDim}>
            This wallet is encrypted. Enter the password.
          </text>
          <input
            focused={!busy}
            value={maskPassword(password)}
            placeholder="password…"
            onInput={(v) => {
              setPassword((prev) => nextPasswordFromMaskedInput(prev, v));
              if (error) setError(null);
            }}
            onSubmit={() => {
              void submit();
            }}
          />
          <text fg={error ? THEME.accentMagenta : THEME.fgDim}>
            {busy ? "Unlocking…" : (error ?? "Enter to unlock")}
          </text>
        </Panel>
      </box>
    </box>
  );
}
