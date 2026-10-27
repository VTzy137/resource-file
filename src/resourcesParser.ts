import { BinaryReader, ParseError } from './binaryReader';
import { EmbeddedImage, NrbfInfo, findImage, inspectNrbf } from './payloadInspector';

/*
 * Parser for the binary .resources format produced by System.Resources.ResourceWriter
 * (and System.Resources.Extensions.PreserializedResourceWriter), following the layout
 * read by System.Resources.ResourceReader:
 *
 *   ResourceManager header : magic 0xBEEFCACE, header version, skip byte count,
 *                            reader type name, resource set type name
 *   RuntimeResourceSet     : version (1|2), resource count, type count, type names,
 *                            padding to 8 bytes ("PAD"), name hashes[], name positions[],
 *                            data section offset
 *   Name section           : per resource: 7-bit byte length, UTF-16LE name, Int32 data offset
 *   Data section           : per resource: type code (V2) or type index (V1), value
 */

export const MAGIC_NUMBER = 0xbeefcace;

/** System.Resources.ResourceTypeCode */
export const TYPE_CODES: Record<number, string> = {
    0x00: 'Null',
    0x01: 'String',
    0x02: 'Boolean',
    0x03: 'Char',
    0x04: 'Byte',
    0x05: 'SByte',
    0x06: 'Int16',
    0x07: 'UInt16',
    0x08: 'Int32',
    0x09: 'UInt32',
    0x0a: 'Int64',
    0x0b: 'UInt64',
    0x0c: 'Single',
    0x0d: 'Double',
    0x0e: 'Decimal',
    0x0f: 'DateTime',
    0x10: 'TimeSpan',
    0x20: 'ByteArray',
    0x21: 'Stream',
};
export const START_OF_USER_TYPES = 0x40;

/** System.Resources.Extensions SerializationFormat (written after the type code by PreserializedResourceWriter). */
export const SERIALIZATION_FORMATS: Record<number, string> = {
    1: 'BinaryFormatter',
    2: 'TypeConverterByteArray',
    3: 'TypeConverterString',
    4: 'ActivatorStream',
};

export type ValueKind = 'null' | 'string' | 'primitive' | 'bytes' | 'stream' | 'object' | 'error';

export interface ResourceEntry {
    /** Index in the hash/position tables (file order). */
    index: number;
    name: string;
    storedHash: number;
    computedHash: number;
    /** Absolute offset of the name record in the name section. */
    nameOffset: number;
    nameRecordSize: number;
    /** Offset relative to the data section, as stored in the name record. */
    dataOffset: number;
    /** Absolute offset of the data record. */
    dataAbsOffset: number;
    /** Size of the whole data record (type code + value), up to the next record. */
    dataSize: number;
    /** Raw type code (V2) or type table index (V1); -1 means null in V1. */
    typeCode: number;
    typeCodeName: string;
    /** .NET type name of the value. */
    typeName: string;
    kind: ValueKind;
    /** Absolute offset and length of the value payload (without type code / length prefixes). */
    valueOffset: number;
    valueLength: number;
    /** Human readable value (for strings and primitives, the full value). */
    value?: string;
    serializationFormat?: string;
    nrbf?: NrbfInfo;
    image?: EmbeddedImage;
    error?: string;
}

export interface Region {
    name: string;
    offset: number;
    size: number;
    detail?: string;
}

export interface ResourcesFile {
    fileSize: number;
    magic: number;
    resMgrHeaderVersion: number;
    numBytesToSkip: number;
    readerType?: string;
    resourceSetType?: string;
    /** True when the file was written by PreserializedResourceWriter (System.Resources.Extensions). */
    preserialized: boolean;
    version: number;
    numResources: number;
    types: { index: number; name: string; offset: number; count: number }[];
    paddingOffset: number;
    paddingSize: number;
    hashTableOffset: number;
    positionTableOffset: number;
    dataSectionOffset: number;
    nameSectionOffset: number;
    entries: ResourceEntry[];
    regions: Region[];
    warnings: string[];
    hashesSorted: boolean;
    hashMismatches: number;
}

