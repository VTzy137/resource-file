import { BinaryReader } from './binaryReader';

export interface EmbeddedImage {
    mime: string;
    format: string;
    /** Absolute offset of the image bytes in the file. */
    offset: number;
    length: number;
}

export interface NrbfInfo {
    rootRecord: string;
    className?: string;
    libraryName?: string;
    memberNames?: string[];
    /** Byte arrays (ArraySinglePrimitive of Byte) found in the stream, absolute offsets. */
    byteArrays: { offset: number; length: number }[];
}

const MIME_SIGNATURES: { format: string; mime: string; test: (b: Buffer, o: number, n: number) => boolean }[] = [
    { format: 'PNG', mime: 'image/png', test: (b, o, n) => n >= 8 && b.readUInt32BE(o) === 0x89504e47 && b.readUInt32BE(o + 4) === 0x0d0a1a0a },
    { format: 'GIF', mime: 'image/gif', test: (b, o, n) => n >= 6 && b.toString('latin1', o, o + 4) === 'GIF8' },
    { format: 'JPEG', mime: 'image/jpeg', test: (b, o, n) => n >= 3 && b[o] === 0xff && b[o + 1] === 0xd8 && b[o + 2] === 0xff },
    { format: 'BMP', mime: 'image/bmp', test: (b, o, n) => n >= 14 && b[o] === 0x42 && b[o + 1] === 0x4d && b.readUInt32LE(o + 2) <= n + 16 },
    { format: 'ICO', mime: 'image/x-icon', test: (b, o, n) => n >= 22 && b.readUInt16LE(o) === 0 && b.readUInt16LE(o + 2) === 1 && b.readUInt16LE(o + 4) > 0 && b.readUInt16LE(o + 4) < 256 },
    { format: 'CUR', mime: 'image/x-icon', test: (b, o, n) => n >= 22 && b.readUInt16LE(o) === 0 && b.readUInt16LE(o + 2) === 2 && b.readUInt16LE(o + 4) > 0 && b.readUInt16LE(o + 4) < 256 },
    { format: 'WebP', mime: 'image/webp', test: (b, o, n) => n >= 12 && b.toString('latin1', o, o + 4) === 'RIFF' && b.toString('latin1', o + 8, o + 12) === 'WEBP' },
    { format: 'SVG', mime: 'image/svg+xml', test: (b, o, n) => /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(b.toString('utf8', o, o + Math.min(n, 256))) },
];

/** Checks whether `buf[offset, offset+length)` starts with a known image signature. */
export function detectImage(buf: Buffer, offset: number, length: number): EmbeddedImage | undefined {
    if (length <= 0 || offset + length > buf.length) {
        return undefined;
    }
    for (const sig of MIME_SIGNATURES) {
        try {
            if (sig.test(buf, offset, length)) {
                return { mime: sig.mime, format: sig.format, offset, length };
            }
        } catch {
            // signature test read past the end; not this format
        }
    }
    return undefined;
}

export function looksLikeNrbf(buf: Buffer, offset: number, length: number): boolean {
    // SerializationHeaderRecord: 0x00, rootId, headerId, majorVersion=1, minorVersion=0
    return length >= 17 && buf[offset] === 0x00 && buf.readInt32LE(offset + 9) === 1 && buf.readInt32LE(offset + 13) === 0;
}

const RECORD_NAMES: Record<number, string> = {
    0x00: 'SerializedStreamHeader',
    0x01: 'ClassWithId',
    0x02: 'SystemClassWithMembers',
    0x03: 'ClassWithMembers',
    0x04: 'SystemClassWithMembersAndTypes',
    0x05: 'ClassWithMembersAndTypes',
    0x06: 'BinaryObjectString',
    0x07: 'BinaryArray',
    0x08: 'MemberPrimitiveTyped',
    0x09: 'MemberReference',
    0x0a: 'ObjectNull',
    0x0b: 'MessageEnd',
    0x0c: 'BinaryLibrary',
    0x0d: 'ObjectNullMultiple256',
    0x0e: 'ObjectNullMultiple',
    0x0f: 'ArraySinglePrimitive',
    0x10: 'ArraySingleObject',
    0x11: 'ArraySingleString',
    0x15: 'MethodCall',
    0x16: 'MethodReturn',
};

