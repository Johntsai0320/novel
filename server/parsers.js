const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const chardet = require('chardet');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');
const OpenCC = require('opencc-js');

let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
} catch (_) {
  pdfParse = null;
}

// Initialize OpenCC converters
const converterS2TWP = OpenCC.Converter({ from: 'cn', to: 'twp' });
const converterS2T = OpenCC.Converter({ from: 'cn', to: 'tw' });
const converterT2S = OpenCC.Converter({ from: 'tw', to: 'cn' });

/**
 * Convert text according to mode:
 * - 's2twp': Simplified -> Traditional (Taiwan standard with idioms, default)
 * - 's2t': Simplified -> Traditional (Standard character mapping)
 * - 't2s': Traditional -> Simplified
 * - 'none': Original text without conversion
 */
function convertText(text, mode = 's2twp') {
  if (!text || typeof text !== 'string') return '';
  if (mode === 'none') return text;
  if (mode === 's2t') return converterS2T(text);
  if (mode === 't2s') return converterT2S(text);
  return converterS2TWP(text);
}

/**
 * Compile a boolean search query into a fast predicate function: (haystackLower) => boolean
 * Supports:
 * - AND: space (' ' or '　'), '&', '&&', 'AND'
 * - OR: '|', '||', 'OR'
 * - NOT: '-' or '!' prefix, or 'NOT' keyword
 * - Grouping: '(...)' or '（...）'
 * - Quotes: '"..."' for exact phrase containing spaces
 * - Automatic Simplified & Traditional Chinese cross-matching!
 */
