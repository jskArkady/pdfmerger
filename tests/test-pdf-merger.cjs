const assert = require("node:assert/strict");
const {
  PdfMergeError,
  analyzePdfDocument,
  mergePdfDocuments,
  _internal
} = require("../src/pdf-merger.js");

function buildPdf(objects, trailerExtra = "") {
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
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra} >>\n`;
  output += `startxref\n${xrefStart}\n%%EOF\n`;
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

const reversed = mergePdfDocuments([
  { name: "second.pdf", data: secondPdf },
  { name: "first.pdf", data: firstPdf }
]);
assert.deepEqual(
  reversed.documents.map((document) => document.name),
  ["second.pdf", "first.pdf"]
);

const objectStreamPdf = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R >>",
  "<< /Type /ObjStm /N 0 /First 0 /Length 0 >>\nstream\n\nendstream"
]);
assertThrowsPdfError(
  () => analyzePdfDocument(objectStreamPdf, "object-stream.pdf"),
  "object streams"
);

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

console.log("pdf-merger tests passed");