/** FastResourceComparer.HashFunction (djb2 variant over UTF-16 code units). */
export function resourceNameHash(name: string): number {
    let hash = 5381;
    for (let i = 0; i < name.length; i++) {
        hash = (Math.imul(hash, 33) ^ name.charCodeAt(i)) >>> 0;
    }
    return hash | 0;
}

const DEFAULT_READER = 'System.Resources.ResourceReader';
const EXTENSIONS_READER = 'System.Resources.Extensions.DeserializingResourceReader';

export function parseResources(buf: Buffer): ResourcesFile {
    const r = new BinaryReader(buf);
    const warnings: string[] = [];
    const regions: Region[] = [];

    // ---- ResourceManager header ----
    if (buf.length < 12) {
        throw new ParseError('File is too small to be a .resources file', 0);
    }
    const magic = r.u32();
    if (magic !== MAGIC_NUMBER) {
        throw new ParseError(`Not a .NET .resources file: magic number is 0x${magic.toString(16).toUpperCase().padStart(8, '0')}, expected 0xBEEFCACE`, 0);
    }
    const resMgrHeaderVersion = r.i32();
    const numBytesToSkip = r.i32();
    const headerStart = r.pos;
    if (numBytesToSkip < 0 || headerStart + numBytesToSkip > buf.length) {
        throw new ParseError(`Invalid ResourceManager header size ${numBytesToSkip}`, 8);
    }
    let readerType: string | undefined;
    let resourceSetType: string | undefined;
    if (resMgrHeaderVersion > 1) {
        warnings.push(`ResourceManager header version ${resMgrHeaderVersion} is newer than 1; reader/set type names skipped.`);
    } else {
        const hr = new BinaryReader(buf, headerStart, headerStart + numBytesToSkip);
        readerType = hr.readString();
        resourceSetType = hr.readString();
    }
    r.pos = headerStart + numBytesToSkip;
    regions.push({ name: 'ResourceManager header', offset: 0, size: r.pos, detail: 'Magic, header version, skip size, reader & resource set type names' });

    const preserialized = !!readerType && readerType.startsWith(EXTENSIONS_READER);
    if (readerType && !readerType.startsWith(DEFAULT_READER) && !preserialized) {
        warnings.push(`Unknown reader type "${readerType}"; values are decoded with the standard ResourceReader rules.`);
    }

    // ---- RuntimeResourceSet header ----
    const rsStart = r.pos;
    const version = r.i32();
    if (version !== 1 && version !== 2) {
        throw new ParseError(`Unsupported RuntimeResourceSet version ${version} (expected 1 or 2)`, rsStart);
    }
    const numResources = r.i32();
    if (numResources < 0) {
        throw new ParseError(`Negative resource count ${numResources}`, rsStart + 4);
    }
    const numTypes = r.i32();
    if (numTypes < 0) {
        throw new ParseError(`Negative type count ${numTypes}`, rsStart + 8);
    }
    const types: ResourcesFile['types'] = [];
    for (let i = 0; i < numTypes; i++) {
        const offset = r.pos;
        types.push({ index: i, name: r.readString(), offset, count: 0 });
    }
    regions.push({ name: 'RuntimeResourceSet header', offset: rsStart, size: 12, detail: `Version ${version}, ${numResources} resources, ${numTypes} types` });
    if (numTypes > 0) {
        regions.push({ name: 'Type table', offset: rsStart + 12, size: r.pos - rsStart - 12, detail: `${numTypes} type names` });
    }

    const paddingOffset = r.pos;
    const align = r.pos & 7;
    if (align !== 0) {
        r.bytes(8 - align);
    }
    const paddingSize = r.pos - paddingOffset;
    if (paddingSize > 0) {
        regions.push({ name: 'Padding', offset: paddingOffset, size: paddingSize, detail: 'Alignment to 8 bytes ("PAD")' });
    }

    const hashTableOffset = r.pos;
    r.ensure(numResources * 8 + 4, 'hash and position tables');
    const hashes: number[] = [];
    for (let i = 0; i < numResources; i++) {
        hashes.push(r.i32());
    }
    regions.push({ name: 'Name hashes', offset: hashTableOffset, size: numResources * 4, detail: `${numResources} × Int32, sorted` });

    const positionTableOffset = r.pos;
    const namePositions: number[] = [];
    for (let i = 0; i < numResources; i++) {
        namePositions.push(r.i32());
    }
    regions.push({ name: 'Name positions', offset: positionTableOffset, size: numResources * 4, detail: `${numResources} × Int32, relative to name section` });

    const dataSectionOffsetPos = r.pos;
    const dataSectionOffset = r.i32();
    regions.push({ name: 'Data section offset', offset: dataSectionOffsetPos, size: 4, detail: `0x${dataSectionOffset.toString(16).toUpperCase()}` });
    const nameSectionOffset = r.pos;
    if (dataSectionOffset < nameSectionOffset || dataSectionOffset > buf.length) {
        throw new ParseError(`Invalid data section offset 0x${dataSectionOffset.toString(16)} (name section starts at 0x${nameSectionOffset.toString(16)}, file size ${buf.length})`, dataSectionOffsetPos);
    }
    regions.push({ name: 'Name section', offset: nameSectionOffset, size: dataSectionOffset - nameSectionOffset, detail: 'UTF-16LE names + Int32 data offsets' });
    regions.push({ name: 'Data section', offset: dataSectionOffset, size: buf.length - dataSectionOffset, detail: 'Type codes + values' });

    let hashesSorted = true;
    for (let i = 1; i < hashes.length; i++) {
        if (hashes[i - 1] > hashes[i]) {
            hashesSorted = false;
            break;
        }
    }
    if (!hashesSorted) {
        warnings.push('Name hash table is not sorted; ResourceReader lookups by name would fail.');
    }

    // ---- Name section ----
    const entries: ResourceEntry[] = [];
    for (let i = 0; i < numResources; i++) {
        const nameOffset = nameSectionOffset + namePositions[i];
        const entry: ResourceEntry = {
            index: i, name: '', storedHash: hashes[i], computedHash: 0, nameOffset, nameRecordSize: 0,
            dataOffset: -1, dataAbsOffset: -1, dataSize: 0, typeCode: -1, typeCodeName: '?', typeName: '?',
            kind: 'error', valueOffset: -1, valueLength: 0,
        };
        try {
            if (namePositions[i] < 0 || nameOffset >= dataSectionOffset) {
                throw new ParseError(`Name position ${namePositions[i]} is outside the name section`, positionTableOffset + i * 4);
            }
            const nr = new BinaryReader(buf, nameOffset, dataSectionOffset);
            const byteLen = nr.read7BitEncodedInt();
            if (byteLen < 0 || (byteLen & 1) !== 0) {
                throw new ParseError(`Invalid name length ${byteLen}`, nameOffset);
            }
            entry.name = nr.bytes(byteLen).toString('utf16le');
            entry.dataOffset = nr.i32();
            entry.nameRecordSize = nr.pos - nameOffset;
            entry.dataAbsOffset = dataSectionOffset + entry.dataOffset;
            if (entry.dataOffset < 0 || entry.dataAbsOffset >= buf.length) {
                throw new ParseError(`Data offset ${entry.dataOffset} is outside the data section`, nr.pos - 4);
            }
        } catch (e) {
            entry.error = (e as Error).message;
        }
        entry.computedHash = resourceNameHash(entry.name);
        entries.push(entry);
    }

    // Record sizes: each value runs to the next distinct data offset (or end of file).
    const starts = [...new Set(entries.filter(e => e.dataAbsOffset >= 0).map(e => e.dataAbsOffset))].sort((a, b) => a - b);
    const nextStart = new Map<number, number>();
    starts.forEach((s, i) => nextStart.set(s, i + 1 < starts.length ? starts[i + 1] : buf.length));

    // ---- Data section ----
    for (const entry of entries) {
        if (entry.error) {
            continue;
        }
        const recordEnd = nextStart.get(entry.dataAbsOffset)!;
        entry.dataSize = recordEnd - entry.dataAbsOffset;
        try {
            const dr = new BinaryReader(buf, entry.dataAbsOffset, recordEnd);
            if (version === 2) {
                readValueV2(dr, entry, types, preserialized);
            } else {
                readValueV1(dr, entry, types, preserialized);
            }
        } catch (e) {
            entry.kind = 'error';
            entry.error = (e as Error).message;
        }
    }

    for (const e of entries) {
        if (e.typeCode >= 0) {
            const t = version === 2 ? (e.typeCode >= START_OF_USER_TYPES ? types[e.typeCode - START_OF_USER_TYPES] : undefined) : types[e.typeCode];
            if (t) {
                t.count++;
            }
        }
    }
    const hashMismatches = entries.filter(e => !e.error && e.storedHash !== e.computedHash).length;
    if (hashMismatches > 0) {
        warnings.push(`${hashMismatches} resource name(s) do not match their stored hash.`);
    }
    const errors = entries.filter(e => e.error).length;
    if (errors > 0) {
        warnings.push(`${errors} resource(s) could not be decoded.`);
    }

    return {
        fileSize: buf.length, magic, resMgrHeaderVersion, numBytesToSkip, readerType, resourceSetType, preserialized,
        version, numResources, types, paddingOffset, paddingSize, hashTableOffset, positionTableOffset,
        dataSectionOffset, nameSectionOffset, entries, regions, warnings, hashesSorted, hashMismatches,
    };
}

