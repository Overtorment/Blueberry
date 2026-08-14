import { useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { isSendMaxAmount, parseBtcToSats } from "../../parse/format.ts";
import type { BuildSendResult } from "../../wallet/build-send-tx.ts";
import { isAddressValid } from "../../wallet/is-address-valid.ts";
import {
  broadcastJobInFlight,
  cancelBroadcast,
  inFlightBroadcastEscape,
  previewOwnsBroadcastJob,
  previewShowsBroadcastUi,
  startUiBroadcast,
} from "../broadcast-actions.ts";
import { fitCryptoPsbtUrQr } from "../fit-ur-qr.ts";
import { buildActiveSendTx, pickUtxosByKeys } from "../send-context.ts";
import { THEME } from "../theme.ts";
import { qrAsciiLinesFitting, qrAsciiLinesCompact } from "../qr-ascii.ts";
import { useBroadcast, useBroadcastStore } from "../use-broadcast.ts";
import { useReceiveAddress } from "../use-receive-address.ts";
import { useUiRouteStore } from "../use-ui-route.ts";
import { useWalletTxs } from "../use-wallet-txs.ts";
import { setUtxoName } from "../utxo-names-actions.ts";
import { utxoListScrollTop } from "../utxo-list-window.ts";
import type { WalletUtxoRow } from "../wallet-txs-store.ts";
import { BtcAmount } from "./BtcAmount.tsx";

export type WalletModalProps = {
  kind: "receive" | "send";
};

type SendStep = "utxos" | "details" | "feerate" | "preview";

type SendDetails = {
  toAddress: string;
  amountSats: bigint | "max";
};

/** BlueWallet DynamicQRCode interval. */
const UR_QR_INTERVAL_MS = 1000;

function ReceiveBody(props: { address: string; qrLines: string[] }) {
  const qrW = props.qrLines[0]?.length ?? 0;
  const qrH = props.qrLines.length;
  return (
    <box flexDirection="column" alignItems="center" gap={1} shouldFill={false}>
      {/* Light plate + dark ink — required for phone cameras to lock on. */}
      <box
        width={qrW}
        height={qrH}
        flexShrink={0}
        backgroundColor={THEME.fg}
        shouldFill
        flexDirection="column"
      >
        {props.qrLines.map((line, i) => (
          <text key={i} fg={THEME.bg} bg={THEME.fg} wrapMode="none">
            {line}
          </text>
        ))}
      </box>
      <text fg={THEME.accentMagenta} wrapMode="none">
        {props.address}
      </text>
    </box>
  );
}

function isFeerateValid(input: string): boolean {
  const t = input.trim();
  if (!t || !/^\d+(\.\d+)?$/.test(t)) return false;
  const n = Number(t);
  return Number.isFinite(n) && n > 0;
}

function FeeHelpLine(props: {
  preview: BuildSendResult;
  label: string;
  toAddress: string;
  amountSats: bigint | "max";
  inputSum: bigint;
}) {
  const paid =
    props.amountSats === "max"
      ? props.inputSum - props.preview.feeSats - props.preview.changeSats
      : props.amountSats;
  return (
    <text fg={THEME.fgDim}>
      {`${props.label} · ${props.toAddress} · `}
      <BtcAmount sats={paid} />
      {props.amountSats === "max" ? " max" : null}
      {` · fee `}
      <BtcAmount sats={props.preview.feeSats} />
      {` (${props.preview.vsize} vB)`}
      {props.preview.changeSats > 0n ? (
        <>
          {" · change "}
          <BtcAmount sats={props.preview.changeSats} />
        </>
      ) : null}
      {" · Esc to close"}
    </text>
  );
}

function UtxoLine(props: {
  utxo: WalletUtxoRow;
  checked: boolean;
  focused: boolean;
}) {
  const mark = props.checked ? "[x]" : "[ ]";
  const fg = props.focused ? THEME.accentCyan : THEME.fg;
  const nameSuffix = props.utxo.name ? `  ${props.utxo.name}` : "";
  return (
    <text fg={fg} wrapMode="none">
      {`${mark} `}
      <BtcAmount sats={props.utxo.valueSats} fg={fg} />
      {`  ${props.utxo.outpointShort}  ${props.utxo.ageLabel}  ${props.utxo.valueBar}${nameSuffix}`}
    </text>
  );
}

function AnimatedUrQr(props: { psbtHex: string }) {
  const { width: termW, height: termH } = useTerminalDimensions();
  const [index, setIndex] = useState(0);

  // Modal ~95% with padding/border/help/part label — keep QR inside the viewport.
  const maxQrW = Math.max(16, Math.floor(termW * 0.95) - 6);
  const maxQrH = Math.max(8, Math.floor(termH * 0.95) - 7);

  const { parts } = useMemo(() => {
    try {
      return fitCryptoPsbtUrQr(props.psbtHex, maxQrW, maxQrH);
    } catch {
      return { parts: [] as string[], capacity: 0 };
    }
  }, [props.psbtHex, maxQrW, maxQrH]);

  const part = parts[index] ?? parts[0] ?? "";
  const qrLines = useMemo(() => {
    if (!part) return [];
    try {
      return qrAsciiLinesCompact(part);
    } catch {
      return [];
    }
  }, [part]);
  const qrW = qrLines[0]?.length ?? 0;
  const qrH = qrLines.length;

  useEffect(() => {
    setIndex(0);
  }, [parts]);

  useEffect(() => {
    if (parts.length <= 1) return;
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % parts.length);
    }, UR_QR_INTERVAL_MS);
    return () => clearInterval(id);
  }, [parts]);

  if (qrLines.length === 0) {
    return <text fg={THEME.error}>Failed to render PSBT QR</text>;
  }

  return (
    <box
      flexGrow={1}
      width="100%"
      justifyContent="center"
      alignItems="center"
      flexDirection="column"
      gap={1}
      overflow="hidden"
    >
      <box
        width={qrW}
        height={qrH}
        flexShrink={0}
        backgroundColor={THEME.fg}
        shouldFill
        flexDirection="column"
      >
        {qrLines.map((line, i) => (
          <text key={i} fg={THEME.bg} bg={THEME.fg} wrapMode="none">
            {line}
          </text>
        ))}
      </box>
      <text fg={THEME.fgDim}>
        {parts.length > 1
          ? `BC-UR v2 · part ${index + 1}/${parts.length}`
          : "BC-UR v2 · crypto-psbt"}
      </text>
    </box>
  );
}

