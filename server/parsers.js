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
 * Extract a binary asset from an EPUB or CBZ ZIP buffer by its internal path
 */
function getEpubAsset(buffer, assetPath) {
  const zip = new AdmZip(buffer);
  const cleanNormalized = String(assetPath || '')
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
  let decodedPath = cleanNormalized;
  try {
    decodedPath = decodeURIComponent(cleanNormalized)
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '');
  } catch (_) {}

  let entry = zip.getEntry(cleanNormalized) || zip.getEntry(decodedPath);
  if (!entry) {
    entry = zip.getEntries().find((e) => {
      if (e.isDirectory) return false;
      const eNorm = e.entryName
        .replace(/\\/g, '/')
        .replace(/^(\.\/)+/, '')
        .replace(/^\/+/, '');
      return eNorm === cleanNormalized || eNorm === decodedPath;
    });
  }
  if (!entry) return null;

  const ext = path.extname(decodedPath || cleanNormalized).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
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

const PDF_CHAPTER_HEADING_REGEX =
  /^(?:第\s*[零一二三四五六七八九十百千万萬千0-9]+\s*[章節节回卷部篇集話话]|(?:Chapter|CHAPTER|Part|PART|Section|Book)\s+[0-9IVXLCDM]+|(?:序章|楔子|引子|プロローグ|前言|自序|導讀|导读|後記|后记|尾聲|尾声|番外|附錄|附录)(?:\s|$|[：:—\-])|[一二三四五六七八九十]+[、.．]\s*\S+)/;

const PAGE_NUMBER_LINE_REGEX =
  /^(?:[-—–~～·•\s]*\d{1,5}[-—–~～·•\s]*|第\s*\d{1,5}\s*[頁页](?:\s*[\/／]\s*共?\s*\d{1,5}\s*[頁页])?|【\s*第\s*\d{1,5}\s*[頁页]\s*】|Page\s+\d{1,5}(?:\s+of\s+\d{1,5})?)$/i;

const TERMINAL_PUNCT_REGEX = /[。！？!?…⋯」』”"》）)\.!;:]$/;
const LIST_OR_DIALOGUE_START_REGEX =
  /^(?:[「『“"（(【《]|[-•·*]\s+|\d{1,3}[.、)）]\s*|[①②③④⑤⑥⑦⑧⑨⑩])/;

/**
 * Compute visual width of a string (CJK = 2, ASCII = 1)
 */
function getVisualWidth(str) {
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    w += str.charCodeAt(i) > 0xff ? 2 : 1;
  }
  return w;
}

/**
 * Join two lines that were split by PDF fixed-width layout
 */
function joinReflowedLines(prev, next) {
  // Handle English word hyphenation across lines: "inter-" + "national" -> "international"
  if (/[a-zA-Z]-$/.test(prev) && /^[a-z]/.test(next)) {
    return prev.slice(0, -1) + next;
  }
  // If both boundary characters are ASCII letters/numbers/punctuation, insert a space
  const lastChar = prev.charAt(prev.length - 1);
  const firstChar = next.charAt(0);
  if (/[a-zA-Z0-9,.;:?!)]/.test(lastChar) && /[a-zA-Z0-9(]/.test(firstChar)) {
    return `${prev} ${next}`;
  }
  // For CJK text, join directly without space
  return prev + next;
}

/**
 * Remove artificial single-space gaps between individual CJK characters caused by PDF TJ positioning
 * (e.g. "他 走 進 了 房 間" -> "他走進了房間"), while preserving normal spaces in titles like "第一章 初入江湖".
 */
function normalizePdfLineSpacing(line) {
  const cjkChar = '[\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF]';
  const spacedSingleCjkRegex = new RegExp(`(?:^|\\s)${cjkChar}\\s+${cjkChar}\\s+${cjkChar}`, '');
  if (!spacedSingleCjkRegex.test(line)) {
    return line;
  }
  const cjkClass =
    '[\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF「」『』《》〈〉【】〔〕（）—…]';
  const re = new RegExp(`(${cjkClass})[ \\t]+(?=${cjkClass})`, 'g');
  return line.replace(re, '$1');
}

/**
 * Smart PDF Reflow Engine:
 * Reflows an array of per-page PDF strings or a single PDF text block into clean, natural paragraphs:
 * 1. Detects and strips repeated running page headers/footers across pages.
 * 2. Strips standalone page number markers (- 12 -, 第 12 頁, 【第 12 頁】, Page 12).
 * 3. Merges mid-sentence hard line breaks caused by fixed-width PDF columns while preserving
 *    true paragraph breaks, chapter headings, dialogue lines, and indented paragraphs.
 */
function reflowPdfText(pagesOrText, options = {}) {
  const { stripHeadersFooters = true, mergeBrokenLines = true } = options;

  const rawPages = Array.isArray(pagesOrText)
    ? pagesOrText.map((p) => String(p || ''))
    : String(pagesOrText || '').split(/\f|\n(?=【第\s*\d+\s*[頁页]】)/);

  let removedArtifacts = 0;

  const pageLinesList = rawPages.map((pageStr) =>
    pageStr
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
  );

  // Detect repeated running headers/footers across 3+ pages
  const repeatedHeaderFooterSet = new Set();
  if (stripHeadersFooters && pageLinesList.length >= 3) {
    const edgeCounts = new Map();
    for (const lines of pageLinesList) {
      const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
      if (nonEmpty.length === 0) continue;
      const first = nonEmpty[0];
      const last = nonEmpty[nonEmpty.length - 1];
      const candidates = new Set([first, last]);
      for (const c of candidates) {
        if (c.length <= 45 && !PDF_CHAPTER_HEADING_REGEX.test(c)) {
          edgeCounts.set(c, (edgeCounts.get(c) || 0) + 1);
        }
      }
    }
    const threshold = Math.max(2, Math.ceil(pageLinesList.length * 0.4));
    for (const [lineText, count] of edgeCounts.entries()) {
      if (count >= threshold) {
        repeatedHeaderFooterSet.add(lineText);
      }
    }
  }

  const cleanedLines = [];
  let rawLineCount = 0;

  for (const lines of pageLinesList) {
    let firstIdx = -1;
    let lastIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) {
        if (firstIdx === -1) firstIdx = i;
        lastIdx = i;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      rawLineCount++;
      const rawLine = lines[i];
      const trimmed = rawLine.trim();

      if (!trimmed) {
        cleanedLines.push({ raw: '', trimmed: '', isBlank: true, isIndented: false });
        continue;
      }

      if (stripHeadersFooters) {
        if (PAGE_NUMBER_LINE_REGEX.test(trimmed)) {
          removedArtifacts++;
          continue;
        }
        if ((i === firstIdx || i === lastIdx) && repeatedHeaderFooterSet.has(trimmed)) {
          removedArtifacts++;
          continue;
        }
      }

      const normalizedTrimmed = normalizePdfLineSpacing(trimmed);
      const isIndented = /^(?:　+|\s{2,}|\t+)/.test(rawLine);

      cleanedLines.push({
        raw: rawLine,
        trimmed: normalizedTrimmed,
        isBlank: false,
        isIndented
      });
    }
  }

  if (!mergeBrokenLines) {
    const paragraphs = cleanedLines.filter((l) => !l.isBlank).map((l) => l.trimmed);
    return {
      paragraphs,
      text: paragraphs.join('\n\n'),
      stats: {
        rawLines: rawLineCount,
        reflowedParagraphs: paragraphs.length,
        removedArtifacts
      }
    };
  }

  // Compute typical full-line visual width (75th percentile)
  const lengths = cleanedLines
    .filter((l) => !l.isBlank && l.trimmed.length > 5)
    .map((l) => getVisualWidth(l.trimmed))
    .sort((a, b) => a - b);

  const typicalFullWidth =
    lengths.length > 0
      ? lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * 0.75))]
      : 60;

  const paragraphs = [];
  let currentPara = '';
  let prevLineWidth = 0;

  for (let i = 0; i < cleanedLines.length; i++) {
    const item = cleanedLines[i];

    if (item.isBlank) {
      if (currentPara) {
        paragraphs.push(currentPara);
        currentPara = '';
        prevLineWidth = 0;
      }
      continue;
    }

    const line = item.trimmed;
    const lineWidth = getVisualWidth(line);
    const isHeading = PDF_CHAPTER_HEADING_REGEX.test(line) && line.length <= 50;

    if (!currentPara) {
      currentPara = line;
      prevLineWidth = lineWidth;
      if (isHeading) {
        paragraphs.push(currentPara);
        currentPara = '';
        prevLineWidth = 0;
      }
      continue;
    }

    const prevEndsWithTerminal = TERMINAL_PUNCT_REGEX.test(currentPara);
    const prevWasShortLine = prevLineWidth < typicalFullWidth * 0.78;
    const nextStartsNewBlock =
      isHeading || item.isIndented || LIST_OR_DIALOGUE_START_REGEX.test(line);

    const shouldStartNewParagraph =
      isHeading ||
      item.isIndented ||
      (prevEndsWithTerminal && (prevWasShortLine || nextStartsNewBlock));

    if (shouldStartNewParagraph) {
      paragraphs.push(currentPara);
      currentPara = line;
      prevLineWidth = lineWidth;
      if (isHeading) {
        paragraphs.push(currentPara);
        currentPara = '';
        prevLineWidth = 0;
      }
    } else {
      currentPara = joinReflowedLines(currentPara, line);
      prevLineWidth = lineWidth;
    }
  }

  if (currentPara) {
    paragraphs.push(currentPara);
  }

  return {
    paragraphs,
    text: paragraphs.join('\n\n'),
    stats: {
      rawLines: rawLineCount,
      reflowedParagraphs: paragraphs.length,
      removedArtifacts
    }
  };
}

