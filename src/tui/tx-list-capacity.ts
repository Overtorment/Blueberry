/** Must match `App.tsx` outer chrome. */
export const APP_OUTER_PADDING = 1;
export const APP_SECTION_GAPS = 2; // strip↔balance, balance↔transactions
/** Border (2) + up to 4 content rows; strip panels use paddingY={0}. */
export const APP_STRIP_HEIGHT = 6;
/** Blueberry wordmark is 5 rows; Balance panel shares this row height. */
export const APP_BALANCE_HEIGHT = 5;
/** Panel border (2) + Panel padding (2). */
export const PANEL_CHROME_ROWS = 4;
/** Must match `ActionBar` overlay height. Reserved so txs are not painted under it. */
export const APP_ACTION_BAR_HEIGHT = 5;

/**
 * How many tx rows fit in the Transactions panel content area.
 * `reservedLines` = lines already used above the list (e.g. parse progress).
 */
export function txListCapacity(
  terminalHeight: number,
  reservedLines = 0,
): number {
  const outerChrome = APP_OUTER_PADDING * 2 + APP_SECTION_GAPS;
  const content =
    terminalHeight -
    outerChrome -
    APP_STRIP_HEIGHT -
    APP_BALANCE_HEIGHT -
    PANEL_CHROME_ROWS -
    APP_ACTION_BAR_HEIGHT -
    Math.max(0, reservedLines);
  return Math.max(0, content);
}
