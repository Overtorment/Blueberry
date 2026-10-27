import { expect, test } from "bun:test";
import { buildBasicFilter } from "bip158";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createFiltersMatchingModule } from "../../src/modules/filters-matching.ts";
import { deriveBip47Account, deriveBip47ReceivePayment, paymentCodeFromAccount } from "../../src/wallet/bip47.ts";
import { createBip47Channels } from "../../src/wallet/bip47-channels.ts";
import { BIP47_ENABLED_KEY } from "../../src/wallet/bip47-wallet.ts";
import { createWallet } from "../../src/wallet/wallet.ts";

const ALICE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BOB = "legal winner thank year wave sausage worth useful legal winner thank yellow";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for BIP47 filter rematch");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("incoming BIP47 channel during an in-flight scan rematches without BIP84 gap growth", async () => {
  const db = createSqliteDatabase(":memory:");
  const bus = createMessageBus();
  db.keyValue.set(BIP47_ENABLED_KEY, "1");
  const wallet = createWallet(db, { secret: BOB, addressGap: 2 });
  const oldGaps = wallet.gaps();
  const senderCode = paymentCodeFromAccount(deriveBip47Account(ALICE));
  const recipientAccount = deriveBip47Account(BOB);
  const incoming = deriveBip47ReceivePayment(recipientAccount, senderCode, 0);
  const hash = "11".repeat(32);
  db.headers.append([{ height: 1, hashInternalHex: hash, header: new Uint8Array(80) }]);
  db.filters.append([{ height: 1, blockHashInternalHex: hash,
    filter: buildBasicFilter({ blockHashDisplay: new Uint8Array(32).fill(0x11), elements: [incoming.scriptPubKey] }) }]);

  let yields = 0;
  let injected = false;
  let hit = false;
  bus.on("filters:match", (match) => { if (match.height === 1) hit = true; });
  const module = createFiltersMatchingModule({ db, bus }, { wallet, batchSize: 1, batchGapMs: 0,
    yieldFn: async () => {
      yields++;
      if (injected || yields < 2) return;
      // The stale pass has already marked this filter scanned without finding
      // its incoming payment. Mimic notification parsing's shared-wallet refresh.
      expect(db.filters.countScanned()).toBe(1);
      injected = true;
      createBip47Channels(db, paymentCodeFromAccount(recipientAccount)).addIncoming(senderCode, "22".repeat(32));
      wallet.refresh();
      expect(wallet.gaps()).toEqual(oldGaps);
      db.filters.markUnscannedFrom(1);
      bus.emit("filters:progress", { at: Date.now(), downloaded: 1, total: 1 });
    } });
  try {
    await module.start();
    await waitFor(() => injected && hit && db.filters.countScanned() === 1);
    expect(db.matchedBlocks.count()).toBe(1);
    expect(wallet.snapshot().addresses.some((address) => address.address === incoming.address)).toBe(true);
    expect(wallet.gaps()).toEqual(oldGaps);
  } finally {
    await module.stop();
    db.close();
  }
});
