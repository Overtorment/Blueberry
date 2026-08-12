import { useKeyboard } from "@opentui/react";
import { useMemo, useState } from "react";
import { DEFAULT_CHECKPOINT_YEAR } from "../checkpoint.ts";
import { listCheckpointYears } from "../sync-year.ts";
import { generateMnemonic12 } from "../wallet/generate-mnemonic.ts";
import { parseWalletSecret } from "../wallet/secret.ts";
import { BlueberryArt } from "./components/BlueberryArt.tsx";
import { Panel } from "./chrome.tsx";
import { THEME } from "./theme.ts";

type Step = "choose" | "import" | "create" | "year";

export type OnboardingAppProps = {
  /** Secret already in KV — skip wallet step. */
  startAtYearStep?: boolean;
  onSecretValidated: (raw: string) => void;
  /** Create path: secret confirmed; caller persists + finishes (no year picker). */
  onWalletCreated: (raw: string) => void;
  onYearChosen: (year: number) => void;
};

const CHOICE_OPTIONS = [
  {
    name: "Create new wallet",
    description: "",
    value: "create" as const,
  },
  {
    name: "Import wallet",
    description: "",
    value: "import" as const,
  },
];

/** BIP39 English words ≤8 chars; pad so 3 columns share the same starts. */
function formatSeedCell(n: number, word: string): string {
  return `${String(n).padStart(2)}. ${word.padEnd(8)}`;
}

function SeedGrid({ words }: { words: string[] }) {
  const lines = [0, 1, 2, 3].map((row) =>
    [0, 1, 2]
      .map((col) => {
        const i = row * 3 + col;
        return formatSeedCell(i + 1, words[i]!);
      })
      .join("   "),
  );

  return (
    <box flexDirection="column" width="100%">
      {lines.map((line, i) => (
        <text key={i} fg={THEME.fg}>
          {line}
        </text>
      ))}
    </box>
  );
}

export function OnboardingApp({
  startAtYearStep = false,
  onSecretValidated,
  onWalletCreated,
  onYearChosen,
}: OnboardingAppProps) {
  const [step, setStep] = useState<Step>(
    startAtYearStep ? "year" : "choose",
  );
  const [choiceIndex, setChoiceIndex] = useState(0);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const options = useMemo(
    () =>
      listCheckpointYears().map((year) => ({
        name: String(year),
        description: "",
        value: year,
      })),
    [],
  );
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = listCheckpointYears().indexOf(DEFAULT_CHECKPOINT_YEAR);
    return idx >= 0 ? idx : 0;
  });

  function submitSecret(raw: string) {
    try {
      parseWalletSecret(raw);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setError(null);
    onSecretValidated(raw);
    setStep("year");
  }

  function confirmYear(index: number) {
    if (busy) return;
    const year = options[index]?.value;
    if (typeof year !== "number") return;
    setBusy(true);
    onYearChosen(year);
  }

  function openCreate() {
    setError(null);
    setMnemonic(generateMnemonic12());
    setStep("create");
  }

  function confirmCreate() {
    if (!mnemonic || busy) return;
    setBusy(true);
    onWalletCreated(mnemonic);
  }

  useKeyboard((key) => {
    if (busy) return;
    if (key.name === "escape") {
      if (step === "create") {
        setMnemonic(null);
        setStep("choose");
      } else if (step === "import") {
        setValue("");
        setError(null);
        setStep("choose");
      }
      return;
    }
    if (step === "create" && (key.name === "return" || key.name === "enter")) {
      confirmCreate();
    }
  });

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

      {step === "choose" ? (
        <box width="80%" height={10} flexGrow={0}>
          <Panel title="Wallet" state="active" accent="magenta" height="100%">
            <text fg={THEME.fgDim}>
              Create a new wallet or import an existing one
            </text>
            <select
              focused
              options={CHOICE_OPTIONS}
              selectedIndex={choiceIndex}
              showDescription={false}
              showScrollIndicator={false}
              height={4}
              onChange={(index) => setChoiceIndex(index)}
              onSelect={(index) => {
                const choice = CHOICE_OPTIONS[index]?.value;
                if (choice === "create") openCreate();
                else if (choice === "import") {
                  setValue("");
                  setError(null);
                  setStep("import");
                }
              }}
            />
            <text fg={THEME.fgDim}>↑/↓ to choose · Enter to continue</text>
          </Panel>
        </box>
      ) : null}

      {step === "import" ? (
        <box width="80%" height={8} flexGrow={0}>
          <Panel title="Import" state="active" accent="magenta" height="100%">
            <text fg={THEME.fgDim}>
              Enter BIP39 seed, account zpub, WIF private key, or address
            </text>
            <input
              focused
              value={value}
              placeholder="seed words, zpub, WIF, or address…"
              onInput={(v) => {
                setValue(v);
                if (error) setError(null);
              }}
              onSubmit={() => submitSecret(value)}
            />
            <text fg={error ? THEME.accentMagenta : THEME.fgDim}>
              {error ?? "Enter to continue · Esc to go back"}
            </text>
          </Panel>
        </box>
      ) : null}

      {step === "create" && mnemonic ? (
        <box width="80%" height={12} flexGrow={0}>
          <Panel title="New seed" state="active" accent="magenta" height="100%">
            <text fg={THEME.fgDim}>
              Write down these 12 words. Anyone with them can spend your bitcoin.
            </text>
            <SeedGrid words={mnemonic.split(" ")} />
            <text fg={THEME.fgDim}>
              {busy
                ? "Saving…"
                : "Enter to continue · Esc to discard and go back"}
            </text>
          </Panel>
        </box>
      ) : null}

      {step === "year" ? (
        <box width="80%" height={16} flexGrow={0}>
          <Panel title="Sync from" state="active" accent="magenta" height="100%">
            <text fg={THEME.fgDim}>
              What year was the first transaction for this wallet?
            </text>
            <select
              focused={!busy}
              options={options}
              selectedIndex={selectedIndex}
              showDescription={false}
              showScrollIndicator
              height={10}
              onChange={(index) => setSelectedIndex(index)}
              onSelect={(index) => confirmYear(index)}
            />
            <text fg={THEME.fgDim}>
              {busy ? "Saving…" : "↑/↓ to choose · Enter to confirm"}
            </text>
          </Panel>
        </box>
      ) : null}
    </box>
  );
}