function BroadcastProgressBody() {
  const b = useBroadcast();
  const lines: string[] = [];
  if (b.phase === "waiting-peers") {
    lines.push("Waiting for alive peers…");
    lines.push(b.detail ?? "Need at least one probed-alive peer");
  } else if (b.phase === "attempt") {
    const n = b.attempt ?? "?";
    const max = b.maxAttempts ?? 20;
    lines.push(`Attempt ${n}/${max}`);
    if (b.peer) lines.push(b.peer);
    if (b.detail) lines.push(b.detail);
  } else if (b.phase === "success") {
    lines.push("Broadcast succeeded");
    if (b.peer) lines.push(b.peer);
    if (b.detail) lines.push(b.detail);
  } else if (b.phase === "error") {
    lines.push("Broadcast failed");
    if (b.peer) lines.push(`last peer: ${b.peer}`);
    if (b.error) lines.push(b.error);
  } else {
    lines.push("Broadcasting…");
  }
  lines.push("");
  lines.push(
    b.phase === "success" || b.phase === "error"
      ? "Esc to close"
      : "Esc cancels broadcast",
  );

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      gap={1}
      overflow="hidden"
    >
      <text fg={THEME.accentCyan}>Broadcasting via Tor</text>
      {lines.map((line, i) => (
        <text key={i} fg={THEME.fgDim} wrapMode="word">
          {line}
        </text>
      ))}
    </box>
  );
}

