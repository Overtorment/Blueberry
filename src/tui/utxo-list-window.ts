/** Keep focused index in the visible window; clamp when the list shrinks. */
export function utxoListScrollTop(
  focused: number,
  scrollTop: number,
  visibleRows: number,
  total: number,
): number {
  if (total <= 0 || visibleRows <= 0) return 0;
  if (total <= visibleRows) return 0;
  let next = scrollTop;
  if (focused < next) next = focused;
  else if (focused >= next + visibleRows) next = focused - visibleRows + 1;
  const maxTop = Math.max(0, total - visibleRows);
  return Math.min(Math.max(0, next), maxTop);
}
