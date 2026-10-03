const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { PdfMergeError, LIMITS, analyzePdfDocument, mergePdfDocuments, _internal } = require("../src/pdf-merger.js");
const { buildPdf, buildXrefStreamPdf, makeSinglePagePdf } = require("./pdf-fixtures.js");
const text = bytes => Buffer.from(bytes).toString("latin1");
const bytes = value => Buffer.from(value, "latin1");
const merge = input => mergePdfDocuments([{ data: input }]).bytes;
const rejects = (fn, pattern) => assert.throws(fn, error => error instanceof PdfMergeError && (!pattern || pattern.test(error.message)));
const ordinary = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 200] >>",
  "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
  "<< /Length 0 >>\nstream\n\nendstream"
];

// Latest xref, not physical object order, defines the page contents.
const original = text(makeSinglePagePdf("APPROVED"));
const previous = Number(original.match(/startxref\s+(\d+)\s+%%EOF\s*$/)[1]);
const originalOffset = original.indexOf("5 0 obj");
const replacement = "BT /F1 12 Tf 40 140 Td (ALTERED) Tj ET";
let input = original + `5 0 obj\n<< /Length ${replacement.length} >>\nstream\n${replacement}\nendstream\nendobj\n`;
const start = input.length;
input += `xref\n5 1\n${String(originalOffset).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R /Prev ${previous} >>\nstartxref\n${start}\n%%EOF\n`;
const snapshot = bytes(input);
const merged = text(merge(snapshot));
assert.ok(merged.includes("(APPROVED"));
assert.ok(!merged.includes("ALTERED"));
assert.equal(snapshot.toString("latin1"), input);

// Removed objects must not be resurrected from an older revision.
const freed = original + `xref\n5 1\n0000000000 00001 f \ntrailer\n<< /Size 6 /Root 1 0 R /Prev ${previous} >>\nstartxref\n${original.length}\n%%EOF\n`;
rejects(() => merge(bytes(freed)), /Missing referenced/);
const stale = original + `xref\n5 1\n${String(originalOffset).padStart(10, "0")} 00001 n \ntrailer\n<< /Size 6 /Root 1 0 R /Prev ${previous} >>\nstartxref\n${original.length}\n%%EOF\n`;
rejects(() => merge(bytes(stale)), /identifier mismatch/);
rejects(() => analyzePdfDocument(bytes(original.replace("/Size 6", "/Size 4"))), /Size/);
rejects(() => analyzePdfDocument(bytes(original.replace("/Size 6", ""))), /Size/);
rejects(() => analyzePdfDocument(bytes(original.replace("/Size 6", `/Size 6 /Prev ${previous}`))), /circular/);
rejects(() => analyzePdfDocument(bytes(original.replace(/startxref\s+\d+/, "startxref\n0"))), /cross-reference/);

// A fake Root in an unindexed object does not override the actual trailer.
const fakeRoot = original;
const suffix = "99 0 obj\n<< /Root 99 0 R >>\nendobj\n";
const tailStart = fakeRoot.length + suffix.length;
assert.equal(analyzePdfDocument(bytes(fakeRoot + suffix + `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 100 /Root 1 0 R /Prev ${previous} >>\nstartxref\n${tailStart}\n%%EOF\n`)).pageCount, 1);

// Comments and PDF whitespace inside references are syntax, not string content.
for (const space of [" % comment\n", "\x00", "\r\n"]) {
  const pdf = buildPdf(ordinary.map((body, i) => i === 2 ? body.replace("4 0 R", `4${space}0${space}R`) : body));
  const result = text(merge(pdf));
  assert.match(result, /\/Contents 5 0 R/);
  assert.equal(analyzePdfDocument(bytes(result)).pageCount, 1);
}
const protectedString = "<< /Next 4 % comment\n0 R /Text (4 0 R literal) /Hex <3420302052> >>";
assert.equal(_internal.rewriteReferences(protectedString, new Map([["4 0", 9]])), "<< /Next 9 0 R /Text (4 0 R literal) /Hex <3420302052> >>");

