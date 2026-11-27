import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Minimal PDF writer for the permit card (OQ-03).
 *
 * A full UTF-8 font (Open Sans, Apache-2.0) is embedded as a CIDFontType2 with
 * Identity-H encoding, so Russian text renders without system fonts. Only the
 * glyphs actually used by the document are listed in /W and /ToUnicode.
 */

const FONT_PATH = path.join(__dirname, '../../assets/OpenSans-Regular.ttf');

interface FontData {
  data: Buffer;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  bbox: [number, number, number, number];
  capHeight: number;
  widths: number[];
  cmap: Map<number, number>;
}

interface PdfLine {
  text: string;
  size: number;
  bold?: boolean;
  gapAfter?: number;
}

const CMAP_CACHE = new Map<number, number>();

function readTables(data: Buffer): Map<string, { offset: number; length: number }> {
  const tables = new Map<string, { offset: number; length: number }>();
  const numTables = data.readUInt16BE(4);
  for (let index = 0; index < numTables; index += 1) {
    const base = 12 + index * 16;
    const tag = data.toString('ascii', base, base + 4);
    const offset = data.readUInt32BE(base + 8);
    const length = data.readUInt32BE(base + 12);
    tables.set(tag, { offset, length });
  }
  return tables;
}

function parseCmapFormat4(data: Buffer, offset: number): void {
  const segCountX2 = data.readUInt16BE(offset + 6);
  const segCount = segCountX2 / 2;
  const endCodes = offset + 14;
  const startCodes = endCodes + segCountX2 + 2;
  const idDeltas = startCodes + segCountX2;
  const idRangeOffsets = idDeltas + segCountX2;

  for (let segment = 0; segment < segCount; segment += 1) {
    const end = data.readUInt16BE(endCodes + segment * 2);
    const start = data.readUInt16BE(startCodes + segment * 2);
    const delta = data.readInt16BE(idDeltas + segment * 2);
    const rangeOffset = data.readUInt16BE(idRangeOffsets + segment * 2);
    if (start === 0xffff && end === 0xffff) {
      continue;
    }
    for (let code = start; code <= end && code !== 0xffff; code += 1) {
      if (CMAP_CACHE.has(code)) {
        continue;
      }
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        const glyphOffset =
          idRangeOffsets + segment * 2 + rangeOffset + (code - start) * 2;
        if (glyphOffset + 1 >= data.length) {
          continue;
        }
        glyph = data.readUInt16BE(glyphOffset);
        if (glyph !== 0) {
          glyph = (glyph + delta) & 0xffff;
        }
      }
      if (glyph !== 0) {
        CMAP_CACHE.set(code, glyph);
      }
    }
  }
}

function parseCmapFormat12(data: Buffer, offset: number): void {
  const groups = data.readUInt32BE(offset + 12);
  for (let index = 0; index < groups; index += 1) {
    const base = offset + 16 + index * 12;
    const start = data.readUInt32BE(base);
    const end = data.readUInt32BE(base + 4);
    const startGlyph = data.readUInt32BE(base + 8);
    for (let code = start; code <= end; code += 1) {
      if (!CMAP_CACHE.has(code)) {
        CMAP_CACHE.set(code, startGlyph + (code - start));
      }
    }
  }
}

function parseCmap(data: Buffer, offset: number): void {
  const numTables = data.readUInt16BE(offset + 2);
  let best: { offset: number; format: number; score: number } | null = null;
  for (let index = 0; index < numTables; index += 1) {
    const base = offset + 4 + index * 8;
    const platform = data.readUInt16BE(base);
    const encoding = data.readUInt16BE(base + 2);
    const subOffset = offset + data.readUInt32BE(base + 4);
    const format = data.readUInt16BE(subOffset);
    const score =
      platform === 3 && encoding === 10
        ? 3
        : platform === 3 && encoding === 1
          ? 2
          : platform === 0
            ? 1
            : 0;
    if (score > 0 && (!best || score > best.score)) {
      best = { offset: subOffset, format, score };
    }
  }
  if (!best) {
    throw new Error('PDF font: Unicode cmap not found');
  }
  if (best.format === 12) {
    parseCmapFormat12(data, best.offset);
  } else if (best.format === 4) {
    parseCmapFormat4(data, best.offset);
  } else {
    throw new Error(`PDF font: unsupported cmap format ${best.format}`);
  }
}

let fontCache: FontData | null = null;

