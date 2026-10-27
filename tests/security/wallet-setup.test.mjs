import assert from "node:assert/strict";
import { test } from "node:test";
import { createWalletSetup } from "../../src/boot/wallet-setup.ts";

const SECRET = "disposable fixture only";
const PASSWORD = "a disposable test password";
const CIPHER = `bbenc1.${"01".repeat(16)}:${"02".repeat(12)}:${"03".repeat(16)}:abcd`;

function fixture(encrypt = async () => CIPHER) {
  const writes = [];
  const setup = createWalletSetup({
    parse: (raw) => raw.trim(),
    encrypt,
    commit: (...args) => writes.push(args),
  });
  return { setup, writes };
}

test("import or creation writes nothing until password protection completes", async () => {
  for (const created of [false, true]) {
    const { setup, writes } = fixture();
    setup.stage(SECRET);
    assert.deepEqual(writes, []);
    assert.equal(await setup.save(2026, PASSWORD, created), SECRET);
    assert.deepEqual(writes, [[CIPHER, 2026, created]]);
    await assert.rejects(setup.save(2026, PASSWORD), /No wallet/);
  }
});

test("short password and encryption failure leave storage untouched", async () => {
  const { setup, writes } = fixture(async () => { throw new Error("encryption unavailable"); });
  setup.stage(SECRET);
  await assert.rejects(setup.save(2026, "short"), /12 characters/);
  await assert.rejects(setup.save(2026, PASSWORD), /encryption unavailable/);
  assert.deepEqual(writes, []);
});

test("an encryptor returning plaintext cannot persist it", async () => {
  const { setup, writes } = fixture(async (secret) => secret);
  setup.stage(SECRET);
  await assert.rejects(setup.save(2026, PASSWORD), /encryption failed/);
  assert.deepEqual(writes, []);
});

test("cancel during encryption prevents a late write and duplicate save is rejected", async () => {
  let finish;
  const { setup, writes } = fixture(() => new Promise((resolve) => { finish = resolve; }));
  setup.stage(SECRET);
  const saving = setup.save(2026, PASSWORD);
  await assert.rejects(setup.save(2026, PASSWORD), /already saving/);
  setup.cancel();
  finish(CIPHER);
  await assert.rejects(saving, /cancelled/);
  assert.deepEqual(writes, []);
});

test("a failed database transaction can be retried without staging the secret again", async () => {
  let calls = 0;
  const setup = createWalletSetup({
    parse: (value) => value,
    encrypt: async () => CIPHER,
    commit: () => { if (++calls === 1) throw new Error("disk full"); },
  });
  setup.stage(SECRET);
  await assert.rejects(setup.save(2026, PASSWORD), /disk full/);
  assert.equal(await setup.save(2026, PASSWORD), SECRET);
  assert.equal(calls, 2);
});
