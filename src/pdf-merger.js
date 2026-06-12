(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.PdfMerger = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PDF_HEADER = "%PDF-";
  const PAGE_TREE_ATTRIBUTES = [
    "Resources",
    "MediaBox",
    "CropBox",
    "Rotate",
    "BleedBox",
    "TrimBox",
    "ArtBox",
    "UserUnit"
  ];

  class PdfMergeError extends Error {
    constructor(message, fileName) {
      super(fileName ? `${fileName}: ${message}` : message);
      this.name = "PdfMergeError";
      this.fileName = fileName || "";
    }
  }

  function bytesToBinaryString(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let result = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      result += String.fromCharCode.apply(null, chunk);
    }
    return result;
  }

  function binaryStringToBytes(text) {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
      bytes[index] = text.charCodeAt(index) & 0xff;
    }
    return bytes;
  }

  function isBoundaryChar(character) {
    return (
      character === undefined ||
      character === "" ||
      character === "\x00" ||
      character === "\t" ||
      character === "\n" ||
      character === "\f" ||
      character === "\r" ||
      character === " " ||
      character === "[" ||
      character === "]" ||
      character === "(" ||
      character === ")" ||
      character === "<" ||
      character === ">" ||
      character === "{" ||
      character === "}" ||
      character === "%"
    );
  }

  function findKeyword(text, keyword, fromIndex) {
    let index = Math.max(0, fromIndex || 0);
    while (index < text.length) {
      const found = text.indexOf(keyword, index);
      if (found === -1) {
        return -1;
      }
      const before = found === 0 ? undefined : text[found - 1];
      const after = text[found + keyword.length];
      if (isBoundaryChar(before) && isBoundaryChar(after)) {
        return found;
      }
      index = found + keyword.length;
    }
    return -1;
  }

  function streamDataStart(text, streamKeywordEnd) {
    if (text[streamKeywordEnd] === "\r" && text[streamKeywordEnd + 1] === "\n") {
      return streamKeywordEnd + 2;
    }
    if (text[streamKeywordEnd] === "\r" || text[streamKeywordEnd] === "\n") {
      return streamKeywordEnd + 1;
    }
    return streamKeywordEnd;
  }

  function findObjectEnd(text, bodyStart) {
    let cursor = bodyStart;
    while (cursor < text.length) {
      const endObjectIndex = findKeyword(text, "endobj", cursor);
      if (endObjectIndex === -1) {
        return -1;
      }

      const streamIndex = findKeyword(text, "stream", cursor);
      if (streamIndex !== -1 && streamIndex < endObjectIndex) {
        const dataStart = streamDataStart(text, streamIndex + "stream".length);
        const endStreamIndex = findKeyword(text, "endstream", dataStart);
        if (endStreamIndex === -1) {
          return -1;
        }
        cursor = endStreamIndex + "endstream".length;
        continue;
      }

      return endObjectIndex;
    }
    return -1;
  }

  function extractObjects(text, fileName) {
    const objects = [];
    const objectPattern = /(\d+)\s+(\d+)\s+obj\b/g;
    let cursor = 0;

    while (cursor < text.length) {
      objectPattern.lastIndex = cursor;
      const match = objectPattern.exec(text);
      if (!match) {
        break;
      }

      const before = match.index === 0 ? undefined : text[match.index - 1];
      if (!isBoundaryChar(before)) {
        cursor = objectPattern.lastIndex;
        continue;
      }

      const number = Number(match[1]);
      const generation = Number(match[2]);
      const bodyStart = objectPattern.lastIndex;
      const bodyEnd = findObjectEnd(text, bodyStart);
      if (bodyEnd === -1) {
        throw new PdfMergeError("PDF object boundary could not be read.", fileName);
      }

      const key = objectKey(number, generation);
      objects.push({
        number,
        generation,
        key,
        body: text.slice(bodyStart, bodyEnd)
      });
      cursor = bodyEnd + "endobj".length;
    }

    return objects;
  }

  function objectKey(number, generation) {
    return `${Number(number)} ${Number(generation)}`;
  }

  function hasType(body, typeName) {
    return new RegExp(`/Type\\s*/${typeName}\\b`).test(body);
  }

  function getReference(body, name) {
    const pattern = new RegExp(`/${name}\\s+(\\d+)\\s+(\\d+)\\s+R\\b`);
    const match = body.match(pattern);
    return match ? objectKey(match[1], match[2]) : "";
  }

  function getCount(body) {
    const match = body.match(/\/Count\s+(-?\d+)/);
    return match ? Number(match[1]) : 0;
  }

  function findArrayBounds(body, name) {
    const nameIndex = body.indexOf(`/${name}`);
    if (nameIndex === -1) {
      return null;
    }

    const openIndex = body.indexOf("[", nameIndex);
    if (openIndex === -1) {
      return null;
    }

    let depth = 0;
    for (let index = openIndex; index < body.length; index += 1) {
      if (body[index] === "[") {
        depth += 1;
      } else if (body[index] === "]") {
        depth -= 1;
        if (depth === 0) {
          return [openIndex, index];
        }
      }
    }
    return null;
  }

  function getKids(body) {
    const bounds = findArrayBounds(body, "Kids");
    if (!bounds) {
      return [];
    }

    const content = body.slice(bounds[0] + 1, bounds[1]);
    const refs = [];
    content.replace(/\b(\d+)\s+(\d+)\s+R\b/g, function (_, number, generation) {
      refs.push(objectKey(number, generation));
      return _;
    });
    return refs;
  }

  function getObjectMap(objects) {
    const map = new Map();
    for (const object of objects) {
      map.set(object.key, object);
    }
    return map;
  }

  function countPages(objectMap, rootKey, fileName) {
    const visited = new Set();

    function visit(key) {
      if (visited.has(key)) {
        throw new PdfMergeError("Circular page tree reference found.", fileName);
      }
      visited.add(key);

      const object = objectMap.get(key);
      if (!object) {
        throw new PdfMergeError(`Missing page tree object ${key} R.`, fileName);
      }

      if (hasType(object.body, "Page")) {
        visited.delete(key);
        return 1;
      }

      if (!hasType(object.body, "Pages")) {
        throw new PdfMergeError(`Object ${key} R is not a page tree node.`, fileName);
      }

      const kids = getKids(object.body);
      if (kids.length > 0) {
        const total = kids.reduce((sum, childKey) => sum + visit(childKey), 0);
        visited.delete(key);
        return total;
      }

      const declaredCount = getCount(object.body);
      if (declaredCount > 0) {
        visited.delete(key);
        return declaredCount;
      }

      throw new PdfMergeError("Page count could not be determined.", fileName);
    }

    return visit(rootKey);
  }

  function findCatalog(objects, fileName) {
    for (const object of objects) {
      if (hasType(object.body, "Catalog")) {
        const pagesKey = getReference(object.body, "Pages");
        if (pagesKey) {
          return { catalog: object, pagesKey };
        }
      }
    }
    throw new PdfMergeError("PDF catalog or page tree was not found.", fileName);
  }

  function assertSupportedPdf(text, objects, fileName) {
    if (!text.includes(PDF_HEADER)) {
      throw new PdfMergeError("Only PDF files can be merged.", fileName);
    }

    if (/\/Encrypt\b/.test(text)) {
      throw new PdfMergeError("Encrypted or password-protected PDFs are not supported.", fileName);
    }

    for (const object of objects) {
      if (hasType(object.body, "ObjStm")) {
        throw new PdfMergeError(
          "PDF object streams are not supported by this no-library merger.",
          fileName
        );
      }
    }
  }

  function analyzePdfDocument(data, fileName) {
    const text = typeof data === "string" ? data : bytesToBinaryString(data);
    const objects = extractObjects(text, fileName);
    if (objects.length === 0) {
      throw new PdfMergeError("No readable PDF objects were found.", fileName);
    }

    assertSupportedPdf(text, objects, fileName);

    const objectMap = getObjectMap(objects);
    const catalogInfo = findCatalog(objects, fileName);
    if (!objectMap.has(catalogInfo.pagesKey)) {
      throw new PdfMergeError("The catalog points to a missing page tree.", fileName);
    }

    const pageCount = countPages(objectMap, catalogInfo.pagesKey, fileName);
    return {
      name: fileName || "document.pdf",
      pageCount,
      objectCount: objects.length,
      pagesKey: catalogInfo.pagesKey
    };
  }

  function transformOutsideStreams(body, transform) {
    let cursor = 0;
    let output = "";

    while (cursor < body.length) {
      const streamIndex = findKeyword(body, "stream", cursor);
      if (streamIndex === -1) {
        output += transform(body.slice(cursor));
        break;
      }

      const dataStart = streamDataStart(body, streamIndex + "stream".length);
      const endStreamIndex = findKeyword(body, "endstream", dataStart);
      if (endStreamIndex === -1) {
        output += transform(body.slice(cursor));
        break;
      }

      output += transform(body.slice(cursor, streamIndex));
      output += body.slice(streamIndex, endStreamIndex + "endstream".length);
      cursor = endStreamIndex + "endstream".length;
    }

    return output;
  }

  function rewriteReferences(body, idMap) {
    return transformOutsideStreams(body, function (segment) {
      return segment.replace(/\b(\d+)\s+(\d+)\s+R\b/g, function (match, number, generation) {
        const mappedId = idMap.get(objectKey(number, generation));
        return mappedId ? `${mappedId} 0 R` : match;
      });
    });
  }

  function setParentReference(body, parentReference) {
    return transformOutsideStreams(body, function (segment) {
      if (/\/Parent\s+\d+\s+\d+\s+R\b/.test(segment)) {
        return segment.replace(/\/Parent\s+\d+\s+\d+\s+R\b/, `/Parent ${parentReference}`);
      }

      const dictionaryStart = segment.indexOf("<<");
      if (dictionaryStart === -1) {
        return segment;
      }

      return (
        segment.slice(0, dictionaryStart + 2) +
        ` /Parent ${parentReference}` +
        segment.slice(dictionaryStart + 2)
      );
    });
  }

  function maybeCopyInheritedAttributes(objectMap, pageObject) {
    const existing = new Set();
    for (const attribute of PAGE_TREE_ATTRIBUTES) {
      if (new RegExp(`/${attribute}\\b`).test(pageObject.body)) {
        existing.add(attribute);
      }
    }
    if (existing.size === PAGE_TREE_ATTRIBUTES.length) {
      return pageObject.body;
    }

    const chainValues = new Map();
    let parentKey = getReference(pageObject.body, "Parent");
    const visited = new Set();

    while (parentKey && !visited.has(parentKey)) {
      visited.add(parentKey);
      const parent = objectMap.get(parentKey);
      if (!parent) {
        break;
      }

      for (const attribute of PAGE_TREE_ATTRIBUTES) {
        if (!existing.has(attribute) && !chainValues.has(attribute)) {
          const value = extractDictionaryValue(parent.body, attribute);
          if (value) {
            chainValues.set(attribute, value);
          }
        }
      }

      parentKey = getReference(parent.body, "Parent");
    }

    if (chainValues.size === 0) {
      return pageObject.body;
    }

    const additions = Array.from(chainValues.entries())
      .map(([name, value]) => `/${name} ${value}`)
      .join(" ");
    return pageObject.body.replace("<<", `<< ${additions} `);
  }

  function extractDictionaryValue(body, name) {
    const nameIndex = body.indexOf(`/${name}`);
    if (nameIndex === -1) {
      return "";
    }

    let cursor = nameIndex + name.length + 1;
    while (/\s/.test(body[cursor] || "")) {
      cursor += 1;
    }

    return readPdfValue(body, cursor).value.trim();
  }

  function readPdfValue(body, startIndex) {
    const first = body[startIndex];
    if (first === "[") {
      return readBalanced(body, startIndex, "[", "]");
    }
    if (first === "<" && body[startIndex + 1] === "<") {
      return readBalanced(body, startIndex, "<<", ">>");
    }
    if (first === "(") {
      return readStringValue(body, startIndex);
    }

    const referenceMatch = body.slice(startIndex).match(/^(\d+\s+\d+\s+R\b)/);
    if (referenceMatch) {
      return {
        value: referenceMatch[1],
        end: startIndex + referenceMatch[1].length
      };
    }

    const tokenMatch = body.slice(startIndex).match(/^[^\s<>\[\]\(\){}%]+/);
    return {
      value: tokenMatch ? tokenMatch[0] : "",
      end: startIndex + (tokenMatch ? tokenMatch[0].length : 0)
    };
  }

  function readBalanced(body, startIndex, openToken, closeToken) {
    let depth = 0;
    let index = startIndex;
    while (index < body.length) {
      if (body.slice(index, index + openToken.length) === openToken) {
        depth += 1;
        index += openToken.length;
        continue;
      }
      if (body.slice(index, index + closeToken.length) === closeToken) {
        depth -= 1;
        index += closeToken.length;
        if (depth === 0) {
          return {
            value: body.slice(startIndex, index),
            end: index
          };
        }
        continue;
      }
      index += 1;
    }

    return {
      value: "",
      end: startIndex
    };
  }

  function readStringValue(body, startIndex) {
    let depth = 0;
    for (let index = startIndex; index < body.length; index += 1) {
      const character = body[index];
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          return {
            value: body.slice(startIndex, index + 1),
            end: index + 1
          };
        }
      }
    }

    return {
      value: "",
      end: startIndex
    };
  }

  function parseDocument(input, fileName) {
    const text = typeof input === "string" ? input : bytesToBinaryString(input);
    const objects = extractObjects(text, fileName);
    if (objects.length === 0) {
      throw new PdfMergeError("No readable PDF objects were found.", fileName);
    }

    assertSupportedPdf(text, objects, fileName);

    const objectMap = getObjectMap(objects);
    const catalogInfo = findCatalog(objects, fileName);
    if (!objectMap.has(catalogInfo.pagesKey)) {
      throw new PdfMergeError("The catalog points to a missing page tree.", fileName);
    }

    return {
      name: fileName || "document.pdf",
      objects,
      objectMap,
      pagesKey: catalogInfo.pagesKey,
      pageCount: countPages(objectMap, catalogInfo.pagesKey, fileName)
    };
  }

  function writePdf(objects) {
    let output = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
    const offsets = [0];

    for (const object of objects) {
      offsets[object.id] = output.length;
      output += `${object.id} 0 obj\n${object.body}\nendobj\n`;
    }

    const xrefStart = output.length;
    const size = objects.length + 1;
    output += `xref\n0 ${size}\n`;
    output += "0000000000 65535 f \n";
    for (let id = 1; id < size; id += 1) {
      output += `${String(offsets[id] || 0).padStart(10, "0")} 00000 n \n`;
    }
    output += `trailer\n<< /Size ${size} /Root 1 0 R >>\n`;
    output += `startxref\n${xrefStart}\n%%EOF\n`;

    return binaryStringToBytes(output);
  }

  function mergePdfDocuments(files) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new PdfMergeError("Select at least one PDF file.");
    }

    const documents = files.map(function (file, index) {
      const name = file.name || `document-${index + 1}.pdf`;
      const data = file.data || file.bytes || file;
      return parseDocument(data, name);
    });

    const catalogId = 1;
    const globalPagesId = 2;
    let nextObjectId = 3;

    for (const document of documents) {
      document.idMap = new Map();
      for (const object of document.objects) {
        document.idMap.set(object.key, nextObjectId);
        nextObjectId += 1;
      }
    }

    const totalPageCount = documents.reduce(function (sum, document) {
      return sum + document.pageCount;
    }, 0);
    const rootPageRefs = documents.map(function (document) {
      return `${document.idMap.get(document.pagesKey)} 0 R`;
    });

    const outputObjects = [
      {
        id: catalogId,
        body: `<< /Type /Catalog /Pages ${globalPagesId} 0 R >>`
      },
      {
        id: globalPagesId,
        body: `<< /Type /Pages /Kids [${rootPageRefs.join(" ")}] /Count ${totalPageCount} >>`
      }
    ];

    for (const document of documents) {
      for (const object of document.objects) {
        let body = object.body;
        if (hasType(body, "Page")) {
          body = maybeCopyInheritedAttributes(document.objectMap, object);
        }
        body = rewriteReferences(body, document.idMap);
        if (object.key === document.pagesKey) {
          body = setParentReference(body, `${globalPagesId} 0 R`);
        }
        outputObjects.push({
          id: document.idMap.get(object.key),
          body
        });
      }
    }

    outputObjects.sort(function (left, right) {
      return left.id - right.id;
    });

    return {
      bytes: writePdf(outputObjects),
      pageCount: totalPageCount,
      documents: documents.map(function (document) {
        return {
          name: document.name,
          pageCount: document.pageCount,
          objectCount: document.objects.length
        };
      })
    };
  }

  return {
    PdfMergeError,
    analyzePdfDocument,
    mergePdfDocuments,
    _internal: {
      bytesToBinaryString,
      binaryStringToBytes,
      extractObjects,
      parseDocument,
      rewriteReferences,
      transformOutsideStreams
    }
  };
});
