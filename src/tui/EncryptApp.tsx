import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { BlueberryArt } from "./components/BlueberryArt.tsx";
import { Panel } from "./chrome.tsx";
import {
  maskPassword,
  nextPasswordFromMaskedInput,
} from "./onboarding-import.ts";
import { THEME } from "./theme.ts";

export type EncryptAppProps = {
  onEncrypt: (password: string) => void | Promise<void>;
  onSkip: () => void;
};

type Field = "password" | "confirm";

export function EncryptApp({ onEncrypt, onSkip }: EncryptAppProps) {
  const [field, setField] = useState<Field>("password");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    if (!password) {
      setError("password is required");
      return;
    }
    if (field === "password") {
      setError(null);
      setField("confirm");
      return;
    }
    if (password !== confirm) {
      setError("passwords do not match");
      return;
    }
    setBusy(true);
    setError(null);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      await onEncrypt(password);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useKeyboard((key) => {
    if (busy) return;
    if (key.name === "escape") {
      if (field === "confirm") {
        setConfirm("");
        setError(null);
        setField("password");
        return;
      }
      onSkip();
    }
  });

  const value = field === "password" ? password : confirm;
  const setValue = field === "password" ? setPassword : setConfirm;

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

      <box width="80%" height={9} flexGrow={0}>
        <Panel title="Encrypt" state="active" accent="magenta" height="100%">
          <text fg={THEME.fgDim}>
            Encrypt the wallet on disk. If you forget the password, only the
            written seed can recover it.
          </text>
          <input
            // Remount on field change. OpenTUI emits onInput when value is
            // set, and that echo would clear the first password.
            key={field}
            focused={!busy}
            value={maskPassword(value)}
            placeholder={
              field === "password" ? "password…" : "confirm password…"
            }
            onInput={(v) => {
              setValue((prev) => nextPasswordFromMaskedInput(prev, v));
              if (error) setError(null);
            }}
            onSubmit={() => {
              void submit();
            }}
          />
          <text fg={error ? THEME.accentMagenta : THEME.fgDim}>
            {busy
              ? "Encrypting…"
              : (error ??
                (field === "password"
                  ? "Enter to continue · Esc to skip"
                  : "Enter to encrypt · Esc to go back"))}
          </text>
        </Panel>
      </box>
    </box>
  );
}
