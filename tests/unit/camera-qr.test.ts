import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createCameraQrScanner, parseCameraPayment } from "../../src/tui/camera-qr.ts";

const ADDRESS = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
// BIP47 public reference-vector identity code.
const BIP47_CODE = "PM8TJTLJbPRGxSbc8EJi42Wrr6QbNSaSSVJ5Y3E4pbCYiTHUskHg13935Ubb7q8tx9GVbh2UuRnBc3WSyJHhUrw8KhprKnn9eDznYGieTzFcwQRya4GA";
// BIP352 official vector recipient.
const SILENT_ADDRESS = "sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwv";

function fakeScanner(source: string) {
  return createCameraQrScanner(() => spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "pipe", "ignore"],
  }));
}

describe("camera payment requests", () => {
  test("accepts a mainnet address and populates only the destination", () => {
    expect(parseCameraPayment(ADDRESS)).toEqual({ address: ADDRESS, amount: null, label: null });
  });

  test("decodes a BIP21 payment into editable send fields", () => {
    expect(parseCameraPayment(`bitcoin:${ADDRESS}?amount=0.00012345&label=Coffee%20shop`)).toEqual({
      address: ADDRESS, amount: "0.00012345", label: "Coffee shop",
    });
  });

  test("accepts Silent Payments codes directly and through BIP21", () => {
    expect(parseCameraPayment(SILENT_ADDRESS)).toEqual({ address: SILENT_ADDRESS, amount: null, label: null });
    expect(parseCameraPayment(`bitcoin:${SILENT_ADDRESS}?amount=0.01&label=Coffee`)).toEqual({
      address: SILENT_ADDRESS, amount: "0.01", label: "Coffee",
    });
    expect(() => parseCameraPayment(SILENT_ADDRESS.slice(0, -1) + "q")).toThrow("mainnet");
  });

  test("accepts BIP47 codes directly and through BIP21", () => {
    expect(parseCameraPayment(BIP47_CODE)).toEqual({ address: BIP47_CODE, amount: null, label: null });
    expect(parseCameraPayment(`bitcoin:${BIP47_CODE}?amount=0.01&label=Alice`)).toEqual({
      address: BIP47_CODE, amount: "0.01", label: "Alice",
    });
    expect(() => parseCameraPayment(BIP47_CODE.slice(0, -1) + "1")).toThrow("mainnet");
  });

  test("rejects unsupported QR types and networks", () => {
    for (const value of ["https://example.com", "lnbc1dummy", "bitcoin:", "not-an-address", "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn"])
      expect(() => parseCameraPayment(value)).toThrow();
  });

  test("rejects unknown required BIP21 extensions", () => {
    expect(() => parseCameraPayment(`bitcoin:${ADDRESS}?req-payjoin=1`)).toThrow("unsupported");
  });

  test("rejects malformed, negative, zero, too precise and excessive URI amounts", () => {
    for (const amount of ["abc", "-1", "0", "0.000000001", "21000001", "max", ""])
      expect(() => parseCameraPayment(`bitcoin:${ADDRESS}?amount=${amount}`)).toThrow("amount");
  });

  test("rejects control characters and multiple scanned requests", () => {
    expect(() => parseCameraPayment(`${ADDRESS}\n${ADDRESS}`)).toThrow();
    expect(() => parseCameraPayment(`bitcoin:${ADDRESS}?label=%1B%5B31m`)).toThrow("control");
    expect(() => parseCameraPayment(`bitcoin:${ADDRESS}?label=%0A`)).toThrow("control");
  });

  test("rejects malformed percent encoding rather than ignoring request fields", () => {
    expect(() => parseCameraPayment(`bitcoin:${ADDRESS}?amount=%ZZ`)).toThrow("encoding");
  });

  test("bounds QR payloads by encoded bytes", () => {
    expect(() => parseCameraPayment("x".repeat(4097))).toThrow("too large");
    expect(() => parseCameraPayment(`bitcoin:${ADDRESS}?label=${"🙂".repeat(1100)}`)).toThrow("too large");
  });
});

