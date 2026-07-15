import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { inspectZipArchive } from "./zip-safety";

function centralOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      return view.getUint32(offset + 16, true);
    }
  }
  throw new Error("EOCD missing in test fixture");
}

describe("inspectZipArchive", () => {
  it("accepts a normal source archive", () => {
    const archive = zipSync({
      "tenant/a.pdf": strToU8("%PDF-test"),
      "tenant/b.xlsx": strToU8("PK-test"),
    });
    expect(inspectZipArchive(archive)).toMatchObject({ entryCount: 2 });
  });

  it("rejects an encrypted entry before decompression", () => {
    const archive = Uint8Array.from(
      zipSync({ "tenant.pdf": strToU8("%PDF-test") }),
    );
    const view = new DataView(archive.buffer);
    const offset = centralOffset(archive);
    view.setUint16(offset + 8, view.getUint16(offset + 8, true) | 0x1, true);
    expect(() => inspectZipArchive(archive)).toThrow(/Encrypted zip/);
  });

  it("rejects an oversized advertised uncompressed entry", () => {
    const archive = Uint8Array.from(
      zipSync({ "tenant.pdf": strToU8("%PDF-test") }),
    );
    const view = new DataView(archive.buffer);
    view.setUint32(centralOffset(archive) + 24, 33 * 1024 * 1024, true);
    expect(() => inspectZipArchive(archive)).toThrow(/maximum is/);
  });
});