function loadFont(): FontData {
  if (fontCache) {
    return fontCache;
  }
  const data = readFileSync(FONT_PATH);
  const tables = readTables(data);
  const head = tables.get('head');
  const hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx');
  const maxp = tables.get('maxp');
  const cmap = tables.get('cmap');
  if (!head || !hhea || !hmtx || !maxp || !cmap) {
    throw new Error('PDF font: required TrueType tables are missing');
  }

  const unitsPerEm = data.readUInt16BE(head.offset + 18);
  const bbox: [number, number, number, number] = [
    data.readInt16BE(head.offset + 36),
    data.readInt16BE(head.offset + 38),
    data.readInt16BE(head.offset + 40),
    data.readInt16BE(head.offset + 42),
  ];
  const ascender = data.readInt16BE(hhea.offset + 4);
  const descender = data.readInt16BE(hhea.offset + 6);
  const numberOfHMetrics = data.readUInt16BE(hhea.offset + 34);
  const numGlyphs = data.readUInt16BE(maxp.offset + 4);
  const widths: number[] = new Array(numGlyphs).fill(0);
  let lastWidth = 0;
  for (let glyph = 0; glyph < numGlyphs; glyph += 1) {
    if (glyph < numberOfHMetrics) {
      lastWidth = data.readUInt16BE(hmtx.offset + glyph * 4);
    }
    widths[glyph] = lastWidth;
  }

  CMAP_CACHE.clear();
  parseCmap(data, cmap.offset);

  fontCache = {
    data,
    unitsPerEm,
    ascender,
    descender,
    bbox,
    capHeight: Math.round(ascender * 0.7),
    widths,
    cmap: CMAP_CACHE,
  };
  return fontCache;
}

function glyphId(font: FontData, char: string): number {
  return font.cmap.get(char.codePointAt(0) ?? 0) ?? 0;
}

function glyphWidth(font: FontData, glyph: number): number {
  return Math.round(((font.widths[glyph] ?? 500) * 1000) / font.unitsPerEm);
}

function measure(font: FontData, text: string, size: number): number {
  let width = 0;
  for (const char of text) {
    width += glyphWidth(font, glyphId(font, char));
  }
  return (width * size) / 1000;
}

function wrap(font: FontData, text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(font, candidate, size) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [''];
}

function hexText(font: FontData, text: string): string {
  let result = '';
  for (const char of text) {
    const glyph = glyphId(font, char);
    result += glyph.toString(16).padStart(4, '0');
  }
  return result;
}

function unicodeHex(char: string): string {
  const codePoint = char.codePointAt(0) ?? 0;
  return codePoint.toString(16).padStart(4, '0');
}

function escapePdfName(value: string): string {
  return value.replace(/[^\w.-]/g, '');
}

interface PdfObject {
  body: Buffer;
}

function objectBuffer(value: string | Buffer): PdfObject {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return { body };
}

function streamObject(dictionary: string, stream: Buffer): PdfObject {
  const header = Buffer.from(
    `<< ${dictionary} /Length ${stream.length} >>\nstream\n`,
    'utf8',
  );
  const footer = Buffer.from('\nendstream', 'utf8');
  return { body: Buffer.concat([header, stream, footer]) };
}

export interface PermitPdfData {
  id: string;
  number: string;
  year: number;
  type: string;
  status: string;
  valid_from: string;
  valid_to: string;
  site_name?: string | null;
  site_code?: string | null;
  work_description: string;
  responsible_name?: string | null;
  external_id?: string | null;
  source_id?: string | null;
  external_url?: string | null;
  version: number;
  generated_at?: string;
}

/**
 * Builds a one-page A4 permit card. Returns a complete PDF file buffer.
 */
