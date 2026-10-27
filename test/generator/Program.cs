// Generates .resources fixtures with the real .NET writers and records what the
// real .NET ResourceReader sees in them, so the TypeScript parser can be checked
// against the reference implementation.
using System.Globalization;
using System.Resources;
using System.Resources.Extensions;
using System.Text;
using System.Text.Json;

var outDir = Path.GetFullPath(args.Length > 0 ? args[0] : "fixtures");
Directory.CreateDirectory(outDir);

// 1x1 red PNG
byte[] png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==");
byte[] bmp = MakeBmp();
const string BitmapType = "System.Drawing.Bitmap, System.Drawing, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a";

// ---------- V2, standard ResourceWriter ----------
string v2Path = Path.Combine(outDir, "v2-standard.resources");
using (var w = new ResourceWriter(v2Path))
{
    w.AddResource("Greeting", "Hello, world!");
    w.AddResource("Vietnamese", "Xin chào thế giới – Tiếng Việt có dấu ✓ 😀");
    w.AddResource("Empty", "");
    w.AddResource("MultiLine", "Line 1\r\nLine 2\n\tTabbed \"quoted\" <tag>");
    w.AddResource("LongString", string.Concat(Enumerable.Repeat("0123456789abcdef", 200)));
    w.AddResource("NullValue", (object?)null);
    w.AddResource("Bool.True", true);
    w.AddResource("Bool.False", false);
    w.AddResource("Char", 'Ư');
    w.AddResource("Byte", (byte)255);
    w.AddResource("SByte", (sbyte)-128);
    w.AddResource("Int16", (short)-32768);
    w.AddResource("UInt16", (ushort)65535);
    w.AddResource("Int32", int.MinValue);
    w.AddResource("UInt32", uint.MaxValue);
    w.AddResource("Int64", long.MinValue);
    w.AddResource("UInt64", ulong.MaxValue);
    w.AddResource("Single", 3.14f);
    w.AddResource("Double", Math.PI);
    w.AddResource("Decimal", -12345.678900m);
    w.AddResource("Decimal.Max", decimal.MaxValue);
    w.AddResource("DateTime.Utc", new DateTime(2024, 2, 29, 13, 45, 30, DateTimeKind.Utc).AddTicks(1234567));
    w.AddResource("DateTime.Unspecified", new DateTime(1999, 12, 31, 23, 59, 59, DateTimeKind.Unspecified));
    w.AddResource("DateTime.Local", new DateTime(2020, 6, 15, 8, 0, 0, DateTimeKind.Local));
    w.AddResource("DateTime.Min", DateTime.MinValue);
    w.AddResource("DateTime.Pre1970", new DateTime(1900, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddTicks(5));
    w.AddResource("TimeSpan", new TimeSpan(3, 4, 5, 6, 789).Add(TimeSpan.FromTicks(1)));
    w.AddResource("TimeSpan.Negative", TimeSpan.FromMinutes(-90));
    w.AddResource("Bytes.Png", png);
    w.AddResource("Bytes.Plain", new byte[] { 1, 2, 3, 4, 5 });
    w.AddResource("Stream.Bmp", new MemoryStream(bmp));
    w.AddResourceData("Logo", BitmapType, MakeNrbfBitmap(png));
    w.AddResource("Form1.Text", "Bond Management – Main");
}

// ---------- V2, PreserializedResourceWriter (System.Resources.Extensions) ----------
string prePath = Path.Combine(outDir, "v2-preserialized.resources");
using (var w = new PreserializedResourceWriter(prePath))
{
    w.AddResource("Title", "Preserialized string");
    w.AddResource("Number", 42);
    w.AddResource("Point", "10, 20", "System.Drawing.Point, System.Drawing, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a");
    w.AddTypeConverterResource("Image", png, BitmapType);
    w.AddActivatorResource("Icon.Stream", new MemoryStream(MakeIco(png)), "System.Drawing.Icon, System.Drawing, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a", true);
#pragma warning disable SYSLIB0011
    w.AddBinaryFormattedResource("Legacy.Bitmap", MakeNrbfBitmap(png), BitmapType);
#pragma warning restore SYSLIB0011
}

// ---------- many resources (hash table ordering) ----------
string manyPath = Path.Combine(outDir, "many.resources");
using (var w = new ResourceWriter(manyPath))
{
    for (int i = 0; i < 2000; i++)
    {
        w.AddResource($"Key_{i:D4}_{(char)('A' + i % 26)}", $"Value number {i}");
    }
}

var report = new Dictionary<string, object>();
foreach (var path in new[] { v2Path, prePath, manyPath })
{
    report[Path.GetFileName(path)] = Describe(path);
}
File.WriteAllText(Path.Combine(outDir, "expected.json"), JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine($"Fixtures written to {outDir}");

static object Describe(string path)
{
    var entries = new List<object>();
    // Enumerating keys never deserializes values.
    var names = new List<string>();
    using (var keys = new DeserializingResourceReader(path))
    {
        var en = keys.GetEnumerator();
        while (en.MoveNext())
        {
            names.Add((string)en.Key);
        }
    }
    System.Resources.ResourceReader? raw = null;
    try
    {
        raw = new System.Resources.ResourceReader(path);
    }
    catch (NotSupportedException)
    {
        // Preserialized files are rejected by the standard reader; GetResourceData is unavailable.
    }
    foreach (var name in names)
    {
        string? typeName = null;
        byte[] data = Array.Empty<byte>();
        raw?.GetResourceData(name, out typeName, out data);
        string? value = null;
        try
        {
            value = Format(GetValue(path, name));
        }
        catch (Exception ex)
        {
            value = "!" + ex.GetType().Name;
        }
        entries.Add(new { name, typeName, dataLength = raw is null ? (int?)null : data.Length, value });
    }
    raw?.Dispose();
    return entries;
}

static object? GetValue(string path, string name)
{
    using var r = new DeserializingResourceReader(path);
    var e = r.GetEnumerator();
    while (e.MoveNext())
    {
        if ((string)e.Key == name) return e.Value;
    }
    throw new KeyNotFoundException(name);
}

static string? Format(object? v) => v switch
{
    null => null,
    string s => s,
    bool b => b ? "True" : "False",
    char c => c.ToString(),
    float f => f.ToString("R", CultureInfo.InvariantCulture),
    double d => d.ToString("R", CultureInfo.InvariantCulture),
    decimal m => m.ToString(CultureInfo.InvariantCulture),
    DateTime dt => (dt.Kind == DateTimeKind.Local ? dt.ToUniversalTime() : dt).ToString("yyyy-MM-ddTHH:mm:ss.fffffff", CultureInfo.InvariantCulture) + "|" + dt.Kind,
    TimeSpan ts => ts.ToString("c", CultureInfo.InvariantCulture),
    byte[] bytes => "bytes:" + bytes.Length,
    Stream st => "stream:" + st.Length,
    IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
    _ => "object:" + v.GetType().FullName,
};

static byte[] MakeBmp()
{
    // 2x2 24-bit BMP
    var ms = new MemoryStream();
    var bw = new BinaryWriter(ms);
    int rowSize = 8, pixels = rowSize * 2;
    bw.Write((byte)'B'); bw.Write((byte)'M');
    bw.Write(54 + pixels); bw.Write(0); bw.Write(54);
    bw.Write(40); bw.Write(2); bw.Write(2); bw.Write((short)1); bw.Write((short)24);
    bw.Write(0); bw.Write(pixels); bw.Write(2835); bw.Write(2835); bw.Write(0); bw.Write(0);
    bw.Write(new byte[] { 0, 0, 255, 0, 255, 0, 0, 0 });
    bw.Write(new byte[] { 255, 0, 0, 255, 255, 255, 0, 0 });
    return ms.ToArray();
}

static byte[] MakeIco(byte[] pngData)
{
    var ms = new MemoryStream();
    var bw = new BinaryWriter(ms);
    bw.Write((short)0); bw.Write((short)1); bw.Write((short)1);
    bw.Write((byte)1); bw.Write((byte)1); bw.Write((byte)0); bw.Write((byte)0);
    bw.Write((short)1); bw.Write((short)32); bw.Write(pngData.Length); bw.Write(22);
    bw.Write(pngData);
    return ms.ToArray();
}

// What BinaryFormatter writes for System.Drawing.Bitmap: a class with one byte[] member "Data".
static byte[] MakeNrbfBitmap(byte[] imageData)
{
    var ms = new MemoryStream();
    var bw = new BinaryWriter(ms, Encoding.UTF8);
    bw.Write((byte)0x00); bw.Write(1); bw.Write(-1); bw.Write(1); bw.Write(0);               // SerializationHeaderRecord
    bw.Write((byte)0x0C); bw.Write(2); bw.Write("System.Drawing, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a"); // BinaryLibrary
    bw.Write((byte)0x05); bw.Write(1); bw.Write("System.Drawing.Bitmap"); bw.Write(1); bw.Write("Data"); // ClassWithMembersAndTypes
    bw.Write((byte)7); bw.Write((byte)2); bw.Write(2);                                         // PrimitiveArray of Byte, libraryId 2
    bw.Write((byte)0x0F); bw.Write(3); bw.Write(imageData.Length); bw.Write((byte)2); bw.Write(imageData); // ArraySinglePrimitive
    bw.Write((byte)0x0B);                                                                      // MessageEnd
    return ms.ToArray();
}