function readValueV2(r: BinaryReader, e: ResourceEntry, types: ResourcesFile['types'], preserialized: boolean): void {
    const code = r.read7BitEncodedInt();
    e.typeCode = code;
    if (code >= START_OF_USER_TYPES) {
        const t = types[code - START_OF_USER_TYPES];
        if (!t) {
            throw new ParseError(`Type code 0x${code.toString(16)} refers to missing type index ${code - START_OF_USER_TYPES}`, e.dataAbsOffset);
        }
        e.typeCodeName = `UserType[${code - START_OF_USER_TYPES}]`;
        e.typeName = t.name;
        readUserType(r, e, preserialized);
        return;
    }
    const name = TYPE_CODES[code];
    if (!name) {
        throw new ParseError(`Unknown type code 0x${code.toString(16)}`, e.dataAbsOffset);
    }
    e.typeCodeName = name;
    e.typeName = name === 'Null' ? 'null' : name === 'ByteArray' ? 'System.Byte[]' : name === 'Stream' ? 'System.IO.MemoryStream' : `System.${name}`;
    readPrimitive(r, e, name, true);
}

function readValueV1(r: BinaryReader, e: ResourceEntry, types: ResourcesFile['types'], preserialized: boolean): void {
    const index = r.read7BitEncodedInt();
    e.typeCode = index;
    if (index === -1) {
        e.typeCodeName = 'Null';
        e.typeName = 'null';
        readPrimitive(r, e, 'Null', false);
        return;
    }
    const t = types[index];
    if (!t) {
        throw new ParseError(`Type index ${index} is outside the type table`, e.dataAbsOffset);
    }
    e.typeCodeName = `Type[${index}]`;
    e.typeName = t.name;
    const simple = t.name.split(',')[0].trim();
    const primitive = V1_PRIMITIVES[simple];
    if (primitive) {
        readPrimitive(r, e, primitive, false);
    } else {
        readUserType(r, e, preserialized);
    }
}