function SignedTxPreviewBody(props: {
  txHex: string;
  preview: BuildSendResult;
  toAddress: string;
  amountSats: bigint | "max";
  inputSum: bigint;
}) {
  const broadcast = useBroadcast();
  const broadcastStore = useBroadcastStore();
  const showBroadcast = previewShowsBroadcastUi(
    broadcast.phase,
    broadcast.txHex,
    props.txHex,
  );

  useKeyboard((key) => {
    if (key.name !== "return" && key.name !== "enter") return;
    if (key.repeated) return;
    if (!broadcastStore) return;
    startUiBroadcast(broadcastStore, props.txHex);
  });

  if (showBroadcast) {
    return <BroadcastProgressBody />;
  }

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      gap={1}
      overflow="hidden"
    >
      <FeeHelpLine
        preview={props.preview}
        label="Signed tx"
        toAddress={props.toAddress}
        amountSats={props.amountSats}
        inputSum={props.inputSum}
      />
      <text fg={THEME.fgDim}>Transaction hex (broadcast-ready)</text>
      <scrollbox
        flexGrow={1}
        width="100%"
        scrollX={false}
        scrollY
        rootOptions={{ backgroundColor: THEME.bg }}
        viewportOptions={{ backgroundColor: THEME.bg }}
        contentOptions={{ backgroundColor: THEME.bg }}
        scrollbarOptions={{
          trackOptions: {
            foregroundColor: THEME.accentCyan,
            backgroundColor: THEME.borderIdle,
          },
        }}
      >
        <text fg={THEME.fg} wrapMode="char">
          {props.txHex}
        </text>
      </scrollbox>
      <text fg={THEME.accentCyan}>▸ Broadcast</text>
      <text fg={THEME.fgDim}>Enter to broadcast · Esc to close</text>
    </box>
  );
}

function SendPreviewBody(props: {
  preview: BuildSendResult;
  details: SendDetails;
  inputSum: bigint;
}) {
  if (props.preview.kind === "psbt") {
    return (
      <box
        width="100%"
        height="100%"
        flexDirection="column"
        gap={1}
        overflow="hidden"
      >
        <FeeHelpLine
          preview={props.preview}
          label="Unsigned PSBT · scan to sign"
          toAddress={props.details.toAddress}
          amountSats={props.details.amountSats}
          inputSum={props.inputSum}
        />
        <AnimatedUrQr psbtHex={props.preview.psbtHex} />
      </box>
    );
  }

  return (
    <SignedTxPreviewBody
      txHex={props.preview.txHex}
      preview={props.preview}
      toAddress={props.details.toAddress}
      amountSats={props.details.amountSats}
      inputSum={props.inputSum}
    />
  );
}

function SendFeerateForm(props: {
  onContinue: (feeRateSatPerVb: number) => string | null;
}) {
  const [feerate, setFeerate] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useKeyboard((key) => {
    if (key.name === "return" || key.name === "enter") {
      if (!isFeerateValid(feerate)) {
        setInvalid(true);
        setError(null);
        return;
      }
      setInvalid(false);
      const err = props.onContinue(Number(feerate.trim()));
      if (err) {
        setError(err);
        setInvalid(true);
      }
    }
  });

  const color = invalid ? THEME.error : undefined;

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      gap={1}
      overflow="hidden"
    >
      <text fg={THEME.fgDim}>Fee rate (sat/vB) · Esc to close</text>
      <text fg={invalid ? THEME.error : THEME.fgDim}>Fee rate</text>
      <input
        focused
        value={feerate}
        placeholder="1"
        textColor={color}
        focusedTextColor={color}
        onInput={(v) => {
          setFeerate(v);
          if (invalid) setInvalid(false);
          if (error) setError(null);
        }}
      />
      {error ? <text fg={THEME.error}>{error}</text> : null}
    </box>
  );
}

