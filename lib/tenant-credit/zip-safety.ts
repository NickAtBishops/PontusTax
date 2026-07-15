export type ZipInspection = {
  entryCount: number;
  compressedBytes: number;
  uncompressedBytes: number;
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_ENTRIES = 500;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;

function findEndOfCentralDirectory(view: DataView): number {
  const firstPossible = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= firstPossible; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("Zip is missing its end-of-central-directory record.");
}

export function inspectZipArchive(bytes: Uint8Array): ZipInspection {
  if (bytes.byteLength < 22) throw new Error("Zip is truncated.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDisk !== 0) {
    throw new Error("Multi-disk zip archives are not supported.");
  }
  if (entryCount === 0 || entryCount > MAX_ENTRIES) {
    throw new Error(`Zip entry count ${entryCount} is outside the 1-${MAX_ENTRIES} limit.`);
  }
  if (
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize > bytes.byteLength
  ) {
    throw new Error("Zip64 or invalid central-directory offsets are not supported.");
  }

  let offset = centralOffset;
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  const names = new Set<string>();
  const decoder = new TextDecoder();
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > bytes.byteLength ||
      view.getUint32(offset, true) !== CENTRAL_SIGNATURE
    ) {
      throw new Error(`Zip central-directory entry ${index + 1} is malformed.`);
    }
    const flags = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if ((flags & 0x1) !== 0) throw new Error("Encrypted zip entries are not supported.");
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new Error("Zip64 entries are not supported.");
    }
    if (uncompressed > MAX_ENTRY_BYTES) {
      throw new Error(
        `Zip entry ${index + 1} expands to ${uncompressed.toLocaleString()} bytes; ` +
          `maximum is ${MAX_ENTRY_BYTES.toLocaleString()}.`,
      );
    }
    const nameStart = offset + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > bytes.byteLength) throw new Error("Zip entry metadata is truncated.");
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (names.has(name)) throw new Error(`Zip contains duplicate path "${name}".`);
    names.add(name);
    compressedBytes += compressed;
    uncompressedBytes += uncompressed;
    if (uncompressedBytes > MAX_TOTAL_BYTES) {
      throw new Error(
        `Zip expands to more than ${MAX_TOTAL_BYTES.toLocaleString()} bytes.`,
      );
    }
    offset = next;
  }
  if (offset !== centralOffset + centralSize) {
    throw new Error("Zip central-directory size does not match its entries.");
  }
  if (
    uncompressedBytes > 0 &&
    (compressedBytes === 0 || uncompressedBytes / compressedBytes > MAX_COMPRESSION_RATIO)
  ) {
    throw new Error("Zip compression ratio is unsafe.");
  }
  return { entryCount, compressedBytes, uncompressedBytes };
}