const V1_PRIMITIVES: Record<string, string> = {
    'System.String': 'String', 'System.Boolean': 'Boolean', 'System.Char': 'Char', 'System.Byte': 'Byte',
    'System.SByte': 'SByte', 'System.Int16': 'Int16', 'System.UInt16': 'UInt16', 'System.Int32': 'Int32',
    'System.UInt32': 'UInt32', 'System.Int64': 'Int64', 'System.UInt64': 'UInt64', 'System.Single': 'Single',
    'System.Double': 'Double', 'System.Decimal': 'Decimal', 'System.DateTime': 'DateTime', 'System.TimeSpan': 'TimeSpan',
};

function readPrimitive(r: BinaryReader, e: ResourceEntry, name: string, v2: boolean): void {
    e.kind = 'primitive';
    const start = r.pos;
    switch (name) {
        case 'Null':
            e.kind = 'null';
            e.value = 'null';
            break;
        case 'String': {
            const len = r.read7BitEncodedInt();
            if (len < 0) {
                throw new ParseError(`Negative string length ${len}`, start);
            }
            e.valueOffset = r.pos;
            e.valueLength = len;
            e.value = r.bytes(len).toString('utf8');
            e.kind = 'string';
            return;
        }
        case 'Boolean':
            e.value = r.u8() !== 0 ? 'True' : 'False';
            break;
        case 'Char': {
            const c = r.u16();
            e.value = `'${String.fromCharCode(c)}' (U+${c.toString(16).toUpperCase().padStart(4, '0')})`;
            break;
        }
        case 'Byte':
            e.value = String(r.u8());
            break;
        case 'SByte':
            e.value = String(r.i8());
            break;
        case 'Int16':
            e.value = String(r.i16());
            break;
        case 'UInt16':
            e.value = String(r.u16());
            break;
        case 'Int32':
            e.value = String(r.i32());
            break;
        case 'UInt32':
            e.value = String(r.u32());
            break;
        case 'Int64':
            e.value = String(r.i64());
            break;
        case 'UInt64':
            e.value = String(r.u64());
            break;
        case 'Single':
            e.value = formatFloat(r.f32(), true);
            break;
        case 'Double':
            e.value = formatFloat(r.f64(), false);
            break;
        case 'Decimal': {
            const lo = r.u32(), mid = r.u32(), hi = r.u32(), flags = r.i32();
            e.value = formatDecimal(lo, mid, hi, flags);
            break;
        }
        case 'DateTime':
            // V2 stores DateTime.ToBinary(); V1 stores raw ticks.
            e.value = v2 ? formatDateTimeBinary(r.i64()) : `${formatTicks(r.i64())} (Unspecified)`;
            break;
        case 'TimeSpan':
            e.value = formatTimeSpan(r.i64());
            break;
        case 'ByteArray':
        case 'Stream': {
            const len = r.i32();
            if (len < 0) {
                throw new ParseError(`Negative ${name} length ${len}`, start);
            }
            e.kind = name === 'ByteArray' ? 'bytes' : 'stream';
            e.valueOffset = r.pos;
            e.valueLength = len;
            r.bytes(len);
            e.value = `${len.toLocaleString('en-US')} bytes`;
            e.image = findImage(r.buf, e.valueOffset, len);
            if (e.image) {
                e.value += ` (${e.image.format} image)`;
            }
            return;
        }
        default:
            throw new ParseError(`Unsupported primitive ${name}`, start);
    }
    e.valueOffset = start;
    e.valueLength = r.pos - start;
}