function SendDetailsForm(props: {
  selectedSumSats: bigint;
  onContinue: (details: SendDetails) => void;
}) {
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [field, setField] = useState<"address" | "amount">("address");
  const [addressInvalid, setAddressInvalid] = useState(false);
  const [amountInvalid, setAmountInvalid] = useState(false);

  useKeyboard((key) => {
    if (key.name === "up") {
      setField("address");
      return;
    }
    if (key.name === "down") {
      setField("amount");
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      if (!isAddressValid(address)) {
        setAddressInvalid(true);
        setAmountInvalid(false);
        setField("address");
        return;
      }
      setAddressInvalid(false);
      if (isSendMaxAmount(amount)) {
        setAmountInvalid(false);
        props.onContinue({ toAddress: address.trim(), amountSats: "max" });
        return;
      }
      const sats = parseBtcToSats(amount);
      if (sats === null || sats <= 0n || sats > props.selectedSumSats) {
        setAmountInvalid(true);
        setField("amount");
        return;
      }
      setAmountInvalid(false);
      props.onContinue({ toAddress: address.trim(), amountSats: sats });
    }
  });

  const addressColor = addressInvalid ? THEME.error : undefined;
  const amountColor = amountInvalid ? THEME.error : undefined;

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      gap={1}
      overflow="hidden"
    >
      <text fg={THEME.fgDim}>
        {"Selected "}
        <BtcAmount sats={props.selectedSumSats} />
        {" · ↑/↓ to switch · Esc to close"}
      </text>
      <text fg={addressInvalid ? THEME.error : THEME.fgDim}>Address</text>
      <input
        focused={field === "address"}
        value={address}
        placeholder="bc1…"
        textColor={addressColor}
        focusedTextColor={addressColor}
        onInput={(v) => {
          setAddress(v);
          if (addressInvalid) setAddressInvalid(false);
        }}
      />
      <text fg={amountInvalid ? THEME.error : THEME.fgDim}>Amount</text>
      <input
        focused={field === "amount"}
        value={amount}
        placeholder="0.00000000"
        textColor={amountColor}
        focusedTextColor={amountColor}
        onInput={(v) => {
          setAmount(v);
          if (amountInvalid) setAmountInvalid(false);
        }}
      />
    </box>
  );
}