/**
 * Reads just enough of a BinaryFormatter (MS-NRBF) stream to name the root
 * object: header, leading BinaryLibrary records and the first ClassInfo.
 * Byte arrays are located by scanning for ArraySinglePrimitive(Byte) records.
 */
export function inspectNrbf(buf: Buffer, offset: number, length: number): NrbfInfo | undefined {
    if (!looksLikeNrbf(buf, offset, length)) {
        return undefined;
    }
    const info: NrbfInfo = { rootRecord: '?', byteArrays: findNrbfByteArrays(buf, offset, length) };
    const r = new BinaryReader(buf, offset + 17, offset + length);
    try {
        const libraries = new Map<number, string>();
        for (let guard = 0; guard < 64 && r.remaining > 0; guard++) {
            const recordType = r.u8();
            info.rootRecord = RECORD_NAMES[recordType] ?? `0x${recordType.toString(16)}`;
            if (recordType === 0x0c) {
                const id = r.i32();
                libraries.set(id, r.readString());
                continue;
            }
            if (recordType >= 0x02 && recordType <= 0x05) {
                r.i32(); // objectId
                info.className = r.readString();
                const memberCount = r.i32();
                if (memberCount >= 0 && memberCount < 4096) {
                    info.memberNames = [];
                    for (let i = 0; i < memberCount; i++) {
                        info.memberNames.push(r.readString());
                    }
                }
                if (recordType === 0x02 || recordType === 0x04) {
                    info.libraryName = 'mscorlib';
                } else if (recordType === 0x03) {
                    info.libraryName = libraries.get(r.i32());
                } else {
                    // ClassWithMembersAndTypes: MemberTypeInfo precedes libraryId; the
                    // only library at this point is almost always the one declared.
                    info.libraryName = libraries.size === 1 ? [...libraries.values()][0] : undefined;
                }
            } else if (recordType === 0x06) {
                r.i32();
                info.className = 'System.String';
            } else if (recordType === 0x0f) {
                r.i32();
                r.i32();
                info.className = `${PRIMITIVE_NAMES[r.u8()] ?? 'Primitive'}[]`;
            } else if (recordType === 0x11) {
                info.className = 'System.String[]';
            } else if (recordType === 0x10) {
                info.className = 'System.Object[]';
            }
            break;
        }
    } catch {
        // partially decoded is still useful
    }
    return info;
}

const PRIMITIVE_NAMES: Record<number, string> = {
    1: 'System.Boolean', 2: 'System.Byte', 3: 'System.Char', 5: 'System.Decimal', 6: 'System.Double',
    7: 'System.Int16', 8: 'System.Int32', 9: 'System.Int64', 10: 'System.SByte', 11: 'System.Single',
    12: 'System.TimeSpan', 13: 'System.DateTime', 14: 'System.UInt16', 15: 'System.UInt32', 16: 'System.UInt64',
    18: 'System.String',
};

function findNrbfByteArrays(buf: Buffer, offset: number, length: number): { offset: number; length: number }[] {
    const found: { offset: number; length: number }[] = [];
    const end = offset + length;
    // ArraySinglePrimitive: 0x0F, objectId:int32, length:int32, primitiveType:byte (2 = Byte)
    for (let i = offset + 17; i + 10 <= end; i++) {
        if (buf[i] !== 0x0f || buf[i + 9] !== 0x02) {
            continue;
        }
        const id = buf.readInt32LE(i + 1);
        const len = buf.readInt32LE(i + 5);
        if (id > 0 && len >= 0 && i + 10 + len <= end) {
            found.push({ offset: i + 10, length: len });
            i += 9 + len;
        }
    }
    return found;
}

/** Finds a displayable image inside a payload: either the payload itself or a byte[] inside NRBF. */
export function findImage(buf: Buffer, offset: number, length: number, nrbf?: NrbfInfo): EmbeddedImage | undefined {
    const direct = detectImage(buf, offset, length);
    if (direct) {
        return direct;
    }
    if (nrbf) {
        const arrays = [...nrbf.byteArrays].sort((a, b) => b.length - a.length);
        for (const a of arrays) {
            const img = detectImage(buf, a.offset, a.length);
            if (img) {
                return img;
            }
        }
    }
    return undefined;
}
