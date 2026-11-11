const fs = require('fs');
const path = require('path');
const chardet = require('chardet');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');
const OpenCC = require('opencc-js');

// Initialize OpenCC converters
const converterS2TWP = OpenCC.Converter({ from: 'cn', to: 'twp' });
const converterS2T = OpenCC.Converter({ from: 'cn', to: 'tw' });

/**
 * Convert text according to mode:
 * - 's2twp': Simplified -> Traditional (Taiwan standard with idioms, default)
 * - 's2t': Simplified -> Traditional (Standard character mapping)
 * - 'none': Original text without conversion
 */
function convertText(text, mode = 's2twp') {
  if (!text || typeof text !== 'string') return '';
  if (mode === 'none') return text;
  if (mode === 's2t') return converterS2T(text);
  return converterS2TWP(text);
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

module.exports = {
  convertText,
  decodeBuffer,
  parseTxtBuffer,
  parseEpubBuffer,
  getEpubAsset
};