function compileBooleanQuery(rawQuery) {
  if (!rawQuery || typeof rawQuery !== 'string' || !rawQuery.trim()) {
    return () => true;
  }

  // Normalize full-width operators to standard ASCII
  const normalized = rawQuery
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/｜/g, '|')
    .replace(/＆/g, '&')
    .replace(/！/g, '!')
    .trim();

  // Tokenize input into: LPAREN, RPAREN, AND, OR, NOT, TERM
  const tokens = [];
  let i = 0;
  const len = normalized.length;

  while (i < len) {
    const ch = normalized[i];

    // Skip whitespace (implicit AND handled between adjacent value tokens)
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '(') {
      tokens.push({ type: 'LPAREN' });
      i++;
      continue;
    }

    if (ch === ')') {
      tokens.push({ type: 'RPAREN' });
      i++;
      continue;
    }

    if (ch === '|') {
      if (normalized[i + 1] === '|') i += 2;
      else i++;
      tokens.push({ type: 'OR' });
      continue;
    }

    if (ch === '&') {
      if (normalized[i + 1] === '&') i += 2;
      else i++;
      tokens.push({ type: 'AND' });
      continue;
    }

    if (ch === '!' || (ch === '-' && i + 1 < len && !/\s/.test(normalized[i + 1]))) {
      tokens.push({ type: 'NOT' });
      i++;
      continue;
    }

    // Quoted exact phrase
    if (ch === '"' || ch === "'") {
      const quoteChar = ch;
      i++;
      let phrase = '';
      while (i < len && normalized[i] !== quoteChar) {
        phrase += normalized[i];
        i++;
      }
      if (i < len && normalized[i] === quoteChar) i++;
      if (phrase) {
        tokens.push({ type: 'TERM', value: phrase });
      }
      continue;
    }

    // Read a contiguous word/term until whitespace or special operator
    let word = '';
    while (
      i < len &&
      !/\s/.test(normalized[i]) &&
      normalized[i] !== '(' &&
      normalized[i] !== ')' &&
      normalized[i] !== '|' &&
      normalized[i] !== '&'
    ) {
      word += normalized[i];
      i++;
    }

    if (!word) continue;

    const upper = word.toUpperCase();
    if (upper === 'AND') {
      tokens.push({ type: 'AND' });
    } else if (upper === 'OR') {
      tokens.push({ type: 'OR' });
    } else if (upper === 'NOT') {
      tokens.push({ type: 'NOT' });
    } else {
      tokens.push({ type: 'TERM', value: word });
    }
  }

  if (tokens.length === 0) {
    return () => true;
  }

  // Insert implicit AND between adjacent terms / parentheses:
  // e.g., TERM TERM -> TERM AND TERM
  //       TERM LPAREN -> TERM AND LPAREN
  //       RPAREN TERM -> RPAREN AND TERM
  //       RPAREN LPAREN -> RPAREN AND LPAREN
  //       TERM NOT -> TERM AND NOT
  //       RPAREN NOT -> RPAREN AND NOT
  const expanded = [];
  for (let idx = 0; idx < tokens.length; idx++) {
    const curr = tokens[idx];
    const prev = expanded[expanded.length - 1];
    if (prev) {
      const prevIsExprEnd = prev.type === 'TERM' || prev.type === 'RPAREN';
      const currIsExprStart =
        curr.type === 'TERM' || curr.type === 'LPAREN' || curr.type === 'NOT';
      if (prevIsExprEnd && currIsExprStart) {
        expanded.push({ type: 'AND' });
      }
    }
    expanded.push(curr);
  }

  // Pre-build term matcher that checks original, Simplified (t2s), and Traditional (s2twp, s2t) variants
  function createTermPredicate(rawTerm) {
    const base = rawTerm.toLowerCase();
    const variantsSet = new Set([
      base,
      converterS2TWP(base).toLowerCase(),
      converterS2T(base).toLowerCase(),
      converterT2S(base).toLowerCase()
    ]);
    const variants = Array.from(variantsSet).filter(Boolean);
    return (haystackLower) => {
      for (let v = 0; v < variants.length; v++) {
        if (haystackLower.includes(variants[v])) return true;
      }
      return false;
    };
  }

  // Recursive descent parser:
  // In search queries (like "火影|海賊 系統 -後宮"), users expect OR ('|') between terms
  // to bind tighter than space/'&' (AND), i.e. "(火影 OR 海賊) AND 系統 AND NOT 後宮".
  // Grammar:
  // Expr     -> OrExpr ( 'AND' OrExpr )*
  // OrExpr   -> NotExpr ( 'OR' NotExpr )*
  // NotExpr  -> 'NOT' NotExpr | Primary
  // Primary  -> '(' Expr ')' | TERM
  let pos = 0;

  function parseExpr() {
    let left = parseOrExpr();
    while (pos < expanded.length && expanded[pos].type === 'AND') {
      pos++; // consume AND
      const right = parseOrExpr();
      const prevLeft = left;
      left = (h) => prevLeft(h) && right(h);
    }
    return left;
  }

  function parseOrExpr() {
    let left = parseNotExpr();
    while (pos < expanded.length && expanded[pos].type === 'OR') {
      pos++; // consume OR
      const right = parseNotExpr();
      const prevLeft = left;
      left = (h) => prevLeft(h) || right(h);
    }
    return left;
  }

  function parseNotExpr() {
    if (pos < expanded.length && expanded[pos].type === 'NOT') {
      pos++; // consume NOT
      const operand = parseNotExpr();
      return (h) => !operand(h);
    }
    return parsePrimary();
  }

  function parsePrimary() {
    if (pos >= expanded.length) {
      return () => true;
    }
    const tok = expanded[pos];
    if (tok.type === 'LPAREN') {
      pos++; // consume '('
      const inner = parseExpr();
      if (pos < expanded.length && expanded[pos].type === 'RPAREN') {
        pos++; // consume ')'
      }
      return inner;
    }
    if (tok.type === 'TERM') {
      pos++;
      return createTermPredicate(tok.value);
    }
    // Unexpected operator token: skip gracefully
    pos++;
    return parsePrimary();
  }

  try {
    const rootPredicate = parseExpr();
    return rootPredicate;
  } catch (_) {
    // Fallback to simple AND split if malformed
    const fallbackPreds = rawQuery
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(createTermPredicate);
    return (h) => fallbackPreds.every((fn) => fn(h));
  }
}

/**
 * Detect buffer encoding and decode to UTF-8 string.
 * Supports UTF-8, GB18030/GBK/GB2312, Big5, UTF-16LE/BE.
 */
function decodeBuffer(buffer) {
  if (!buffer || buffer.length === 0) {
    return { text: '', encoding: 'UTF-8' };
  }
  // Sample first 64KB for fast encoding detection
  const sample = buffer.subarray(0, Math.min(buffer.length, 65536));
  let detected = (chardet.detect(sample) || 'UTF-8').toUpperCase();

  let encoding = 'utf8';
  if (detected.includes('GB') || detected.includes('18030') || detected.includes('2312') || detected.includes('HZ')) {
    encoding = 'gb18030';
  } else if (detected.includes('BIG5')) {
    encoding = 'big5';
  } else if (detected.includes('UTF-16LE')) {
    encoding = 'utf16-le';
  } else if (detected.includes('UTF-16BE')) {
    encoding = 'utf16-be';
  } else if (detected.includes('ISO-8859') || detected.includes('WINDOWS-1252')) {
    // Often Chinese GBK files get misclassified as ISO-8859-1 on short samples
    encoding = 'gb18030';
  }

  try {
    const text = iconv.decode(buffer, encoding);
    return { text, encoding: encoding.toUpperCase() };
  } catch (err) {
    return { text: buffer.toString('utf8'), encoding: 'UTF-8' };
  }
}