function normalizePdfUnicodeText(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/[\u2E80-\u2FDF\uF900-\uFAFF]/g, (ch) => ch.normalize('NFKC'));
}

function isGarbledPdfText(text) {
  if (!text || typeof text !== 'string') return true;
  const nonWs = text.replace(/\s+/g, '');
  if (nonWs.length === 0) return true;

  let controlOrPua = 0;
  let weirdOrExotic = 0;
  let readable = 0;
  let cjkCount = 0;
  let kanaCount = 0;
  let commonCjkCount = 0;

  const commonCjkSet = new Set(
    '的一是不了人在有我他這中大來上國個到說們為子和你地出道也時年得就那要下以生會自著去之過家學對可她裡后小心嗎啊呢吧，。、：；「」『』！？（）'
  );

  for (let i = 0; i < nonWs.length; i++) {
    const code = nonWs.charCodeAt(i);
    const ch = nonWs[i];

    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0xfffd ||
      (code >= 0xe000 && code <= 0xf8ff) ||
      code >= 0xfff0
    ) {
      controlOrPua++;
      continue;
    }

    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
      cjkCount++;
      readable++;
      if (commonCjkSet.has(ch)) commonCjkCount++;
      continue;
    }

    if (code >= 0x3040 && code <= 0x30ff) {
      kanaCount++;
      readable++;
      continue;
    }

    if (
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xff01 && code <= 0xff5e) ||
      (code >= 0x20 && code <= 0x7e) ||
      '—–…·•「」『』《》〈〉【】〔〕、。，．！？：；（）°±×÷©®§€£¥'.includes(ch)
    ) {
      readable++;
      if (commonCjkSet.has(ch)) commonCjkCount++;
      continue;
    }

    weirdOrExotic++;
  }

  const total = nonWs.length;
  if (controlOrPua / total > 0.05) return true;
  if (weirdOrExotic / total > 0.16) return true;
  if (readable / total < 0.58) return true;
  if (cjkCount >= 80 && kanaCount < 10 && commonCjkCount / cjkCount < 0.025) {
    return true;
  }
  return false;
}

/**
 * Parse a ToUnicode CMap stream (codespacerange / beginbfchar / beginbfrange) into a Map<code, unicodeStr>
 */
function parseToUnicodeCMap(cmapStr) {
  const map = new Map();
  const codespaces = [];
  let keyByteLen = 2;
  let saw1Byte = false;
  let saw2Byte = false;

  const csRegex = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  let match;
  while ((match = csRegex.exec(cmapStr)) !== null) {
    const pairRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let pair;
    while ((pair = pairRegex.exec(match[1])) !== null) {
      const lenBytes = Math.max(1, Math.ceil(pair[1].length / 2));
      const start = parseInt(pair[1], 16);
      const end = parseInt(pair[2], 16);
      if (!Number.isNaN(start) && !Number.isNaN(end)) {
        codespaces.push({ lenBytes, start, end });
        if (lenBytes === 1) saw1Byte = true;
        else if (lenBytes === 2) saw2Byte = true;
      }
    }
  }

  const bfcharRegex = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((match = bfcharRegex.exec(cmapStr)) !== null) {
    const body = match[1];
    const pairRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let pair;
    while ((pair = pairRegex.exec(body)) !== null) {
      const srcHex = pair[1];
      const dstHex = pair[2];
      if (srcHex.length <= 2) saw1Byte = true;
      else saw2Byte = true;
      const code = parseInt(srcHex, 16);
      const unicodeStr = decodeHexUtf16Be(dstHex);
      if (!Number.isNaN(code) && unicodeStr) {
        map.set(code, unicodeStr);
      }
    }
  }

  const bfrangeRegex = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((match = bfrangeRegex.exec(cmapStr)) !== null) {
    const body = match[1];
    const rangeDirectRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let r;
    while ((r = rangeDirectRegex.exec(body)) !== null) {
      const startCode = parseInt(r[1], 16);
      const endCode = parseInt(r[2], 16);
      const dstHex = r[3].replace(/\s+/g, '');
      if (r[1].length <= 2) saw1Byte = true;
      else saw2Byte = true;
      if (!Number.isNaN(startCode) && !Number.isNaN(endCode) && dstHex) {
        const limit = Math.min(endCode, startCode + 4096);
        if (dstHex.length <= 4) {
          const baseCodePoint = parseInt(dstHex, 16);
          if (!Number.isNaN(baseCodePoint)) {
            for (let c = startCode; c <= limit; c++) {
              const cp = baseCodePoint + (c - startCode);
              if (cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
                map.set(c, String.fromCodePoint(cp));
              }
            }
          }
        } else {
          const prefixHex = dstHex.slice(0, dstHex.length - 4);
          const tailVal = parseInt(dstHex.slice(-4), 16);
          if (!Number.isNaN(tailVal)) {
            for (let c = startCode; c <= limit; c++) {
              const tailHex = ((tailVal + (c - startCode)) & 0xffff)
                .toString(16)
                .padStart(4, '0');
              const decoded = decodeHexUtf16Be(prefixHex + tailHex);
              if (decoded) map.set(c, decoded);
            }
          }
        }
      }
    }
    const rangeArrayRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
    while ((r = rangeArrayRegex.exec(body)) !== null) {
      const startCode = parseInt(r[1], 16);
      const endCode = parseInt(r[2], 16);
      if (r[1].length <= 2) saw1Byte = true;
      else saw2Byte = true;
      const arrBody = r[3];
      const items = arrBody.match(/<([0-9A-Fa-f]+)>/g) || [];
      for (let i = 0; i < items.length && startCode + i <= endCode; i++) {
        const hex = items[i].slice(1, -1);
        const decoded = decodeHexUtf16Be(hex);
        if (decoded) map.set(startCode + i, decoded);
      }
    }
  }

  if (saw2Byte) keyByteLen = 2;
  else if (saw1Byte) keyByteLen = 1;

  return { map, keyByteLen, codespaces };
}

