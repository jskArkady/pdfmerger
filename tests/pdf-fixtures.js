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
    const offsets = new Map();
    let previous = null;
    function checkpoint() {
      const start = output.length;
      const size = Math.max(...offsets.keys()) + 1;
      output += `xref\n0 ${size}\n0000000000 65535 f \n`;
      for (let id = 1; id < size; id++) {
        const object = offsets.get(id);
        output += object ? `${String(object.offset).padStart(10, "0")} ${String(object.generation).padStart(5, "0")} n \n` : "0000000000 00000 f \n";
      }
      output += `trailer\n<< /Size ${size} /Root ${rootId} 0 R${previous === null ? "" : " /Prev " + previous} >>\nstartxref\n${start}\n%%EOF\n`;
      previous = start;
    }
    for (const object of objects) {
      if (offsets.has(object.id)) checkpoint();
      offsets.set(object.id, {offset: output.length, generation: object.generation || 0});
      output += `${object.id} ${object.generation || 0} obj\n${object.body}\nendobj\n`;
    }
    checkpoint();
    return Uint8Array.from(output, ch => ch.charCodeAt(0));
  }

  // Explicit type-2 entries make compressed-object fixtures valid PDF 1.5 files.
  function buildXrefStreamPdf(objects, compressed = {}, trailerExtra = "", rootId = 1) {
    let output = "%PDF-1.5\n%\xE2\xE3\xCF\xD3\n";
    const locations = new Map();
    objects.forEach((body, index) => {
      locations.set(index + 1, [1, output.length, 0]);
      output += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    for (const [id, position] of Object.entries(compressed)) locations.set(Number(id), [2, ...position]);
    const xrefId = Math.max(...locations.keys()) + 1;
    const start = output.length;
    locations.set(xrefId, [1, start, 0]);
    const bytes = [];
    for (let id = 0; id <= xrefId; id++) {
      const [type, second, third] = locations.get(id) || [0, 0, id === 0 ? 65535 : 0];
      bytes.push(type, (second >>> 24) & 255, (second >>> 16) & 255, (second >>> 8) & 255, second & 255, (third >>> 8) & 255, third & 255);
    }
    output += `${xrefId} 0 obj\n<< /Type /XRef /Size ${xrefId + 1} /Root ${rootId} 0 R /W [1 4 2] /Length ${bytes.length} ${trailerExtra} >>\nstream\n`;
    output += String.fromCharCode(...bytes) + `\nendstream\nendobj\nstartxref\n${start}\n%%EOF\n`;
    return Uint8Array.from(output, ch => ch.charCodeAt(0));
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

  return { buildPdf, buildPdfWithRevisions, buildXrefStreamPdf, makeSinglePagePdf };
});
