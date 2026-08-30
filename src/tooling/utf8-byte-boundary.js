/**
 * Counts UTF-8 bytes from UTF-16 code units without allocating encoded output,
 * stopping as soon as the inclusive limit is exceeded.
 *
 * @param {string} value
 * @param {number} maximumBytes
 * @returns {boolean}
 */
export function isUtf8ByteLengthAtMost(value, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return false;
  if (value.length > maximumBytes) return false;

  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maximumBytes) return false;
  }
  return true;
}
