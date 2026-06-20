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
  }

  function analyzePdfDocument(data, fileName) {
    const text = typeof data === "string" ? data : bytesToBinaryString(data);
    let objects = extractObjects(text, fileName);
    if (objects.length === 0) {
      throw new PdfMergeError("No readable PDF objects were found.", fileName);
    }

    assertSupportedPdf(text, objects, fileName);
    objects = unpackObjectStreams(objects, fileName);

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

  // ─── RFC 1951 deflate decompression (pure JS, no dependencies) ───

  const INFLATE_LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const INFLATE_LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const INFLATE_DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const INFLATE_DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  const INFLATE_CL_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

  function buildInflateHuffmanTable(lengths, count) {
    let maxBits = 0;
    for (let i = 0; i < count; i++) {
      if (lengths[i] > maxBits) maxBits = lengths[i];
    }
    if (maxBits === 0) return { bits: 0, table: new Int32Array(1) };

    const blCount = new Array(maxBits + 1).fill(0);
    for (let i = 0; i < count; i++) {
      if (lengths[i]) blCount[lengths[i]]++;
    }

    const nextCode = new Array(maxBits + 1);
    let code = 0;
    nextCode[0] = 0;
    for (let b = 1; b <= maxBits; b++) {
      code = (code + blCount[b - 1]) << 1;
      nextCode[b] = code;
    }

    const size = 1 << maxBits;
    const table = new Int32Array(size).fill(-1);

    for (let sym = 0; sym < count; sym++) {
      const len = lengths[sym];
      if (len === 0) continue;
      let c = nextCode[len]++;
      let rev = 0;
      for (let j = 0; j < len; j++) {
        rev = (rev << 1) | (c & 1);
        c >>= 1;
      }
      const entry = (sym << 8) | len;
      const step = 1 << len;
      for (let idx = rev; idx < size; idx += step) {
        table[idx] = entry;
      }
    }

    return { bits: maxBits, table };
  }

  const INFLATE_FIXED_LIT = (function () {
    const lens = new Array(288);
    for (let i = 0; i <= 143; i++) lens[i] = 8;
    for (let i = 144; i <= 255; i++) lens[i] = 9;
    for (let i = 256; i <= 279; i++) lens[i] = 7;
    for (let i = 280; i <= 287; i++) lens[i] = 8;
    return buildInflateHuffmanTable(lens, 288);
  })();

  const INFLATE_FIXED_DIST = (function () {
    const lens = new Array(32).fill(5);
    return buildInflateHuffmanTable(lens, 32);
  })();

  function inflateRaw(src) {
    const input = src instanceof Uint8Array ? src : new Uint8Array(src);
    const inputLen = input.length;
    let pos = 0;
    let bitBuf = 0;
    let bitCnt = 0;
    const output = [];

    function readBits(n) {
      while (bitCnt < n) {
        if (pos >= inputLen) throw new PdfMergeError("Unexpected end of compressed data.");
        bitBuf |= input[pos++] << bitCnt;
        bitCnt += 8;
      }
      const val = bitBuf & ((1 << n) - 1);
      bitBuf >>>= n;
      bitCnt -= n;
      return val;
    }

    function huffDecode(ht) {
      while (bitCnt < ht.bits) {
        if (pos >= inputLen) throw new PdfMergeError("Unexpected end of compressed data.");
        bitBuf |= input[pos++] << bitCnt;
        bitCnt += 8;
      }
      const entry = ht.table[bitBuf & ((1 << ht.bits) - 1)];
      if (entry < 0) throw new PdfMergeError("Invalid Huffman code in compressed data.");
      const len = entry & 0xFF;
      bitBuf >>>= len;
      bitCnt -= len;
      return entry >>> 8;
    }

    function decodeBlock(litHt, distHt) {
      for (;;) {
        const sym = huffDecode(litHt);
        if (sym < 256) {
          output.push(sym);
        } else if (sym === 256) {
          return;
        } else {
          const li = sym - 257;
          const length = INFLATE_LEN_BASE[li] + (INFLATE_LEN_EXTRA[li] ? readBits(INFLATE_LEN_EXTRA[li]) : 0);
          const di = huffDecode(distHt);
          const distance = INFLATE_DIST_BASE[di] + (INFLATE_DIST_EXTRA[di] ? readBits(INFLATE_DIST_EXTRA[di]) : 0);
          const from = output.length - distance;
          for (let k = 0; k < length; k++) {
            output.push(output[from + k]);
          }
        }
      }
    }

    let bfinal;
    do {
      bfinal = readBits(1);
      const btype = readBits(2);

      if (btype === 0) {
        bitBuf = 0;
        bitCnt = 0;
        const len = input[pos] | (input[pos + 1] << 8);
        pos += 4;
        for (let i = 0; i < len; i++) {
          output.push(input[pos++]);
        }
      } else if (btype === 1) {
        decodeBlock(INFLATE_FIXED_LIT, INFLATE_FIXED_DIST);
      } else if (btype === 2) {
        const hlit = readBits(5) + 257;
        const hdist = readBits(5) + 1;
        const hclen = readBits(4) + 4;

        const clLens = new Array(19).fill(0);
        for (let ci = 0; ci < hclen; ci++) {
          clLens[INFLATE_CL_ORDER[ci]] = readBits(3);
        }
        const clHt = buildInflateHuffmanTable(clLens, 19);

        const allLens = [];
        while (allLens.length < hlit + hdist) {
          const csym = huffDecode(clHt);
          if (csym < 16) {
            allLens.push(csym);
          } else if (csym === 16) {
            const rep = readBits(2) + 3;
            const prev = allLens[allLens.length - 1] || 0;
            for (let r = 0; r < rep; r++) allLens.push(prev);
          } else if (csym === 17) {
            const rep = readBits(3) + 3;
            for (let r = 0; r < rep; r++) allLens.push(0);
          } else {
            const rep = readBits(7) + 11;
            for (let r = 0; r < rep; r++) allLens.push(0);
          }
        }

        decodeBlock(
          buildInflateHuffmanTable(allLens.slice(0, hlit), hlit),
          buildInflateHuffmanTable(allLens.slice(hlit), hdist)
        );
      } else {
        throw new PdfMergeError("Invalid deflate block type.");
      }
    } while (!bfinal);

    return new Uint8Array(output);
  }

  // ─── FlateDecode (zlib wrapper → inflate) ───

  function decompressFlateDecode(streamBytes) {
    const bytes = streamBytes instanceof Uint8Array ? streamBytes : new Uint8Array(streamBytes);
    if (bytes.length < 2) throw new PdfMergeError("FlateDecode stream is too short.");
    let offset = 2;
    if (bytes[1] & 0x20) offset += 4;
    return inflateRaw(bytes.subarray(offset));
  }

  // ─── Object Stream unpacking ───

  function getStreamFilter(dictText) {
    const match = dictText.match(/\/Filter\s+\[?\s*\/(\w+)/);
    return match ? match[1] : "";
  }

  function getIntFromDict(dictText, name) {
    const pattern = new RegExp("/" + name + "\\s+(\\d+)");
    const match = dictText.match(pattern);
    return match ? Number(match[1]) : -1;
  }

  function extractRawStreamBytes(body) {
    const streamIdx = findKeyword(body, "stream", 0);
    if (streamIdx === -1) return null;
    const dataStart = streamDataStart(body, streamIdx + "stream".length);
    const endStreamIdx = findKeyword(body, "endstream", dataStart);
    if (endStreamIdx === -1) return null;
    return binaryStringToBytes(body.slice(dataStart, endStreamIdx));
  }

  function unpackOneObjectStream(object, fileName) {
    const dictEnd = object.body.indexOf("stream");
    if (dictEnd === -1) {
      throw new PdfMergeError("Object stream has no stream data.", fileName);
    }
    const dictText = object.body.slice(0, dictEnd);

    const n = getIntFromDict(dictText, "N");
    const first = getIntFromDict(dictText, "First");
    if (n <= 0 || first < 0) {
      throw new PdfMergeError("Object stream has invalid /N or /First.", fileName);
    }

    const filter = getStreamFilter(dictText);
    const rawBytes = extractRawStreamBytes(object.body);
    if (!rawBytes) {
      throw new PdfMergeError("Could not extract object stream data.", fileName);
    }

    let decoded;
    if (filter === "FlateDecode") {
      decoded = bytesToBinaryString(decompressFlateDecode(rawBytes));
    } else if (filter === "") {
      decoded = bytesToBinaryString(rawBytes);
    } else {
      throw new PdfMergeError(
        "Unsupported object stream filter: /" + filter + ".",
        fileName
      );
    }

    const dataPart = decoded.slice(first);
    const indexPart = decoded.slice(0, first);
    const indexTokens = indexPart.trim().split(/\s+/);
    if (indexTokens.length < n * 2) {
      throw new PdfMergeError("Object stream index is incomplete.", fileName);
    }

    const unpacked = [];
    for (let i = 0; i < n; i++) {
      const objNumber = Number(indexTokens[i * 2]);
      const offset = Number(indexTokens[i * 2 + 1]);
      const nextOffset = i < n - 1 ? Number(indexTokens[(i + 1) * 2 + 1]) : dataPart.length;
      const objBody = dataPart.slice(offset, nextOffset).trim();

      if (objBody.length > 0) {
        unpacked.push({
          number: objNumber,
          generation: 0,
          key: objectKey(objNumber, 0),
          body: objBody
        });
      }
    }

    return unpacked;
  }

  function unpackObjectStreams(objects, fileName) {
    const unpackedObjects = [];
    let hasObjStm = false;

    for (let i = 0; i < objects.length; i++) {
      if (hasType(objects[i].body, "ObjStm")) {
        hasObjStm = true;
        const inner = unpackOneObjectStream(objects[i], fileName);
        for (let j = 0; j < inner.length; j++) {
          unpackedObjects.push(inner[j]);
        }
      }
    }

    if (!hasObjStm) return objects;

    const filtered = objects.filter(function (obj) {
      return !hasType(obj.body, "ObjStm");
    });

    return filtered.concat(unpackedObjects);
  }

  function parseDocument(input, fileName) {
    const text = typeof input === "string" ? input : bytesToBinaryString(input);
    let objects = extractObjects(text, fileName);
    if (objects.length === 0) {
      throw new PdfMergeError("No readable PDF objects were found.", fileName);
    }

    assertSupportedPdf(text, objects, fileName);
    objects = unpackObjectStreams(objects, fileName);

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
      transformOutsideStreams,
      inflateRaw,
      decompressFlateDecode,
      unpackObjectStreams
    }
  };
});