function readUserType(r: BinaryReader, e: ResourceEntry, preserialized: boolean): void {
    e.kind = 'object';
    let payloadStart = r.pos;
    let payloadLength = r.end - r.pos;
    let format = 'BinaryFormatter';
    if (preserialized) {
        const f = r.read7BitEncodedInt();
        format = SERIALIZATION_FORMATS[f] ?? `Unknown(${f})`;
        e.serializationFormat = format;
        if (format === 'TypeConverterString') {
            // No separate length: the value is a BinaryWriter string.
            const strStart = r.pos;
            e.value = r.readString();
            e.valueOffset = strStart;
            e.valueLength = r.pos - strStart;
            e.kind = 'string';
            return;
        }
        const len = r.read7BitEncodedInt();
        if (len < 0 || len > r.remaining) {
            throw new ParseError(`Invalid serialized data length ${len}`, payloadStart);
        }
        payloadStart = r.pos;
        payloadLength = len;
    }
    e.serializationFormat = format;
    e.valueOffset = payloadStart;
    e.valueLength = payloadLength;

    if (format === 'BinaryFormatter') {
        e.nrbf = inspectNrbf(r.buf, payloadStart, payloadLength);
    }
    e.image = findImage(r.buf, payloadStart, payloadLength, e.nrbf);
    const parts = [`${payloadLength.toLocaleString('en-US')} bytes`, format];
    if (e.nrbf?.className && e.nrbf.className !== e.typeName.split(',')[0]) {
        parts.push(e.nrbf.className);
    }
    if (e.image) {
        parts.push(`${e.image.format} image`);
    }
    e.value = parts.join(' · ');
}