// Unreachable objects, document info, metadata, and old comments stay out of output.
const metadata = "CONFIDENTIAL-METADATA";
const privatePdf = buildPdf([
  ordinary[0], ordinary[1], ordinary[2].replace(" >>", " /Metadata 6 0 R >>"), ordinary[3],
  "<< /Title (CONFIDENTIAL-INFO) >>",
  `<< /Type /Metadata /Subtype /XML /Length ${metadata.length} >>\nstream\n${metadata}\nendstream`,
  "(CONFIDENTIAL-ORPHAN)"
], "/Info 5 0 R");
const privateOutput = text(merge(privatePdf));
assert.doesNotMatch(privateOutput, /CONFIDENTIAL|\/Metadata|\/Info/);
assert.equal((privateOutput.match(/\/Type \/Catalog/g) || []).length, 1);
const formPdf = buildPdf([
  ordinary[0], ordinary[1].replace(" >>", " /Resources << /XObject << /Fm 5 0 R >> >> >>"), ordinary[2], ordinary[3],
  "<< /Subtype /Form /BBox [0 0 20 20] /Metadata 6 0 R /Length 0 >>\nstream\n\nendstream",
  `<< /Type /Metadata /Length ${metadata.length} >>\nstream\n${metadata}\nendstream`
]);
assert.doesNotMatch(text(merge(formPdf)), /CONFIDENTIAL|\/Metadata/);

// Preserve exact numeric spelling; PDF does not accept exponent notation.
const numeric = buildPdf(ordinary.map((body, i) => i === 2 ? body.replace(" >>", " /UserUnit 0.0000001 /CustomNumber 9007199254740993 >>") : body));
const numericOutput = text(merge(numeric));
assert.match(numericOutput, /\/UserUnit 0\.0000001\b/);
assert.match(numericOutput, /\/CustomNumber 9007199254740993\b/);

// Security names can be escaped or indirect; strings are never interpreted as keys.
for (const field of ["/AA << >>", "/#41A << >>", "/OpenAction 5 0 R", "/AcroForm << >>", "/OCProperties << >>", "/EmbeddedFiles << >>"]) {
  rejects(() => analyzePdfDocument(buildPdf([ordinary[0].replace(" >>", " " + field + " >>"), ...ordinary.slice(1), "null"])), /Unsupported/);
}
for (const dictionary of [
  "<< /S /URI /URI (https://example.invalid/) >>",
  "<< /S 6 0 R /URI (https://example.invalid/) >>",
  "<< /Type /Action /S /Unknown >>",
  "<< /Type /Sig /Contents <00> >>",
  "<< /Subtype 6 0 R >>",
  "<< /Subtype /Form /Ref << /F (external.pdf) /Page 0 >> >>"
]) {
  const semanticName = dictionary.includes("/Subtype 6") ? "/Link" : "/URI";
  rejects(() => analyzePdfDocument(buildPdf([...ordinary, dictionary, semanticName])), /Unsupported|unsupported/);
}
rejects(() => analyzePdfDocument(buildPdf(ordinary.map((body, i) => i === 3 ? body.replace("/Length", "/F (external.bin) /Length") : body))), /External/);
assert.equal(analyzePdfDocument(makeSinglePagePdf("/AA /JavaScript /URI are only visible text")).pageCount, 1);
rejects(() => analyzePdfDocument(buildPdf(ordinary, "/Encr#79pt 5 0 R")), /Encrypted/);
rejects(() => analyzePdfDocument(buildPdf(ordinary.map((body, i) => i === 2 ? body.replace(" >>", " /Contents 4 0 R >>") : body))), /duplicate/);
rejects(() => analyzePdfDocument(buildPdf(ordinary.map((body, i) => i === 1 ? body.replace("/Count 1", "/Count 2") : body))), /Count/);

