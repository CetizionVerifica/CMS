/**
 * How many bytes an .xlsx (a zip archive) declares it will inflate to, read from its central directory without
 * inflating anything. The 20 MB upload limit is on compressed bytes, and a crafted workbook can expand far
 * beyond that, so `readWorkbook` refuses archives that declare too much before handing them to ExcelJS.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
/** End record (22 bytes) plus the longest comment a zip may carry. */
const MAX_END_SEARCH = 22 + 0xffff;

/** The total declared uncompressed size, or null when the bytes are not a zip this reader understands. */
export function declaredInflatedSize(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowest = Math.max(0, bytes.byteLength - MAX_END_SEARCH);
  let end = -1;
  for (let i = bytes.byteLength - 22; i >= lowest; i--) {
    if (view.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const entries = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_FILE_HEADER) {
      return null;
    }
    const size = view.getUint32(offset + 24, true);
    // 0xFFFFFFFF means the real size is in a ZIP64 record: more than 4 GB, so too large anyway.
    if (size === 0xffffffff) return Number.POSITIVE_INFINITY;
    total += size;
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  return total;
}
