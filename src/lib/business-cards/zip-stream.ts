// A ZIP written ONE FILE AT A TIME, straight into the HTTP response.
//
// Every card PDF carries the design's 2.6 MB colour profile (see render-pdf.ts), so a ZIP of the
// whole staff as separate PDFs is a few hundred megabytes. Built in memory — JSZip's way — that is
// several hundred megabytes of server RAM held until the last byte is sent. Here each PDF is
// rendered, written out and released before the next one exists. Entries are "stored": the PDFs
// are already compressed, so deflating them again costs time and saves nothing.

export type ZipEntry = { bytes: Uint8Array; name: string };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ bytes[index]) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The DOS date and time a ZIP stores, in Cairo local time. */
function dosDateTime(now: Date): { date: number; time: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: "Africa/Cairo",
      year: "numeric",
    })
      .formatToParts(now)
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return {
    date: ((parts.year - 1980) << 9) | (parts.month << 5) | parts.day,
    time: (parts.hour << 11) | (parts.minute << 5) | Math.floor(parts.second / 2),
  };
}

export function storedZipStream(entries: AsyncIterable<ZipEntry>, now = new Date()): ReadableStream<Uint8Array> {
  const iterator = entries[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const { date, time } = dosDateTime(now);
  const centralRecords: Uint8Array[] = [];
  let offset = 0;

  return new ReadableStream<Uint8Array>({
    async cancel() {
      await iterator.return?.();
    },
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        let centralSize = 0;
        for (const record of centralRecords) {
          controller.enqueue(record);
          centralSize += record.length;
        }
        const end = new Uint8Array(22);
        const view = new DataView(end.buffer);
        view.setUint32(0, 0x06054b50, true);
        view.setUint16(8, centralRecords.length, true);
        view.setUint16(10, centralRecords.length, true);
        view.setUint32(12, centralSize, true);
        view.setUint32(16, offset, true);
        controller.enqueue(end);
        controller.close();
        return;
      }

      const { bytes, name } = next.value;
      const nameBytes = encoder.encode(name);
      const crc = crc32(bytes);

      const local = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true); // file names are UTF-8
      localView.setUint16(10, time, true);
      localView.setUint16(12, date, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, bytes.length, true);
      localView.setUint32(22, bytes.length, true);
      localView.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);

      const central = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(12, time, true);
      centralView.setUint16(14, date, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, bytes.length, true);
      centralView.setUint32(24, bytes.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centralRecords.push(central);

      offset += local.length + bytes.length;
      controller.enqueue(local);
      controller.enqueue(bytes);
    },
  });
}