// Optional XObject Type and signature Type cannot bypass document policies.
for (const object of [
  "<< /Subtype /Form /OPI << /2.0 << /Version 2 /F (external.tif) >> >> >>",
  "<< /Subtype /PS /Length 0 >>\nstream\n\nendstream",
  "<< /ByteRange [0 0 0 0] /Contents <00> >>"
]) rejects(() => analyzePdfDocument(buildPdf([...ordinary, object])), /Unsupported|unsupported/);
for (const field of ["/OutputIntents []", "/Perms << >>", "/NeedsRendering true", "/NeedsRendering 5 0 R"]) {
  rejects(() => analyzePdfDocument(buildPdf([ordinary[0].replace(" >>", " " + field + " >>"), ...ordinary.slice(1), "true"])), /Unsupported|unsupported/);
}
for (const flag of ["false", "null"]) {
  assert.equal(analyzePdfDocument(buildPdf([ordinary[0].replace(" >>", " /NeedsRendering 5 0 R >>"), ...ordinary.slice(1), flag])).pageCount, 1);
}

// Correct xref-stream type-2 entry wins even over a later physical direct object.
const page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>";
const packed = "11 0 " + page;
const packedObjects = [
  ordinary[0], ordinary[1].replace("3 0 R", "11 0 R"),
  `<< /Type /ObjStm /N 1 /First 5 /Length ${packed.length} >>\nstream\n${packed}\nendstream`
];
const packedPdf = buildXrefStreamPdf(packedObjects, {11: [3, 0]});
assert.equal(analyzePdfDocument(packedPdf).pageCount, 1);
const laterPhysical = [...packedObjects, ...new Array(7).fill("null"), page.replace("200 200", "300 300")];
assert.match(_internal.parseDocument(buildXrefStreamPdf(laterPhysical, {11: [3, 0]})).objectMap.get("11 0").body, /200 200/);

// Hybrid stream entries override free placeholders in the same classic section.
const packedText = text(packedPdf);
const packedXref = Number(packedText.match(/startxref\s+(\d+)/)[1]);
const hybrid = packedText + `xref\n0 1\n0000000000 65535 f \n11 1\n0000000000 00000 f \ntrailer\n<< /Size 13 /Root 1 0 R /XRefStm ${packedXref} >>\nstartxref\n${packedText.length}\n%%EOF\n`;
assert.equal(analyzePdfDocument(bytes(hybrid)).pageCount, 1);
assert.equal(analyzePdfDocument(merge(bytes(hybrid))).pageCount, 1);

// A hybrid supplement's Prev must not become the classic trailer's Prev.
const supplementPrev = text(buildXrefStreamPdf(packedObjects, {11: [3, 0]}, `/Prev ${packedXref}`));
const hybridPrev = supplementPrev + `xref\n0 1\n0000000000 65535 f \n11 1\n0000000000 00000 f \ntrailer\n<< /Size 13 /Root 1 0 R /XRefStm ${packedXref} >>\nstartxref\n${supplementPrev.length}\n%%EOF\n`;
assert.equal(analyzePdfDocument(bytes(hybridPrev)).pageCount, 1);
// Likewise, a supplement Root is not a replacement for the classic trailer Root.
rejects(() => analyzePdfDocument(bytes(hybridPrev.replace("/Size 13 /Root 1 0 R /XRefStm", "/Size 13 /XRefStm"))), /Root/);

