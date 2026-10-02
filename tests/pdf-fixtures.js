(function (root, factory) {
  const fixtures = factory();
  if (typeof module === "object" && module.exports) module.exports = fixtures;
  else root.PdfFixtures = fixtures;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

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
    return Uint8Array.from(output, (character) => character.charCodeAt(0));
  }

  function buildPdfWithRevisions(objects, rootId = 1) {
    let output = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
    for (const object of objects) {
      output += `${object.id} ${object.generation || 0} obj\n${object.body}\nendobj\n`;
    }
    output += `trailer\n<< /Root ${rootId} 0 R >>\nstartxref\n0\n%%EOF\n`;
    return Uint8Array.from(output, (character) => character.charCodeAt(0));
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

  return { buildPdf, buildPdfWithRevisions, makeSinglePagePdf };
});
