// Checks the parser against fixtures written (and read back) by the real .NET
// ResourceWriter / ResourceReader. Generate fixtures first:
//   dotnet run --project test/generator -- test/fixtures
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseResources, resourceNameHash } = require('../out/resourcesParser');
const { ParseError } = require('../out/binaryReader');

const fixtures = path.join(__dirname, 'fixtures');
let failures = 0;
let passed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failures++;
        console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
    }
}

function load(file) {
    return parseResources(fs.readFileSync(path.join(fixtures, file)));
}

function byName(parsed) {
    return new Map(parsed.entries.map((e) => [e.name, e]));
}

// ---------- compare with .NET ResourceReader ----------
const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));

for (const [file, entries] of Object.entries(expected)) {
    console.log(file);
    const parsed = load(file);
    const map = byName(parsed);

    test('header is valid, no warnings, every entry decoded', () => {
        assert.strictEqual(parsed.version, 2);
        assert.strictEqual(parsed.numResources, entries.length);
        assert.deepStrictEqual(parsed.warnings, []);
        assert.ok(parsed.hashesSorted);
        assert.strictEqual(parsed.hashMismatches, 0);
        for (const e of parsed.entries) assert.ok(!e.error, `${e.name}: ${e.error}`);
    });

    test('resource names match ResourceReader', () => {
        assert.deepStrictEqual([...map.keys()].sort(), entries.map((e) => e.name).sort());
    });

    test('types, sizes and values match ResourceReader', () => {
        for (const x of entries) {
            const e = map.get(x.name);
            if (x.typeName) {
                if (x.typeName.startsWith('ResourceTypeCode.')) {
                    assert.strictEqual(e.typeCodeName, x.typeName.slice('ResourceTypeCode.'.length), `${x.name} type`);
                } else {
                    assert.strictEqual(e.typeName, x.typeName, `${x.name} type`);
                }
            }
            if (x.dataLength !== null) {
                const codeLen = e.typeCode < 0x80 ? 1 : 2;
                assert.strictEqual(e.dataSize - codeLen, x.dataLength, `${x.name} data length`);
            }
            checkValue(x, e);
        }
    });
}

function checkValue(x, e) {
    const v = x.value;
    const where = `${x.name}: expected ${JSON.stringify(v)}, got ${JSON.stringify(e.value)}`;
    if (v === null) {
        assert.strictEqual(e.kind, 'null', where);
    } else if (v.startsWith('!') || v.startsWith('object:')) {
        // .NET could not (or did not) materialize the object; it must be a user type here.
        assert.ok(e.kind === 'object' || e.kind === 'string', where);
    } else if (v.startsWith('bytes:') || v.startsWith('stream:')) {
        assert.strictEqual(e.valueLength, Number(v.split(':')[1]), where);
    } else if (e.typeCodeName === 'Char') {
        assert.ok(e.value.startsWith(`'${v}'`), where);
    } else if (e.typeCodeName === 'DateTime') {
        const [iso, kind] = v.split('|');
        assert.strictEqual(e.value.slice(0, 27), iso, where);
        assert.ok(e.value.includes(kind), where);
    } else {
        assert.strictEqual(e.value, v, where);
    }
}

// ---------- specific decoding checks ----------
console.log('details');
test('standard file: images, NRBF and strings', () => {
    const m = byName(load('v2-standard.resources'));
    assert.strictEqual(m.get('Bytes.Png').image.format, 'PNG');
    assert.strictEqual(m.get('Bytes.Plain').image, undefined);
    assert.strictEqual(m.get('Stream.Bmp').image.format, 'BMP');
    const logo = m.get('Logo');
    assert.strictEqual(logo.kind, 'object');
    assert.strictEqual(logo.serializationFormat, 'BinaryFormatter');
    assert.strictEqual(logo.nrbf.className, 'System.Drawing.Bitmap');
    assert.deepStrictEqual(logo.nrbf.memberNames, ['Data']);
    assert.ok(logo.nrbf.libraryName.startsWith('System.Drawing'));
    assert.strictEqual(logo.image.format, 'PNG');
    assert.strictEqual(logo.image.length, 70);
    assert.strictEqual(m.get('Vietnamese').value, 'Xin chào thế giới – Tiếng Việt có dấu ✓ 😀');
    assert.strictEqual(m.get('LongString').value.length, 3200);
    assert.strictEqual(m.get('Char').value, "'Ư' (U+01AF)");
    assert.strictEqual(m.get('Decimal.Max').value, '79228162514264337593543950335');
    assert.strictEqual(m.get('Int64').value, '-9223372036854775808');
    assert.strictEqual(m.get('UInt64').value, '18446744073709551615');
    const p = load('v2-standard.resources');
    assert.strictEqual(p.readerType.split(',')[0], 'System.Resources.ResourceReader');
    assert.strictEqual(p.resourceSetType.split(',')[0], 'System.Resources.RuntimeResourceSet');
    assert.strictEqual(p.preserialized, false);
    assert.strictEqual(p.types.length, 1);
    assert.strictEqual(p.types[0].count, 1);
});

