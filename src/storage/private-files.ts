import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
} from "node:fs";

function requirePosixPermissions(): void {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    throw new Error("Private wallet storage requires POSIX permissions; use WSL on Windows");
  }
}

function secureDescriptor(fd: number, directory: boolean): void {
  const stat = fstatSync(fd);
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) {
    throw new Error("Wallet storage must be an ordinary directory or a file without hard links");
  }
  if (stat.uid !== process.getuid!()) {
    throw new Error("Wallet storage is owned by another user");
  }
  const mode = directory ? 0o700 : 0o600;
  fchmodSync(fd, mode);
  if ((fstatSync(fd).mode & 0o777) !== mode) {
    throw new Error("Filesystem cannot enforce private wallet permissions");
  }
}

export function ensurePrivateDirectory(path: string): void {
  requirePosixPermissions();
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // Check and chmod the opened object, never the target of a symbolic link.
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    secureDescriptor(fd, true);
  } finally {
    closeSync(fd);
  }
}

function secureFile(path: string, create: boolean): void {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | (create ? constants.O_CREAT : 0),
      0o600,
    );
  } catch (err) {
    if (!create && (err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    secureDescriptor(fd, false);
  } finally {
    closeSync(fd);
  }
}

/** Apply before opening SQLite and after it creates its sidecars. Never chmod a parent directory. */
export function secureDatabaseFiles(path: string): void {
  if (path === ":memory:") return;
  requirePosixPermissions();
  secureFile(path, true);
  for (const suffix of ["-wal", "-shm", "-journal"]) secureFile(path + suffix, false);
}
