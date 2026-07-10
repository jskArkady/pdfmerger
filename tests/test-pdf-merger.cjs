const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const {
  PdfMergeError,
  analyzePdfDocument,
  mergePdfDocuments,
  _internal
} = require("../src/pdf-merger.js");

function buildPdf(objects, trailerExtra = "", rootId = 1) {
  let output = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];

  objects.forEach((body, index) => {
    const id = index + 1;
    offsets[id] = output.length;
    output += `${id} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = output.length;
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
  for (let id = 1; id <= objects.length; id += 1) {
    output += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${rootId} 0 R ${trailerExtra} >>\n`;
  output += `startxref\n${xrefStart}\n%%EOF\n`;
  return _internal.binaryStringToBytes(output);
}

function buildPdfWithRevisions(objects, rootId = 1) {
  let output = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  for (const object of objects) {
    output += `${object.id} ${object.generation || 0} obj\n${object.body}\nendobj\n`;
  }
  output += `trailer\n<< /Root ${rootId} 0 R >>\nstartxref\n0\n%%EOF\n`;
  return _internal.binaryStringToBytes(output);
}

function makeSinglePagePdf(label) {
  const stream = `BT /F1 12 Tf 40 140 Td (${label} 1 0 R literal) Tj ET`;
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> >>",
    "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  ]);
}

function assertThrowsPdfError(action, expectedText) {
  assert.throws(
    action,
    (error) => error instanceof PdfMergeError && error.message.includes(expectedText)
  );
}

// ─── Basic merge tests ───

const firstPdf = makeSinglePagePdf("first");
const secondPdf = makeSinglePagePdf("second");

assert.equal(analyzePdfDocument(firstPdf, "first.pdf").pageCount, 1);

const merged = mergePdfDocuments([
  { name: "first.pdf", data: firstPdf },
  { name: "second.pdf", data: secondPdf }
]);
const mergedText = _internal.bytesToBinaryString(merged.bytes);

assert.equal(merged.pageCount, 2);
assert.deepEqual(
  merged.documents.map((document) => document.name),
  ["first.pdf", "second.pdf"]
);
assert.equal(analyzePdfDocument(merged.bytes, "merged.pdf").pageCount, 2);
assert.ok(mergedText.startsWith("%PDF-1.7"));
assert.match(mergedText, /<< \/Type \/Pages \/Kids \[4 0 R 9 0 R\] \/Count 2 >>/);
assert.match(mergedText, /4 0 obj\s*<< \/Parent 2 0 R \/Type \/Pages/);
assert.match(mergedText, /9 0 obj\s*<< \/Parent 2 0 R \/Type \/Pages/);
assert.match(mergedText, /5 0 obj\s*<< \/Resources << \/Font << \/F1 6 0 R >> >> \/MediaBox \[0 0 200 200\]/);
assert.ok(mergedText.includes("(first 1 0 R literal)"));
assert.ok(mergedText.includes("(second 1 0 R literal)"));

const protectedReferenceText = [
  "<< /Next 1 0 R",
  "/Title (keep 1 0 R and (nested 1 0 R))",
  "/Code <3120302052>",
  "% keep 1 0 R",
  ">>"
].join("\n");
const rewrittenReferenceText = _internal.rewriteReferences(
  protectedReferenceText,
  new Map([["1 0", 9]])
);
assert.match(rewrittenReferenceText, /\/Next 9 0 R/);
assert.ok(rewrittenReferenceText.includes("(keep 1 0 R and (nested 1 0 R))"));
assert.ok(rewrittenReferenceText.includes("<3120302052>"));
assert.ok(rewrittenReferenceText.includes("% keep 1 0 R"));

const reversed = mergePdfDocuments([
  { name: "second.pdf", data: secondPdf },
  { name: "first.pdf", data: firstPdf }
]);
assert.deepEqual(
  reversed.documents.map((document) => document.name),
  ["second.pdf", "first.pdf"]
);

// PDF syntax inside strings and streams must not be treated as document structure.
const encryptTextPdf = makeSinglePagePdf("visible /Encrypt text");
assert.equal(analyzePdfDocument(encryptTextPdf, "encrypt-text.pdf").pageCount, 1);

const misleadingCatalogPdf = buildPdf(
  [
    "<< /Title (/Type /Catalog /Pages 99 0 R stream endobj) /Note (plain /Encrypt text) >>",
    "<< /Type /Catalog /Pages 3 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 3 0 R >>"
  ],
  "/Info 1 0 R",
  2
);
const misleadingObjects = _internal.extractObjects(
  _internal.bytesToBinaryString(misleadingCatalogPdf),
  "syntax-in-string.pdf"
);
assert.equal(misleadingObjects.length, 4);
assert.ok(misleadingObjects[0].body.includes("stream endobj"));
assert.equal(
  analyzePdfDocument(misleadingCatalogPdf, "syntax-in-string.pdf").pageCount,
  1
);

// Incremental PDFs may contain more than one revision of the same object.
const revisedPdf = buildPdfWithRevisions([
  { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
  { id: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
  { id: 3, body: "<< /Type /Page /Parent 2 0 R >>" },
  { id: 2, body: "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>" },
  { id: 4, body: "<< /Type /Page /Parent 2 0 R >>" }
]);
const revisedInfo = analyzePdfDocument(revisedPdf, "revised.pdf");
assert.equal(revisedInfo.pageCount, 2);
assert.equal(revisedInfo.objectCount, 4);

const revisedMerged = mergePdfDocuments([{ name: "revised.pdf", data: revisedPdf }]);
const revisedMergedText = _internal.bytesToBinaryString(revisedMerged.bytes);
const revisedObjectIds = Array.from(
  revisedMergedText.matchAll(/^(\d+) 0 obj$/gm),
  (match) => Number(match[1])
);
assert.equal(revisedObjectIds.length, new Set(revisedObjectIds).size);
assert.equal(analyzePdfDocument(revisedMerged.bytes, "revised-merged.pdf").pageCount, 2);

const revisedRootPdf = buildPdfWithRevisions(
  [
    { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { id: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { id: 3, body: "<< /Type /Page /Parent 2 0 R >>" },
    { id: 4, body: "<< /Type /Catalog /Pages 5 0 R >>" },
    { id: 5, body: "<< /Type /Pages /Kids [6 0 R 7 0 R] /Count 2 >>" },
    { id: 6, body: "<< /Type /Page /Parent 5 0 R >>" },
    { id: 7, body: "<< /Type /Page /Parent 5 0 R >>" }
  ],
  4
);
assert.equal(analyzePdfDocument(revisedRootPdf, "revised-root.pdf").pageCount, 2);

// ─── Encrypted PDF test ───

const encryptedPdf = buildPdf(
  [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R >>"
  ],
  "/Encrypt 9 0 R"
);
assertThrowsPdfError(
  () => analyzePdfDocument(encryptedPdf, "encrypted.pdf"),
  "Encrypted"
);

// ─── Inflate unit test ───

const testString = "Hello, PDF Object Stream World!";
const testBytes = Buffer.from(testString, "utf-8");
const compressed = zlib.deflateSync(testBytes);
const decompressed = _internal.decompressFlateDecode(new Uint8Array(compressed));
assert.equal(
  _internal.bytesToBinaryString(decompressed),
  testString,
  "FlateDecode round-trip should produce original data"
);

// ─── Object Stream test (uncompressed) ───

const page11Body = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>";
const font12Body = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
const objStmIndex = "11 0 12 " + page11Body.length;
const objStmFirst = objStmIndex.length + 1;
const objStmStream = objStmIndex + "\n" + page11Body + font12Body;

const uncompressedObjStmPdf = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [11 0 R] /Count 1 >>",
  `<< /Type /ObjStm /N 2 /First ${objStmFirst} /Length ${objStmStream.length} >>\nstream\n${objStmStream}\nendstream`
]);

const uncompressedResult = analyzePdfDocument(uncompressedObjStmPdf, "uncompressed-objstm.pdf");
assert.equal(uncompressedResult.pageCount, 1, "Uncompressed ObjStm: should find 1 page");

// ─── Object Stream test (FlateDecode compressed) ───

const compressedStreamData = zlib.deflateSync(Buffer.from(objStmStream, "binary"));
const compressedStreamStr = _internal.bytesToBinaryString(compressedStreamData);

const compressedObjStmPdf = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [11 0 R] /Count 1 >>",
  `<< /Type /ObjStm /N 2 /First ${objStmFirst} /Filter/FlateDecode /Length ${compressedStreamData.length} >>\nstream\n${compressedStreamStr}\nendstream`
]);

const compressedResult = analyzePdfDocument(compressedObjStmPdf, "compressed-objstm.pdf");
assert.equal(compressedResult.pageCount, 1, "FlateDecode ObjStm: should find 1 page");

// A direct object in a later incremental revision must supersede an older ObjStm entry.
const revisedObjStmPdf = buildPdfWithRevisions([
  { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
  { id: 2, body: "<< /Type /Pages /Kids [11 0 R] /Count 1 >>" },
  {
    id: 3,
    body: `<< /Type /ObjStm /N 2 /First ${objStmFirst} /Length ${objStmStream.length} >>\nstream\n${objStmStream}\nendstream`
  },
  { id: 11, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>" }
]);
const revisedObjStmDocument = _internal.parseDocument(
  revisedObjStmPdf,
  "revised-objstm.pdf"
);
assert.match(revisedObjStmDocument.objectMap.get("11 0").body, /\[0 0 300 300\]/);

// ─── Merge ObjStm PDF with normal PDF ───

const objStmMerged = mergePdfDocuments([
  { name: "objstm.pdf", data: compressedObjStmPdf },
  { name: "normal.pdf", data: firstPdf }
]);
assert.equal(objStmMerged.pageCount, 2, "Merging ObjStm PDF with normal PDF should produce 2 pages");
assert.equal(
  analyzePdfDocument(objStmMerged.bytes, "merged-objstm.pdf").pageCount,
  2,
  "Re-analyzing merged ObjStm output should find 2 pages"
);

// ─── Merge two ObjStm PDFs ───

const objStmMerged2 = mergePdfDocuments([
  { name: "objstm1.pdf", data: compressedObjStmPdf },
  { name: "objstm2.pdf", data: uncompressedObjStmPdf }
]);
assert.equal(objStmMerged2.pageCount, 2, "Merging two ObjStm PDFs should produce 2 pages");

console.log("pdf-merger tests passed");
