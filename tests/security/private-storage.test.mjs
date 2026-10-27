import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDataDir, listDataDirs } from "../../src/boot/data-dir.ts";
import { secureDatabaseFiles } from "../../src/storage/private-files.ts";

function withDirectory(run) {
  const root = mkdtempSync(join(tmpdir(), "blueberry-private-storage-"));
  const old = process.umask(0);
  try { run(root); } finally { process.umask(old); rmSync(root, { recursive: true, force: true }); }
}

test("new wallet directory is private even with umask 000", () => {
  withDirectory((root) => {
    const wallet = join(root, "wallet.data");
    ensureDataDir(wallet);
    assert.equal(statSync(wallet).mode & 0o777, 0o700);
  });
});

test("database and existing sidecars are 600 without changing contents or parent permissions", () => {
  withDirectory((root) => {
    const path = join(root, "wallet.sqlite");
    chmodSync(root, 0o755);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      writeFileSync(path + suffix, "fixture", { mode: 0o666 });
    }
    secureDatabaseFiles(path);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      assert.equal(statSync(path + suffix).mode & 0o777, 0o600);
      assert.equal(readFileSync(path + suffix, "utf8"), "fixture");
    }
    assert.equal(statSync(root).mode & 0o777, 0o755);
  });
});

test("database creation is private and absent sidecars are not created", () => {
  withDirectory((root) => {
    const path = join(root, "new.sqlite");
    secureDatabaseFiles(path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => statSync(path + "-wal"), { code: "ENOENT" });
  });
});

test("database symlinks and hard links fail without touching the target", () => {
  withDirectory((root) => {
    const target = join(root, "target");
    writeFileSync(target, "fixture", { mode: 0o644 });
    const path = join(root, "wallet.sqlite");
    symlinkSync(target, path);
    assert.throws(() => secureDatabaseFiles(path));
    rmSync(path);
    linkSync(target, path);
    assert.throws(() => secureDatabaseFiles(path), /hard links/);
    assert.equal(statSync(target).mode & 0o777, 0o644);
    assert.equal(readFileSync(target, "utf8"), "fixture");
  });
});

test("symlinked WAL is rejected without modifying its target", () => {
  withDirectory((root) => {
    const target = join(root, "target");
    writeFileSync(target, "fixture", { mode: 0o644 });
    const path = join(root, "wallet.sqlite");
    symlinkSync(target, path + "-wal");
    assert.throws(() => secureDatabaseFiles(path));
    assert.equal(statSync(target).mode & 0o777, 0o644);
  });
});

test("existing wallet directory is tightened before access", () => {
  withDirectory((root) => {
    const wallet = join(root, "wallet.data");
    mkdirSync(wallet);
    chmodSync(wallet, 0o777);
    ensureDataDir(wallet);
    assert.equal(statSync(wallet).mode & 0o777, 0o700);
  });
});

test("wallet selection ignores symlinks and opening one fails without changing its target", () => {
  withDirectory((root) => {
    const target = join(root, "target");
    mkdirSync(target, { mode: 0o755 });
    const link = join(root, "wallet.data");
    symlinkSync(target, link);
    assert.deepEqual(listDataDirs(root), []);
    assert.throws(() => ensureDataDir(link), /symlink|symbolic|directory/i);
    assert.equal(statSync(target).mode & 0o777, 0o755);
  });
});