describe("camera process lifecycle", () => {
  test("requests one local QR without a shell, display or DBus", async () => {
    let args: string[] = [];
    const scan = createCameraQrScanner((received) => {
      args = received;
      return spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(ADDRESS)})`], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    });
    expect(await scan({ device: "/dev/video2" })).toEqual({ address: ADDRESS, amount: null, label: null });
    expect(args).toEqual(["--quiet", "--raw", "--oneshot", "--nodisplay", "--nodbus", "--set=*.enable=0", "--set=qrcode.enable=1", "/dev/video2"]);
  });

  test("waits for complete chunked output before parsing", async () => {
    const scan = fakeScanner(`process.stdout.write('bitcoin:${ADDRESS}?amount='); setTimeout(() => process.stdout.write('0.01&label=rent'), 15)`);
    expect(await scan()).toEqual({ address: ADDRESS, amount: "0.01", label: "rent" });
  });

  test("does not accept output from a failed process", async () => {
    const scan = fakeScanner(`process.stdout.write('${ADDRESS}'); process.exitCode = 1`);
    await expect(scan()).rejects.toThrow("scanner failed");
  });

  test("missing dependency becomes an actionable form error", async () => {
    const scan = createCameraQrScanner(() => spawn("/no-such-blueberry-zbarcam", []));
    await expect(scan()).rejects.toThrow("install zbarcam");
  });

  test("rejects non-local camera input before starting a process", async () => {
    let starts = 0;
    const scan = createCameraQrScanner(() => { starts++; throw new Error("must not start"); });
    for (const device of ["https://camera.example", "--help", "/dev/video0;touch /tmp/marker"])
      await expect(scan({ device })).rejects.toThrow("local /dev/video");
    expect(starts).toBe(0);
  });

  test("already cancelled scans never open the camera", async () => {
    let starts = 0;
    const scan = createCameraQrScanner(() => { starts++; throw new Error("must not start"); });
    const controller = new AbortController();
    controller.abort();
    await expect(scan({ signal: controller.signal })).rejects.toThrow("cancelled");
    expect(starts).toBe(0);
  });

  test("cancel closes an active camera process", async () => {
    let child: ReturnType<typeof spawn> | undefined;
    const scan = createCameraQrScanner(() => {
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
      return child;
    });
    const controller = new AbortController();
    const result = scan({ signal: controller.signal });
    const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
    controller.abort();
    await expect(result).rejects.toThrow("cancelled");
    await closed;
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
  });

  test("forces a scanner closed if it ignores cancellation", async () => {
    const controller = new AbortController();
    let child: ReturnType<typeof spawn> | undefined;
    const scan = createCameraQrScanner(() => {
      child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stderr.write('ready'); setInterval(() => {}, 1000)"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stderr!.once("data", () => controller.abort());
      return child;
    });
    const result = scan({ signal: controller.signal });
    const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
    await expect(result).rejects.toThrow("cancelled");
    await closed;
    expect(child!.signalCode).toBe("SIGKILL");
  });

  test("times out rather than leaving the camera open", async () => {
    const scan = fakeScanner("setInterval(() => {}, 1000)");
    await expect(scan({ timeoutMs: 20 })).rejects.toThrow("timed out");
  });

  test("rejects oversized scanner output while it is still running", async () => {
    const scan = fakeScanner("process.stdout.write('x'.repeat(4097)); setInterval(() => {}, 1000)");
    await expect(scan()).rejects.toThrow("too large");
  });

  test("refuses timeout settings that remove the scan bound", async () => {
    for (const timeoutMs of [0, -1, Infinity, NaN, 60_001])
      await expect(fakeScanner("")({ timeoutMs })).rejects.toThrow("timeout");
  });
});
