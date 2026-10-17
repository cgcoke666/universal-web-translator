/**
 * 极简 ZIP 写入器（仅 store，不压缩）。
 *
 * 为什么自己写：本机沙箱禁止 spawn 子进程，`Compress-Archive` 之类的外部工具
 * 和任何原生依赖（archiver / yazl）都用不了；而扩展包本来就只有几百 KB，
 * 用 store 模式（不压缩）体积完全可接受，实现也简单到能一眼看懂。
 *
 * 只实现「写」这一个方向，够 `scripts/pack.mjs` 生成 GitHub Release 附件用。
 * 格式参考 PKWARE APPNOTE：本地文件头 + 中央目录 + EOCD。
 */

/** CRC32 查表（多项式 0xEDB88320） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * @param {Buffer|Uint8Array} data
 * @returns {number}
 */
export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** JS Date → DOS 时间/日期（秒精度只保留到 2 秒） */
function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { dosDate, dosTime };
}

/**
 * 把一组文件打成 ZIP。
 * @param {Array<{name: string, data: Buffer|Uint8Array, mtime?: Date}>} entries
 *        name 是包内路径，必须用 `/` 分隔
 * @returns {Buffer}
 */
export function buildZip(entries) {
  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {Array<{name: Buffer, crc: number, size: number, offset: number, dosDate: number, dosTime: number}>} */
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const { dosDate, dosTime } = toDosDateTime(entry.mtime ?? new Date());
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    header.writeUInt16LE(20, 4); // 解压所需版本 2.0
    header.writeUInt16LE(0x0800, 6); // 通用标志：文件名是 UTF-8
    header.writeUInt16LE(0, 8); // 压缩方式：0 = store
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); // 压缩后大小
    header.writeUInt32LE(data.length, 22); // 原始大小
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // 无 extra field

    chunks.push(header, name, data);
    central.push({ name, crc, size: data.length, offset, dosDate, dosTime });
    offset += header.length + name.length + data.length;
  }

  const centralStart = offset;
  let centralSize = 0;

  for (const item of central) {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    record.writeUInt16LE(20, 4); // 生成者版本
    record.writeUInt16LE(20, 6); // 解压所需版本
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10); // store
    record.writeUInt16LE(item.dosTime, 12);
    record.writeUInt16LE(item.dosDate, 14);
    record.writeUInt32LE(item.crc, 16);
    record.writeUInt32LE(item.size, 20);
    record.writeUInt32LE(item.size, 24);
    record.writeUInt16LE(item.name.length, 28);
    record.writeUInt16LE(0, 30); // extra
    record.writeUInt16LE(0, 32); // comment
    record.writeUInt16LE(0, 34); // 起始磁盘号
    record.writeUInt16LE(0, 36); // 内部属性
    record.writeUInt32LE(0, 38); // 外部属性
    record.writeUInt32LE(item.offset, 42);
    chunks.push(record, item.name);
    centralSize += record.length + item.name.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);

  return Buffer.concat(chunks);
}
