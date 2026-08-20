export function isBip38Key(value: string): boolean {
  const v = value.trim();
  if (/\s/.test(v)) return false;
  return v.startsWith("6P") && v.length === 58;
}
