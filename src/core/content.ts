/** Same heuristic Git uses: a NUL byte in the first 8000 bytes means binary. */
export function isBinary(data: Uint8Array): boolean {
  const end = Math.min(data.length, 8000);
  for (let i = 0; i < end; i++) {
    if (data[i] === 0) {
      return true;
    }
  }
  return false;
}