// PNG Up predictor used by real compressed xref streams.
const oldXrefObject = packedText.slice(packedXref);
const streamStart = oldXrefObject.indexOf("stream\n") + 7;
const rawLength = Number(oldXrefObject.match(/\/Length (\d+)/)[1]);
const rawXref = bytes(oldXrefObject.slice(streamStart, streamStart + rawLength));
const predicted = [];
for (let row = 0; row < rawXref.length; row += 7) {
  predicted.push(2);
  for (let x = 0; x < 7; x++) predicted.push((rawXref[row + x] - (row ? rawXref[row + x - 7] : 0)) & 255);
}
const compressedXref = zlib.deflateSync(Buffer.from(predicted));
const xrefHeader = oldXrefObject.slice(0, streamStart).replace(`/Length ${rawLength}`, `/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> /Length ${compressedXref.length}`);
const predictedPdf = bytes(packedText.slice(0, packedXref) + xrefHeader + text(compressedXref) + `\nendstream\nendobj\nstartxref\n${packedXref}\n%%EOF\n`);
assert.equal(analyzePdfDocument(predictedPdf).pageCount, 1);
assert.equal(analyzePdfDocument(merge(predictedPdf)).pageCount, 1);

// Differential decompression checks include stored, fixed and dynamic blocks.
let random = 12345;
const noise = Buffer.from(Array.from({ length: 8192 }, () => { random = (random * 1664525 + 1013904223) >>> 0; return random >>> 24; }));
for (const value of [Buffer.alloc(0), Buffer.from("a"), Buffer.from("PDF ".repeat(10000)), noise]) {
  for (const options of [{level:0}, {strategy:zlib.constants.Z_FIXED}, {level:6}, {level:9}]) {
    const compressed = zlib.deflateSync(value, options);
    assert.deepEqual(Buffer.from(_internal.decompressFlateDecode(compressed)), value);
    const damaged = Buffer.from(compressed); damaged[damaged.length - 1] ^= 1;
    rejects(() => _internal.decompressFlateDecode(damaged), /checksum/);
    rejects(() => _internal.decompressFlateDecode(compressed.subarray(0, compressed.length - 1)));
  }
}

// Literal-only dynamic blocks are valid with an unused empty distance alphabet.
const bits = [];
function bit(value, count) { for (let i = 0; i < count; i++) bits.push((value >>> i) & 1); }
bit(1,1); bit(2,2); bit(0,5); bit(0,5); bit(14,4);
const order = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1];
for (const symbol of order) bit(symbol === 0 || symbol === 1 ? 1 : 0, 3);
for (let i = 0; i < 258; i++) bit(i === 65 || i === 256 ? 1 : 0, 1);
bit(0,1); bit(1,1);
const literalOnly = Buffer.alloc(Math.ceil(bits.length / 8));
bits.forEach((value, i) => literalOnly[i >> 3] |= value << (i & 7));
assert.equal(zlib.inflateRawSync(literalOnly).toString(), "A");
assert.equal(Buffer.from(_internal.inflateRaw(literalOnly)).toString(), "A");

// Time-bound the former empty-table regression in a separate process.
const modulePath = require.resolve("../src/pdf-merger.js");
const child = spawnSync(process.execPath, ["--max-old-space-size=128", "-e", `const m=require(${JSON.stringify(modulePath)});try{m._internal.inflateRaw(Uint8Array.from([5,0,0,0]));process.exitCode=1}catch(e){if(e.name!=='PdfMergeError')throw e;console.log('rejected')}`], {timeout:2000, encoding:"utf8"});
assert.equal(child.error, undefined);
assert.equal(child.status, 0);
assert.equal(child.stdout.trim(), "rejected");
rejects(() => analyzePdfDocument(new Uint8Array(LIMITS.fileBytes + 1)), /size limit/);
rejects(() => mergePdfDocuments(new Array(LIMITS.files + 1).fill({data:makeSinglePagePdf("small")})), /Select between/);
rejects(() => analyzePdfDocument(buildPdf([...ordinary, "[".repeat(LIMITS.depth + 1) + "0" + "]".repeat(LIMITS.depth + 1)])), /nesting limit/);
const tooLarge = zlib.deflateSync(Buffer.alloc(LIMITS.decodedBytes + 1), {level:1});
rejects(() => _internal.decompressFlateDecode(tooLarge), /decompression limit/);
console.log("pdf security tests passed");