function decodeHexUtf16Be(hex) {
  if (!hex) return '';
  const clean = hex.replace(/\s+/g, '');
  if (!clean) return '';
  if (clean.length === 2) {
    return String.fromCharCode(parseInt(clean, 16));
  }
  const buf = Buffer.from(clean.length % 2 === 0 ? clean : '0' + clean, 'hex');
  let out = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const code = (buf[i] << 8) | buf[i + 1];
    if (code === 0xfeff) continue;
    out += String.fromCharCode(code);
  }
  return out;
}

function decodeBufferWithPdfEncoding(buf, encodingName) {
  if (!buf || buf.length === 0) return '';
  const enc = (encodingName || '').toLowerCase();
  try {
    if (enc.includes('gbk') || enc.includes('gb2312') || enc.includes('gb18030') || enc.includes('euc-h')) {
      return iconv.decode(buf, 'gb18030');
    }
    if (enc.includes('b5') || enc.includes('big5') || enc.includes('cns-')) {
      if (enc.includes('utf16') || enc.includes('ucs2')) {
        return decodeHexUtf16Be(buf.toString('hex'));
      }
      return iconv.decode(buf, 'big5');
    }
    if (enc.includes('utf16') || enc.includes('ucs2')) {
      return decodeHexUtf16Be(buf.toString('hex'));
    }
    if (enc.includes('winansi')) {
      return iconv.decode(buf, 'win1252');
    }
    if (enc.includes('macroman')) {
      return iconv.decode(buf, 'macintosh');
    }
  } catch (_) {}
  return '';
}

function isLikelyAsciiHex(cleanHex) {
  if (!cleanHex || cleanHex.length < 4 || cleanHex.length % 2 !== 0) return false;
  for (let i = 0; i < cleanHex.length; i += 2) {
    const b = parseInt(cleanHex.slice(i, i + 2), 16);
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b > 0x7e) return false;
  }
  return true;
}

function decodeHexWithCMap(hexStr, cmapObj, encodingName = '') {
  const clean = hexStr.replace(/\s+/g, '');
  if (!clean) return '';
  if (clean.toUpperCase().startsWith('FEFF') && clean.length >= 8) {
    return decodeHexUtf16Be(clean.slice(4));
  }
  if (cmapObj && cmapObj.map && cmapObj.map.size > 0) {
    if (Array.isArray(cmapObj.codespaces) && cmapObj.codespaces.length > 0) {
      let out = '';
      let i = 0;
      while (i < clean.length) {
        let matched = false;
        for (const cs of cmapObj.codespaces) {
          const hexLen = cs.lenBytes * 2;
          if (i + hexLen <= clean.length) {
            const slice = clean.slice(i, i + hexLen);
            const code = parseInt(slice, 16);
            if (code >= cs.start && code <= cs.end && cmapObj.map.has(code)) {
              out += cmapObj.map.get(code);
              i += hexLen;
              matched = true;
              break;
            }
          }
        }
        if (!matched) {
          const step = cmapObj.keyByteLen === 1 ? 2 : 4;
          const slice = clean.slice(i, i + step);
          const code = parseInt(slice, 16);
          if (cmapObj.map.has(code)) {
            out += cmapObj.map.get(code);
          } else if (step === 2 && code >= 0x20 && code <= 0x7e) {
            out += String.fromCharCode(code);
          }
          i += step;
        }
      }
      return out;
    }

    const step = cmapObj.keyByteLen === 1 ? 2 : 4;
    let out = '';
    for (let i = 0; i < clean.length; i += step) {
      const slice = clean.slice(i, i + step);
      const code = parseInt(slice, 16);
      if (cmapObj.map.has(code)) {
        out += cmapObj.map.get(code);
      } else if (step === 4 && slice.length === 4) {
        const hi = parseInt(slice.slice(0, 2), 16);
        const lo = parseInt(slice.slice(2, 4), 16);
        if (cmapObj.map.has(hi) && cmapObj.map.has(lo)) {
          out += cmapObj.map.get(hi) + cmapObj.map.get(lo);
        } else if (hi === 0x00 && lo >= 0x20 && lo <= 0x7e) {
          out += String.fromCharCode(lo);
        }
      } else if (step === 2 && code >= 0x20 && code <= 0x7e) {
        out += String.fromCharCode(code);
      }
    }
    return out;
  }

  if (encodingName) {
    const encDecoded = decodeBufferWithPdfEncoding(
      Buffer.from(clean.length % 2 === 0 ? clean : '0' + clean, 'hex'),
      encodingName
    );
    if (encDecoded) return encDecoded;
  }

  if (isLikelyAsciiHex(clean)) {
    return Buffer.from(clean, 'hex').toString('ascii');
  }
  if (clean.length % 4 === 0) {
    return decodeHexUtf16Be(clean);
  }
  return Buffer.from(clean.length % 2 === 0 ? clean : '0' + clean, 'hex').toString('utf8');
}

function unescapePdfLiteral(str, cmapObj, encodingName = '') {
  const raw = str
    .replace(/\\\r?\n/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));

  if (raw.length >= 2 && raw.charCodeAt(0) === 0xfe && raw.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < raw.length; i += 2) {
      out += String.fromCharCode((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1));
    }
    return out;
  }

  if (cmapObj && cmapObj.map && cmapObj.map.size > 0) {
    if (cmapObj.keyByteLen === 2 && raw.length >= 2 && raw.length % 2 === 0) {
      let mapped = '';
      let hits = 0;
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const code = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1);
        if (cmapObj.map.has(code)) {
          mapped += cmapObj.map.get(code);
          hits++;
        } else if (raw.charCodeAt(i) === 0 && raw.charCodeAt(i + 1) >= 0x20 && raw.charCodeAt(i + 1) <= 0x7e) {
          mapped += raw[i + 1];
        }
      }
      if (hits > 0 || mapped.length > 0) return mapped;
    } else if (cmapObj.keyByteLen === 1) {
      let mapped = '';
      for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        if (cmapObj.map.has(code)) {
          mapped += cmapObj.map.get(code);
        } else if (code >= 0x20 && code <= 0x7e) {
          mapped += raw[i];
        }
      }
      return mapped;
    }
  }

  if (encodingName) {
    const encDecoded = decodeBufferWithPdfEncoding(Buffer.from(raw, 'latin1'), encodingName);
    if (encDecoded) return encDecoded;
  }

  return raw;
}

