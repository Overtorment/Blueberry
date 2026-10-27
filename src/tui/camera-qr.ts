import { spawn, type ChildProcess } from "node:child_process";
import { parseBip21 } from "../parse/bip21.ts";
import { parseBtcToSats } from "../parse/format.ts";
import { isPaymentDestinationValid } from "../wallet/payment-destination.ts";

const MAX_QR_BYTES = 4096;
const MAX_MONEY_SATS = 21_000_000n * 100_000_000n;

export type CameraPayment = {
  address: string;
  amount: string | null;
  label: string | null;
};

/** Camera data remains untrusted; only populate the editable send form. */
export function parseCameraPayment(input: string): CameraPayment {
  if (Buffer.byteLength(input, "utf8") > MAX_QR_BYTES) {
    throw new Error("Camera QR is too large");
  }
  const value = input.trim();
  if (!value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error("Camera QR is not a Bitcoin payment request");
  }
  if (/^bitcoin:/i.test(value)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      throw new Error("Camera QR contains invalid URI encoding");
    }
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(decoded)) {
      throw new Error("Camera QR contains invalid control characters");
    }
  }
  const parsed = parseBip21(value);
  if (/^bitcoin:/i.test(value) && !parsed) {
    throw new Error("Camera QR contains an unsupported Bitcoin payment request");
  }
  const payment = parsed ?? { address: value, amount: null, label: null };
  if (!isPaymentDestinationValid(payment.address)) {
    throw new Error("Camera QR does not contain a valid Bitcoin mainnet address");
  }
  // Do not allow terminal control codes hidden behind percent encoding.
  if (payment.label && /[\u0000-\u001f\u007f-\u009f]/u.test(payment.label)) {
    throw new Error("Camera QR contains an invalid payment label");
  }
  if (payment.amount !== null) {
    const sats = parseBtcToSats(payment.amount);
    if (sats === null || sats <= 0n || sats > MAX_MONEY_SATS) {
      throw new Error("Camera QR contains an invalid Bitcoin amount");
    }
  }
  return payment;
}

export type CameraScanOptions = {
  signal?: AbortSignal;
  /** A local V4L2 device; cannot be a URL or command-line option. */
  device?: string;
  timeoutMs?: number;
};

type StartCamera = (args: string[]) => ChildProcess;

/** Process creation is the sole platform seam; tests never open a camera. */
export function createCameraQrScanner(
  start: StartCamera = (args) =>
    spawn("zbarcam", args, {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    }),
) {
  return (options: CameraScanOptions = {}): Promise<CameraPayment> => {
    if (options.signal?.aborted) {
      return Promise.reject(new Error("Camera scan cancelled"));
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      return Promise.reject(new Error("Camera timeout must be between 1 and 60000 milliseconds"));
    }
    const device = options.device ?? process.env.BLUEBERRY_CAMERA_DEVICE;
    if (device !== undefined && !/^\/dev\/video\d+$/.test(device)) {
      return Promise.reject(new Error("Camera device must be a local /dev/video device"));
    }
    // Raw one-shot output has no trailing newline. Disable other barcode types
    // and DBus so requests remain within this process's private stdout pipe.
    const args = [
      "--quiet", "--raw", "--oneshot", "--nodisplay", "--nodbus",
      "--set=*.enable=0", "--set=qrcode.enable=1",
      ...(device ? [device] : []),
    ];
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = start(args);
      } catch {
        reject(new Error("Camera scanner unavailable: install zbarcam and connect a supported camera"));
        return;
      }
      let settled = false;
      let closed = false;
      let bytes = 0;
      const chunks: Buffer[] = [];
      const stopCamera = () => {
        if (closed) return;
        child.kill("SIGTERM");
        const hardStop = setTimeout(() => {
          if (!closed) child.kill("SIGKILL");
        }, 250);
        hardStop.unref();
      };
      const finish = (error?: Error, payment?: CameraPayment) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) {
          stopCamera();
          reject(error);
        } else {
          resolve(payment!);
        }
      };
      const abort = () => finish(new Error("Camera scan cancelled"));
      const timer = setTimeout(() => finish(new Error("Camera scan timed out; try again")), timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      // An injected/platform start may synchronously abort before registration.
      if (options.signal?.aborted) abort();
      child.once("error", () => finish(new Error("Camera scanner unavailable: install zbarcam and connect a supported camera")));
      child.stdout?.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > MAX_QR_BYTES) {
          finish(new Error("Camera QR is too large"));
          return;
        }
        chunks.push(data);
      });
      child.once("close", (code) => {
        closed = true;
        if (settled) return;
        if (code !== 0) {
          finish(new Error("Camera scanner failed: check camera access and zbarcam support"));
          return;
        }
        try {
          finish(undefined, parseCameraPayment(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Invalid camera QR"));
        }
      });
      if (!child.stdout) finish(new Error("Camera scanner has no output stream"));
    });
  };
}

export const scanCameraQr = createCameraQrScanner();
