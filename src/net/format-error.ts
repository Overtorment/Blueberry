/** Flatten Error / cause / reason into a short readable string for logs + UI. */
export function formatError(err: unknown, maxDepth = 5): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < maxDepth && cur != null; i++) {
    if (cur instanceof Error) {
      const label =
        cur.name && cur.name !== "Error"
          ? `${cur.name}: ${cur.message}`
          : cur.message || cur.name;
      if (label && !parts.includes(label)) parts.push(label);
      if (cur instanceof AggregateError && cur.errors.length > 0) {
        cur = cur.errors[0];
        continue;
      }
      cur = cur.cause;
      continue;
    }
    if (typeof cur === "object") {
      const o = cur as { message?: unknown; reason?: unknown; name?: unknown };
      if (typeof o.message === "string" && o.message) {
        const label =
          typeof o.name === "string" && o.name && o.name !== "Error"
            ? `${o.name}: ${o.message}`
            : o.message;
        if (!parts.includes(label)) parts.push(label);
      }
      if (o.reason != null && o.reason !== cur) {
        cur = o.reason;
        continue;
      }
    }
    const s = String(cur);
    if (s && s !== "[object Object]" && !parts.includes(s)) parts.push(s);
    break;
  }
  return parts.length > 0 ? parts.join(" ← ") : "unknown error";
}
