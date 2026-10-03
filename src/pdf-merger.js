(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.PdfMerger = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

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
      character === "/" ||
      character === "%"
    );
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

  function objectKey(number, generation) {
    return `${Number(number)} ${Number(generation)}`;
  }

  function skipComment(text, startIndex) {
    let index = startIndex;
    while (index < text.length && text[index] !== "\r" && text[index] !== "\n") {
      index += 1;
    }
    return index;
  }

  function skipPdfSpace(text, start) {
    let cursor = start;
    while (cursor < text.length) {
      if (/[\x00\t\n\f\r ]/.test(text[cursor])) {
        cursor += 1;
      } else if (text[cursor] === "%") {
        cursor = skipComment(text, cursor);
      } else {
        break;
      }
    }
    return cursor;
  }

  function decodePdfName(name) {
    return name.replace(/#([\da-f]{2})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)));
  }

  function isKeywordAt(text, keyword, index) {
    return (
      text.slice(index, index + keyword.length) === keyword &&
      isBoundaryChar(index === 0 ? undefined : text[index - 1]) &&
      isBoundaryChar(text[index + keyword.length])
    );
  }

  const LIMITS = Object.freeze({
    fileBytes: 25 * 1024 * 1024, totalBytes: 100 * 1024 * 1024, files: 50,
    decodedBytes: 32 * 1024 * 1024, totalDecodedBytes: 64 * 1024 * 1024,
    objects: 100000, depth: 128, revisions: 128, steps: 2000000,
    outputBytes: 128 * 1024 * 1024, milliseconds: 10000
  });

  function makeBudget() {
    const deadline = Date.now() + LIMITS.milliseconds;
    let steps = 0;
    let decoded = 0;
    return {
      check(amount = 1) {
        steps += amount;
        if (steps > LIMITS.steps || Date.now() > deadline) {
          throw new PdfMergeError("PDF processing limit exceeded.");
        }
      },
      decoded(size) {
        decoded += size;
        if (size > LIMITS.decodedBytes || decoded > LIMITS.totalDecodedBytes) {
          throw new PdfMergeError("PDF decompression limit exceeded.");
        }
        this.check();
      }
    };
  }

  // Values retain byte spans so references can be changed without touching strings.
  function readValue(text, start, budget, depth = 0) {
    budget.check();
    if (depth > LIMITS.depth) throw new PdfMergeError("PDF nesting limit exceeded.");
    let cursor = skipPdfSpace(text, start);
    start = cursor;
    const finish = (type, value, end) => ({ type, value, start, end });
    if (text.slice(cursor, cursor + 2) === "<<") {
      cursor += 2;
      const entries = new Map();
      for (;;) {
        cursor = skipPdfSpace(text, cursor);
        if (text.slice(cursor, cursor + 2) === ">>") return finish("dict", entries, cursor + 2);
        const key = readValue(text, cursor, budget, depth + 1);
        if (key.type !== "name" || entries.has(key.value)) throw new PdfMergeError("Invalid or duplicate PDF dictionary key.");
        const value = readValue(text, key.end, budget, depth + 1);
        entries.set(key.value, value);
        cursor = value.end;
      }
    }
    if (text[cursor] === "[") {
      const values = [];
      cursor++;
      for (;;) {
        cursor = skipPdfSpace(text, cursor);
        if (text[cursor] === "]") return finish("array", values, cursor + 1);
        const value = readValue(text, cursor, budget, depth + 1);
        values.push(value);
        cursor = value.end;
      }
    }
    if (text[cursor] === "(") {
      let nesting = 1;
      cursor++;
      while (cursor < text.length && nesting) {
        if ((cursor & 4095) === 0) budget.check();
        const ch = text[cursor++];
        if (ch === "\\") cursor++;
        else if (ch === "(") nesting++;
        else if (ch === ")") nesting--;
      }
      if (nesting || cursor > text.length) throw new PdfMergeError("Unterminated PDF string.");
      return finish("raw", text.slice(start, cursor), cursor);
    }
    if (text[cursor] === "<") {
      cursor = text.indexOf(">", cursor + 1);
      if (cursor < 0 || /[^\da-f\x00\t\n\f\r ]/i.test(text.slice(start + 1, cursor))) {
        throw new PdfMergeError("Invalid PDF hex string.");
      }
      return finish("raw", text.slice(start, cursor + 1), cursor + 1);
    }
    if (text[cursor] === "/") {
      cursor++;
      while (cursor < text.length && !isBoundaryChar(text[cursor])) cursor++;
      const name = text.slice(start + 1, cursor);
      if (/#(?![\da-f]{2})/i.test(name)) throw new PdfMergeError("Invalid escaped PDF name.");
      return finish("name", decodePdfName(name), cursor);
    }
    const token = text.slice(cursor).match(/^[^\x00\t\n\f\r ()<>\[\]{}/%]+/);
    if (!token) throw new PdfMergeError("Invalid PDF value.");
    cursor += token[0].length;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token[0])) {
      const value = Number(token[0]);
      if (!Number.isFinite(value)) throw new PdfMergeError("Invalid PDF number.");
      if (/^\d+$/.test(token[0])) {
        const genStart = skipPdfSpace(text, cursor);
        const gen = text.slice(genStart).match(/^\d+/);
        if (gen && isBoundaryChar(text[genStart + gen[0].length])) {
          const r = skipPdfSpace(text, genStart + gen[0].length);
          if (isKeywordAt(text, "R", r)) {
            if (!Number.isSafeInteger(value) || value <= 0 || Number(gen[0]) > 65535) throw new PdfMergeError("Invalid PDF reference.");
            return finish("ref", objectKey(value, gen[0]), r + 1);
          }
        }
      }
      return { ...finish("number", value, cursor), raw: token[0] };
    }
    if (["true", "false", "null"].includes(token[0])) return finish("raw", token[0], cursor);
    throw new PdfMergeError("Unsupported PDF value: " + token[0].slice(0, 30));
  }

  function entry(value, name) { return value && value.type === "dict" ? value.value.get(name) : undefined; }
  function nameOf(value) { return value && value.type === "name" ? value.value : ""; }
  function integer(value, label, max = Number.MAX_SAFE_INTEGER) {
    if (!value || value.type !== "number" || !Number.isSafeInteger(value.value) || value.value < 0 || value.value > max) {
      throw new PdfMergeError("Invalid " + label + ".");
    }
    return value.value;
  }
  function numbers(value, label) {
    if (!value || value.type !== "array") throw new PdfMergeError("Invalid " + label + ".");
    return value.value.map(item => integer(item, label));
  }

  function readObject(text, offset, resolve, budget) {
    budget.check();
    const header = text.slice(offset).match(/^(\d+)[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+obj\b/);
    if (!header || offset < 0 || !Number.isSafeInteger(offset)) throw new PdfMergeError("Cross-reference points to an invalid object.");
    const number = Number(header[1]);
    const generation = Number(header[2]);
    if (!Number.isSafeInteger(number) || number <= 0 || generation > 65535) throw new PdfMergeError("Invalid object identifier.");
    const value = readValue(text, offset + header[0].length, budget);
    let cursor = skipPdfSpace(text, value.end);
    let stream = null;
    if (isKeywordAt(text, "stream", cursor)) {
      if (value.type !== "dict") throw new PdfMergeError("PDF stream requires a dictionary.");
      let length = entry(value, "Length");
      if (length && length.type === "ref") {
        if (!resolve) throw new PdfMergeError("Indirect xref stream Length is unsupported.");
        try { length = resolve(length.value).value; }
        catch (error) { throw new PdfMergeError("Cannot resolve indirect stream length: " + error.message); }
      }
      length = integer(length, "PDF stream /Length", LIMITS.fileBytes);
      const start = streamDataStart(text, cursor + 6);
      if (start === cursor + 6 || start + length > text.length) throw new PdfMergeError("Invalid PDF stream Length or line ending.");
      stream = text.slice(start, start + length);
      cursor = start + length;
      if (text.slice(cursor, cursor + 2) === "\r\n") cursor += 2;
      else if (text[cursor] === "\r" || text[cursor] === "\n") cursor++;
      if (!isKeywordAt(text, "endstream", cursor) && !(text.slice(cursor, cursor + 9) === "endstream" && isBoundaryChar(text[cursor + 9]))) {
        throw new PdfMergeError("PDF stream /Length does not match its endstream marker.");
      }
      cursor = skipPdfSpace(text, cursor + 9);
      value.value.set("Length", { type: "number", value: length });
    }
    if (!isKeywordAt(text, "endobj", cursor)) throw new PdfMergeError("PDF object boundary could not be read.");
    return { number, generation, key: objectKey(number, generation), value, stream, sourceOffset: offset, end: cursor + 6 };
  }

  function decodeStream(object, budget) {
    if (object.stream === null) throw new PdfMergeError("Expected a PDF stream.");
    let filter = entry(object.value, "Filter");
    if (filter && filter.type === "array") {
      if (filter.value.length > 1) throw new PdfMergeError("Unsupported stream filter pipeline.");
      filter = filter.value[0];
    }
    let bytes = binaryStringToBytes(object.stream);
    if (filter && !(filter.type === "raw" && filter.value === "null")) {
      if (nameOf(filter) !== "FlateDecode") throw new PdfMergeError("Unsupported stream filter.");
      bytes = decompressFlateDecode(bytes, budget);
    } else budget.decoded(bytes.length);
    let parms = entry(object.value, "DecodeParms");
    if (parms && parms.type === "array" && parms.value.length === 1) parms = parms.value[0];
    if (!parms || (parms.type === "raw" && parms.value === "null")) return bytes;
    if (parms.type !== "dict") throw new PdfMergeError("Unsupported stream DecodeParms.");
    const predictor = entry(parms, "Predictor") ? integer(entry(parms, "Predictor"), "Predictor") : 1;
    if (predictor === 1) return bytes;
    const colors = entry(parms, "Colors") ? integer(entry(parms, "Colors"), "Colors", 32) : 1;
    const bits = entry(parms, "BitsPerComponent") ? integer(entry(parms, "BitsPerComponent"), "BitsPerComponent") : 8;
    const columns = entry(parms, "Columns") ? integer(entry(parms, "Columns"), "Columns", LIMITS.decodedBytes) : 1;
    const width = colors * columns;
    if (bits !== 8 || !width || width > LIMITS.decodedBytes || (predictor !== 2 && (predictor < 10 || predictor > 15))) {
      throw new PdfMergeError("Unsupported stream predictor.");
    }
    const stride = width + (predictor === 2 ? 0 : 1);
    if (bytes.length % stride) throw new PdfMergeError("Invalid predictor row length.");
    const output = new Uint8Array(bytes.length / stride * width);
    budget.decoded(output.length);
    for (let row = 0, target = 0; row < bytes.length; row += stride, target += width) {
      budget.check();
      const type = predictor === 2 ? 1 : bytes[row];
      if (type > 4) throw new PdfMergeError("Invalid PNG predictor.");
      for (let x = 0; x < width; x++) {
        if ((x & 4095) === 0) budget.check();
        const left = x >= colors ? output[target + x - colors] : 0;
        const up = target >= width ? output[target + x - width] : 0;
        const corner = target >= width && x >= colors ? output[target + x - width - colors] : 0;
        let delta = 0;
        if (type === 1) delta = left;
        if (type === 2) delta = up;
        if (type === 3) delta = Math.floor((left + up) / 2);
        if (type === 4) {
          const p = left + up - corner;
          const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
          delta = a <= b && a <= c ? left : b <= c ? up : corner;
        }
        output[target + x] = bytes[row + x + (predictor === 2 ? 0 : 1)] + delta;
      }
    }
    return output;
  }

  function readIndex(text, budget) {
    const start = text.match(/startxref[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+%%EOF[\x00\t\n\f\r ]*$/);
    if (!start) throw new PdfMergeError("Missing final startxref.");
    const entries = new Map();
    const trailer = new Map();
    const visited = new Set();
    let total = 0;
    function add(map, number, value) {
      if (!Number.isSafeInteger(number) || number < 0 || map.has(number) || ++total > LIMITS.objects * 4) throw new PdfMergeError("Invalid or excessive cross-reference entries.");
      map.set(number, value);
    }
    function section(offset, streamOnly = false) {
      budget.check();
      if (!Number.isSafeInteger(offset) || offset < 1 || offset >= text.length || visited.has(offset) || visited.size >= LIMITS.revisions) {
        throw new PdfMergeError("Invalid or circular cross-reference chain.");
      }
      visited.add(offset);
      const map = new Map();
      let dict;
      if (!streamOnly && isKeywordAt(text, "xref", offset)) {
        let cursor = skipPdfSpace(text, offset + 4);
        while (!isKeywordAt(text, "trailer", cursor)) {
          const head = text.slice(cursor).match(/^(\d+)[ \t]+(\d+)[\r\n ]+/);
          if (!head) throw new PdfMergeError("Invalid cross-reference subsection.");
          const first = Number(head[1]), count = Number(head[2]);
          if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || count > LIMITS.objects) throw new PdfMergeError("Cross-reference entry limit exceeded.");
          cursor += head[0].length;
          for (let i = 0; i < count; i++) {
            budget.check();
            const match = text.slice(cursor).match(/^(\d{10})[ \t](\d{5})[ \t]([nf])(?:[ \t]*\r?\n|[ \t]*\r)/);
            if (!match) throw new PdfMergeError("Invalid cross-reference entry.");
            add(map, first + i, { type: match[3] === "n" ? 1 : 0, offset: Number(match[1]), generation: Number(match[2]) });
            cursor += match[0].length;
          }
          cursor = skipPdfSpace(text, cursor);
        }
        dict = readValue(text, cursor + 7, budget);
        if (dict.type !== "dict") throw new PdfMergeError("Invalid PDF trailer.");
        const hybrid = entry(dict, "XRefStm");
        if (hybrid) {
          const supplement = section(integer(hybrid, "XRefStm"), true);
          for (const [id, value] of supplement.map) map.set(id, value);
          // A hybrid supplement contributes entries only. Its trailer, including
          // /Prev, cannot override or extend the classic trailer chain.
        }
      } else {
        const object = readObject(text, offset, null, budget);
        dict = object.value;
        if (nameOf(entry(dict, "Type")) !== "XRef") throw new PdfMergeError("startxref does not point to a cross-reference section.");
        const size = integer(entry(dict, "Size"), "xref Size", LIMITS.objects);
        const widths = numbers(entry(dict, "W"), "xref W");
        const ranges = entry(dict, "Index") ? numbers(entry(dict, "Index"), "xref Index") : [0, size];
        if (widths.length !== 3 || widths.some(n => n > 8) || !widths.some(Boolean) || ranges.length % 2) throw new PdfMergeError("Invalid xref stream fields.");
        const bytes = decodeStream(object, budget);
        let cursor = 0;
        function field(width) {
          let value = 0;
          for (let i = 0; i < width; i++) {
            if (cursor >= bytes.length) throw new PdfMergeError("Truncated xref stream.");
            value = value * 256 + bytes[cursor++];
          }
          if (!Number.isSafeInteger(value)) throw new PdfMergeError("Oversized xref stream field.");
          return value;
        }
        for (let i = 0; i < ranges.length; i += 2) {
          if (ranges[i] + ranges[i + 1] > size) throw new PdfMergeError("Invalid xref Index range.");
          for (let n = 0; n < ranges[i + 1]; n++) {
            budget.check();
            const type = widths[0] ? field(widths[0]) : 1;
            const second = field(widths[1]), third = field(widths[2]);
            if (type > 2) throw new PdfMergeError("Unsupported xref entry type.");
            add(map, ranges[i] + n, type === 2 ? { type, container: second, index: third, generation: 0 } : { type, offset: second, generation: third });
          }
        }
        if (cursor !== bytes.length) throw new PdfMergeError("Unexpected xref stream data.");
      }
      const declaredSize = integer(entry(dict, "Size"), "xref Size", LIMITS.objects);
      if (!declaredSize) throw new PdfMergeError("Invalid xref Size.");
      for (const [id, location] of map) {
        if (id >= declaredSize || location.generation > 65535 || (id === 0 && location.type !== 0)) throw new PdfMergeError("Cross-reference entry exceeds declared Size or generation.");
      }
      return { map, dict, size: declaredSize };
    }
    let offset = Number(start[1]);
    let newestSize = null;
    while (offset !== null) {
      const current = section(offset);
      if (newestSize !== null && current.size > newestSize) throw new PdfMergeError("Cross-reference Size decreases across revisions.");
      newestSize = current.size;
      for (const [id, value] of current.map) if (!entries.has(id)) entries.set(id, value);
      for (const [key, value] of current.dict.value) if (!trailer.has(key)) trailer.set(key, value);
      const previous = entry(current.dict, "Prev");
      offset = previous ? integer(previous, "Prev") : null;
    }
    if (entries.size > LIMITS.objects) throw new PdfMergeError("PDF object limit exceeded.");
    const root = trailer.get("Root");
    if (!root || root.type !== "ref") throw new PdfMergeError("The PDF trailer has no valid Root.");
    const encrypt = trailer.get("Encrypt");
    if (encrypt && !(encrypt.type === "raw" && encrypt.value === "null")) throw new PdfMergeError("Encrypted or password-protected PDFs are not supported.");
    return { entries, root: root.value };
  }

  const FORBIDDEN_KEYS = new Set(["AA", "OpenAction", "JS", "JavaScript", "AcroForm", "XFA", "OCProperties", "OC", "EmbeddedFiles", "EF", "AF", "RichMediaContent", "RichMediaSettings", "OPI"]);
  const ACTION_TYPES = new Set(["GoTo", "GoToR", "GoToE", "Launch", "Thread", "URI", "Sound", "Movie", "Hide", "Named", "SubmitForm", "ResetForm", "ImportData", "JavaScript", "SetOCGState", "Rendition", "Trans", "GoTo3DView"]);
  function checkSafety(value, budget, resolveValue) {
    budget.check();
    if (value.type === "array") value.value.forEach(item => checkSafety(item, budget, resolveValue));
    if (value.type !== "dict") return;
    const type = nameOf(resolveValue(entry(value, "Type")));
    const subtype = nameOf(resolveValue(entry(value, "Subtype")));
    if (["Action", "Filespec", "EmbeddedFile", "Sig", "OCG", "OCMD"].includes(type) || ["Widget", "Link", "FileAttachment", "Screen", "Movie", "Sound", "RichMedia", "3D", "PS"].includes(subtype) || ACTION_TYPES.has(nameOf(resolveValue(entry(value, "S")))) || nameOf(resolveValue(entry(value, "FT"))) === "Sig") {
      throw new PdfMergeError("Unsupported interactive, external, attachment, signature, or layer feature.");
    }
    if ((["Page", "Pages", "Catalog", "Annot", "Outline"].includes(type) || subtype) && entry(value, "A")) throw new PdfMergeError("PDF actions are unsupported.");
    if ((type === "XObject" || subtype === "Form") && entry(value, "Ref")) throw new PdfMergeError("External reference XObjects are unsupported.");
    if (entry(value, "ByteRange") && entry(value, "Contents")) throw new PdfMergeError("PDF signatures are unsupported.");
    if (type === "Catalog") {
      if (entry(value, "OutputIntents") || entry(value, "Perms")) throw new PdfMergeError("Unsupported document output intent or signature permissions.");
      const rendering = resolveValue(entry(value, "NeedsRendering"));
      if (rendering && !(rendering.type === "raw" && ["false", "null"].includes(rendering.value))) throw new PdfMergeError("Documents requiring rendering are unsupported.");
    }
    value.omitMetadata = Boolean(type) || ["Form", "Image"].includes(subtype);
    for (const [key, item] of value.value) {
      if (FORBIDDEN_KEYS.has(key)) throw new PdfMergeError("Unsupported PDF security feature: /" + key + ".");
      checkSafety(item, budget, resolveValue);
    }
  }

  function readDocumentStructure(input, fileName, budget = makeBudget()) {
    if (input.length > LIMITS.fileBytes || input.byteLength > LIMITS.fileBytes) throw new PdfMergeError("PDF file size limit exceeded.", fileName);
    const text = typeof input === "string" ? input : bytesToBinaryString(input);
    if (!/^%PDF-1\.[0-7](?:\r|\n)/.test(text) && !/^%PDF-2\.0(?:\r|\n)/.test(text)) throw new PdfMergeError("Only PDF files can be merged.", fileName);
    const index = readIndex(text, budget);
    const objectMap = new Map();
    const resolving = new Set();
    const containers = new Map();
    function load(key) {
      budget.check();
      if (objectMap.has(key)) return objectMap.get(key);
      if (resolving.has(key) || resolving.size >= LIMITS.depth) throw new PdfMergeError("Circular or excessive PDF object resolution.");
      const [id, generation] = key.split(" ").map(Number);
      const location = index.entries.get(id);
      if (!location || !location.type || location.generation !== generation) throw new PdfMergeError("Reference points to a missing, free or stale object: " + key + ".");
      resolving.add(key);
      let object;
      if (location.type === 1) {
        object = readObject(text, location.offset, load, budget);
        if (object.key !== key) throw new PdfMergeError("Cross-reference object identifier mismatch.");
      } else {
        const containerLocation = index.entries.get(location.container);
        if (!containerLocation || containerLocation.type !== 1 || containerLocation.generation !== 0) throw new PdfMergeError("Invalid object stream container.");
        const container = load(objectKey(location.container, 0));
        if (nameOf(entry(container.value, "Type")) !== "ObjStm") throw new PdfMergeError("Expected an object stream.");
        let packed = containers.get(location.container);
        if (!packed) {
          const count = integer(entry(container.value, "N"), "object stream /N", LIMITS.objects);
          const first = integer(entry(container.value, "First"), "object stream /First", LIMITS.decodedBytes);
          const decoded = bytesToBinaryString(decodeStream(container, budget));
          if (!count || first > decoded.length) throw new PdfMergeError("Invalid object stream header.");
          let cursor = 0;
          const parts = [];
          const ids = new Set();
          for (let i = 0; i < count; i++) {
            const number = readValue(decoded, cursor, budget);
            const offset = readValue(decoded, number.end, budget);
            const id = integer(number, "object stream number");
            const position = integer(offset, "object stream offset");
            if (!id || ids.has(id) || position >= decoded.length - first || (i && position <= parts[i - 1].offset)) throw new PdfMergeError("Invalid object stream index.");
            ids.add(id); parts.push({ id, offset: position }); cursor = offset.end;
          }
          if (skipPdfSpace(decoded, cursor) !== first) throw new PdfMergeError("Invalid object stream /First.");
          packed = { decoded, first, parts };
          containers.set(location.container, packed);
        }
        const part = packed.parts[location.index];
        if (!part || part.id !== id) throw new PdfMergeError("Compressed object index mismatch.");
        const start = packed.first + part.offset;
        const end = location.index + 1 < packed.parts.length ? packed.first + packed.parts[location.index + 1].offset : packed.decoded.length;
        const value = readValue(packed.decoded, start, budget);
        if (skipPdfSpace(packed.decoded, value.end) !== end || value.type === "ref") throw new PdfMergeError("Invalid compressed PDF object boundary.");
        object = { number: id, generation, key, value, stream: null, sourceOffset: container.sourceOffset };
      }
      if (object.stream !== null && entry(object.value, "F")) throw new PdfMergeError("External PDF stream files are unsupported.");
      object.body = serializeObject(object);
      objectMap.set(key, object);
      resolving.delete(key);
      return object;
    }
    // Parse only active xref entries. Unindexed and superseded bytes are never objects.
    for (const [id, location] of index.entries) if (id && location.type) load(objectKey(id, location.generation));
    function resolveValue(value) {
      const seen = new Set();
      while (value && value.type === "ref") {
        budget.check();
        if (seen.has(value.value) || seen.size >= LIMITS.depth) throw new PdfMergeError("Circular security feature reference.");
        seen.add(value.value);
        const object = objectMap.get(value.value);
        if (!object) throw new PdfMergeError("Missing security feature reference.");
        value = object.value;
      }
      return value;
    }
    for (const object of objectMap.values()) checkSafety(object.value, budget, resolveValue);
    return { text, root: index.root, objects: Array.from(objectMap.values()), objectMap, budget };
  }

  function serializeValue(value, idMap, dropMetadata = false, budget) {
    if (budget) budget.check();
    if (value.type === "ref") {
      if (!idMap) return value.value + " R";
      if (!idMap.has(value.value)) throw new PdfMergeError("Unresolved output reference: " + value.value + ".");
      return idMap.get(value.value) + " 0 R";
    }
    if (value.type === "name") return "/" + value.value.replace(/[\x00-\x20\x7f-\xff#%()<>\[\]{}/]/g, ch => "#" + ch.charCodeAt(0).toString(16).padStart(2, "0"));
    if (value.type === "number") return value.raw === undefined ? String(value.value) : value.raw;
    if (value.type === "array") return "[" + value.value.map(v => serializeValue(v, idMap, dropMetadata, budget)).join(" ") + "]";
    if (value.type === "dict") {
      const fields = [];
      const typed = nameOf(entry(value, "Type"));
      for (const [key, item] of value.value) {
        if (dropMetadata && (value.omitMetadata || typed) && ["Metadata", "PieceInfo"].includes(key)) continue;
        fields.push(serializeValue({ type: "name", value: key }) + " " + serializeValue(item, idMap, dropMetadata, budget));
      }
      return "<< " + fields.join(" ") + " >>";
    }
    return value.value;
  }
  function serializeObject(object, idMap, dropMetadata = false, budget) {
    let body = serializeValue(object.value, idMap, dropMetadata, budget);
    if (object.stream !== null) body += "\nstream\n" + object.stream + "\nendstream";
    return body;
  }

  function visitReferences(value, visitor, dropMetadata = false, budget) {
    if (budget) budget.check();
    if (value.type === "ref") visitor(value.value);
    if (value.type === "array") value.value.forEach(v => visitReferences(v, visitor, dropMetadata, budget));
    if (value.type === "dict") for (const [key, item] of value.value) {
      if (dropMetadata && (value.omitMetadata || nameOf(entry(value, "Type"))) && ["Metadata", "PieceInfo"].includes(key)) continue;
      visitReferences(item, visitor, dropMetadata, budget);
    }
  }

  function rewriteReferences(body, idMap) {
    const value = readValue(body, 0, makeBudget());
    const replacements = [];
    function visit(node) {
      if (node.type === "ref" && idMap.has(node.value)) replacements.push({ start: node.start, end: node.end, value: idMap.get(node.value) + " 0 R" });
      if (node.type === "array") node.value.forEach(visit);
      if (node.type === "dict") node.value.forEach(visit);
    }
    visit(value);
    for (const change of replacements.sort((a, b) => b.start - a.start)) body = body.slice(0, change.start) + change.value + body.slice(change.end);
    return body;
  }

  function parseDocument(input, fileName, budget = makeBudget()) {
    try {
      const structure = readDocumentStructure(input, fileName, budget);
      const catalog = structure.objectMap.get(structure.root);
      if (!catalog || nameOf(entry(catalog.value, "Type")) !== "Catalog") throw new PdfMergeError("The PDF trailer points to a missing catalog.");
      const pages = entry(catalog.value, "Pages");
      if (!pages || pages.type !== "ref") throw new PdfMergeError("The PDF catalog has no page tree reference.");
      const visited = new Set();
      function count(key, parent, depth) {
        budget.check();
        if (depth > LIMITS.depth || visited.has(key)) throw new PdfMergeError("Circular, duplicate or excessive page tree reference.");
        visited.add(key);
        const object = structure.objectMap.get(key);
        if (!object) throw new PdfMergeError("Missing page tree object.");
        const type = nameOf(entry(object.value, "Type"));
        const parentValue = entry(object.value, "Parent");
        if (parent && (!parentValue || parentValue.type !== "ref" || parentValue.value !== parent)) throw new PdfMergeError("Invalid page parent reference.");
        if (!parent && parentValue) throw new PdfMergeError("Root page tree has a parent.");
        if (type === "Page") return 1;
        const kids = entry(object.value, "Kids");
        if (type !== "Pages" || !kids || kids.type !== "array") throw new PdfMergeError("Invalid PDF page tree.");
        let total = 0;
        for (const child of kids.value) {
          if (child.type !== "ref") throw new PdfMergeError("Invalid page child reference.");
          total += count(child.value, key, depth + 1);
        }
        if (integer(entry(object.value, "Count"), "page Count", LIMITS.objects) !== total) throw new PdfMergeError("Page Count does not match page tree.");
        return total;
      }
      const pageCount = count(pages.value, "", 0);
      if (!pageCount) throw new PdfMergeError("PDF contains no pages.");
      return { ...structure, name: fileName || "document.pdf", pagesKey: pages.value, pageCount };
    } catch (error) {
      if (error instanceof PdfMergeError && fileName && !error.fileName) throw new PdfMergeError(error.message, fileName);
      throw error;
    }
  }
  function analyzePdfDocument(data, fileName) {
    const document = parseDocument(data, fileName);
    return { name: document.name, pageCount: document.pageCount, objectCount: document.objects.length, pagesKey: document.pagesKey };
  }

  function mergePdfDocuments(files) {
    if (!Array.isArray(files) || !files.length || files.length > LIMITS.files) throw new PdfMergeError("Select between 1 and " + LIMITS.files + " PDF files.");
    const budget = makeBudget();
    let inputBytes = 0;
    const documents = files.map((file, index) => {
      const data = file.data || file.bytes || file;
      inputBytes += typeof data === "string" ? data.length : data.byteLength;
      if (!Number.isFinite(inputBytes) || inputBytes > LIMITS.totalBytes) throw new PdfMergeError("Total PDF input size limit exceeded.");
      return parseDocument(data, file.name || `document-${index + 1}.pdf`, budget);
    });
    const output = [];
    let nextId = 3;
    for (const document of documents) {
      const selected = new Set();
      const queue = [document.pagesKey];
      for (let i = 0; i < queue.length; i++) {
        budget.check();
        const key = queue[i];
        if (selected.has(key)) continue;
        const object = document.objectMap.get(key);
        if (!object) throw new PdfMergeError("Missing referenced PDF object: " + key + ".", document.name);
        const type = nameOf(entry(object.value, "Type"));
        if (["Catalog", "XRef", "ObjStm"].includes(type)) throw new PdfMergeError("Page references unsupported document structure.", document.name);
        selected.add(key);
        visitReferences(object.value, ref => { if (!selected.has(ref)) queue.push(ref); }, true, budget);
        if (queue.length > LIMITS.steps) throw new PdfMergeError("PDF reference limit exceeded.");
      }
      document.idMap = new Map();
      // Stable source numbering keeps output order independent of graph traversal.
      const objects = document.objects.filter(o => selected.has(o.key)).sort((a, b) => a.number - b.number || a.generation - b.generation);
      for (const object of objects) document.idMap.set(object.key, nextId++);
      for (const object of objects) {
        let value = object.value;
        if (object.key === document.pagesKey) {
          value = { ...value, value: new Map(value.value) };
          // This is already an output reference, so serialize it after remapping.
          const body = serializeObject({ ...object, value }, document.idMap, true, budget);
          output.push({ id: document.idMap.get(object.key), body: body.replace("<<", "<< /Parent 2 0 R") });
        } else output.push({ id: document.idMap.get(object.key), body: serializeObject(object, document.idMap, true, budget) });
      }
    }
    const pageCount = documents.reduce((n, d) => n + d.pageCount, 0);
    output.unshift(
      { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { id: 2, body: `<< /Type /Pages /Kids [${documents.map(d => d.idMap.get(d.pagesKey) + " 0 R").join(" ")}] /Count ${pageCount} >>` }
    );
    return { bytes: writePdf(output, budget), pageCount, documents: documents.map(d => ({ name: d.name, pageCount: d.pageCount, objectCount: d.objects.length })) };
  }

  const INFLATE_LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const INFLATE_LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const INFLATE_DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const INFLATE_DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  const INFLATE_CL_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

  function buildInflateHuffmanTable(lengths, count, kind = "literal") {
    let maxBits = 0, symbols = 0;
    const counts = new Array(16).fill(0);
    for (let i = 0; i < count; i++) {
      const length = lengths[i];
      if (!Number.isInteger(length) || length < 0 || length > 15) throw new PdfMergeError("Invalid Huffman length.");
      if (length) { counts[length]++; symbols++; maxBits = Math.max(maxBits, length); }
    }
    if (!maxBits) {
      if (kind === "distance") return { bits: 0, table: new Int32Array([-1]) };
      throw new PdfMergeError("Empty Huffman table.");
    }
    let left = 1;
    for (let bits = 1; bits <= 15; bits++) {
      left = left * 2 - counts[bits];
      if (left < 0) throw new PdfMergeError("Oversubscribed Huffman table.");
    }
    if (left && (kind === "code-length" || symbols !== 1 || maxBits !== 1)) throw new PdfMergeError("Incomplete Huffman table.");
    const nextCode = new Array(maxBits + 1).fill(0);
    let code = 0;
    for (let bits = 1; bits <= maxBits; bits++) {
      code = (code + counts[bits - 1]) << 1;
      nextCode[bits] = code;
    }
    const table = new Int32Array(1 << maxBits).fill(-1);
    for (let sym = 0; sym < count; sym++) {
      const len = lengths[sym];
      if (!len) continue;
      let value = nextCode[len]++, reversed = 0;
      for (let i = 0; i < len; i++) { reversed = (reversed << 1) | (value & 1); value >>= 1; }
      for (let i = reversed; i < table.length; i += 1 << len) table[i] = (sym << 8) | len;
    }
    return { bits: maxBits, table };
  }

  const INFLATE_FIXED_LIT = buildInflateHuffmanTable(Array.from({length:288}, (_, i) => i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8), 288);
  const INFLATE_FIXED_DIST = buildInflateHuffmanTable(new Array(32).fill(5), 32, "distance");

  function inflateRaw(src, budget = makeBudget()) {
    const input = src instanceof Uint8Array ? src : new Uint8Array(src);
    let pos = 0, bitBuf = 0, bitCnt = 0, size = 0;
    let output = new Uint8Array(4096);
    function reserve(length) {
      if (!Number.isSafeInteger(length) || length > LIMITS.decodedBytes) throw new PdfMergeError("PDF decompression limit exceeded.");
      if (length > output.length) {
        const next = new Uint8Array(Math.min(LIMITS.decodedBytes, Math.max(length, output.length * 2)));
        next.set(output); output = next;
      }
    }
    function readBits(n) {
      while (bitCnt < n) {
        if (pos >= input.length) throw new PdfMergeError("Unexpected end of compressed data.");
        bitBuf |= input[pos++] << bitCnt; bitCnt += 8;
      }
      const value = bitBuf & ((1 << n) - 1);
      bitBuf >>>= n; bitCnt -= n;
      return value;
    }
    function huffDecode(ht) {
      budget.check();
      while (bitCnt < ht.bits && pos < input.length) { bitBuf |= input[pos++] << bitCnt; bitCnt += 8; }
      const value = ht.table[bitBuf & ((1 << ht.bits) - 1)];
      const len = value & 255;
      if (value < 0 || !len || len > bitCnt) throw new PdfMergeError("Invalid or truncated Huffman code.");
      bitBuf >>>= len; bitCnt -= len;
      return value >>> 8;
    }
    function decodeBlock(literal, distanceTable) {
      for (;;) {
        const sym = huffDecode(literal);
        if (sym < 256) { reserve(size + 1); output[size++] = sym; }
        else if (sym === 256) return;
        else {
          const li = sym - 257;
          if (li < 0 || li >= INFLATE_LEN_BASE.length) throw new PdfMergeError("Invalid deflate length code.");
          const length = INFLATE_LEN_BASE[li] + readBits(INFLATE_LEN_EXTRA[li]);
          const di = huffDecode(distanceTable);
          if (di >= INFLATE_DIST_BASE.length) throw new PdfMergeError("Invalid deflate distance code.");
          const distance = INFLATE_DIST_BASE[di] + readBits(INFLATE_DIST_EXTRA[di]);
          if (distance > size) throw new PdfMergeError("Deflate distance exceeds available output.");
          reserve(size + length);
          for (let i = 0; i < length; i++) { output[size] = output[size - distance]; size++; }
        }
      }
    }
    let final;
    do {
      budget.check();
      final = readBits(1);
      const type = readBits(2);
      if (type === 0) {
        // Huffman lookahead can leave whole bytes buffered at a block boundary.
        const padding = bitCnt % 8;
        bitBuf >>>= padding; bitCnt -= padding;
        const length = readBits(16), inverse = readBits(16);
        if ((length ^ inverse) !== 65535) throw new PdfMergeError("Invalid stored deflate block length.");
        reserve(size + length);
        for (let i = 0; i < length; i++) {
          if ((i & 4095) === 0) budget.check();
          output[size++] = readBits(8);
        }
      } else if (type === 1) decodeBlock(INFLATE_FIXED_LIT, INFLATE_FIXED_DIST);
      else if (type === 2) {
        const literalCount = readBits(5) + 257, distanceCount = readBits(5) + 1, codeCount = readBits(4) + 4;
        if (literalCount > 286) throw new PdfMergeError("Invalid literal code count.");
        const codeLengths = new Array(19).fill(0);
        for (let i = 0; i < codeCount; i++) codeLengths[INFLATE_CL_ORDER[i]] = readBits(3);
        const codeTable = buildInflateHuffmanTable(codeLengths, 19, "code-length");
        const lengths = [];
        while (lengths.length < literalCount + distanceCount) {
          const symbol = huffDecode(codeTable);
          if (symbol < 16) lengths.push(symbol);
          else {
            if (symbol === 16 && !lengths.length) throw new PdfMergeError("Missing previous Huffman length.");
            const repeat = symbol === 16 ? readBits(2) + 3 : symbol === 17 ? readBits(3) + 3 : readBits(7) + 11;
            if (lengths.length + repeat > literalCount + distanceCount) throw new PdfMergeError("Huffman repeat exceeds code count.");
            const length = symbol === 16 ? lengths[lengths.length - 1] : 0;
            for (let i = 0; i < repeat; i++) lengths.push(length);
          }
        }
        if (!lengths[256]) throw new PdfMergeError("Missing deflate end-of-block code.");
        decodeBlock(buildInflateHuffmanTable(lengths.slice(0, literalCount), literalCount), buildInflateHuffmanTable(lengths.slice(literalCount), distanceCount, "distance"));
      } else throw new PdfMergeError("Invalid deflate block type.");
    } while (!final);
    if (pos - Math.floor(bitCnt / 8) !== input.length) throw new PdfMergeError("Trailing deflate data.");
    budget.decoded(size);
    return output.slice(0, size);
  }

  function decompressFlateDecode(src, budget = makeBudget()) {
    const bytes = src instanceof Uint8Array ? src : new Uint8Array(src);
    if (bytes.length < 6 || (bytes[0] & 15) !== 8 || bytes[0] >>> 4 > 7 || ((bytes[0] << 8) + bytes[1]) % 31 || bytes[1] & 32) {
      throw new PdfMergeError("Invalid or unsupported zlib header.");
    }
    const output = inflateRaw(bytes.subarray(2, bytes.length - 4), budget);
    let a = 1, b = 0;
    for (let i = 0; i < output.length; i++) {
      if ((i & 4095) === 0) budget.check();
      a = (a + output[i]) % 65521; b = (b + a) % 65521;
    }
    const checksum = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 4, 4).getUint32(0);
    if (((b << 16 | a) >>> 0) !== checksum) throw new PdfMergeError("Invalid zlib checksum.");
    return output;
  }

  function writePdf(objects, budget = makeBudget()) {
    let output = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
    const offsets = [0];

    for (const object of objects) {
      budget.check();
      if (output.length + object.body.length + 64 > LIMITS.outputBytes) throw new PdfMergeError("PDF output size limit exceeded.");
      offsets[object.id] = output.length;
      output += `${object.id} 0 obj\n${object.body}\nendobj\n`;
    }

    const xrefStart = output.length;
    const size = objects.length + 1;
    output += `xref\n0 ${size}\n`;
    output += "0000000000 65535 f \n";
    for (let id = 1; id < size; id += 1) {
      if ((id & 1023) === 0) budget.check(1024);
      output += `${String(offsets[id] || 0).padStart(10, "0")} 00000 n \n`;
    }
    output += `trailer\n<< /Size ${size} /Root 1 0 R >>\n`;
    output += `startxref\n${xrefStart}\n%%EOF\n`;

    budget.check();
    if (output.length > LIMITS.outputBytes) throw new PdfMergeError("PDF output size limit exceeded.");
    return binaryStringToBytes(output);
  }

  return {
    PdfMergeError, LIMITS, analyzePdfDocument, mergePdfDocuments,
    _internal: {
      bytesToBinaryString, binaryStringToBytes, parseDocument, rewriteReferences,
      extractObjects: (text, name) => readDocumentStructure(text, name).objects,
      inflateRaw, decompressFlateDecode
    }
  };
});
