/**
 * Minimal equivalent of System.IO.BinaryReader over a Node Buffer, with
 * bounds checking so malformed files produce readable errors.
 */
export class ParseError extends Error {
    constructor(message: string, public readonly offset: number) {
        super(`${message} (offset 0x${offset.toString(16).toUpperCase()})`);
    }
}

export class BinaryReader {
    constructor(public readonly buf: Buffer, public pos = 0, public readonly end = buf.length) {}

    get remaining(): number {
        return this.end - this.pos;
    }

    ensure(count: number, what: string): void {
        if (count < 0 || this.pos + count > this.end) {
            throw new ParseError(`Unexpected end of data while reading ${what} (need ${count} bytes, ${this.remaining} left)`, this.pos);
        }
    }

    u8(): number {
        this.ensure(1, 'byte');
        return this.buf.readUInt8(this.pos++);
    }

    i8(): number {
        this.ensure(1, 'sbyte');
        return this.buf.readInt8(this.pos++);
    }

    i16(): number {
        this.ensure(2, 'Int16');
        const v = this.buf.readInt16LE(this.pos);
        this.pos += 2;
        return v;
    }

    u16(): number {
        this.ensure(2, 'UInt16');
        const v = this.buf.readUInt16LE(this.pos);
        this.pos += 2;
        return v;
    }

    i32(): number {
        this.ensure(4, 'Int32');
        const v = this.buf.readInt32LE(this.pos);
        this.pos += 4;
        return v;
    }

    u32(): number {
        this.ensure(4, 'UInt32');
        const v = this.buf.readUInt32LE(this.pos);
        this.pos += 4;
        return v;
    }

    i64(): bigint {
        this.ensure(8, 'Int64');
        const v = this.buf.readBigInt64LE(this.pos);
        this.pos += 8;
        return v;
    }

    u64(): bigint {
        this.ensure(8, 'UInt64');
        const v = this.buf.readBigUInt64LE(this.pos);
        this.pos += 8;
        return v;
    }

    f32(): number {
        this.ensure(4, 'Single');
        const v = this.buf.readFloatLE(this.pos);
        this.pos += 4;
        return v;
    }

    f64(): number {
        this.ensure(8, 'Double');
        const v = this.buf.readDoubleLE(this.pos);
        this.pos += 8;
        return v;
    }

    bytes(count: number): Buffer {
        this.ensure(count, 'byte array');
        const v = this.buf.subarray(this.pos, this.pos + count);
        this.pos += count;
        return v;
    }

    /** BinaryReader.Read7BitEncodedInt: at most 5 bytes, result is an Int32. */
    read7BitEncodedInt(): number {
        const start = this.pos;
        let result = 0;
        for (let shift = 0; shift < 35; shift += 7) {
            const b = this.u8();
            result |= (b & 0x7f) << shift;
            if ((b & 0x80) === 0) {
                if (shift === 28 && b > 0x0f) {
                    throw new ParseError('Bad 7-bit encoded Int32 (overflow)', start);
                }
                return result | 0;
            }
        }
        throw new ParseError('Bad 7-bit encoded Int32 (more than 5 bytes)', start);
    }

    /** BinaryReader.ReadString: 7-bit encoded byte length + UTF-8 bytes. */
    readString(): string {
        const start = this.pos;
        const len = this.read7BitEncodedInt();
        if (len < 0) {
            throw new ParseError(`Negative string length ${len}`, start);
        }
        return this.bytes(len).toString('utf8');
    }
}