function SendBody(props: {
  step: SendStep;
  selectedKeys: string[];
  details: SendDetails | null;
  previewInputSum: bigint;
  onUtxosContinue: (keys: string[]) => void;
  onDetailsContinue: (details: SendDetails) => void;
  onFeerateContinue: (feeRateSatPerVb: number) => string | null;
  preview: BuildSendResult | null;
  onRenamingChange?: (renaming: boolean) => void;
}) {
  const { utxos } = useWalletTxs();
  const { height: termHeight } = useTerminalDimensions();
  const [focused, setFocused] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(props.selectedKeys),
  );
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameKey, setRenameKey] = useState<string | null>(null);

  function beginRename() {
    const row = utxos[focused];
    if (!row) return;
    setRenameKey(row.key);
    setRenameDraft(row.name ?? "");
    setRenaming(true);
    props.onRenamingChange?.(true);
  }

  function endRename(save: boolean) {
    if (save && renameKey) {
      setUtxoName(renameKey, renameDraft);
    }
    setRenameKey(null);
    setRenaming(false);
    props.onRenamingChange?.(false);
  }

  // Modal chrome + title line; keep list inside the terminal.
  const visibleRows = Math.max(3, Math.min(16, termHeight - 10));

  function moveFocus(next: number) {
    setFocused(next);
    setScrollTop((s) => utxoListScrollTop(next, s, visibleRows, utxos.length));
  }

  useEffect(() => {
    if (utxos.length === 0) {
      setFocused(0);
      setScrollTop(0);
      return;
    }
    setFocused((i) => {
      const next = Math.min(i, utxos.length - 1);
      setScrollTop((s) =>
        utxoListScrollTop(next, s, visibleRows, utxos.length),
      );
      return next;
    });
  }, [utxos.length, visibleRows]);

  useKeyboard((key) => {
    if (props.step !== "utxos") return;

    if (renaming) {
      if (key.name === "escape" || key.name === "esc") {
        endRename(false);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        endRename(true);
        return;
      }
      return;
    }

    if (utxos.length === 0) return;
    if (key.name === "up") {
      moveFocus(Math.max(0, focused - 1));
      return;
    }
    if (key.name === "down") {
      moveFocus(Math.min(utxos.length - 1, focused + 1));
      return;
    }
    if (key.name === "r") {
      beginRename();
      return;
    }
    if (key.name === "space") {
      const row = utxos[focused];
      if (!row) return;
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(row.key)) next.delete(row.key);
        else next.add(row.key);
        return next;
      });
      return;
    }
    if (
      (key.name === "return" || key.name === "enter") &&
      checked.size > 0
    ) {
      props.onUtxosContinue([...checked]);
    }
  });

  const windowStart = utxoListScrollTop(
    focused,
    scrollTop,
    visibleRows,
    utxos.length,
  );
  const windowed = utxos.slice(windowStart, windowStart + visibleRows);

  const selectedKeySet = props.step === "utxos" ? checked : new Set(props.selectedKeys);
  let selectedSum = 0n;
  for (const u of utxos) {
    if (selectedKeySet.has(u.key)) selectedSum += u.valueSats;
  }
  if (props.step === "preview" && props.preview && props.details) {
    return (
      <SendPreviewBody
        preview={props.preview}
        details={props.details}
        inputSum={props.previewInputSum}
      />
    );
  }

  if (props.step === "feerate") {
    return <SendFeerateForm onContinue={props.onFeerateContinue} />;
  }

  if (props.step === "details") {
    return (
      <SendDetailsForm
        selectedSumSats={selectedSum}
        onContinue={props.onDetailsContinue}
      />
    );
  }

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      gap={1}
      overflow="hidden"
    >
      <text fg={THEME.fgDim}>
        {checked.size > 0 ? (
          <>
            {"Select UTXOs ("}
            <BtcAmount sats={selectedSum} />
            {") · Esc to close · R to rename · Space to select · Enter to continue"}
          </>
        ) : (
          "Esc to close · R to rename · Space to select · Enter to continue"
        )}
      </text>
      {renaming ? (
        <>
          <text fg={THEME.fgDim}>Rename UTXO</text>
          <input
            focused
            value={renameDraft}
            onInput={setRenameDraft}
          />
        </>
      ) : null}
      {utxos.length === 0 ? (
        <text fg={THEME.fgDim}>No UTXOs</text>
      ) : (
        <box
          width="100%"
          flexGrow={1}
          flexDirection="column"
          overflow="hidden"
        >
          {windowed.map((u, i) => {
            const index = windowStart + i;
            return (
              <UtxoLine
                key={u.key}
                utxo={u}
                checked={checked.has(u.key)}
                focused={index === focused}
              />
            );
          })}
        </box>
      )}
    </box>
  );
}