export function buildPermitPdf(permit: PermitPdfData): Buffer {
  const font = loadFont();
  const generatedAt = permit.generated_at ?? new Date().toISOString();

  const lines: PdfLine[] = [
    { text: 'ЭОЖ Logbook — НАРЯД-ДОПУСК', size: 16, gapAfter: 6 },
    { text: `Наряд ${permit.number} (${permit.year})`, size: 13, gapAfter: 4 },
    { text: `Тип: ${permit.type}`, size: 11 },
    { text: `Статус: ${permit.status}`, size: 11 },
    {
      text: `Период действия: ${permit.valid_from} — ${permit.valid_to}`,
      size: 11,
    },
    {
      text: `Объект: ${permit.site_name ?? permit.site_code ?? '—'}`,
      size: 11,
    },
    { text: `Ответственный: ${permit.responsible_name ?? '—'}`, size: 11 },
    { text: `Источник: ${permit.source_id ?? '—'} / ${permit.external_id ?? '—'}`, size: 11 },
    ...wrap(font, `Работы: ${permit.work_description}`, 11, 495).map((text) => ({
      text,
      size: 11,
    })),
    { text: '', size: 6 },
    {
      text: `Сформировано: ${generatedAt}`,
      size: 9,
      gapAfter: 2,
    },
    {
      text: 'Документ сформирован ЭОЖ Logbook. Электронная подпись не проставлена;',
      size: 8,
    },
    {
      text: 'юридическая значимость PDF и ЭП определяются OQ-03/OQ-04.',
      size: 8,
    },
    {
      text: permit.external_url ? `Ссылка на источник: ${permit.external_url}` : '',
      size: 8,
    },
  ];

  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 50;
  let y = pageHeight - margin;

  const content: string[] = [];
  for (const line of lines) {
    if (!line.text) {
      y -= (line.size || 8) + 4;
      continue;
    }
    y -= line.size + 4;
    content.push(
      `BT /F1 ${line.size} Tf ${margin} ${y.toFixed(2)} Td <${hexText(font, line.text)}> Tj ET`,
    );
  }
  y -= 10;
  content.push(
    `BT /F1 8 Tf ${margin} ${y.toFixed(2)} Td <${hexText(font, 'Страница 1 из 1')}> Tj ET`,
  );

  // Only glyphs used by this document are exposed via /W and /ToUnicode.
  const used = new Map<number, string>();
  for (const line of lines) {
    for (const char of line.text) {
      const glyph = glyphId(font, char);
      if (glyph !== 0 && !used.has(glyph)) {
        used.set(glyph, char);
      }
    }
  }
  for (const char of 'Страница 1 из 1') {
    const glyph = glyphId(font, char);
    if (glyph !== 0 && !used.has(glyph)) {
      used.set(glyph, char);
    }
  }

  const widths = [...used.keys()]
    .sort((left, right) => left - right)
    .map((glyph) => `${glyph} [${glyphWidth(font, glyph)}]`)
    .join(' ');

  const toUnicodeEntries = [...used.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([glyph, char]) => `<${glyph.toString(16).padStart(4, '0')}> <${unicodeHex(char)}>`);
  const toUnicodeChunks: string[] = [];
  for (let offset = 0; offset < toUnicodeEntries.length; offset += 100) {
    const chunk = toUnicodeEntries.slice(offset, offset + 100);
    toUnicodeChunks.push(
      `${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`,
    );
  }
  const toUnicode = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${toUnicodeChunks.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

  const contentStream = Buffer.from(content.join('\n'), 'latin1');

  // Object layout: 1 Catalog, 2 Pages, 3 Page, 4 Contents, 5 Type0 font,
  // 6 CIDFont, 7 FontDescriptor, 8 FontFile2, 9 ToUnicode.
  const fontName = `/${escapePdfName('OpenSans')}`;
  const objects: PdfObject[] = [];
  const add = (value: string | Buffer): number => {
    objects.push(objectBuffer(value));
    return objects.length;
  };

  const catalogRef = add('<< /Type /Catalog /Pages 2 0 R >>');
  const pagesRef = add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  const pageRef = add(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
  );
  const contentsRef = streamObject('', contentStream);
  objects.push(contentsRef);
  const type0Ref = add(
    `<< /Type /Font /Subtype /Type0 /BaseFont ${fontName} /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 9 0 R >>`,
  );
  const cidFontRef = add(
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont ${fontName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /W [${widths}] /CIDToGIDMap /Identity >>`,
  );
  const descriptorRef = add(
    `<< /Type /FontDescriptor /FontName ${fontName} /Flags 32 /FontBBox [${font.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${font.ascender} /Descent ${font.descender} /CapHeight ${font.capHeight} /StemV 80 /FontFile2 8 0 R >>`,
  );
  const fontFileRef = streamObject('/Length1 ' + font.data.length, font.data);
  objects.push(fontFileRef);
  const toUnicodeRef = streamObject('', Buffer.from(toUnicode, 'latin1'));
  objects.push(toUnicodeRef);

  if (
    catalogRef !== 1 ||
    pagesRef !== 2 ||
    pageRef !== 3 ||
    type0Ref !== 5 ||
    cidFontRef !== 6 ||
    descriptorRef !== 7
  ) {
    throw new Error('PDF writer: invalid object layout');
  }

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets: number[] = [];
  let position = chunks[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(position);
    const prefix = Buffer.from(`${index + 1} 0 obj\n`, 'latin1');
    const suffix = Buffer.from('\nendobj\n', 'latin1');
    chunks.push(prefix, object.body, suffix);
    position += prefix.length + object.body.length + suffix.length;
  });

  const xrefOffset = position;
  const xrefLines = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
  ].join('\n');
  chunks.push(Buffer.from(`${xrefLines}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1'));

  return Buffer.concat(chunks);
}

export function permitPdfFontPath(): string {
  return FONT_PATH;
}

export interface PdfTextRun {
  text: string;
  size: number;
  x: number;
  y: number;
}

export function measurePdfText(text: string, size: number): number {
  return measure(loadFont(), text, size);
}

export function wrapPdfText(
  text: string,
  size: number,
  maxWidth: number,
): string[] {
  return wrap(loadFont(), text, size, maxWidth);
}

function toUnicodeCMap(used: Map<number, string>): string {
  const entries = [...used.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(
      ([glyph, char]) =>
        `<${glyph.toString(16).padStart(4, '0')}> <${unicodeHex(char)}>`,
    );
  const chunks: string[] = [];
  for (let offset = 0; offset < entries.length; offset += 100) {
    const chunk = entries.slice(offset, offset + 100);
    chunks.push(`${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`);
  }
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${chunks.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

function serializePdf(objects: PdfObject[]): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets: number[] = [];
  let position = chunks[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(position);
    const prefix = Buffer.from(`${index + 1} 0 obj\n`, 'latin1');
    const suffix = Buffer.from('\nendobj\n', 'latin1');
    chunks.push(prefix, object.body, suffix);
    position += prefix.length + object.body.length + suffix.length;
  });

  const xrefOffset = position;
  const xrefLines = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
  ].join('\n');
  chunks.push(
    Buffer.from(
      `${xrefLines}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      'latin1',
    ),
  );
  return Buffer.concat(chunks);
}

/**
 * Generic multi-page text PDF. Used by the journal export; the permit card
 * keeps its own single-page layout.
 */
export function buildPdfPages(
  pages: PdfTextRun[][],
  pageWidth = 595,
  pageHeight = 842,
): Buffer {
  if (pages.length === 0) {
    throw new Error('PDF writer: no pages');
  }
  const font = loadFont();
  const used = new Map<number, string>();
  for (const page of pages) {
    for (const run of page) {
      for (const char of run.text) {
        const glyph = glyphId(font, char);
        if (glyph !== 0 && !used.has(glyph)) {
          used.set(glyph, char);
        }
      }
    }
  }

  const widths = [...used.keys()]
    .sort((left, right) => left - right)
    .map((glyph) => `${glyph} [${glyphWidth(font, glyph)}]`)
    .join(' ');
  const toUnicode = toUnicodeCMap(used);
  const fontName = `/${escapePdfName('OpenSans')}`;
  const pageCount = pages.length;
  const fontBase = 3 + pageCount * 2;

  const objects: PdfObject[] = [];
  const add = (value: string | Buffer): number => {
    objects.push(objectBuffer(value));
    return objects.length;
  };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ');
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);

  pages.forEach((runs, index) => {
    const pageRef = 3 + index * 2;
    const contentRef = pageRef + 1;
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontBase} 0 R >> >> /Contents ${contentRef} 0 R >>`,
    );
    const content = runs
      .filter((run) => run.text.length > 0)
      .map(
        (run) =>
          `BT /F1 ${run.size} Tf ${run.x.toFixed(2)} ${run.y.toFixed(2)} Td <${hexText(font, run.text)}> Tj ET`,
      )
      .join('\n');
    objects.push(streamObject('', Buffer.from(content, 'latin1')));
  });

  const type0Ref = add(
    `<< /Type /Font /Subtype /Type0 /BaseFont ${fontName} /Encoding /Identity-H /DescendantFonts [${fontBase + 1} 0 R] /ToUnicode ${fontBase + 4} 0 R >>`,
  );
  const cidFontRef = add(
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont ${fontName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${fontBase + 2} 0 R /W [${widths}] /CIDToGIDMap /Identity >>`,
  );
  const descriptorRef = add(
    `<< /Type /FontDescriptor /FontName ${fontName} /Flags 32 /FontBBox [${font.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${font.ascender} /Descent ${font.descender} /CapHeight ${font.capHeight} /StemV 80 /FontFile2 ${fontBase + 3} 0 R >>`,
  );
  objects.push(streamObject('/Length1 ' + font.data.length, font.data));
  objects.push(streamObject('', Buffer.from(toUnicode, 'latin1')));

  if (
    type0Ref !== fontBase ||
    cidFontRef !== fontBase + 1 ||
    descriptorRef !== fontBase + 2
  ) {
    throw new Error('PDF writer: invalid font object layout');
  }

  return serializePdf(objects);
}