function unfilterPngPredictor(buf, columns, colors = 1, bpc = 8) {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.max(1, Math.ceil((columns * colors * bpc) / 8));
  const stride = rowLen + 1;
  if (columns <= 0 || buf.length < stride) return buf;

  const rowCount = Math.floor(buf.length / stride);
  const out = Buffer.alloc(rowCount * rowLen);

  for (let r = 0; r < rowCount; r++) {
    const srcOff = r * stride;
    const dstOff = r * rowLen;
    const filterType = buf[srcOff];

    for (let c = 0; c < rowLen; c++) {
      const x = buf[srcOff + 1 + c];
      const a = c >= bpp ? out[dstOff + c - bpp] : 0;
      const b = r > 0 ? out[(r - 1) * rowLen + c] : 0;
      const d = r > 0 && c >= bpp ? out[(r - 1) * rowLen + c - bpp] : 0;

      let val = x;
      if (filterType === 1) val = (x + a) & 0xff;
      else if (filterType === 2) val = (x + b) & 0xff;
      else if (filterType === 3) val = (x + ((a + b) >> 1)) & 0xff;
      else if (filterType === 4) {
        const p = a + b - d;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - d);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : d;
        val = (x + pr) & 0xff;
      }
      out[dstOff + c] = val;
    }
  }
  return out;
}

function inflatePdfStream(rawStreamLatin1, dictStr = '') {
  const buf = Buffer.from(rawStreamLatin1, 'latin1');
  let outBuf = buf;

  if (!dictStr || /\/FlateDecode\b/i.test(dictStr) || !/\/Filter\b/i.test(dictStr)) {
    try {
      outBuf = zlib.inflateSync(buf);
    } catch (_) {
      try {
        outBuf = zlib.inflateRawSync(buf.subarray(2));
      } catch (_2) {
        try {
          outBuf = zlib.inflateRawSync(buf);
        } catch (_3) {
          outBuf = buf;
        }
      }
    }
  }

  if (dictStr) {
    const predMatch = dictStr.match(/\/Predictor\s+(\d+)/);
    const predictor = predMatch ? parseInt(predMatch[1], 10) : 1;
    if (predictor >= 10 && outBuf !== buf) {
      const colsMatch = dictStr.match(/\/Columns\s+(\d+)/);
      const colorsMatch = dictStr.match(/\/Colors\s+(\d+)/);
      const bpcMatch = dictStr.match(/\/BitsPerComponent\s+(\d+)/);
      const columns = colsMatch ? parseInt(colsMatch[1], 10) : 1;
      const colors = colorsMatch ? parseInt(colorsMatch[1], 10) : 1;
      const bpc = bpcMatch ? parseInt(bpcMatch[1], 10) : 8;
      outBuf = unfilterPngPredictor(outBuf, columns, colors, bpc);
    }
  }

  return outBuf.toString('latin1');
}

/**
 * Built-in zero-dependency PDF text, CMap, /ObjStm & page layout extractor (using Node native zlib)
 * Supports PDF 1.5+ ObjStm, PNG predictors, per-page Resources, ToUnicode CMaps (codespace/bfchar/bfrange),
 * 1-byte and 2-byte literal strings, Encoding fallbacks, Tm/Td/TD/T* positioning, and TJ/Tj text arrays.
 */