test('preserialized file: all SerializationFormat kinds', () => {
    const p = load('v2-preserialized.resources');
    assert.strictEqual(p.preserialized, true);
    const m = byName(p);
    assert.strictEqual(m.get('Title').value, 'Preserialized string');
    assert.strictEqual(m.get('Number').value, '42');
    const point = m.get('Point');
    assert.strictEqual(point.serializationFormat, 'TypeConverterString');
    assert.strictEqual(point.value, '10, 20');
    const image = m.get('Image');
    assert.strictEqual(image.serializationFormat, 'TypeConverterByteArray');
    assert.strictEqual(image.image.format, 'PNG');
    assert.strictEqual(image.valueLength, 70);
    const icon = m.get('Icon.Stream');
    assert.strictEqual(icon.serializationFormat, 'ActivatorStream');
    assert.strictEqual(icon.image.format, 'ICO');
    const legacy = m.get('Legacy.Bitmap');
    assert.strictEqual(legacy.serializationFormat, 'BinaryFormatter');
    assert.strictEqual(legacy.nrbf.className, 'System.Drawing.Bitmap');
    assert.strictEqual(legacy.image.format, 'PNG');
});

test('regions tile the whole file without gaps', () => {
    for (const f of ['v2-standard.resources', 'v2-preserialized.resources', 'many.resources']) {
        const p = load(f);
        let pos = 0;
        for (const r of p.regions) {
            assert.strictEqual(r.offset, pos, `${f}: ${r.name} starts at ${r.offset}, expected ${pos}`);
            pos += r.size;
        }
        assert.strictEqual(pos, p.fileSize, f);
    }
});

test('name hash matches FastResourceComparer for known values', () => {
    // Values taken from the files written by ResourceWriter.
    const p = load('many.resources');
    for (const e of p.entries) assert.strictEqual(resourceNameHash(e.name), e.storedHash);
    assert.strictEqual(resourceNameHash(''), 5381);
});

// ---------- V1 format (hand-built, .NET Core cannot write it) ----------
console.log('version 1');
function write7(n, out) {
    let v = n >>> 0;
    while (v >= 0x80) {
        out.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    out.push(v);
}
function str(s, out) {
    const b = Buffer.from(s, 'utf8');
    write7(b.length, out);
    out.push(...b);
}
function i32(n, out) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(n);
    out.push(...b);
}
function buildV1(items, types) {
    const out = [];
    i32(0xbeefcace | 0, out);
    i32(1, out);
    const hdr = [];
    str('System.Resources.ResourceReader, mscorlib', hdr);
    str('System.Resources.RuntimeResourceSet, mscorlib', hdr);
    i32(hdr.length, out);
    out.push(...hdr);
    i32(1, out);
    i32(items.length, out);
    i32(types.length, out);
    types.forEach((t) => str(t, out));
    const pad = 'PAD';
    for (let i = 0; out.length & 7; i++) out.push(pad.charCodeAt(i % 3));
    const sorted = items.map((it) => ({ ...it, hash: resourceNameHash(it.name) })).sort((a, b) => a.hash - b.hash);
    const names = [];
    const data = [];
    const positions = [];
    for (const it of sorted) {
        positions.push(names.length);
        const nb = Buffer.from(it.name, 'utf16le');
        write7(nb.length, names);
        names.push(...nb);
        i32(data.length, names);
        it.write(data);
    }
    sorted.forEach((it) => i32(it.hash, out));
    positions.forEach((p) => i32(p, out));
    i32(out.length + 4 + names.length, out);
    out.push(...names, ...data);
    return Buffer.from(out);
}
const v1 = buildV1(
    [
        { name: 'Hello', write: (o) => { write7(0, o); str('Xin chào', o); } },
        { name: 'Answer', write: (o) => { write7(1, o); i32(42, o); } },
        { name: 'When', write: (o) => { write7(2, o); const b = Buffer.alloc(8); b.writeBigInt64LE(630822816000000000n); o.push(...b); } },
        { name: 'Nothing', write: (o) => write7(-1, o) },
        { name: 'Blob', write: (o) => { write7(3, o); o.push(0, 1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 1, 0, 0, 0, 0, 0, 0, 0, 0x0b); } },
    ],
    ['System.String, mscorlib', 'System.Int32, mscorlib', 'System.DateTime, mscorlib', 'System.Collections.ArrayList, mscorlib'],
);
test('V1 values decode through the type table', () => {
    const p = parseResources(v1);
    assert.strictEqual(p.version, 1);
    assert.deepStrictEqual(p.warnings, []);
    const m = byName(p);
    assert.strictEqual(m.get('Hello').value, 'Xin chào');
    assert.strictEqual(m.get('Hello').typeName, 'System.String, mscorlib');
    assert.strictEqual(m.get('Answer').value, '42');
    assert.strictEqual(m.get('When').value, '2000-01-01T00:00:00.0000000 (Unspecified)');
    assert.strictEqual(m.get('Nothing').kind, 'null');
    assert.strictEqual(m.get('Blob').kind, 'object');
    assert.strictEqual(m.get('Blob').valueLength, 18);
});

// ---------- robustness ----------
console.log('robustness');
test('rejects non-.resources input with a clear error', () => {
    assert.throws(() => parseResources(Buffer.from('MZ not a resources file at all')), /magic number/);
    assert.throws(() => parseResources(Buffer.alloc(3)), /too small/);
});

test('truncated and corrupted files never crash with non-parse errors', () => {
    const src = fs.readFileSync(path.join(fixtures, 'v2-standard.resources'));
    const check = (buf) => {
        try {
            parseResources(buf);
        } catch (e) {
            if (!(e instanceof ParseError)) throw new Error(`unexpected ${e.constructor.name}: ${e.message}`);
        }
    };
    for (let len = 0; len < src.length; len += 7) check(src.subarray(0, len));
    let seed = 12345;
    const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    for (let i = 0; i < 3000; i++) {
        const b = Buffer.from(src);
        for (let k = 0; k < 4; k++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
        check(b);
    }
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
