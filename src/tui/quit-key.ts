/** Quit on q/Q only when a text field is not capturing keys (bc1q…). */
export function shouldHardQuit(
  key: { name?: string },
  focusedEditor: unknown,
): boolean {
  if (focusedEditor) return false;
  return key.name === "q" || key.name === "Q";
}