/**
 * Parse a .txt novel buffer into metadata and chapters.
 * Automatically identifies standard Chinese and English chapter headings,
 * and splits oversized unchaptered texts into readable segments.
 */
function parseTxtBuffer(buffer, filename = '未命名小說.txt') {
  const { text: rawText, encoding } = decodeBuffer(buffer);
  const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  const rawTitle = path.basename(filename, path.extname(filename));
  let author = '佚名';

  // Extract author if present in first 25 lines
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const line = lines[i].trim();
    const authorMatch = line.match(/^(?:作者|Author|撰寫|著)\s*[：:]\s*(.+)$/i);
    if (authorMatch && authorMatch[1].trim().length <= 30) {
      author = authorMatch[1].trim();
      break;
    }
  }

  // Regex for chapter headers
  const chapterRegex = /^\s*(?:正文\s*)?(?:第[零一二三四五六七八九十百千萬萬0-9０-９]+[章回節卷集部篇]|楔子|序章|序言|引子|前言|プロローグ|尾聲|後記|番外(?:\s*[零一二三四五六七八九十0-9]+)?|Chapter\s+\d+|卷[零一二三四五六七八九十0-9]+)(?:[\s　：:、.—\-].*)?$/i;

  const chapters = [];
  let currentTitle = '序幕 / 前言';
  let currentLines = [];

  const flushChapter = (title, contentLines) => {
    const joined = contentLines.join('\n').trim();
    if (!joined && chapters.length === 0) return;

    // If a single chapter is extremely long (> 25000 chars), split into sub-parts for smooth mobile reading
    const MAX_CHARS = 18000;
    if (joined.length > MAX_CHARS * 1.4) {
      const paragraphs = joined.split(/\n+/);
      let chunk = [];
      let chunkLen = 0;
      let partNum = 1;
      for (const p of paragraphs) {
        chunk.push(p);
        chunkLen += p.length;
        if (chunkLen >= MAX_CHARS) {
          const partText = chunk.join('\n\n');
          chapters.push({
            index: chapters.length,
            title: partNum === 1 ? title : `${title}（${partNum}）`,
            content: partText,
            wordCount: partText.replace(/\s+/g, '').length
          });
          chunk = [];
          chunkLen = 0;
          partNum++;
        }
      }
      if (chunk.length > 0) {
        const partText = chunk.join('\n\n');
        chapters.push({
          index: chapters.length,
          title: partNum === 1 ? title : `${title}（${partNum}）`,
          content: partText,
          wordCount: partText.replace(/\s+/g, '').length
        });
      }
    } else {
      chapters.push({
        index: chapters.length,
        title,
        content: joined,
        wordCount: joined.replace(/\s+/g, '').length
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed.length <= 65 && chapterRegex.test(trimmed)) {
      if (currentLines.length > 0) {
        flushChapter(currentTitle, currentLines);
        currentLines = [];
      }
      currentTitle = trimmed;
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0 || chapters.length === 0) {
    flushChapter(chapters.length === 0 ? rawTitle : currentTitle, currentLines);
  }

  const totalWords = chapters.reduce((acc, ch) => acc + ch.wordCount, 0);

  return {
    title: rawTitle,
    author,
    description: chapters[0] ? chapters[0].content.slice(0, 180).replace(/\s+/g, ' ') : '',
    encoding,
    format: 'txt',
    totalChapters: chapters.length,
    totalWords,
    chapters
  };
}

/**
 * Resolve relative path inside an EPUB archive
 */
function resolveEpubPath(basePath, relativeHref) {
  if (!relativeHref) return '';
  const cleanHref = decodeURIComponent(relativeHref.split('#')[0]);
  if (!basePath) return cleanHref.replace(/^\/+/, '');
  const combined = path.posix.join(path.posix.dirname(basePath), cleanHref);
  return combined.replace(/^\/+/, '');
}

/**
 * Parse an .epub buffer into metadata, chapters, and asset resolver.
 */
function parseEpubBuffer(buffer, filename = '未命名小說.epub', bookId = '') {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const entryMap = new Map();

  for (const entry of entries) {
    entryMap.set(entry.entryName, entry);
    entryMap.set(decodeURIComponent(entry.entryName), entry);
  }

  const getEntryText = (entryPath) => {
    const normalized = entryPath.replace(/^\/+/, '');
    const entry = entryMap.get(normalized);
    if (!entry) return null;
    const { text } = decodeBuffer(entry.getData());
    return text;
  };

  // 1. Locate OPF file via META-INF/container.xml
  let opfPath = '';
  const containerXml = getEntryText('META-INF/container.xml');
  if (containerXml) {
    const $container = cheerio.load(containerXml, { xmlMode: true });
    opfPath = $container('rootfile').attr('full-path') || '';
  }

  if (!opfPath) {
    const opfEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.opf'));
    if (opfEntry) opfPath = opfEntry.entryName;
  }

  let title = path.basename(filename, path.extname(filename));
  let author = '佚名';
  let description = '';
  const manifest = new Map();
  const spineIds = [];
  let tocId = '';
  let navHref = '';

  if (opfPath) {
    const opfXml = getEntryText(opfPath);
    if (opfXml) {
      const $opf = cheerio.load(opfXml, { xmlMode: true });
      const dcTitle = $opf('dc\\:title, title').first().text().trim();
      const dcCreator = $opf('dc\\:creator, creator').first().text().trim();
      const dcDesc = $opf('dc\\:description, description').first().text().trim();

      if (dcTitle) title = dcTitle;
      if (dcCreator) author = dcCreator;
      if (dcDesc) description = cheerio.load(dcDesc).text().trim();

      $opf('manifest > item').each((_, el) => {
        const id = $opf(el).attr('id');
        const href = $opf(el).attr('href');
        const mediaType = $opf(el).attr('media-type') || '';
        const properties = $opf(el).attr('properties') || '';
        if (id && href) {
          const fullPath = resolveEpubPath(opfPath, href);
          manifest.set(id, { id, href, fullPath, mediaType, properties });
          if (properties.includes('nav')) {
            navHref = fullPath;
          }
        }
      });

      const spineEl = $opf('spine');
      tocId = spineEl.attr('toc') || '';
      $opf('spine > itemref').each((_, el) => {
        const idref = $opf(el).attr('idref');
        if (idref) spineIds.push(idref);
      });
    }
  }

  // 2. Parse TOC mapping (filepath -> chapter title)
  const tocTitleMap = new Map();

  // Check EPUB3 nav document first
  if (navHref) {
    const navHtml = getEntryText(navHref);
    if (navHtml) {
      const $nav = cheerio.load(navHtml);
      $nav('nav a, a').each((_, el) => {
        const href = $nav(el).attr('href');
        const label = $nav(el).text().trim();
        if (href && label) {
          const targetPath = resolveEpubPath(navHref, href);
          if (!tocTitleMap.has(targetPath)) {
            tocTitleMap.set(targetPath, label);
          }
        }
      });
    }
  }

  // Check EPUB2 NCX document
  let ncxPath = '';
  if (tocId && manifest.has(tocId)) {
    ncxPath = manifest.get(tocId).fullPath;
  } else {
    for (const item of manifest.values()) {
      if (item.mediaType.includes('ncx') || item.fullPath.toLowerCase().endsWith('.ncx')) {
        ncxPath = item.fullPath;
        break;
      }
    }
  }

  if (ncxPath) {
    const ncxXml = getEntryText(ncxPath);
    if (ncxXml) {
      const $ncx = cheerio.load(ncxXml, { xmlMode: true });
      $ncx('navPoint').each((_, el) => {
        const label = $ncx(el).find('navLabel > text').first().text().trim();
        const src = $ncx(el).find('content').first().attr('src');
        if (label && src) {
          const targetPath = resolveEpubPath(ncxPath, src);
          if (!tocTitleMap.has(targetPath)) {
            tocTitleMap.set(targetPath, label);
          }
        }
      });
    }
  }

  // 3. Extract spine chapters in reading order
  const chapters = [];
  const spineItems = spineIds
    .map((id) => manifest.get(id))
    .filter(Boolean);

  // Fallback if spine is empty: find all xhtml/html entries
  const htmlTargets =
    spineItems.length > 0
      ? spineItems
      : entries
          .filter((e) => /\.(xhtml|html|htm)$/i.test(e.entryName) && !e.entryName.includes('nav'))
          .map((e) => ({ fullPath: e.entryName }));

  htmlTargets.forEach((item, idx) => {
    const rawHtml = getEntryText(item.fullPath);
    if (!rawHtml) return;

    const $ = cheerio.load(rawHtml);
    $('script, style, link, meta, noscript').remove();

    // Extract heading if not in TOC
    let chTitle = tocTitleMap.get(item.fullPath) || '';
    if (!chTitle) {
      chTitle =
        $('h1, h2, h3, title')
          .first()
          .text()
          .replace(/\s+/g, ' ')
          .trim() || '';
    }

    // Rewrite image src to point to our on-demand asset endpoint
    $('img, image').each((_, imgEl) => {
      const srcAttr = $(imgEl).attr('src') || $(imgEl).attr('xlink:href') || '';
      if (srcAttr && !srcAttr.startsWith('data:') && !srcAttr.startsWith('http')) {
        const resolvedImg = resolveEpubPath(item.fullPath, srcAttr);
        if (bookId) {
          $(imgEl).attr('src', `/api/books/${encodeURIComponent(bookId)}/asset/${resolvedImg}`);
        }
      }
    });

    // Build clean paragraphs and HTML blocks
    const blocks = [];
    const bodyEl = $('body').length > 0 ? $('body') : $.root();

    // Extract structured paragraphs and images
    bodyEl.find('h1, h2, h3, h4, p, div, li, blockquote, img').each((_, el) => {
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'img') {
        const src = $(el).attr('src');
        if (src) {
          blocks.push({ type: 'image', src, alt: $(el).attr('alt') || '' });
        }
        return;
      }
      // Skip container divs that have nested block elements to avoid duplication
      if (tag === 'div' && $(el).find('p, div, h1, h2, h3, h4, blockquote').length > 0) {
        return;
      }
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text) {
        blocks.push({
          type: /^h[1-4]$/.test(tag) ? 'heading' : 'paragraph',
          text
        });
      }
    });

    // Fallback to plain body text if no standard block tags matched
    if (blocks.length === 0) {
      const plain = bodyEl.text().trim();
      if (plain) {
        plain.split(/\n+/).forEach((line) => {
          const t = line.trim();
          if (t) blocks.push({ type: 'paragraph', text: t });
        });
      }
    }

    const plainContent = blocks
      .filter((b) => b.text)
      .map((b) => b.text)
      .join('\n\n');

    const wordCount = plainContent.replace(/\s+/g, '').length;
    if (wordCount === 0 && blocks.length === 0) return;

    if (!chTitle) {
      chTitle = `第 ${chapters.length + 1} 節`;
    }

    chapters.push({
      index: chapters.length,
      title: chTitle,
      content: plainContent,
      blocks,
      wordCount
    });
  });

  const totalWords = chapters.reduce((acc, ch) => acc + ch.wordCount, 0);

  return {
    title,
    author,
    description: description || (chapters[0] ? chapters[0].content.slice(0, 180) : ''),
    encoding: 'UTF-8',
    format: 'epub',
    totalChapters: chapters.length,
    totalWords,
    chapters
  };
}