export function WalletModal({ kind }: WalletModalProps) {
  const recv = useReceiveAddress();
  const uiRouteStore = useUiRouteStore();
  const broadcastStore = useBroadcastStore();
  const { utxos } = useWalletTxs();
  const { width: termW, height: termH } = useTerminalDimensions();
  const [sendStep, setSendStep] = useState<SendStep>("utxos");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [details, setDetails] = useState<SendDetails | null>(null);
  const [preview, setPreview] = useState<BuildSendResult | null>(null);
  const [previewInputSum, setPreviewInputSum] = useState(0n);
  const [utxoRenaming, setUtxoRenaming] = useState(false);
  const [cancelArmedForId, setCancelArmedForId] = useState<string | null>(
    null,
  );
  const accent =
    kind === "receive" ? THEME.accentMagenta : THEME.accentCyan;
  const titleLabel = kind === "receive" ? "Receive" : "Send";

  useEffect(() => {
    if (kind === "send") {
      setSendStep("utxos");
      setSelectedKeys([]);
      setDetails(null);
      setPreview(null);
      setPreviewInputSum(0n);
      setUtxoRenaming(false);
      setCancelArmedForId(null);
      if (!broadcastJobInFlight(broadcastStore?.get().phase)) {
        broadcastStore?.reset();
      }
    }
  }, [kind, broadcastStore]);

  useKeyboard((key) => {
    if (key.name !== "escape" && key.name !== "esc") return;
    if (utxoRenaming) return;
    const snap = broadcastStore?.get();
    const action = inFlightBroadcastEscape(
      snap?.phase,
      snap?.id,
      cancelArmedForId,
    );
    if (
      kind === "send" &&
      sendStep === "preview" &&
      preview?.kind === "signed" &&
      snap?.id &&
      previewOwnsBroadcastJob(snap.txHex, preview.txHex) &&
      action !== "ignore"
    ) {
      cancelBroadcast(snap.id);
      if (action === "force-close") {
        uiRouteStore?.close();
        return;
      }
      setCancelArmedForId(snap.id);
      return;
    }
    if (snap?.phase === "success" || snap?.phase === "error") {
      broadcastStore?.reset();
    }
    uiRouteStore?.close();
  });

  const qrLines = useMemo(() => {
    if (kind !== "receive" || !recv.address) return [];
    return qrAsciiLinesFitting(
      recv.address,
      Math.max(8, termW - 4),
      Math.max(4, termH - 6),
    );
  }, [kind, recv.address, termW, termH]);
  const qrWidth = qrLines[0]?.length ?? 0;
  const qrHeight = qrLines.length;
  const receiveWidth = recv.address
    ? Math.max(qrWidth + 4, recv.address.length + 4)
    : 44;
  const receiveHeight = Math.min(
    termH,
    qrHeight > 0 ? qrHeight + 1 /* address */ + 1 /* gap */ + 4 /* pad+border */ : 8,
  );

  const sendPsbtPreview = kind === "send" && sendStep === "preview" && preview?.kind === "psbt";
  const sendModalWidth = sendPsbtPreview ? "95%" : "80%";
  const sendModalHeight = sendPsbtPreview ? "95%" : "70%";

  return (
    <box
      position="absolute"
      left={0}
      right={0}
      top={0}
      bottom={0}
      zIndex={20}
      justifyContent="center"
      alignItems="center"
      shouldFill={false}
    >
      <box
        width={kind === "receive" ? receiveWidth : sendModalWidth}
        height={kind === "receive" ? receiveHeight : sendModalHeight}
        maxHeight="100%"
        maxWidth="100%"
        overflow="hidden"
        border
        borderStyle="single"
        borderColor={accent}
        title={`◆ ${titleLabel}`}
        titleColor={accent}
        backgroundColor={THEME.bg}
        paddingX={1}
        paddingY={1}
        flexDirection="column"
        gap={1}
        alignItems={kind === "receive" ? "center" : "stretch"}
      >
        {kind === "receive" ? (
          recv.address ? (
            <ReceiveBody address={recv.address} qrLines={qrLines} />
          ) : (
            <text fg={THEME.fgDim}>
              No unused receive address in watch window
            </text>
          )
        ) : (
          <SendBody
            step={sendStep}
            selectedKeys={selectedKeys}
            details={details}
            preview={preview}
            previewInputSum={previewInputSum}
            onRenamingChange={setUtxoRenaming}
            onUtxosContinue={(keys) => {
              setSelectedKeys(keys);
              setSendStep("details");
            }}
            onDetailsContinue={(d) => {
              setDetails(d);
              setSendStep("feerate");
            }}
            onFeerateContinue={(feeRateSatPerVb) => {
              if (!details || selectedKeys.length === 0) {
                return "missing send details";
              }
              const picked = pickUtxosByKeys(utxos, selectedKeys);
              if (!picked.ok) return picked.error;
              const selected = picked.selected;
              let inputSum = 0n;
              for (const u of selected) inputSum += u.valueSats;
              try {
                const result = buildActiveSendTx({
                  utxos: selected.map((u) => ({
                    txid: u.txid,
                    vout: u.vout,
                    valueSats: u.valueSats,
                    scriptPubKey: u.scriptPubKey,
                  })),
                  toAddress: details.toAddress,
                  amountSats: details.amountSats,
                  feeRateSatPerVb,
                });
                setPreview(result);
                setPreviewInputSum(inputSum);
                setSendStep("preview");
                return null;
              } catch (err) {
                return err instanceof Error ? err.message : String(err);
              }
            }}
          />
        )}
      </box>
    </box>
  );
}