function extractPdfBuiltin(buffer) {
  const rawLatin1 = buffer.toString('latin1');
  const pageMatches = rawLatin1.match(/\/Type\s*\/Page\b(?!s)/g);
  const numpages = pageMatches ? pageMatches.length : 1;

  const objectsById = new Map();
  const cmapsByObjId = new Map();
  const fontObjToCmapObj = new Map();
  const fontObjToDescendant = new Map();
  const fontObjToEncoding = new Map();
  const resourceNameToFontObj = new Map();
  const globalCMap1Map = new Map();
  const globalCMap2Map = new Map();

  const registerFontAndResourceDict = (dictStr, objId = null) => {
    if (!dictStr) return;
    if (objId !== null) {
      const toUniMatch = dictStr.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
      if (toUniMatch) {
        fontObjToCmapObj.set(objId, parseInt(toUniMatch[1], 10));
      }
      const descMatch = dictStr.match(/\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/);
      if (descMatch) {
        fontObjToDescendant.set(objId, parseInt(descMatch[1], 10));
      }
      const encMatch = dictStr.match(/\/Encoding\s*\/([A-Za-z0-9_.+-]+)/);
      if (encMatch) {
        fontObjToEncoding.set(objId, encMatch[1]);
      }
    }
    const fontDictRegex = /\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+\d+\s+R/g;
    let fdMatch;
    while ((fdMatch = fontDictRegex.exec(dictStr)) !== null) {
      const key = fdMatch[1];
      if (
        ![
          'Type',
          'Parent',
          'Resources',
          'Contents',
          'MediaBox',
          'CropBox',
          'ToUnicode',
          'FontDescriptor',
          'FontFile',
          'FontFile2',
          'FontFile3',
          'BaseFont',
          'Encoding',
          'DescendantFonts',
          'Kids',
          'Pages',
          'Outlines',
          'StructTreeRoot',
          'Metadata',
          'ExtGState',
          'ColorSpace',
          'Pattern',
          'Shading'
        ].includes(key)
      ) {
        resourceNameToFontObj.set(key, parseInt(fdMatch[2], 10));
      }
    }
  };

  // Pass 1: Index all top-level PDF objects and unpack /ObjStm streams
  const objRegex = /(\d+)\s+\d+\s+obj\b([\s\S]*?)endobj/g;
  let objMatch;
  while ((objMatch = objRegex.exec(rawLatin1)) !== null) {
    const objId = parseInt(objMatch[1], 10);
    const objBody = objMatch[2];
    const streamMatch = objBody.match(/^([\s\S]*?)stream(?:\r\n|\n)([\s\S]*?)endstream/);

    if (streamMatch) {
      const dictPart = streamMatch[1];
      const decompressed = inflatePdfStream(streamMatch[2], dictPart);
      objectsById.set(objId, { dict: dictPart, stream: decompressed });
      registerFontAndResourceDict(dictPart, objId);

      if (/\/Type\s*\/ObjStm\b/.test(dictPart)) {
        const firstMatch = dictPart.match(/\/First\s+(\d+)/);
        const firstOffset = firstMatch ? parseInt(firstMatch[1], 10) : 0;
        if (firstOffset > 0 && firstOffset < decompressed.length) {
          const headerStr = decompressed.slice(0, firstOffset).trim();
          const bodyStr = decompressed.slice(firstOffset);
          const nums = headerStr
            .split(/\s+/)
            .map((n) => parseInt(n, 10))
            .filter((n) => !Number.isNaN(n));
          const entries = [];
          for (let i = 0; i + 1 < nums.length; i += 2) {
            entries.push({ innerId: nums[i], offset: nums[i + 1] });
          }
          entries.sort((a, b) => a.offset - b.offset);
          for (let i = 0; i < entries.length; i++) {
            const start = entries[i].offset;
            const end = i + 1 < entries.length ? entries[i + 1].offset : bodyStr.length;
            const innerBody = bodyStr.slice(start, end);
            objectsById.set(entries[i].innerId, { dict: innerBody, stream: null });
            registerFontAndResourceDict(innerBody, entries[i].innerId);
          }
        }
      } else if (decompressed.includes('beginbfchar') || decompressed.includes('beginbfrange')) {
        const parsedCmap = parseToUnicodeCMap(decompressed);
        cmapsByObjId.set(objId, parsedCmap);
        const targetGlobal = parsedCmap.keyByteLen === 1 ? globalCMap1Map : globalCMap2Map;
        for (const [k, v] of parsedCmap.map.entries()) {
          if (!targetGlobal.has(k)) targetGlobal.set(k, v);
        }
      }
    } else {
      objectsById.set(objId, { dict: objBody, stream: null });
      registerFontAndResourceDict(objBody, objId);
    }
  }

  for (const [fontId, descId] of fontObjToDescendant.entries()) {
    if (!fontObjToCmapObj.has(fontId) && fontObjToCmapObj.has(descId)) {
      fontObjToCmapObj.set(fontId, fontObjToCmapObj.get(descId));
    }
    if (!fontObjToEncoding.has(fontId) && fontObjToEncoding.has(descId)) {
      fontObjToEncoding.set(fontId, fontObjToEncoding.get(descId));
    }
  }

  const globalCmap2Obj = { map: globalCMap2Map, keyByteLen: 2, codespaces: [] };
  const globalCmap1Obj = { map: globalCMap1Map, keyByteLen: 1, codespaces: [] };

  const extractFontMapFromDict = (dictStr, visited = new Set()) => {
    const fontMap = new Map();
    if (!dictStr) return fontMap;

    const inlineFontBlock = dictStr.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (inlineFontBlock) {
      const refRe = /\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+\d+\s+R/g;
      let m;
      while ((m = refRe.exec(inlineFontBlock[1])) !== null) {
        fontMap.set(m[1], parseInt(m[2], 10));
      }
    }
    const fontRef = dictStr.match(/\/Font\s+(\d+)\s+\d+\s+R/);
    if (fontRef) {
      const fObjId = parseInt(fontRef[1], 10);
      if (!visited.has(fObjId) && objectsById.has(fObjId)) {
        visited.add(fObjId);
        const fDict = objectsById.get(fObjId).dict;
        const refRe = /\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+\d+\s+R/g;
        let m;
        while ((m = refRe.exec(fDict)) !== null) {
          fontMap.set(m[1], parseInt(m[2], 10));
        }
      }
    }
    const resRef = dictStr.match(/\/Resources\s+(\d+)\s+\d+\s+R/);
    if (resRef) {
      const rObjId = parseInt(resRef[1], 10);
      if (!visited.has(rObjId) && objectsById.has(rObjId)) {
        visited.add(rObjId);
        const subMap = extractFontMapFromDict(objectsById.get(rObjId).dict, visited);
        for (const [k, v] of subMap.entries()) {
          if (!fontMap.has(k)) fontMap.set(k, v);
        }
      }
    }
    const parentRef = dictStr.match(/\/Parent\s+(\d+)\s+\d+\s+R/);
    if (parentRef) {
      const pObjId = parseInt(parentRef[1], 10);
      if (!visited.has(pObjId) && objectsById.has(pObjId)) {
        visited.add(pObjId);
        const parentMap = extractFontMapFromDict(objectsById.get(pObjId).dict, visited);
        for (const [k, v] of parentMap.entries()) {
          if (!fontMap.has(k)) fontMap.set(k, v);
        }
      }
    }
    return fontMap;
  };

  // Pass 2: Resolve per-page /Contents streams paired with exact page /Font maps
  const pageJobs = [];
  const consumedStreamIds = new Set();

  for (const [, obj] of objectsById.entries()) {
    if (!/\/Type\s*\/Page\b(?!s)/.test(obj.dict)) continue;

    const pageFontMap = extractFontMapFromDict(obj.dict);
    const contentIds = [];
    const arrMatch = obj.dict.match(/\/Contents\s*\[([\s\S]*?)\]/);
    if (arrMatch) {
      const rRe = /(\d+)\s+\d+\s+R/g;
      let rm;
      while ((rm = rRe.exec(arrMatch[1])) !== null) {
        contentIds.push(parseInt(rm[1], 10));
      }
    } else {
      const singleMatch = obj.dict.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
      if (singleMatch) {
        contentIds.push(parseInt(singleMatch[1], 10));
      }
    }

    const streams = [];
    for (const cid of contentIds) {
      consumedStreamIds.add(cid);
      const cObj = objectsById.get(cid);
      if (
        cObj &&
        cObj.stream &&
        (cObj.stream.includes('BT') || cObj.stream.includes('Tj') || cObj.stream.includes('TJ'))
      ) {
        streams.push(cObj.stream);
      }
    }
    if (streams.length > 0) {
      pageJobs.push({ contentStr: streams.join('\n'), fontMap: pageFontMap });
    }
  }

  if (pageJobs.length === 0) {
    for (const [id, obj] of objectsById.entries()) {
      if (consumedStreamIds.has(id)) continue;
      if (obj.stream && obj.stream.includes('BT') && obj.stream.includes('ET')) {
        pageJobs.push({ contentStr: obj.stream, fontMap: resourceNameToFontObj });
      }
    }
  }

  if (pageJobs.length === 0) {
    const streamRegex = /stream(?:\r\n|\n)([\s\S]*?)endstream/g;
    let match;
    while ((match = streamRegex.exec(rawLatin1)) !== null) {
      const contentStr = inflatePdfStream(match[1]);
      if (contentStr.includes('beginbfchar') || contentStr.includes('beginbfrange')) {
        const parsedCmap = parseToUnicodeCMap(contentStr);
        const targetGlobal = parsedCmap.keyByteLen === 1 ? globalCMap1Map : globalCMap2Map;
        for (const [k, v] of parsedCmap.map.entries()) {
          if (!targetGlobal.has(k)) targetGlobal.set(k, v);
        }
      } else if (contentStr.includes('BT') && contentStr.includes('ET')) {
        pageJobs.push({ contentStr, fontMap: resourceNameToFontObj });
      }
    }
  }

  const resolveActiveFont = (fontName, pageFontMap) => {
    const fontObjId = pageFontMap.get(fontName) || resourceNameToFontObj.get(fontName) || null;
    const cmapObjId = fontObjId ? fontObjToCmapObj.get(fontObjId) : null;
    const encodingName = fontObjId ? fontObjToEncoding.get(fontObjId) || '' : '';
    if (cmapObjId && cmapsByObjId.has(cmapObjId)) {
      return { cmapObj: cmapsByObjId.get(cmapObjId), encodingName };
    }
    return {
      cmapObj: globalCMap2Map.size > 0 ? globalCmap2Obj : globalCMap1Map.size > 0 ? globalCmap1Obj : null,
      encodingName
    };
  };

  const pages = [];

  for (const job of pageJobs) {
    const pageLines = [];
    let currentLine = '';
    let activeCmapObj = globalCMap2Map.size > 0 ? globalCmap2Obj : globalCMap1Map.size > 0 ? globalCmap1Obj : null;
    let activeEncoding = '';
    let lastTmY = null;

    const btEtRegex = /\bBT\b([\s\S]*?)\bET\b/g;
    let btMatch;
    while ((btMatch = btEtRegex.exec(job.contentStr)) !== null) {
      const block = btMatch[1];
      const tokenRegex =
        /\/([A-Za-z0-9_.+-]+)\s+[-+]?\d+(?:\.\d+)?\s+Tf\b|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Tm\b|\[([\s\S]*?)\]\s*TJ|<([0-9A-Fa-f\s]+)>\s*Tj|\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*(?:Tj|'|")|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+T[dD]\b|\bT\*/g;
      let tok;
      while ((tok = tokenRegex.exec(block)) !== null) {
        if (tok[1] !== undefined) {
          const resolved = resolveActiveFont(tok[1], job.fontMap);
          activeCmapObj = resolved.cmapObj;
          activeEncoding = resolved.encodingName;
        } else if (tok[7] !== undefined) {
          const tmY = parseFloat(tok[7]);
          if (lastTmY !== null && Math.abs(tmY - lastTmY) > 2 && currentLine.trim()) {
            pageLines.push(currentLine);
            currentLine = '';
          }
          lastTmY = tmY;
        } else if (tok[8] !== undefined) {
          const arrStr = tok[8];
          const subRegex = /<([0-9A-Fa-f\s]+)>|\(([^()\\]*(?:\\.[^()\\]*)*)\)|(-?\d+(?:\.\d+)?)/g;
          let sub;
          while ((sub = subRegex.exec(arrStr)) !== null) {
            if (sub[1] !== undefined) {
              currentLine += decodeHexWithCMap(sub[1], activeCmapObj, activeEncoding);
            } else if (sub[2] !== undefined) {
              currentLine += unescapePdfLiteral(sub[2], activeCmapObj, activeEncoding);
            } else if (sub[3] !== undefined) {
              const kern = parseFloat(sub[3]);
              if (kern < -180 && currentLine && !currentLine.endsWith(' ')) {
                currentLine += ' ';
              }
            }
          }
        } else if (tok[9] !== undefined) {
          currentLine += decodeHexWithCMap(tok[9], activeCmapObj, activeEncoding);
        } else if (tok[10] !== undefined) {
          currentLine += unescapePdfLiteral(tok[10], activeCmapObj, activeEncoding);
        } else if (tok[11] !== undefined && tok[12] !== undefined) {
          const ty = parseFloat(tok[12]);
          if (Math.abs(ty) > 0.1 && currentLine.trim()) {
            pageLines.push(currentLine);
            currentLine = '';
          }
        } else {
          if (currentLine.trim()) {
            pageLines.push(currentLine);
            currentLine = '';
          }
        }
      }
      if (currentLine.trim()) {
        pageLines.push(currentLine);
        currentLine = '';
      }
    }

    if (pageLines.length > 0) {
      pages.push(normalizePdfUnicodeText(pageLines.join('\n')));
    }
  }

  return {
    numpages: Math.max(numpages, pages.length),
    info: {},
    pages,
    text: pages.join('\n\n')
  };
}

/**
 * Parse a .pdf buffer into metadata and chapters (with built-in Smart PDF Reflow,
 * Simplified/Traditional conversion support, raw line fallback, and native PDF viewer stream URL).
 */
async function parsePdfBuffer(buffer, filename = '未命名文件.pdf', bookId = '') {
  const rawTitle = path.basename(filename, path.extname(filename));

  try {
    let pages = [];
    let data = null;
    if (typeof pdfParse === 'function') {
      try {
        const options = {
          pagerender: function (pageData) {
            return pageData.getTextContent().then(function (textContent) {
              let lastY = null;
              let pageText = '';
              for (const item of textContent.items) {
                const str = normalizePdfUnicodeText(item.str || '');
                if (lastY === item.transform[5] || lastY === null) {
                  pageText += str;
                } else {
                  pageText += '\n' + str;
                }
                lastY = item.transform[5];
              }
              pages.push(pageText.trim());
              return pageText;
            });
          }
        };
        data = await pdfParse(buffer, options);
        if (data && typeof data.text === 'string') {
          data.text = normalizePdfUnicodeText(data.text);
        }
      } catch (_) {
        data = null;
        pages = [];
      }
    }

    const pdfParseTextRaw = pages.join('\n\n') || (data && data.text) || '';
    const pdfParseTextLen = pdfParseTextRaw.replace(/\s+/g, '').length;
    const pdfParseGarbled = pdfParseTextLen > 20 && isGarbledPdfText(pdfParseTextRaw);
    let garbledFallbackDetected = false;

    if (!data || pdfParseTextLen <= 20 || pdfParseGarbled) {
      const builtinData = extractPdfBuiltin(buffer);
      const builtinText = builtinData.text || '';
      const builtinLen = builtinText.replace(/\s+/g, '').length;
      const builtinGarbled = builtinLen > 20 && isGarbledPdfText(builtinText);

      if (!builtinGarbled && (pdfParseGarbled || builtinLen > pdfParseTextLen || !data)) {
        data = { ...builtinData, info: (data && data.info) || builtinData.info || {} };
        if (Array.isArray(builtinData.pages) && builtinData.pages.length > 0) {
          pages = builtinData.pages;
        }
      } else if ((pdfParseGarbled && (builtinLen <= 20 || builtinGarbled)) || builtinGarbled) {
        garbledFallbackDetected = true;
        pages = [];
        data = { ...(data || {}), text: '' };
      }
    }

    const infoTitle =
      data.info && typeof data.info.Title === 'string' && data.info.Title.trim()
        ? data.info.Title.trim()
        : rawTitle;
    const infoAuthor =
      data.info && typeof data.info.Author === 'string' && data.info.Author.trim()
        ? data.info.Author.trim()
        : '佚名';

    const rawFullText = pages.length > 0 ? pages.join('\n\n') : (data.text || '').trim();
    const totalChars = rawFullText.replace(/\s+/g, '').length;
    const textIsGarbled = garbledFallbackDetected || (totalChars > 20 && isGarbledPdfText(rawFullText));

    // If PDF contains clean extractable text (> 20 chars & not garbled), apply Smart PDF Reflow
    if (totalChars > 20 && !textIsGarbled) {
      const fullReflow = reflowPdfText(pages.length > 0 ? pages : rawFullText, {
        stripHeadersFooters: true,
        mergeBrokenLines: true
      });
      const reflowedFullText = fullReflow.text || rawFullText;

      const txtParsed = parseTxtBuffer(Buffer.from(reflowedFullText, 'utf8'), `${infoTitle}.txt`);
      const rawTxtParsed = parseTxtBuffer(Buffer.from(rawFullText, 'utf8'), `${infoTitle}.txt`);

      // If standard chapter headings were detected (more than 1 chapter), use them with reflowed content!
      if (txtParsed.chapters.length > 1) {
        const chaptersWithRaw = txtParsed.chapters.map((ch, idx) => ({
          ...ch,
          rawLineContent:
            rawTxtParsed.chapters[idx] && rawTxtParsed.chapters[idx].content
              ? rawTxtParsed.chapters[idx].content
              : ch.content
        }));
        return {
          ...txtParsed,
          chapters: chaptersWithRaw,
          title: infoTitle,
          author: infoAuthor !== '佚名' ? infoAuthor : txtParsed.author,
          format: 'pdf',
          pdfReflowed: true,
          pdfReflowStats: fullReflow.stats,
          pdfPageCount: data.numpages || pages.length,
          rawPdfUrl: bookId ? `/api/books/${encodeURIComponent(bookId)}/raw` : null
        };
      }

      // Otherwise group every 10 PDF pages into a structured chapter (with both Reflowed & Raw Line modes)
      if (pages.length > 1) {
        const PAGES_PER_CHAPTER = 10;
        const chapters = [];
        for (let i = 0; i < pages.length; i += PAGES_PER_CHAPTER) {
          const slice = pages.slice(i, i + PAGES_PER_CHAPTER);
          const startPage = i + 1;
          const endPage = Math.min(pages.length, i + PAGES_PER_CHAPTER);

          const rawJoined = slice
            .map((pText, idx) => `【第 ${startPage + idx} 頁】\n${pText}`)
            .join('\n\n')
            .trim();
          if (!rawJoined) continue;

          const sliceReflow = reflowPdfText(slice, {
            stripHeadersFooters: true,
            mergeBrokenLines: true
          });
          const reflowedJoined = sliceReflow.text.trim() || rawJoined;

          chapters.push({
            index: chapters.length,
            title:
              startPage === endPage
                ? `第 ${startPage} 頁`
                : `第 ${startPage} ~ ${endPage} 頁`,
            content: reflowedJoined,
            rawLineContent: rawJoined,
            wordCount: reflowedJoined.replace(/\s+/g, '').length
          });
        }

        if (chapters.length > 0) {
          return {
            title: infoTitle,
            author: infoAuthor,
            description: chapters[0].content.slice(0, 180).replace(/\s+/g, ' '),
            encoding: 'PDF-UTF8',
            format: 'pdf',
            pdfReflowed: true,
            pdfReflowStats: fullReflow.stats,
            pdfPageCount: data.numpages || pages.length,
            rawPdfUrl: bookId ? `/api/books/${encodeURIComponent(bookId)}/raw` : null,
            totalChapters: chapters.length,
            totalWords: chapters.reduce((acc, c) => acc + c.wordCount, 0),
            chapters
          };
        }
      }

      // Single-chapter PDF with extractable text
      const singleChapters = txtParsed.chapters.map((ch) => ({
        ...ch,
        rawLineContent: rawFullText
      }));

      return {
        ...txtParsed,
        chapters: singleChapters,
        title: infoTitle,
        author: infoAuthor,
        format: 'pdf',
        pdfReflowed: true,
        pdfReflowStats: fullReflow.stats,
        pdfPageCount: data.numpages || 1,
        rawPdfUrl: bookId ? `/api/books/${encodeURIComponent(bookId)}/raw` : null
      };
    }

    // Image/Scanned or custom-encoded PDF without usable Unicode map: provide embedded PDF viewer chapter
    return {
      title: infoTitle,
      author: infoAuthor,
      description: textIsGarbled
        ? '此 PDF 未內嵌完整文字編碼表（自動切換為原版 PDF 檢視）'
        : '掃描版或純圖片 PDF 書籍（支援原版 PDF 檢視模式）',
      encoding: 'PDF-IMAGE',
      format: 'pdf',
      pdfPageCount: (data && data.numpages) || 1,
      rawPdfUrl: bookId ? `/api/books/${encodeURIComponent(bookId)}/raw` : null,
      totalChapters: 1,
      totalWords: 0,
      chapters: [
        {
          index: 0,
          title: `原版 PDF 檢視（共 ${(data && data.numpages) || 1} 頁）`,
          content: textIsGarbled
            ? '此 PDF 檔案的字型未包含完整 Unicode 對應表（若強制擷取文字會出現亂碼），已自動為您切換至「📄 原版 PDF」原樣顯示。若裝置內嵌檢視器無法顯示，請點擊上方「↗ 新分頁開啟」以系統 PDF 閱讀器開啟。'
            : '此 PDF 檔案為掃描圖片版或不含文字圖層，已為您載入下方原版 PDF 線上檢視器（亦可點擊上方「📄 原版 PDF」全幅閱讀）。',
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

const COMIC_IMAGE_EXT_REGEX = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const naturalComicCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareNaturalComicPath(a, b) {
  const partsA = a.split('/');
  const partsB = b.split('/');
  const minLen = Math.min(partsA.length, partsB.length);
  for (let i = 0; i < minLen; i++) {
    if (partsA[i] !== partsB[i]) {
      return naturalComicCollator.compare(partsA[i], partsB[i]);
    }
  }
  return partsA.length - partsB.length;
}

function isIgnoredComicEntry(entryName) {
  if (!entryName) return true;
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('__MACOSX/') || normalized.includes('/__MACOSX/')) return true;
  const segments = normalized.split('/');
  if (segments.some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) return true;
  const base = path.posix.basename(normalized).toLowerCase();
  if (base === 'thumbs.db' || base === 'desktop.ini') return true;
  return false;
}

function decodeXmlText(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseComicInfoXml(xmlStr) {
  if (!xmlStr) return {};
  const extractTag = (tag) => {
    const m = xmlStr.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? decodeXmlText(m[1].trim()) : '';
  };
  const series = extractTag('Series');
  const title = extractTag('Title');
  const number = extractTag('Number');
  const volume = extractTag('Volume');
  const writer = extractTag('Writer') || extractTag('Author') || extractTag('Penciller');
  const summary = extractTag('Summary');
  const mangaRaw = extractTag('Manga').toLowerCase();

  let fullTitle = title;
  if (series && title && !title.includes(series)) {
    fullTitle = `${series} - ${title}`;
  } else if (series && !title) {
    fullTitle = number ? `${series} 第${number}話` : volume ? `${series} 第${volume}卷` : series;
  }

  return {
    title: fullTitle,
    author: writer,
    description: summary,
    mangaRtl: mangaRaw === 'no' ? false : true
  };
}

/**
 * Parse a .cbz (Comic Book ZIP) buffer into comic metadata and page chapters.
 * Supports natural alphanumeric image sorting, subfolder chapter grouping,
 * ComicInfo.xml metadata, and on-demand image asset URLs.
 */
function parseCbzBuffer(buffer, filename = '未命名漫畫.cbz', bookId = '') {
  const rawTitle = path.basename(filename, path.extname(filename));

  // Check if file is actually a RAR archive renamed to .cbz (CBR magic header)
  if (
    buffer &&
    buffer.length >= 4 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x61 &&
    buffer[2] === 0x72 &&
    buffer[3] === 0x21
  ) {
    return {
      title: rawTitle,
      author: '漫畫作品',
      description: '偵測到此檔案實為 RAR (CBR) 格式重新命名為 .cbz，請轉存為標準 ZIP 格式 (.cbz) 後閱讀。',
      encoding: 'CBR-UNSUPPORTED',
      format: 'cbz',
      isComic: true,
      mangaRtl: true,
      comicPageCount: 0,
      totalChapters: 1,
      totalWords: 0,
      chapters: [
        {
          index: 0,
          title: '格式提示',
          content:
            '此檔案內部為 RAR 壓縮格式（CBR），目前僅支援標準 ZIP 壓縮的 CBZ 漫畫格式，建議使用壓縮軟體轉存為 .cbz (ZIP) 後重新讀取。',
          blocks: [],
          wordCount: 0,
          pageCount: 0
        }
      ]
    };
  }

  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();

    let comicMeta = {};
    const comicInfoEntry = entries.find(
      (e) => !e.isDirectory && /(?:^|\/)ComicInfo\.xml$/i.test(e.entryName.replace(/\\/g, '/'))
    );
    if (comicInfoEntry) {
      try {
        comicMeta = parseComicInfoXml(comicInfoEntry.getData().toString('utf8'));
      } catch (_) {}
    }

    const imageEntries = entries
      .filter((e) => {
        if (e.isDirectory) return false;
        const cleanName = e.entryName.replace(/\\/g, '/');
        if (isIgnoredComicEntry(cleanName)) return false;
        return COMIC_IMAGE_EXT_REGEX.test(cleanName);
      })
      .map((e) => e.entryName.replace(/\\/g, '/'))
      .sort(compareNaturalComicPath);

    const title = comicMeta.title || rawTitle;
    const author = comicMeta.author || '漫畫作品';

    if (imageEntries.length === 0) {
      return {
        title,
        author,
        description: 'CBZ 漫畫壓縮檔內未偵測到支援的圖片檔案（JPG/PNG/WebP/GIF）。',
        encoding: 'CBZ-IMAGE',
        format: 'cbz',
        isComic: true,
        mangaRtl: comicMeta.mangaRtl !== undefined ? comicMeta.mangaRtl : true,
        comicPageCount: 0,
        totalChapters: 1,
        totalWords: 0,
        chapters: [
          {
            index: 0,
            title: '空白漫畫檔',
            content: '此 CBZ 壓縮檔中未包含可顯示的圖片頁面（支援 JPG / PNG / WebP / GIF / AVIF）。',
            blocks: [],
            wordCount: 0,
            pageCount: 0
          }
        ]
      };
    }

    const folderGroups = new Map();
    for (const entryPath of imageEntries) {
      const dir = path.posix.dirname(entryPath);
      const groupKey = dir === '.' ? '' : dir;
      if (!folderGroups.has(groupKey)) folderGroups.set(groupKey, []);
      folderGroups.get(groupKey).push(entryPath);
    }

    const makeImageBlock = (entryPath, pageIndexInChapter, globalPageNum) => {
      const encodedPath = entryPath
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
      const src = bookId
        ? `/api/books/${encodeURIComponent(bookId)}/asset/${encodedPath}`
        : entryPath;
      return {
        type: 'image',
        src,
        entryPath,
        alt: `第 ${globalPageNum} 頁 (${path.posix.basename(entryPath)})`,
        pageNumber: pageIndexInChapter + 1,
        globalPageNumber: globalPageNum
      };
    };

    const chapters = [];
    let globalPage = 1;
    const PAGES_PER_CHUNK = 25;

    if (folderGroups.size > 1) {
      const sortedGroups = Array.from(folderGroups.entries()).sort((a, b) =>
        compareNaturalComicPath(a[0], b[0])
      );
      for (const [folderName, list] of sortedGroups) {
        const displayLabel = folderName ? folderName.split('/').slice(-1)[0] : '封面 / 序頁';
        if (list.length <= 45) {
          const blocks = list.map((ep, idx) => makeImageBlock(ep, idx, globalPage++));
          chapters.push({
            index: chapters.length,
            title: `${displayLabel} (${list.length} 頁)`,
            content: `${displayLabel}，共 ${list.length} 頁漫畫圖片`,
            blocks,
            wordCount: list.length,
            pageCount: list.length
          });
        } else {
          for (let i = 0; i < list.length; i += PAGES_PER_CHUNK) {
            const slice = list.slice(i, i + PAGES_PER_CHUNK);
            const blocks = slice.map((ep, idx) => makeImageBlock(ep, idx, globalPage++));
            chapters.push({
              index: chapters.length,
              title: `${displayLabel} (P.${i + 1}~${i + slice.length})`,
              content: `${displayLabel} 第 ${i + 1}~${i + slice.length} 頁`,
              blocks,
              wordCount: slice.length,
              pageCount: slice.length
            });
          }
        }
      }
    } else {
      if (imageEntries.length <= 30) {
        const blocks = imageEntries.map((ep, idx) => makeImageBlock(ep, idx, globalPage++));
        chapters.push({
          index: 0,
          title: `全一話 (共 ${imageEntries.length} 頁)`,
          content: `共 ${imageEntries.length} 頁漫畫圖片`,
          blocks,
          wordCount: imageEntries.length,
          pageCount: imageEntries.length
        });
      } else {
        for (let i = 0; i < imageEntries.length; i += PAGES_PER_CHUNK) {
          const slice = imageEntries.slice(i, i + PAGES_PER_CHUNK);
          const startP = i + 1;
          const endP = i + slice.length;
          const blocks = slice.map((ep, idx) => makeImageBlock(ep, idx, globalPage++));
          chapters.push({
            index: chapters.length,
            title: `第 ${startP} ~ ${endP} 頁`,
            content: `第 ${startP} ~ ${endP} 頁漫畫圖片`,
            blocks,
            wordCount: slice.length,
            pageCount: slice.length
          });
        }
      }
    }

    return {
      title,
      author,
      description:
        comicMeta.description ||
        `CBZ 漫畫書（共 ${imageEntries.length} 頁，分為 ${chapters.length} 話/章節）`,
      encoding: 'CBZ-IMAGE',
      format: 'cbz',
      isComic: true,
      mangaRtl: comicMeta.mangaRtl !== undefined ? comicMeta.mangaRtl : true,
      comicPageCount: imageEntries.length,
      totalChapters: chapters.length,
      totalWords: imageEntries.length,
      chapters
    };
  } catch (err) {
    return {
      title: rawTitle,
      author: '漫畫作品',
      description: `CBZ 漫畫讀取失敗：${err.message}`,
      encoding: 'CBZ-ERROR',
      format: 'cbz',
      isComic: true,
      mangaRtl: true,
      comicPageCount: 0,
      totalChapters: 1,
      totalWords: 0,
      chapters: [
        {
          index: 0,
          title: '讀取錯誤',
          content: `無法解析此 CBZ 漫畫檔案（${err.message}），請確認檔案未損毀且為標準 ZIP 格式。`,
          blocks: [],
          wordCount: 0,
          pageCount: 0
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
  parseCbzBuffer,
  reflowPdfText,
  extractPdfBuiltin,
  getEpubAsset,
  getZipAsset: getEpubAsset
};