/**
 * Extract a binary asset from an EPUB buffer by its internal path
 */
function getEpubAsset(buffer, assetPath) {
  const zip = new AdmZip(buffer);
  const normalized = assetPath.replace(/^\/+/, '');
  const entry = zip.getEntry(normalized) || zip.getEntry(decodeURIComponent(normalized));
  if (!entry) return null;

  const ext = path.extname(normalized).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
  };

  return {
    data: entry.getData(),
    contentType: mimeMap[ext] || 'application/octet-stream'
  };
}

/**
 * Decompress a PalmDOC LZ77 compressed record buffer used by MOBI / AZW files
 */
function decompressPalmDocRecord(buf) {
  const out = [];
  let i = 0;
  const len = buf.length;

  while (i < len) {
    const c = buf[i++];
    if (c === 0x00) {
      out.push(0x00);
    } else if (c >= 0x01 && c <= 0x08) {
      for (let j = 0; j < c && i < len; j++) {
        out.push(buf[i++]);
      }
    } else if (c >= 0x09 && c <= 0x7f) {
      out.push(c);
    } else if (c >= 0x80 && c <= 0xbf) {
      if (i >= len) break;
      const next = buf[i++];
      const pair = (c << 8) | next;
      const distance = (pair >> 3) & 0x07ff;
      const length = (pair & 0x07) + 3;
      const startPos = out.length - distance;
      for (let j = 0; j < length; j++) {
        if (startPos + j >= 0 && startPos + j < out.length) {
          out.push(out[startPos + j]);
        } else {
          out.push(0x20);
        }
      }
    } else {
      // 0xC0 - 0xFF: space (0x20) followed by (c ^ 0x80)
      out.push(0x20, c ^ 0x80);
    }
  }
  return Buffer.from(out);
}

