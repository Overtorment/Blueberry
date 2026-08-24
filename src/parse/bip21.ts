export type Bip21Payment = {
  address: string;
  amount: string | null;
  label: string | null;
};

const SCHEME = /^bitcoin:/i;
const KNOWN_REQ = new Set(["amount", "label", "message"]);

function decodeOrRaw(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function decodeOrDrop(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function firstNonEmpty(
  params: Map<string, string>,
  name: string,
): string | null {
  const raw = params.get(name) ?? params.get(`req-${name}`);
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

export function parseBip21(input: string): Bip21Payment | null {
  const trimmed = input.trim();
  if (!SCHEME.test(trimmed)) return null;

  let rest = trimmed.replace(SCHEME, "");
  if (rest.startsWith("//")) rest = rest.slice(2);

  const q = rest.indexOf("?");
  const addressRaw = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? "" : rest.slice(q + 1);

  const address = decodeOrRaw(addressRaw).trim();
  if (!address) return null;

  const params = new Map<string, string>();
  if (query.length > 0) {
    for (const piece of query.split("&")) {
      if (!piece) continue;
      const eq = piece.indexOf("=");
      const rawName = eq === -1 ? piece : piece.slice(0, eq);
      const rawValue = eq === -1 ? "" : piece.slice(eq + 1);
      const name = decodeOrDrop(rawName);
      const value = decodeOrDrop(rawValue);
      if (name === null || value === null) continue;
      const key = name.toLowerCase();
      if (!params.has(key)) params.set(key, value);
    }
  }

  for (const key of params.keys()) {
    if (key.startsWith("req-") && !KNOWN_REQ.has(key.slice(4))) return null;
  }

  let amount: string | null = null;
  if (params.has("amount")) amount = params.get("amount")!;
  else if (params.has("req-amount")) amount = params.get("req-amount")!;

  const label = firstNonEmpty(params, "label") ?? firstNonEmpty(params, "message");

  return { address, amount, label };
}