function formatFloat(v: number, single: boolean): string {
    if (Number.isNaN(v)) {
        return 'NaN';
    }
    if (!Number.isFinite(v)) {
        return v > 0 ? '∞' : '-∞';
    }
    if (!single) {
        return String(v);
    }
    // Shortest representation that round-trips through float32, like .NET Core's Single.ToString().
    for (let p = 1; p <= 9; p++) {
        const s = Number(v.toPrecision(p));
        if (Math.fround(s) === v) {
            return String(s);
        }
    }
    return String(v);
}

export function formatDecimal(lo: number, mid: number, hi: number, flags: number): string {
    const scale = (flags >> 16) & 0xff;
    const negative = (flags & 0x80000000) !== 0;
    let digits = ((BigInt(hi) << 64n) | (BigInt(mid) << 32n) | BigInt(lo)).toString();
    if (scale > 0) {
        digits = digits.padStart(scale + 1, '0');
        digits = `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
    }
    return (negative ? '-' : '') + digits;
}

const TICKS_MASK = 0x3fffffffffffffffn;
const TICKS_AT_UNIX_EPOCH = 621355968000000000n;

/** Formats DateTime ticks (100ns since 0001-01-01) as ISO 8601 with 7 fractional digits. */
export function formatTicks(ticks: bigint): string {
    const diff = ticks - TICKS_AT_UNIX_EPOCH;
    let ms = diff / 10000n;
    let rest = diff % 10000n;
    if (rest < 0n) {
        ms -= 1n;
        rest += 10000n;
    }
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) {
        return `${ticks} ticks`;
    }
    const iso = d.toISOString(); // yyyy-MM-ddTHH:mm:ss.fffZ
    return `${iso.slice(0, 23)}${rest.toString().padStart(4, '0')}`;
}

const TICKS_CEILING = 0x4000000000000000n;
const TICKS_PER_100_YEARS = 864000000000n * 36524n;

/** DateTime.FromBinary: bits 62-63 hold the DateTimeKind, the rest the ticks. */
export function formatDateTimeBinary(data: bigint): string {
    const kindBits = Number((BigInt.asUintN(64, data) >> 62n) & 3n);
    let ticks = data & TICKS_MASK;
    if (kindBits >= 2) {
        // Local: the stored ticks are UTC ticks; negative values wrap to the top of the range.
        if (ticks > TICKS_CEILING - TICKS_PER_100_YEARS) {
            ticks -= TICKS_CEILING;
        }
        return `${formatTicks(ticks)}Z (Local; shown as stored UTC)`;
    }
    return kindBits === 1 ? `${formatTicks(ticks)}Z (Utc)` : `${formatTicks(ticks)} (Unspecified)`;
}

export function formatTimeSpan(ticks: bigint): string {
    const negative = ticks < 0n;
    let t = negative ? -ticks : ticks;
    const frac = t % 10000000n;
    t /= 10000000n;
    const s = t % 60n;
    t /= 60n;
    const m = t % 60n;
    t /= 60n;
    const h = t % 24n;
    const d = t / 24n;
    const pad = (v: bigint) => v.toString().padStart(2, '0');
    let out = `${negative ? '-' : ''}${d > 0n ? `${d}.` : ''}${pad(h)}:${pad(m)}:${pad(s)}`;
    if (frac > 0n) {
        out += `.${frac.toString().padStart(7, '0')}`;
    }
    return out;
}