/**
 * Parse a .mobi or .azw3 buffer into metadata and chapters.
 * Supports PalmDOC uncompressed (1) and LZ77 compressed (2) records, UTF-8 / GB18030 / CP1252,
 * EXTH metadata records, and HTML / chapter splitting.
 */
function parseMobiBuffer(buffer, filename = '未命名小說.mobi') {
  const rawTitle = path.basename(filename, path.extname(filename));
  const ext = path.extname(filename).toLowerCase().replace('.', '') || 'mobi';

  if (!buffer || buffer.length < 78) {
    return {
      ...parseTxtBuffer(buffer || Buffer.alloc(0), filename),
      format: ext
    };
  }

  try {
    const numRecords = buffer.readUInt16BE(76);
    if (numRecords === 0 || 78 + numRecords * 8 > buffer.length) {
      return { ...parseTxtBuffer(buffer, filename), format: ext };
    }

    const recordOffsets = [];
    for (let i = 0; i < numRecords; i++) {
      const offset = buffer.readUInt32BE(78 + i * 8);
      recordOffsets.push(offset);
    }

    const getRecord = (idx) => {
      if (idx < 0 || idx >= numRecords) return Buffer.alloc(0);
      const start = recordOffsets[idx];
      const end = idx + 1 < numRecords ? recordOffsets[idx + 1] : buffer.length;
      if (start >= buffer.length || end <= start) return Buffer.alloc(0);
      return buffer.subarray(start, Math.min(end, buffer.length));
    };

    const rec0 = getRecord(0);
    if (rec0.length < 16) {
      return { ...parseTxtBuffer(buffer, filename), format: ext };
    }

    const compression = rec0.readUInt16BE(0); // 1 = none, 2 = PalmDOC LZ77, 17480 = HUFF/CDIC
    const textRecordCount = rec0.readUInt16BE(8);

    let textEncodingCode = 65001; // Default UTF-8
    let title = rawTitle;
    let author = '佚名';
    let extraDataFlags = 0;

    // Check MOBI header magic at offset 16
    if (rec0.length >= 132 && rec0.subarray(16, 20).toString('ascii') === 'MOBI') {
      const mobiHeaderLen = rec0.readUInt32BE(20);
      textEncodingCode = rec0.readUInt32BE(28);
      const fullNameOffset = rec0.readUInt32BE(84);
      const fullNameLen = rec0.readUInt32BE(88);

      if (rec0.length >= 244 && mobiHeaderLen >= 228) {
        extraDataFlags = rec0.readUInt16BE(242);
      }

      const encName = textEncodingCode === 65001 ? 'utf8' : 'gb18030';
      if (
        fullNameOffset > 0 &&
        fullNameLen > 0 &&
        fullNameOffset + fullNameLen <= rec0.length
      ) {
        const extractedTitle = iconv
          .decode(rec0.subarray(fullNameOffset, fullNameOffset + fullNameLen), encName)
          .replace(/\0/g, '')
          .trim();
        if (extractedTitle) title = extractedTitle;
      }

      // Check EXTH header for author (type 100) and updated title (type 503)
      const exthFlag = rec0.length >= 132 ? rec0.readUInt32BE(128) : 0;
      const exthOffset = 16 + mobiHeaderLen;
      if (
        (exthFlag & 0x40) !== 0 &&
        exthOffset + 12 <= rec0.length &&
        rec0.subarray(exthOffset, exthOffset + 4).toString('ascii') === 'EXTH'
      ) {
        const exthCount = rec0.readUInt32BE(exthOffset + 8);
        let pos = exthOffset + 12;
        for (let k = 0; k < exthCount && pos + 8 <= rec0.length; k++) {
          const recType = rec0.readUInt32BE(pos);
          const recLen = rec0.readUInt32BE(pos + 4);
          if (recLen < 8 || pos + recLen > rec0.length) break;
          const valBuf = rec0.subarray(pos + 8, pos + recLen);
          if (recType === 100) {
            const a = iconv.decode(valBuf, encName).replace(/\0/g, '').trim();
            if (a) author = a;
          } else if (recType === 503) {
            const t = iconv.decode(valBuf, encName).replace(/\0/g, '').trim();
            if (t) title = t;
          }
          pos += recLen;
        }
      }
    }

    // Strip trailing multibyte overlap / extra data entries from each text record
    const trimRecordTrailingEntries = (recBuf) => {
      if (!extraDataFlags || recBuf.length === 0) return recBuf;
      let end = recBuf.length;
      // Handle flags bit 1..15
      let flags = extraDataFlags >> 1;
      while (flags > 0 && end > 0) {
        if (flags & 1) {
          // Variable-length backward-encoded size at end of record
          let size = 0;
          let shift = 0;
          let pos = end - 1;
          while (pos >= 0 && shift < 28) {
            const b = recBuf[pos--];
            size |= (b & 0x7f) << shift;
            shift += 7;
            if ((b & 0x80) !== 0) break;
          }
          if (size > 0 && size <= end) {
            end -= size;
          }
        }
        flags >>= 1;
      }
      if ((extraDataFlags & 1) !== 0 && end > 0) {
        const overlap = (recBuf[end - 1] & 0x03) + 1;
        if (overlap <= end) end -= overlap;
      }
      return recBuf.subarray(0, end);
    };

    const maxRec = Math.min(numRecords - 1, textRecordCount || numRecords - 1);
    const decompressedChunks = [];

    for (let r = 1; r <= maxRec; r++) {
      let rawRec = getRecord(r);
      if (!rawRec || rawRec.length === 0) continue;
      rawRec = trimRecordTrailingEntries(rawRec);

      if (compression === 1) {
        decompressedChunks.push(rawRec);
      } else if (compression === 2) {
        decompressedChunks.push(decompressPalmDocRecord(rawRec));
      } else {
        // Fallback for unsupported HUFF/CDIC: push raw bytes
        decompressedChunks.push(rawRec);
      }
    }

    const fullTextBuffer = Buffer.concat(decompressedChunks);
    let htmlOrText = '';
    if (textEncodingCode === 65001) {
      htmlOrText = fullTextBuffer.toString('utf8');
    } else {
      htmlOrText = decodeBuffer(fullTextBuffer).text;
    }

    // Convert MOBI HTML markup (<mbp:pagebreak/>, <p>, <br>, <h1>..<h4>, <div>) into clean plain text with linebreaks
    let cleanText = htmlOrText
      .replace(/<mbp:pagebreak\s*\/?>/gi, '\n\n')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/\s*(p|div|h[1-6]|li|blockquote|tr)\s*>/gi, '\n')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '');

    // Decode common HTML entities
    const $entities = cheerio.load(`<div>${cleanText}</div>`);
    cleanText = $entities('div').text();

    const parsedTxt = parseTxtBuffer(Buffer.from(cleanText, 'utf8'), `${title}.txt`);
    return {
      ...parsedTxt,
      title,
      author: author !== '佚名' ? author : parsedTxt.author,
      format: ext,
      encoding: textEncodingCode === 65001 ? 'UTF-8' : 'GB18030'
    };
  } catch (err) {
    return {
      ...parseTxtBuffer(buffer, filename),
      format: ext
    };
  }
}

/**
 * Built-in zero-dependency PDF text & page count extractor fallback (using Node native zlib)
 * Used automatically if the NAS environment did not run `npm install pdf-parse`.
 */
function extractPdfBuiltin(buffer) {
  const rawLatin1 = buffer.toString('latin1');
  const pageMatches = rawLatin1.match(/\/Type\s*\/Page\b(?!s)/g);
  const numpages = pageMatches ? pageMatches.length : 1;

  const textChunks = [];
  const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
  let match;
  while ((match = streamRegex.exec(rawLatin1)) !== null) {
    const streamBody = Buffer.from(match[1], 'latin1');
    let contentStr = '';
    try {
      contentStr = zlib.inflateSync(streamBody).toString('latin1');
    } catch (_) {
      contentStr = match[1];
    }
    if (!contentStr.includes('BT') || !contentStr.includes('ET')) continue;

    // Extract UTF-16BE hex strings <FEFF...> or literal strings (...)
    const hexMatches = contentStr.match(/<([0-9A-Fa-f]{4,})>/g);
    if (hexMatches) {
      for (const h of hexMatches) {
        const hex = h.slice(1, -1);
        if (hex.toUpperCase().startsWith('FEFF')) {
          const buf = Buffer.from(hex.slice(4), 'hex');
          for (let i = 0; i + 1 < buf.length; i += 2) {
            const code = (buf[i] << 8) | buf[i + 1];
            if (code >= 0x20) textChunks.push(String.fromCharCode(code));
          }
        }
      }
    }
    const litMatches = contentStr.match(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*T[jJ]/g);
    if (litMatches) {
      for (const l of litMatches) {
        const inner = l.replace(/\)\s*T[jJ]$/, '').slice(1);
        textChunks.push(inner);
      }
    }
  }

  return {
    numpages,
    info: {},
    text: textChunks.join('\n')
  };
}

/**
 * Parse a .pdf buffer into metadata and chapters (with automatic Simplified/Traditional conversion support
 * and optional native PDF viewer stream URL).
 */
async function parsePdfBuffer(buffer, filename = '未命名文件.pdf', bookId = '') {
  const rawTitle = path.basename(filename, path.extname(filename));

  try {
    const pages = [];
    let data;
    if (typeof pdfParse === 'function') {
      const options = {
        pagerender: function (pageData) {
          return pageData.getTextContent().then(function (textContent) {
            let lastY = null;
            let pageText = '';
            for (const item of textContent.items) {
              if (lastY === item.transform[5] || lastY === null) {
                pageText += item.str;
              } else {
                pageText += '\n' + item.str;
              }
              lastY = item.transform[5];
            }
            pages.push(pageText.trim());
            return pageText;
          });
        }
      };
      data = await pdfParse(buffer, options);
    } else {
      data = extractPdfBuiltin(buffer);
    }
    const infoTitle =
      data.info && typeof data.info.Title === 'string' && data.info.Title.trim()
        ? data.info.Title.trim()
        : rawTitle;
    const infoAuthor =
      data.info && typeof data.info.Author === 'string' && data.info.Author.trim()
        ? data.info.Author.trim()
        : '佚名';

    const fullText = pages.length > 0 ? pages.join('\n\n') : (data.text || '').trim();
    const totalChars = fullText.replace(/\s+/g, '').length;

    // If PDF contains extractable text (> 50 chars), try splitting by chapters first, or group by 10 pages per chapter
    if (totalChars > 50) {
      const txtParsed = parseTxtBuffer(Buffer.from(fullText, 'utf8'), `${infoTitle}.txt`);

      // If standard chapter headings were detected (more than 1 chapter), use them directly!
      if (txtParsed.chapters.length > 1) {
        return {
          ...txtParsed,
          title: infoTitle,
          author: infoAuthor !== '佚名' ? infoAuthor : txtParsed.author,
          format: 'pdf',
          pdfPageCount: data.numpages || pages.length,
          rawPdfUrl: bookId ? `/api/books/${encodeURIComponent(bookId)}/raw` : null
        };
      }

      // Otherwise group every 10 PDF pages into a structured chapter for smooth reading
      if (pages.length > 1) {
        const PAGES_PER_CHAPTER = 10;
        const chapters = [];
        for (let i = 0; i < pages.length; i += PAGES_PER_CHAPTER) {
          const slice = pages.slice(i, i + PAGES_PER_CHAPTER);
          const startPage = i + 1;
          const endPage = Math.min(pages.length, i + PAGES_PER_CHAPTER);
          const joined = slice
            .map((pText, idx) => `【第 ${startPage + idx} 頁】\n${pText}`)
            .join('\n\n')
            .trim();
          if (!joined) continue;
          chapters.push({
            index: chapters.length,
            title:
              startPage === endPage
                ? `第 ${startPage} 頁`
                : `第 ${startPage} ~ ${endPage} 頁`,
            content: joined,
            wordCount: joined.replace(/\s+/g, '').length
          });
        }

        if (chapters.length > 0) {
          return {
            title: infoTitle,
            author: infoAuthor,
            description: chapters[0].content.slice(0, 180).replace(/\s+/g, ' '),
            encoding: 'PDF-UTF8',
            format: 'pdf',
            pdfPageCount: data.numpages || pages.length,
            rawPdfUrl: bookId ? `/api/books/${encodeURIComponent(bookId)}/raw` : null,
            totalChapters: chapters.length,
            totalWords: chapters.reduce((acc, c) => acc + c.wordCount, 0),
            chapters
          };
        }
      }

      return {
        ...txtParsed,
        title: infoTitle,
        author: infoAuthor,
        format: 'pdf',
        pdfPageCount: data.numpages || 1,
        rawPdfUrl: bookId ? `/api/books/${encodeURIComponent(bookId)}/raw` : null
      };
    }

    // Image/Scanned PDF with no text layer: provide embedded PDF viewer chapter
    return {
      title: infoTitle,
      author: infoAuthor,
      description: '掃描版或純圖片 PDF 書籍（支援原版 PDF 檢視模式）',
      encoding: 'PDF-IMAGE',
      format: 'pdf',
      pdfPageCount: data.numpages || 1,
      rawPdfUrl: bookId ? `/api/books/${encodeURIComponent(bookId)}/raw` : null,
      totalChapters: 1,
      totalWords: 0,
      chapters: [
        {
          index: 0,
          title: `原版 PDF 檢視（共 ${data.numpages || 1} 頁）`,
          content:
            '此 PDF 檔案為掃描圖片版或不含文字圖層，已為您載入下方原版 PDF 線上檢視器（亦可點擊上方「📄 原版 PDF 檢視」全幅閱讀）。',
          wordCount: 0
        }
      ]
    };
  } catch (err) {
    return {
      title: rawTitle,
      author: '佚名',
      description: 'PDF 書籍（原版檢視模式）',
      encoding: 'PDF',
      format: 'pdf',
      rawPdfUrl: bookId ? `/api/books/${encodeURIComponent(bookId)}/raw` : null,
      totalChapters: 1,
      totalWords: 0,
      chapters: [
        {
          index: 0,
          title: '原版 PDF 閱讀器',
          content: '請使用下方原版 PDF 檢視器進行閱讀。',
          wordCount: 0
        }
      ]
    };
  }
}

module.exports = {
  convertText,
  compileBooleanQuery,
  decodeBuffer,
  parseTxtBuffer,
  parseEpubBuffer,
  parseMobiBuffer,
  parsePdfBuffer,
  getEpubAsset
};
