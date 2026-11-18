/**
 * 雲端書閣 (Cloud Book Sanctuary) — NAS 私人小說線上閱讀平台
 * Supports:
 * 1. NAS Backend Server Mode (Docker / Node.js mounted /novels + WebDAV proxy + /api/sync)
 * 2. Direct WebDAV / Static GitHub Pages Mode (In-memory streaming + WebDAV .novel-reader-sync.json)
 * 3. Real-time Simplified-to-Traditional Chinese conversion (OpenCC s2twp / s2t / none)
 */

(function () {
  'use strict';

  // ==========================================================================
  // 1. OpenCC Simplified <-> Traditional Converter & Boolean Search Compiler
  // ==========================================================================
  let openccS2TWP = null;
  let openccS2T = null;
  let openccT2S = null;

  function initOpenCC() {
    if (window.OpenCC && window.OpenCC.Converter) {
      try {
        openccS2TWP = window.OpenCC.Converter({ from: 'cn', to: 'twp' });
        openccS2T = window.OpenCC.Converter({ from: 'cn', to: 'tw' });
        openccT2S = window.OpenCC.Converter({ from: 'tw', to: 'cn' });
      } catch (e) {
        console.warn('OpenCC init warning:', e);
      }
    }
  }

  function convertStr(text, mode) {
    if (!text || typeof text !== 'string') return '';
    const activeMode = mode || state.settings.convertMode || 's2twp';
    if (activeMode === 'none') return text;
    if (activeMode === 's2t' && openccS2T) return openccS2T(text);
    if (activeMode === 't2s' && openccT2S) return openccT2S(text);
    if (openccS2TWP) return openccS2TWP(text);
    return text;
  }

  /**
   * Client-side boolean query compiler:
   * Supports AND (space, &, &&, AND), OR (|, ||, OR), NOT (-, !, NOT), and parentheses ()
   * with automatic Simplified/Traditional cross-matching.
   */
  function compileBooleanQueryClient(rawQuery) {
    if (!rawQuery || typeof rawQuery !== 'string' || !rawQuery.trim()) {
      return () => true;
    }

    const normalized = rawQuery
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/｜/g, '|')
      .replace(/＆/g, '&')
      .replace(/！/g, '!')
      .trim();

    const tokens = [];
    let i = 0;
    const len = normalized.length;

    while (i < len) {
      const ch = normalized[i];
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
      if (ch === '"' || ch === "'") {
        const quoteChar = ch;
        i++;
        let phrase = '';
        while (i < len && normalized[i] !== quoteChar) {
          phrase += normalized[i];
          i++;
        }
        if (i < len && normalized[i] === quoteChar) i++;
        if (phrase) tokens.push({ type: 'TERM', value: phrase });
        continue;
      }

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
      if (upper === 'AND') tokens.push({ type: 'AND' });
      else if (upper === 'OR') tokens.push({ type: 'OR' });
      else if (upper === 'NOT') tokens.push({ type: 'NOT' });
      else tokens.push({ type: 'TERM', value: word });
    }

    if (tokens.length === 0) return () => true;

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

    function createTermPredicate(rawTerm) {
      const base = rawTerm.toLowerCase();
      const set = new Set([base]);
      if (openccS2TWP) set.add(openccS2TWP(base).toLowerCase());
      if (openccS2T) set.add(openccS2T(base).toLowerCase());
      if (openccT2S) set.add(openccT2S(base).toLowerCase());
      const variants = Array.from(set).filter(Boolean);
      return (haystackLower) => {
        for (let v = 0; v < variants.length; v++) {
          if (haystackLower.includes(variants[v])) return true;
        }
        return false;
      };
    }

    let pos = 0;
    function parseExpr() {
      let left = parseOrExpr();
      while (pos < expanded.length && expanded[pos].type === 'AND') {
        pos++;
        const right = parseOrExpr();
        const prevLeft = left;
        left = (h) => prevLeft(h) && right(h);
      }
      return left;
    }
    function parseOrExpr() {
      let left = parseNotExpr();
      while (pos < expanded.length && expanded[pos].type === 'OR') {
        pos++;
        const right = parseNotExpr();
        const prevLeft = left;
        left = (h) => prevLeft(h) || right(h);
      }
      return left;
    }
    function parseNotExpr() {
      if (pos < expanded.length && expanded[pos].type === 'NOT') {
        pos++;
        const operand = parseNotExpr();
        return (h) => !operand(h);
      }
      return parsePrimary();
    }
    function parsePrimary() {
      if (pos >= expanded.length) return () => true;
      const tok = expanded[pos];
      if (tok.type === 'LPAREN') {
        pos++;
        const inner = parseExpr();
        if (pos < expanded.length && expanded[pos].type === 'RPAREN') pos++;
        return inner;
      }
      if (tok.type === 'TERM') {
        pos++;
        return createTermPredicate(tok.value);
      }
      pos++;
      return parsePrimary();
    }

    try {
      return parseExpr();
    } catch (_) {
      const preds = rawQuery.trim().split(/\s+/).filter(Boolean).map(createTermPredicate);
      return (h) => preds.every((fn) => fn(h));
    }
  }

  // ==========================================================================
  // 2. Application State & Local Cache
  // ==========================================================================
  const STORAGE_KEYS = {
    SYNC_KEY: 'novel_reader_sync_key',
    CUSTOM_API: 'novel_reader_custom_api',
    WEBDAV_CFG: 'novel_reader_webdav_cfg',
    LOCAL_SYNC_CACHE: 'novel_reader_sync_cache'
  };

  const state = {
    serverAvailable: false,
    connectionMode: 'checking', // 'nas-server' | 'webdav-direct' | 'static-demo'
    customApiUrl: localStorage.getItem(STORAGE_KEYS.CUSTOM_API) || '',
    syncKey: localStorage.getItem(STORAGE_KEYS.SYNC_KEY) || 'default',
    webdavConfig: loadLocalJson(STORAGE_KEYS.WEBDAV_CFG, {
      enableWebdav: false,
      webdavUrl: '',
      webdavUsername: '',
      webdavPassword: '',
      webdavBasePath: '/'
    }),

    books: [],
    inMemoryBooks: new Map(), // For static/WebDAV direct mode parsed books
    selectedFolder: 'ALL',
    selectedFormat: 'ALL',
    sortBy: 'recent',
    searchQuery: '',
    currentPage: 1,
    pageSize: 60,
    totalPages: 1,
    totalBooksCount: 0,
    folderCountsMap: {},

    // Synced User Data
    progress: {},
    bookmarks: {},
    annotations: {}, // { [bookId]: { highlights: [...], strokes: { [chIdx]: [...] } } }
    settings: {
      theme: 'sepia',
      fontSize: 19,
      lineHeight: 1.85,
      fontFamily: 'serif',
      maxWidth: 760,
      convertMode: 's2twp',
      writingMode: 'horizontal', // 'horizontal' | 'vertical'
      pdfReflowMode: 'reflow',   // 'reflow' (智慧重排) | 'raw' (原始斷行) | 'native' (原版 PDF)
      clickFlip: 'both' // 'both' | 'left_next' | 'next_only' | 'off'
    },

    // Active Reader Session & Annotation Tools
    currentBook: null,      // { id, title, originalTitle, author, totalChapters, chapters: [...] }
    currentChapter: null,   // { index, title, originalTitle, content, rawLineContent, blocks, wordCount, prevIndex, nextIndex }
    pdfViewMode: 'reflow',  // 'reflow' | 'raw' | 'native'
    activeDrawerTab: 'toc',
    tocSearchQuery: '',
    isRestoringScroll: false,
    annotToolbarOpen: false,
    annotTool: 'read',      // 'read' | 'highlighter' | 'pen' | 'eraser'
    annotColor: 'yellow',   // 'yellow' | 'green' | 'blue' | 'pink'
    pendingSelectionText: '',
    editingHighlightId: null
  };

  function loadLocalJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveLocalCache() {
    try {
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_SYNC_CACHE,
        JSON.stringify({
          syncKey: state.syncKey,
          progress: state.progress,
          bookmarks: state.bookmarks,
          annotations: state.annotations,
          settings: state.settings,
          updatedAt: new Date().toISOString()
        })
      );
    } catch (_) {}
  }

  // Restore cached sync data immediately for zero-flicker startup
  const cachedSync = loadLocalJson(STORAGE_KEYS.LOCAL_SYNC_CACHE, null);
  if (cachedSync) {
    if (cachedSync.progress) state.progress = cachedSync.progress;
    if (cachedSync.bookmarks) state.bookmarks = cachedSync.bookmarks;
    if (cachedSync.annotations) state.annotations = cachedSync.annotations;
    if (cachedSync.settings) {
      state.settings = { ...state.settings, ...cachedSync.settings };
    }
  }

  // ==========================================================================
  // 3. API & Network Helper (Supports NAS Server, Custom Backend URL & WebDAV)
  // ==========================================================================
  function getApiBase() {
    if (state.customApiUrl) {
      return state.customApiUrl.replace(/\/+$/, '');
    }
    return '';
  }

  function getApiHeaders(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Sync-Key': state.syncKey || 'default',
      ...extra
    };
    if (state.webdavConfig && state.webdavConfig.enableWebdav && state.webdavConfig.webdavUrl) {
      try {
        const encoded = btoa(
          unescape(
            encodeURIComponent(
              JSON.stringify({
                url: state.webdavConfig.webdavUrl,
                username: state.webdavConfig.webdavUsername,
                password: state.webdavConfig.webdavPassword,
                basePath: state.webdavConfig.webdavBasePath || '/'
              })
            )
          )
        );
        headers['X-Webdav-Config'] = encoded;
      } catch (_) {}
    }
    return headers;
  }

  async function apiFetch(endpoint, options = {}) {
    const url = `${getApiBase()}${endpoint}`;
    const res = await fetch(url, {
      ...options,
      headers: getApiHeaders(options.headers || {})
    });
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const errData = await res.json();
        if (errData && errData.error) errMsg = errData.error;
      } catch (_) {}
      throw new Error(errMsg);
    }
    return await res.json();
  }

  // ==========================================================================
  // 4. Client-Side TXT & EPUB In-Memory Parser (For Static / Direct WebDAV Mode)
  // ==========================================================================
  function decodeArrayBufferClient(arrayBuffer) {
    const uint8 = new Uint8Array(arrayBuffer);
    // Try strict UTF-8 first
    try {
      const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
      return utf8Decoder.decode(uint8);
    } catch (_) {
      // Fallback to GB18030 (covers GBK / GB2312 Simplified Chinese novels)
      try {
        const gbkDecoder = new TextDecoder('gb18030');
        return gbkDecoder.decode(uint8);
      } catch (__) {
        return new TextDecoder('utf-8').decode(uint8);
      }
    }
  }

  function parseTxtClient(text, filename) {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const rawTitle = filename.replace(/\.(txt|epub)$/i, '');
    const chapterRegex = /^\s*(?:正文\s*)?(?:第[零一二三四五六七八九十百千萬萬0-9０-９]+[章回節卷集部篇]|楔子|序章|序言|引子|前言|尾聲|後記|番外(?:\s*[零一二三四五六七八九十0-9]+)?|Chapter\s+\d+)(?:[\s　：:、.—\-].*)?$/i;

    const chapters = [];
    let currentTitle = '序幕 / 前言';
    let currentLines = [];

    const flush = (title, contentLines) => {
      const joined = contentLines.join('\n').trim();
      if (!joined && chapters.length === 0) return;
      chapters.push({
        index: chapters.length,
        title,
        originalTitle: title,
        content: joined,
        wordCount: joined.replace(/\s+/g, '').length
      });
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && trimmed.length <= 65 && chapterRegex.test(trimmed)) {
        if (currentLines.length > 0) {
          flush(currentTitle, currentLines);
          currentLines = [];
        }
        currentTitle = trimmed;
      } else {
        currentLines.push(line);
      }
    }
    if (currentLines.length > 0 || chapters.length === 0) {
      flush(chapters.length === 0 ? rawTitle : currentTitle, currentLines);
    }

    return {
      title: rawTitle,
      originalTitle: rawTitle,
      author: '佚名',
      format: 'txt',
      totalChapters: chapters.length,
      totalWords: chapters.reduce((s, c) => s + c.wordCount, 0),
      chapters
    };
  }

  async function parseEpubClient(arrayBuffer, filename) {
    if (!window.JSZip) throw new Error('JSZip 尚未載入');
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    const parser = new DOMParser();

    const getText = async (filePath) => {
      const clean = filePath.replace(/^\/+/, '');
      const f = zip.file(clean) || zip.file(decodeURIComponent(clean));
      if (!f) return null;
      const buf = await f.async('arraybuffer');
      return decodeArrayBufferClient(buf);
    };

    let opfPath = '';
    const containerXml = await getText('META-INF/container.xml');
    if (containerXml) {
      const doc = parser.parseFromString(containerXml, 'application/xml');
      const rootfile = doc.querySelector('rootfile');
      if (rootfile) opfPath = rootfile.getAttribute('full-path') || '';
    }

    let title = filename.replace(/\.epub$/i, '');
    let author = '佚名';
    const manifest = new Map();
    const spinePaths = [];

    const resolveRel = (base, rel) => {
      if (!rel) return '';
      const cleanRel = decodeURIComponent(rel.split('#')[0]);
      const baseParts = base.split('/');
      baseParts.pop();
      for (const seg of cleanRel.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') baseParts.pop();
        else baseParts.push(seg);
      }
      return baseParts.join('/');
    };

    if (opfPath) {
      const opfXml = await getText(opfPath);
      if (opfXml) {
        const doc = parser.parseFromString(opfXml, 'application/xml');
        const tEl = doc.querySelector('title');
        const cEl = doc.querySelector('creator');
        if (tEl && tEl.textContent.trim()) title = tEl.textContent.trim();
        if (cEl && cEl.textContent.trim()) author = cEl.textContent.trim();

        doc.querySelectorAll('manifest > item').forEach((el) => {
          const id = el.getAttribute('id');
          const href = el.getAttribute('href');
          if (id && href) {
            manifest.set(id, resolveRel(opfPath, href));
          }
        });

        doc.querySelectorAll('spine > itemref').forEach((el) => {
          const idref = el.getAttribute('idref');
          if (idref && manifest.has(idref)) {
            spinePaths.push(manifest.get(idref));
          }
        });
      }
    }

    const chapters = [];
    for (let i = 0; i < spinePaths.length; i++) {
      const htmlStr = await getText(spinePaths[i]);
      if (!htmlStr) continue;
      const doc = parser.parseFromString(htmlStr, 'text/html');
      doc.querySelectorAll('script, style').forEach((s) => s.remove());
      const headingEl = doc.querySelector('h1, h2, h3, title');
      const chTitle =
        (headingEl && headingEl.textContent.trim()) || `第 ${chapters.length + 1} 章`;

      const paragraphs = [];
      doc.querySelectorAll('p, h1, h2, h3, h4, li, blockquote').forEach((p) => {
        const t = p.textContent.replace(/\s+/g, ' ').trim();
        if (t && t !== chTitle) paragraphs.push(t);
      });

      const content =
        paragraphs.length > 0
          ? paragraphs.join('\n\n')
          : (doc.body ? doc.body.textContent.trim() : '');
      if (!content) continue;

      chapters.push({
        index: chapters.length,
        title: chTitle,
        originalTitle: chTitle,
        content,
        wordCount: content.replace(/\s+/g, '').length
      });
    }

    return {
      title,
      originalTitle: title,
      author,
      format: 'epub',
      totalChapters: chapters.length,
      totalWords: chapters.reduce((s, c) => s + c.wordCount, 0),
      chapters
    };
  }

  function decompressPalmDocClient(uint8) {
    const out = [];
    let i = 0;
    const len = uint8.length;
    while (i < len) {
      const c = uint8[i++];
      if (c === 0x00) {
        out.push(0x00);
      } else if (c >= 0x01 && c <= 0x08) {
        for (let j = 0; j < c && i < len; j++) out.push(uint8[i++]);
      } else if (c >= 0x09 && c <= 0x7f) {
        out.push(c);
      } else if (c >= 0x80 && c <= 0xbf) {
        if (i >= len) break;
        const next = uint8[i++];
        const pair = (c << 8) | next;
        const distance = (pair >> 3) & 0x07ff;
        const length = (pair & 0x07) + 3;
        const startPos = out.length - distance;
        for (let j = 0; j < length; j++) {
          out.push(startPos + j >= 0 && startPos + j < out.length ? out[startPos + j] : 0x20);
        }
      } else {
        out.push(0x20, c ^ 0x80);
      }
    }
    return new Uint8Array(out);
  }

  function parseMobiClient(arrayBuffer, filename) {
    const view = new DataView(arrayBuffer);
    const uint8 = new Uint8Array(arrayBuffer);
    const rawTitle = filename.replace(/\.(mobi|azw3|azw)$/i, '');

    if (arrayBuffer.byteLength < 78) {
      return { ...parseTxtClient(decodeArrayBufferClient(arrayBuffer), filename), format: 'mobi' };
    }

    try {
      const numRecords = view.getUint16(76, false);
      if (numRecords === 0 || 78 + numRecords * 8 > arrayBuffer.byteLength) {
        return { ...parseTxtClient(decodeArrayBufferClient(arrayBuffer), filename), format: 'mobi' };
      }

      const offsets = [];
      for (let i = 0; i < numRecords; i++) {
        offsets.push(view.getUint32(78 + i * 8, false));
      }

      const getRec = (idx) => {
        const s = offsets[idx];
        const e = idx + 1 < numRecords ? offsets[idx + 1] : arrayBuffer.byteLength;
        if (s >= arrayBuffer.byteLength || e <= s) return new Uint8Array(0);
        return uint8.subarray(s, Math.min(e, arrayBuffer.byteLength));
      };

      const rec0 = getRec(0);
      if (rec0.length < 16) {
        return { ...parseTxtClient(decodeArrayBufferClient(arrayBuffer), filename), format: 'mobi' };
      }

      const rec0View = new DataView(rec0.buffer, rec0.byteOffset, rec0.byteLength);
      const compression = rec0View.getUint16(0, false);
      const textRecordCount = rec0View.getUint16(8, false);
      let extraDataFlags = 0;
      if (rec0.length >= 244) {
        extraDataFlags = rec0View.getUint16(242, false);
      }

      const trimTrailing = (buf) => {
        if (!extraDataFlags || buf.length === 0) return buf;
        let end = buf.length;
        let flags = extraDataFlags >> 1;
        while (flags > 0 && end > 0) {
          if (flags & 1) {
            let size = 0;
            let shift = 0;
            let pos = end - 1;
            while (pos >= 0 && shift < 28) {
              const b = buf[pos--];
              size |= (b & 0x7f) << shift;
              shift += 7;
              if ((b & 0x80) !== 0) break;
            }
            if (size > 0 && size <= end) end -= size;
          }
          flags >>= 1;
        }
        if ((extraDataFlags & 1) !== 0 && end > 0) {
          const overlap = (buf[end - 1] & 0x03) + 1;
          if (overlap <= end) end -= overlap;
        }
        return buf.subarray(0, end);
      };

      const maxRec = Math.min(numRecords - 1, textRecordCount || numRecords - 1);
      const chunks = [];
      let totalLen = 0;
      for (let r = 1; r <= maxRec; r++) {
        let rec = trimTrailing(getRec(r));
        if (!rec.length) continue;
        const dec = compression === 2 ? decompressPalmDocClient(rec) : rec;
        chunks.push(dec);
        totalLen += dec.length;
      }

      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const ch of chunks) {
        merged.set(ch, offset);
        offset += ch.length;
      }

      const decodedHtml = decodeArrayBufferClient(merged.buffer);
      const doc = new DOMParser().parseFromString(
        decodedHtml
          .replace(/<mbp:pagebreak\s*\/?>/gi, '\n\n')
          .replace(/<\s*br\s*\/?>/gi, '\n')
          .replace(/<\/\s*(p|div|h[1-6]|li|blockquote|tr)\s*>/gi, '\n'),
        'text/html'
      );
      doc.querySelectorAll('script, style').forEach((s) => s.remove());
      const cleanText = doc.body ? doc.body.textContent : decodedHtml.replace(/<[^>]+>/g, '');

      const parsed = parseTxtClient(cleanText, `${rawTitle}.txt`);
      return {
        ...parsed,
        format: 'mobi'
      };
    } catch (_) {
      return { ...parseTxtClient(decodeArrayBufferClient(arrayBuffer), filename), format: 'mobi' };
    }
  }

  const PDF_CHAPTER_HEADING_REGEX_CLIENT =
    /^(?:第\s*[零一二三四五六七八九十百千万萬千0-9]+\s*[章節节回卷部篇集話话]|(?:Chapter|CHAPTER|Part|PART|Section|Book)\s+[0-9IVXLCDM]+|(?:序章|楔子|引子|プロローグ|前言|自序|導讀|导读|後記|后记|尾聲|尾声|番外|附錄|附录)(?:\s|$|[：:—\-])|[一二三四五六七八九十]+[、.．]\s*\S+)/;

  const PAGE_NUMBER_LINE_REGEX_CLIENT =
    /^(?:[-—–~～·•\s]*\d{1,5}[-—–~～·•\s]*|第\s*\d{1,5}\s*[頁页](?:\s*[\/／]\s*共?\s*\d{1,5}\s*[頁页])?|【\s*第\s*\d{1,5}\s*[頁页]\s*】|Page\s+\d{1,5}(?:\s+of\s+\d{1,5})?)$/i;

  const TERMINAL_PUNCT_REGEX_CLIENT = /[。！？!?…⋯」』”"》）)\.!;:]$/;
  const LIST_OR_DIALOGUE_START_REGEX_CLIENT =
    /^(?:[「『“"（(【《]|[-•·*]\s+|\d{1,3}[.、)）]\s*|[①②③④⑤⑥⑦⑧⑨⑩])/;

  function getVisualWidthClient(str) {
    let w = 0;
    for (let i = 0; i < str.length; i++) {
      w += str.charCodeAt(i) > 0xff ? 2 : 1;
    }
    return w;
  }

  function joinReflowedLinesClient(prev, next) {
    if (/[a-zA-Z]-$/.test(prev) && /^[a-z]/.test(next)) {
      return prev.slice(0, -1) + next;
    }
    const lastChar = prev.charAt(prev.length - 1);
    const firstChar = next.charAt(0);
    if (/[a-zA-Z0-9,.;:?!)]/.test(lastChar) && /[a-zA-Z0-9(]/.test(firstChar)) {
      return `${prev} ${next}`;
    }
    return prev + next;
  }

  function normalizePdfLineSpacingClient(line) {
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
   * Client-side Smart PDF & Hard-Wrapped Text Reflow Engine
   */
  function reflowPdfTextClient(pagesOrText, options = {}) {
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

    const repeatedHeaderFooterSet = new Set();
    if (stripHeadersFooters && pageLinesList.length >= 3) {
      const edgeCounts = new Map();
      for (const lines of pageLinesList) {
        const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
        if (nonEmpty.length === 0) continue;
        const candidates = new Set([nonEmpty[0], nonEmpty[nonEmpty.length - 1]]);
        for (const c of candidates) {
          if (c.length <= 45 && !PDF_CHAPTER_HEADING_REGEX_CLIENT.test(c)) {
            edgeCounts.set(c, (edgeCounts.get(c) || 0) + 1);
          }
        }
      }
      const threshold = Math.max(2, Math.ceil(pageLinesList.length * 0.4));
      for (const [lineText, count] of edgeCounts.entries()) {
        if (count >= threshold) repeatedHeaderFooterSet.add(lineText);
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
          if (PAGE_NUMBER_LINE_REGEX_CLIENT.test(trimmed)) {
            removedArtifacts++;
            continue;
          }
          if ((i === firstIdx || i === lastIdx) && repeatedHeaderFooterSet.has(trimmed)) {
            removedArtifacts++;
            continue;
          }
        }

        const normalizedTrimmed = normalizePdfLineSpacingClient(trimmed);
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
        stats: { rawLines: rawLineCount, reflowedParagraphs: paragraphs.length, removedArtifacts }
      };
    }

    const lengths = cleanedLines
      .filter((l) => !l.isBlank && l.trimmed.length > 5)
      .map((l) => getVisualWidthClient(l.trimmed))
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
      const lineWidth = getVisualWidthClient(line);
      const isHeading = PDF_CHAPTER_HEADING_REGEX_CLIENT.test(line) && line.length <= 50;

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

      const prevEndsWithTerminal = TERMINAL_PUNCT_REGEX_CLIENT.test(currentPara);
      const prevWasShortLine = prevLineWidth < typicalFullWidth * 0.78;
      const nextStartsNewBlock =
        isHeading || item.isIndented || LIST_OR_DIALOGUE_START_REGEX_CLIENT.test(line);

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
        currentPara = joinReflowedLinesClient(currentPara, line);
        prevLineWidth = lineWidth;
      }
    }

    if (currentPara) {
      paragraphs.push(currentPara);
    }

    return {
      paragraphs,
      text: paragraphs.join('\n\n'),
      stats: { rawLines: rawLineCount, reflowedParagraphs: paragraphs.length, removedArtifacts }
    };
  }

  async function inflateStreamClient(uint8Slice) {
    if (typeof DecompressionStream === 'undefined') {
      return new TextDecoder('latin1').decode(uint8Slice);
    }
    for (const format of ['deflate', 'deflate-raw']) {
      try {
        const ds = new DecompressionStream(format);
        const writer = ds.writable.getWriter();
        writer.write(uint8Slice);
        writer.close();
        const outBuf = await new Response(ds.readable).arrayBuffer();
        return new TextDecoder('latin1').decode(outBuf);
      } catch (_) {}
    }
    return new TextDecoder('latin1').decode(uint8Slice);
  }

  function decodeHexUtf16BeClient(hex) {
    if (!hex) return '';
    const clean = hex.replace(/\s+/g, '');
    if (clean.length === 2) return String.fromCharCode(parseInt(clean, 16));
    const padded = clean.length % 2 === 0 ? clean : '0' + clean;
    let out = '';
    for (let i = 0; i + 3 < padded.length; i += 4) {
      const code = parseInt(padded.slice(i, i + 4), 16);
      if (code === 0xfeff) continue;
      out += String.fromCharCode(code);
    }
    return out;
  }

  function parseToUnicodeCMapClient(cmapStr) {
    const map = new Map();
    let keyByteLen = 2;
    const bfcharRegex = /beginbfchar([\s\S]*?)endbfchar/g;
    let m;
    while ((m = bfcharRegex.exec(cmapStr)) !== null) {
      const pairRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let p;
      while ((p = pairRegex.exec(m[1])) !== null) {
        if (p[1].length === 2) keyByteLen = 1;
        const code = parseInt(p[1], 16);
        const u = decodeHexUtf16BeClient(p[2]);
        if (!Number.isNaN(code) && u) map.set(code, u);
      }
    }
    const bfrangeRegex = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = bfrangeRegex.exec(cmapStr)) !== null) {
      const rangeDirectRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let r;
      while ((r = rangeDirectRegex.exec(m[1])) !== null) {
        const s = parseInt(r[1], 16);
        const e = parseInt(r[2], 16);
        const base = parseInt(r[3], 16);
        if (r[1].length === 2) keyByteLen = 1;
        if (!Number.isNaN(s) && !Number.isNaN(e) && !Number.isNaN(base)) {
          const lim = Math.min(e, s + 4096);
          for (let c = s; c <= lim; c++) map.set(c, String.fromCodePoint(base + (c - s)));
        }
      }
    }
    return { map, keyByteLen };
  }

  function decodeHexWithCMapClient(hexStr, cmapObj) {
    const clean = hexStr.replace(/\s+/g, '');
    if (!clean) return '';
    if (clean.toUpperCase().startsWith('FEFF')) return decodeHexUtf16BeClient(clean.slice(4));
    if (cmapObj && cmapObj.map && cmapObj.map.size > 0) {
      const step = cmapObj.keyByteLen === 1 ? 2 : 4;
      let out = '';
      for (let i = 0; i < clean.length; i += step) {
        const slice = clean.slice(i, i + step);
        const code = parseInt(slice, 16);
        if (cmapObj.map.has(code)) out += cmapObj.map.get(code);
        else if (code >= 0x20) out += String.fromCharCode(code);
      }
      return out;
    }
    if (clean.length % 4 === 0) return decodeHexUtf16BeClient(clean);
    return clean;
  }

  async function parsePdfClient(arrayBuffer, filename) {
    const rawTitle = filename.replace(/\.pdf$/i, '');
    const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
    const blobUrl = URL.createObjectURL(blob);

    try {
      const rawLatin1 = new TextDecoder('latin1').decode(arrayBuffer);
      const uint8 = new Uint8Array(arrayBuffer);
      const pageMatches = rawLatin1.match(/\/Type\s*\/Page\b(?!s)/g);
      const numpages = pageMatches ? pageMatches.length : 1;

      const globalCMap = new Map();
      let globalKeyByteLen = 2;
      const contentStreams = [];

      const streamRegex = /stream(?:\r\n|\n)([\s\S]*?)endstream/g;
      let match;
      while ((match = streamRegex.exec(rawLatin1)) !== null) {
        const startOffset = match.index + match[0].indexOf(match[1]);
        const endOffset = startOffset + match[1].length;
        const contentStr = await inflateStreamClient(uint8.subarray(startOffset, endOffset));
        if (contentStr.includes('beginbfchar') || contentStr.includes('beginbfrange')) {
          const parsed = parseToUnicodeCMapClient(contentStr);
          if (parsed.keyByteLen === 1) globalKeyByteLen = 1;
          for (const [k, v] of parsed.map.entries()) globalCMap.set(k, v);
        } else if (contentStr.includes('BT') && contentStr.includes('ET')) {
          contentStreams.push(contentStr);
        }
      }

      const cmapObj = { map: globalCMap, keyByteLen: globalKeyByteLen };
      const pages = [];

      for (const contentStr of contentStreams) {
        const pageLines = [];
        let currentLine = '';
        let lastTmY = null;
        const btEtRegex = /\bBT\b([\s\S]*?)\bET\b/g;
        let btMatch;
        while ((btMatch = btEtRegex.exec(contentStr)) !== null) {
          const block = btMatch[1];
          const tokenRegex =
            /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Tm\b|\[([\s\S]*?)\]\s*TJ|<([0-9A-Fa-f\s]+)>\s*Tj|\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*(?:Tj|')|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+T[dD]\b|\bT\*/g;
          let tok;
          while ((tok = tokenRegex.exec(block)) !== null) {
            if (tok[6] !== undefined) {
              const tmY = parseFloat(tok[6]);
              if (lastTmY !== null && Math.abs(tmY - lastTmY) > 2 && currentLine.trim()) {
                pageLines.push(currentLine);
                currentLine = '';
              }
              lastTmY = tmY;
            } else if (tok[7] !== undefined) {
              const subRegex = /<([0-9A-Fa-f\s]+)>|\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
              let sub;
              while ((sub = subRegex.exec(tok[7])) !== null) {
                if (sub[1] !== undefined) currentLine += decodeHexWithCMapClient(sub[1], cmapObj);
                else if (sub[2] !== undefined) currentLine += sub[2];
              }
            } else if (tok[8] !== undefined) {
              currentLine += decodeHexWithCMapClient(tok[8], cmapObj);
            } else if (tok[9] !== undefined) {
              currentLine += tok[9];
            } else if (tok[10] !== undefined && tok[11] !== undefined) {
              if (Math.abs(parseFloat(tok[11])) > 0.1 && currentLine.trim()) {
                pageLines.push(currentLine);
                currentLine = '';
              }
            } else if (currentLine.trim()) {
              pageLines.push(currentLine);
              currentLine = '';
            }
          }
          if (currentLine.trim()) {
            pageLines.push(currentLine);
            currentLine = '';
          }
        }
        if (pageLines.length > 0) pages.push(pageLines.join('\n'));
      }

      const rawFullText = pages.join('\n\n').trim();
      if (rawFullText.replace(/\s+/g, '').length > 20) {
        const reflowed = reflowPdfTextClient(pages, {
          stripHeadersFooters: true,
          mergeBrokenLines: true
        });
        const parsedTxt = parseTxtClient(reflowed.text || rawFullText, `${rawTitle}.txt`);
        const chaptersWithRaw = parsedTxt.chapters.map((ch) => ({
          ...ch,
          rawLineContent: rawFullText
        }));
        return {
          ...parsedTxt,
          chapters: chaptersWithRaw,
          format: 'pdf',
          pdfReflowed: true,
          pdfPageCount: Math.max(numpages, pages.length),
          rawPdfUrl: blobUrl
        };
      }
    } catch (_) {}

    return {
      title: rawTitle,
      originalTitle: rawTitle,
      author: 'PDF 文件',
      format: 'pdf',
      rawPdfUrl: blobUrl,
      totalChapters: 1,
      totalWords: 0,
      chapters: [
        {
          index: 0,
          title: '原版 PDF 閱讀器',
          originalTitle: '原版 PDF 閱讀器',
          content: '已載入原版 PDF 檢視器。',
          wordCount: 0
        }
      ]
    };
  }

  // ==========================================================================
  // 4B. Direct Browser WebDAV Client (For Pure Static GitHub Pages Mode)
  // ==========================================================================
  function getDirectWebdavHeaders(extra = {}, customCfg = null) {
    const cfg = customCfg || state.webdavConfig || {};
    const headers = { ...extra };
    if (cfg.webdavUsername || cfg.webdavPassword) {
      const token = btoa(
        unescape(encodeURIComponent(`${cfg.webdavUsername || ''}:${cfg.webdavPassword || ''}`))
      );
      headers['Authorization'] = `Basic ${token}`;
    }
    return headers;
  }

  function buildDirectWebdavUrl(relPath = '/', isDirectory = false, customCfg = null) {
    const cfg = customCfg || state.webdavConfig || {};
    const rawUrl = (cfg.webdavUrl || '').trim();
    const fullInputUrl = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
    const parsed = new URL(fullInputUrl);
    const origin = parsed.origin;
    const urlPath = decodeURIComponent(parsed.pathname || '/').replace(/^\/+|\/+$/g, '');

    const cfgBase = (cfg.webdavBasePath || '/').replace(/^\/+|\/+$/g, '');
    const cleanRel = (relPath || '/').replace(/^\/+|\/+$/g, '');

    // Avoid duplicating path if user put /WebDAV/小說 in both URL and basePath
    let baseSegments = [];
    if (urlPath && cfgBase) {
      if (cfgBase.startsWith(urlPath)) {
        baseSegments = cfgBase.split('/');
      } else if (urlPath.startsWith(cfgBase)) {
        baseSegments = urlPath.split('/');
      } else {
        baseSegments = [...urlPath.split('/'), ...cfgBase.split('/')];
      }
    } else if (urlPath) {
      baseSegments = urlPath.split('/');
    } else if (cfgBase) {
      baseSegments = cfgBase.split('/');
    }

    const relSegments = cleanRel ? cleanRel.split('/') : [];
    const allSegments = [...baseSegments, ...relSegments].filter(Boolean);

    const encodedPath = allSegments
      .map((s) => encodeURIComponent(decodeURIComponent(s)))
      .join('/');

    let finalUrl = encodedPath ? `${origin}/${encodedPath}` : `${origin}/`;
    if (isDirectory && !finalUrl.endsWith('/')) {
      finalUrl += '/';
    }
    return finalUrl;
  }

  async function listDirectWebdavBooks(subPath = '/', currentDepth = 0, maxDepth = 3, customCfg = null) {
    const url = buildDirectWebdavUrl(subPath, true, customCfg);
    const res = await fetch(url, {
      method: 'PROPFIND',
      headers: getDirectWebdavHeaders(
        {
          Depth: '1',
          'Content-Type': 'application/xml; charset=utf-8'
        },
        customCfg
      )
    });
    if (!res.ok && res.status !== 207) {
      throw new Error(`WebDAV HTTP ${res.status}`);
    }
    const xmlText = await res.text();
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const responses = Array.from(doc.querySelectorAll('response, *|response'));
    let books = [];
    const subDirs = [];

    const reqUrlObj = new URL(url);
    const reqPathClean = decodeURIComponent(reqUrlObj.pathname).replace(/\/+$/, '');

    responses.forEach((el, idx) => {
      const hrefEl = el.querySelector('href, *|href');
      if (!hrefEl) return;
      const decodedHref = decodeURIComponent(hrefEl.textContent.trim());
      const hrefPath = decodedHref.replace(/^https?:\/\/[^/]+/i, '').replace(/\/+$/, '');

      const isCollection =
        el.querySelectorAll('collection, *|collection').length > 0 ||
        decodedHref.endsWith('/');

      // Skip the current directory entry itself
      if (hrefPath === reqPathClean || (idx === 0 && isCollection)) {
        return;
      }

      const baseName = hrefPath.split('/').filter(Boolean).pop() || '';
      if (!baseName || baseName.startsWith('.') || baseName === '@eaDir' || baseName === '#recycle') {
        return;
      }

      const relFromRoot = [subPath.replace(/^\/+|\/+$/g, ''), baseName].filter(Boolean).join('/');

      if (isCollection) {
        if (currentDepth < maxDepth) {
          subDirs.push(relFromRoot);
        }
        return;
      }

      if (!/\.(txt|epub|pdf|mobi|azw3|azw)$/i.test(baseName)) return;

      const lowerName = baseName.toLowerCase();
      const ext = lowerName.endsWith('.epub')
        ? 'epub'
        : lowerName.endsWith('.pdf')
        ? 'pdf'
        : lowerName.endsWith('.mobi') || lowerName.endsWith('.azw3') || lowerName.endsWith('.azw')
        ? 'mobi'
        : 'txt';
      const rawTitle = baseName.replace(/\.(txt|epub|pdf|mobi|azw3|azw)$/i, '');
      const sizeEl = el.querySelector('getcontentlength, *|getcontentlength');
      const size = sizeEl ? parseInt(sizeEl.textContent.trim(), 10) || 0 : 0;
      const id = `webdav_direct_${btoa(unescape(encodeURIComponent(relFromRoot)))}`;

      const folderLabel = subPath.replace(/^\/+|\/+$/g, '') || 'WebDAV 書庫';

      books.push({
        id,
        source: 'webdav-direct',
        relativePath: relFromRoot,
        filename: baseName,
        title: convertStr(rawTitle),
        originalTitle: rawTitle,
        folder: convertStr(folderLabel),
        originalFolder: folderLabel,
        format: ext,
        size,
        mtime: new Date().toISOString()
      });
    });

    for (const dir of subDirs) {
      try {
        const childBooks = await listDirectWebdavBooks(dir, currentDepth + 1, maxDepth, customCfg);
        books = books.concat(childBooks);
      } catch (_) {}
    }

    return books;
  }

  // ==========================================================================
  // 5. Cloud Sync Engine (NAS Server /api/sync + Direct WebDAV .novel-reader-sync.json)
  // ==========================================================================
  let syncTimeout = null;

  async function pullCloudSync(silent = false) {
    updateSyncIndicator('同步中...');
    try {
      if (state.serverAvailable) {
        const res = await apiFetch(`/api/sync?syncKey=${encodeURIComponent(state.syncKey)}`);
        if (res.ok && res.data) {
          mergeIncomingSyncData(res.data);
          updateSyncIndicator('☁️ 雲端進度已同步');
          if (!silent) showToast(`已同步「${state.syncKey}」的跨裝置閱讀紀錄`);
          return;
        }
      } else if (state.webdavConfig?.enableWebdav && state.webdavConfig?.webdavUrl) {
        const syncUrl = buildDirectWebdavUrl('.novel-reader-sync.json');
        const res = await fetch(syncUrl, {
          method: 'GET',
          headers: getDirectWebdavHeaders()
        });
        if (res.ok) {
          const store = await res.json();
          const profile = store?.profiles?.[state.syncKey];
          if (profile) {
            mergeIncomingSyncData(profile);
            updateSyncIndicator('☁️ WebDAV 已同步');
            if (!silent) showToast(`已從 WebDAV 同步「${state.syncKey}」的閱讀紀錄`);
            return;
          }
        }
      }
      updateSyncIndicator('☁️ 本機同步已就緒');
    } catch (err) {
      updateSyncIndicator('⚠️ 離線快取模式');
    }
  }

  function mergeIncomingSyncData(remote) {
    if (!remote) return;
    if (remote.progress && typeof remote.progress === 'object') {
      for (const [bookId, rProg] of Object.entries(remote.progress)) {
        const localProg = state.progress[bookId];
        if (
          !localProg ||
          !localProg.updatedAt ||
          new Date(rProg.updatedAt || 0) >= new Date(localProg.updatedAt)
        ) {
          state.progress[bookId] = rProg;
        }
      }
    }
    if (remote.bookmarks && typeof remote.bookmarks === 'object') {
      for (const [bookId, rList] of Object.entries(remote.bookmarks)) {
        if (Array.isArray(rList) && rList.length > 0) {
          state.bookmarks[bookId] = rList;
        }
      }
    }
    if (remote.annotations && typeof remote.annotations === 'object') {
      for (const [bookId, rAnnot] of Object.entries(remote.annotations)) {
        if (rAnnot && typeof rAnnot === 'object') {
          state.annotations[bookId] = rAnnot;
        }
      }
    }
    if (remote.settings && typeof remote.settings === 'object') {
      state.settings = { ...state.settings, ...remote.settings };
      applyReaderSettingsToDOM();
    }
    saveLocalCache();
    renderLibrary();
  }

  async function pushCloudSync(singleBookProgress = null) {
    saveLocalCache();
    updateSyncIndicator('☁️ 正在儲存進度...');
    try {
      if (state.serverAvailable) {
        const payload = {
          syncKey: state.syncKey,
          singleProgress: singleBookProgress,
          progress: state.progress,
          bookmarks: state.bookmarks,
          annotations: state.annotations,
          settings: state.settings
        };
        await apiFetch('/api/sync', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        updateSyncIndicator('☁️ 進度已同步');
      } else if (state.webdavConfig?.enableWebdav && state.webdavConfig?.webdavUrl) {
        const syncUrl = buildDirectWebdavUrl('.novel-reader-sync.json');
        const store = {
          profiles: {
            [state.syncKey]: {
              syncKey: state.syncKey,
              updatedAt: new Date().toISOString(),
              progress: state.progress,
              bookmarks: state.bookmarks,
              annotations: state.annotations,
              settings: state.settings
            }
          }
        };
        await fetch(syncUrl, {
          method: 'PUT',
          headers: getDirectWebdavHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
          body: JSON.stringify(store, null, 2)
        });
        updateSyncIndicator('☁️ 已同步至 WebDAV');
      } else {
        updateSyncIndicator('💾 已儲存至本機');
      }
    } catch (_) {
      updateSyncIndicator('⚠️ 暫存於本機');
    }
  }

  function scheduleProgressSync() {
    if (!state.currentBook || !state.currentChapter) return;

    const scrollPercent = calculateCurrentScrollPercent();
    const bookId = state.currentBook.id;

    const existingMeta = state.books.find((b) => b.id === bookId) || {};
    const record = {
      bookId,
      title: state.currentBook.originalTitle || state.currentBook.title,
      folder: existingMeta.originalFolder || existingMeta.folder || '書庫',
      format: state.currentBook.format || existingMeta.format || 'txt',
      chapterIndex: state.currentChapter.index,
      chapterTitle: state.currentChapter.originalTitle || state.currentChapter.title,
      totalChapters: state.currentBook.totalChapters || 1,
      scrollPercent,
      updatedAt: new Date().toISOString()
    };

    state.progress[bookId] = record;
    saveLocalCache();

    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      pushCloudSync(record);
    }, 900);
  }

  function updateSyncIndicator(text) {
    const libBadge = document.getElementById('last-sync-badge');
    const readerBadge = document.getElementById('reader-sync-indicator');
    const syncKeyEl = document.getElementById('sync-key-badge');
    if (libBadge) libBadge.textContent = text;
    if (readerBadge) readerBadge.textContent = text;
    if (syncKeyEl) syncKeyEl.textContent = state.syncKey;
  }

  // ==========================================================================
  // 6. Initialize & Load Library Books
  // ==========================================================================
  async function loadLibrary(page = state.currentPage) {
    state.currentPage = page;
    const connDot = document.getElementById('conn-dot');
    const connText = document.getElementById('conn-status-text');

    try {
      // 1. Try connecting to NAS Backend API (/api/health & /api/books with pagination)
      const health = await apiFetch('/api/health');
      if (health && health.ok) {
        state.serverAvailable = true;
        state.connectionMode = 'nas-server';

        // Also load server-side saved WebDAV config if present
        try {
          const cfgRes = await apiFetch('/api/config');
          if (cfgRes && cfgRes.ok && cfgRes.config) {
            state.webdavConfig = {
              ...state.webdavConfig,
              enableWebdav: cfgRes.config.enableWebdav,
              webdavUrl: cfgRes.config.webdavUrl || state.webdavConfig.webdavUrl,
              webdavUsername: cfgRes.config.webdavUsername || state.webdavConfig.webdavUsername,
              webdavBasePath: cfgRes.config.webdavBasePath || state.webdavConfig.webdavBasePath
            };
          }
        } catch (_) {}

        const queryParams = new URLSearchParams({
          convert: state.settings.convertMode,
          page: String(state.currentPage),
          limit: String(state.pageSize),
          folder: state.selectedFolder,
          format: state.selectedFormat,
          sort: state.sortBy,
          q: state.searchQuery
        });

        const booksRes = await apiFetch(`/api/books?${queryParams.toString()}`);

        state.books = booksRes.books || [];
        state.totalBooksCount = booksRes.total || 0;
        state.totalPages = booksRes.totalPages || 1;
        state.folderCountsMap = booksRes.folders || {};

        connDot.classList.remove('offline');
        const countDisplay = (booksRes.totalAll || booksRes.total || 0).toLocaleString();
        connText.textContent = `NAS 伺服器已連線 (${countDisplay} 本小說)`;

        await pullCloudSync(true);
        renderLibrary();
        return;
      }
    } catch (_) {
      state.serverAvailable = false;
    }

    // 2. Direct Browser WebDAV Mode (when hosted on GitHub Pages without backend)
    if (state.webdavConfig?.enableWebdav && state.webdavConfig?.webdavUrl) {
      try {
        const directBooks = await listDirectWebdavBooks();
        state.connectionMode = 'webdav-direct';
        state.books = directBooks;
        connDot.classList.remove('offline');
        connText.textContent = `WebDAV 直接連線 (${state.books.length} 本小說)`;
        await pullCloudSync(true);
        renderLibrary();
        return;
      } catch (err) {
        showToast(`WebDAV 直接連線失敗 (${err.message})，切換至展示書庫`);
      }
    }

    // 3. Fallback: Static GitHub Pages Demo Mode (loads ./demo-books.json)
    try {
      const res = await fetch('./demo-books.json');
      if (res.ok) {
        const demoBooks = await res.json();
        state.connectionMode = 'static-demo';
        state.books = demoBooks.map((b) => {
          state.inMemoryBooks.set(b.id, b);
          return {
            id: b.id,
            source: 'demo',
            relativePath: b.relativePath,
            filename: b.filename,
            title: convertStr(b.originalTitle || b.title),
            originalTitle: b.originalTitle || b.title,
            folder: convertStr(b.originalFolder || b.folder),
            originalFolder: b.originalFolder || b.folder,
            format: b.format,
            size: b.size,
            mtime: b.mtime
          };
        });
        connDot.classList.remove('offline');
        connText.textContent = `雲端書庫展示模式 (${state.books.length} 本小說 · 可於設定連回私人 NAS)`;
        renderLibrary();
        return;
      }
    } catch (err) {
      connDot.classList.add('offline');
      connText.textContent = '尚未連線至 NAS 書庫，請點擊右上角「NAS 連線設定」';
    }
  }

  // ==========================================================================
  // 7. Render Bookshelf, Subfolder Categories & Continue Reading Shelf
  // ==========================================================================
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 KB';
    const k = 1024;
    if (bytes < k * 1024) return `${Math.max(1, Math.round(bytes / k))} KB`;
    return `${(bytes / (k * 1024)).toFixed(1)} MB`;
  }

  function formatRelativeTime(isoStr) {
    if (!isoStr) return '';
    const diffSec = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
    if (diffSec < 60) return '剛剛';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分鐘前`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小時前`;
    return `${Math.floor(diffSec / 86400)} 天前`;
  }

  function getCoverToneClass(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return `cover-tone-${Math.abs(hash) % 6}`;
  }

  function renderLibrary() {
    renderContinueReading();
    renderFolderTabs();
    renderBooksGrid();
    renderPaginationBar();
    updateGlobalConvertButtonUI();
  }

  function renderContinueReading() {
    const section = document.getElementById('continue-reading-section');
    const grid = document.getElementById('continue-reading-grid');

    const progressEntries = Object.values(state.progress || {})
      .filter((p) => p && p.bookId)
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
      .slice(0, 3);

    if (progressEntries.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    grid.innerHTML = '';

    progressEntries.forEach((prog) => {
      const displayTitle = convertStr(prog.title || '未命名小說');
      const displayChapter = convertStr(prog.chapterTitle || `第 ${(prog.chapterIndex || 0) + 1} 章`);
      const totalCh = prog.totalChapters || 1;
      const overallPct = Math.min(
        100,
        Math.max(
          1,
          Math.round((((prog.chapterIndex || 0) + (prog.scrollPercent || 0) / 100) / totalCh) * 100)
        )
      );

      const card = document.createElement('div');
      card.className = 'continue-card';
      card.innerHTML = `
        <div class="mini-book-spine ${getCoverToneClass(prog.bookId)}">
          <span>${escapeHtml(displayTitle.slice(0, 2))}</span>
        </div>
        <div class="continue-info">
          <div class="continue-book-title">${escapeHtml(displayTitle)}</div>
          <div class="continue-chapter">${escapeHtml(displayChapter)} · ${formatRelativeTime(prog.updatedAt)}</div>
          <div class="progress-row">
            <div class="progress-track">
              <div class="progress-fill" style="width: ${overallPct}%"></div>
            </div>
            <span class="progress-pct">${overallPct}%</span>
          </div>
        </div>
      `;
      card.addEventListener('click', () => {
        openBookReader(prog.bookId, prog.chapterIndex || 0, prog.scrollPercent || 0);
      });
      grid.appendChild(card);
    });
  }

  function renderFolderTabs() {
    const container = document.getElementById('folder-tabs');
    container.innerHTML = '';

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = `folder-tab ${state.selectedFolder === 'ALL' ? 'active' : ''}`;
    allBtn.textContent = `全部書庫 (${state.totalBooksCount || state.books.length})`;
    allBtn.addEventListener('click', () => {
      state.selectedFolder = 'ALL';
      state.currentPage = 1;
      loadLibrary(1);
    });
    container.appendChild(allBtn);

    // If server returned folderCountsMap, render top folders
    const entries = Object.entries(state.folderCountsMap || {});
    // Sort folders by book count descending, limit top 12 to avoid clutter
    entries.sort((a, b) => b[1] - a[1]);
    const topFolders = entries.slice(0, 15);

    topFolders.forEach(([folder, count]) => {
      const displayFolder = convertStr(folder);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `folder-tab ${state.selectedFolder === folder ? 'active' : ''}`;
      btn.textContent = `📁 ${displayFolder} (${count})`;
      btn.addEventListener('click', () => {
        state.selectedFolder = folder;
        state.currentPage = 1;
        loadLibrary(1);
      });
      container.appendChild(btn);
    });
  }

  function renderPaginationBar() {
    const bar = document.getElementById('pagination-bar');
    const prevBtn = document.getElementById('prev-page-btn');
    const nextBtn = document.getElementById('next-page-btn');
    const indicator = document.getElementById('page-indicator');
    if (!bar) return;

    if (state.totalPages <= 1) {
      bar.style.display = 'none';
      return;
    }

    bar.style.display = 'flex';
    prevBtn.disabled = state.currentPage <= 1;
    nextBtn.disabled = state.currentPage >= state.totalPages;
    indicator.textContent = `第 ${state.currentPage} / ${state.totalPages} 頁 (共 ${state.totalBooksCount.toLocaleString()} 本)`;
  }

  function renderBooksGrid() {
    const grid = document.getElementById('books-grid');
    grid.innerHTML = '';

    let displayBooks = state.books || [];

    // When running in client-only mode (Direct WebDAV or Static Demo), apply boolean search & folder/format filter client-side
    if (!state.serverAvailable && displayBooks.length > 0) {
      if (state.selectedFolder && state.selectedFolder !== 'ALL') {
        displayBooks = displayBooks.filter(
          (b) => (b.originalFolder || b.folder) === state.selectedFolder
        );
      }
      if (state.selectedFormat && state.selectedFormat !== 'ALL') {
        displayBooks = displayBooks.filter((b) => b.format === state.selectedFormat);
      }
      if (state.searchQuery && state.searchQuery.trim()) {
        const matchQuery = compileBooleanQueryClient(state.searchQuery);
        displayBooks = displayBooks.filter((b) => {
          const target = `${b.originalTitle || ''} ${b.title || ''} ${b.originalFolder || ''} ${
            b.folder || ''
          } ${b.filename || ''}`.toLowerCase();
          return matchQuery(target);
        });
      }
    }

    if (!displayBooks || displayBooks.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <h3>找不到符合條件的小說檔案</h3>
          <p>支援邏輯搜尋：<b>空白</b> 或 <b>&amp;</b> 代表「且 (AND)」、<b>|</b> 代表「或 (OR)」、<b>-關鍵字</b> 代表「排除 (NOT)」、<b>()</b> 代表括號分組。<br/>範例：<code>火影|海賊 系統 -後宮</code></p>
        </div>
      `;
      return;
    }

    displayBooks.forEach((book) => {
      const prog = state.progress[book.id];
      const toneClass = getCoverToneClass(book.id);

      let statusHtml = '尚未開始閱讀';
      let actionLabel = '開始閱讀 →';

      if (prog) {
        const chName = convertStr(prog.chapterTitle || `第 ${(prog.chapterIndex || 0) + 1} 章`);
        statusHtml = `讀至：${escapeHtml(chName)}`;
        actionLabel = '繼續閱讀 →';
      }

      const card = document.createElement('article');
      card.className = 'book-card';
      card.innerHTML = `
        <div class="book-card-top">
          <div class="book-cover ${toneClass}">
            <div class="book-cover-title">${escapeHtml(book.title)}</div>
            <span class="book-format-badge">${escapeHtml(book.format)}</span>
          </div>
          <div class="book-meta">
            <span class="book-folder-tag">📁 ${escapeHtml(book.folder)}</span>
            <h3 class="book-title">${escapeHtml(book.title)}</h3>
            <div class="book-details-line">
              ${formatBytes(book.size)} · ${book.source.includes('webdav') ? 'WebDAV 遠端' : 'NAS 書庫'}
            </div>
          </div>
        </div>
        <div class="book-card-footer">
          <span class="book-status-text">${statusHtml}</span>
          <span class="book-read-action">${actionLabel}</span>
        </div>
      `;

      card.addEventListener('click', () => {
        const startChapter = prog ? prog.chapterIndex || 0 : 0;
        const startScroll = prog ? prog.scrollPercent || 0 : 0;
        openBookReader(book.id, startChapter, startScroll);
      });

      grid.appendChild(card);
    });
  }

  // ==========================================================================
  // 8. Immersive Reader Engine (Streaming Chapters & Instant S2T Conversion)
  // ==========================================================================
  async function openBookReader(bookId, chapterIndex = 0, targetScrollPercent = 0) {
    document.getElementById('library-view').style.display = 'none';
    const readerView = document.getElementById('reader-view');
    readerView.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'instant' });

    document.getElementById('reader-book-title').textContent = '正在串流載入書籍目錄...';
    document.getElementById('chapter-main-title').textContent = '載入中...';
    document.getElementById('chapter-body').innerHTML = '<p>正在從 NAS 線上讀取章節內容（免下載整本檔案）...</p>';

    try {
      // Load Book TOC first
      if (state.serverAvailable && !state.inMemoryBooks.has(bookId)) {
        const tocRes = await apiFetch(
          `/api/books/${encodeURIComponent(bookId)}/toc?convert=${encodeURIComponent(state.settings.convertMode)}`
        );
        state.currentBook = tocRes.book;
      } else if (!state.inMemoryBooks.has(bookId) && bookId.startsWith('webdav_direct_')) {
        const bookMeta = state.books.find((b) => b.id === bookId);
        if (!bookMeta) throw new Error('找不到 WebDAV 書籍項目');
        const fileUrl = buildDirectWebdavUrl(bookMeta.relativePath);
        const res = await fetch(fileUrl, {
          method: 'GET',
          headers: getDirectWebdavHeaders()
        });
        if (!res.ok) throw new Error(`WebDAV 讀取失敗 (${res.status})`);
        const arrayBuf = await res.arrayBuffer();
        let parsed;
        if (bookMeta.format === 'epub') {
          parsed = await parseEpubClient(arrayBuf, bookMeta.filename);
        } else if (bookMeta.format === 'mobi') {
          parsed = parseMobiClient(arrayBuf, bookMeta.filename);
        } else if (bookMeta.format === 'pdf') {
          parsed = await parsePdfClient(arrayBuf, bookMeta.filename);
        } else {
          parsed = parseTxtClient(decodeArrayBufferClient(arrayBuf), bookMeta.filename);
        }
        const memObj = {
          ...bookMeta,
          ...parsed,
          id: bookId
        };
        state.inMemoryBooks.set(bookId, memObj);
        state.currentBook = memObj;
      } else if (state.inMemoryBooks.has(bookId)) {
        const memBook = state.inMemoryBooks.get(bookId);
        state.currentBook = {
          ...memBook,
          title: convertStr(memBook.originalTitle || memBook.title),
          author: convertStr(memBook.author || '佚名'),
          chapters: memBook.chapters.map((c) => ({
            index: c.index,
            title: convertStr(c.originalTitle || c.title),
            originalTitle: c.originalTitle || c.title,
            wordCount: c.wordCount
          }))
        };
      } else {
        throw new Error('找不到該書籍資料');
      }

      // Default to 'reflow' (PDF 智慧重排) if the PDF has extractable text, or 'native' if image-only
      if (state.currentBook.format === 'pdf') {
        if ((state.currentBook.totalWords || 0) === 0) {
          state.pdfViewMode = 'native';
        } else {
          const savedPref = state.settings.pdfReflowMode || 'reflow';
          state.pdfViewMode = ['reflow', 'raw', 'native'].includes(savedPref) ? savedPref : 'reflow';
        }
      } else {
        state.pdfViewMode = state.settings.pdfReflowMode === 'raw' ? 'raw' : 'reflow';
      }
      updatePdfModeButtonUI();

      document.getElementById('reader-book-title').textContent = convertStr(
        state.currentBook.originalTitle || state.currentBook.title
      );

      await loadAndRenderChapter(chapterIndex, targetScrollPercent);
      renderDrawerToc();
      renderDrawerBookmarks();
    } catch (err) {
      showToast(`讀取失敗：${err.message}`);
      closeReaderView();
    }
  }

  function updatePdfModeButtonUI() {
    const btn = document.getElementById('reader-pdf-mode-btn');
    const txt = document.getElementById('reader-pdf-mode-text');
    const isPdf = Boolean(state.currentBook && state.currentBook.format === 'pdf');
    const mode = state.pdfViewMode || 'reflow';

    if (btn && txt) {
      if (isPdf) {
        btn.style.display = 'inline-flex';
        btn.classList.toggle('btn-pill-active', mode === 'reflow' || mode === 'native');
        txt.textContent =
          mode === 'reflow'
            ? '📐 PDF 重排'
            : mode === 'raw'
            ? '📝 PDF 原行'
            : '📄 原版 PDF';
      } else {
        btn.style.display = 'none';
      }
    }

    const reflowLabel = document.getElementById('pdf-reflow-label');
    if (reflowLabel) {
      reflowLabel.textContent =
        mode === 'reflow'
          ? '📐 智慧重排 (自動合併斷行)'
          : mode === 'raw'
          ? '📝 原始斷行'
          : '📄 原版 PDF 檢視';
    }

    const nativeOptBtn = document.getElementById('pdf-native-opt-btn');
    if (nativeOptBtn) {
      nativeOptBtn.style.display = isPdf ? '' : 'none';
    }

    document.querySelectorAll('[data-pdf-reflow-opt]').forEach((b) => {
      b.classList.toggle('active', b.dataset.pdfReflowOpt === mode);
    });
  }

  async function setPdfViewMode(newMode) {
    const isPdf = Boolean(state.currentBook && state.currentBook.format === 'pdf');
    if (newMode === 'native' && !isPdf) {
      newMode = 'reflow';
    }
    state.pdfViewMode = newMode;
    state.settings.pdfReflowMode = newMode;
    updatePdfModeButtonUI();
    pushCloudSync();

    if (document.getElementById('reader-view').classList.contains('active') && state.currentChapter) {
      const currentScroll = calculateCurrentScrollPercent();
      await loadAndRenderChapter(state.currentChapter.index, currentScroll);
    }

    const toastMap = {
      reflow: '📐 已切換至「PDF 智慧重排」：自動合併跨行斷句、過濾頁碼與頁眉，支援直橫排與字級縮放',
      raw: '📝 已切換至「原始斷行」：保留每行原始換行與頁碼標記',
      native: '📄 已切換至「原版 PDF 檢視模式」'
    };
    showToast(toastMap[newMode] || toastMap.reflow);
  }

  async function cyclePdfViewMode() {
    const isPdf = Boolean(state.currentBook && state.currentBook.format === 'pdf');
    const order = isPdf ? ['reflow', 'raw', 'native'] : ['reflow', 'raw'];
    const currentIdx = order.indexOf(state.pdfViewMode || 'reflow');
    const nextMode = order[(currentIdx + 1) % order.length];
    await setPdfViewMode(nextMode);
  }

  async function loadAndRenderChapter(chapterIndex, targetScrollPercent = 0) {
    if (!state.currentBook) return;
    const bookId = state.currentBook.id;
    const clampedIndex = Math.max(
      0,
      Math.min(chapterIndex, (state.currentBook.totalChapters || 1) - 1)
    );

    document.getElementById('reader-chapter-subtitle').textContent = '章節串流讀取中...';

    let chapterData = null;

    if (state.serverAvailable && !state.inMemoryBooks.has(bookId)) {
      const res = await apiFetch(
        `/api/books/${encodeURIComponent(bookId)}/chapter/${clampedIndex}?convert=${encodeURIComponent(
          state.settings.convertMode
        )}`
      );
      chapterData = res.chapter;
    } else if (state.inMemoryBooks.has(bookId)) {
      const memBook = state.inMemoryBooks.get(bookId);
      const rawCh = memBook.chapters[clampedIndex];
      chapterData = {
        index: rawCh.index,
        title: convertStr(rawCh.originalTitle || rawCh.title),
        originalTitle: rawCh.originalTitle || rawCh.title,
        wordCount: rawCh.wordCount,
        content: convertStr(rawCh.content),
        rawLineContent: rawCh.rawLineContent ? convertStr(rawCh.rawLineContent) : null,
        blocks: rawCh.blocks
          ? rawCh.blocks.map((b) =>
              b.type === 'image' ? b : { ...b, text: convertStr(b.text) }
            )
          : null,
        prevIndex: clampedIndex > 0 ? clampedIndex - 1 : null,
        nextIndex: clampedIndex < memBook.chapters.length - 1 ? clampedIndex + 1 : null
      };
    }

    state.currentChapter = chapterData;

    // Render Chapter UI
    const displayBookTitle = convertStr(state.currentBook.originalTitle || state.currentBook.title);
    const displayChTitle = convertStr(chapterData.originalTitle || chapterData.title);

    document.getElementById('reader-book-title').textContent = displayBookTitle;
    document.getElementById('reader-chapter-subtitle').textContent = displayChTitle;
    document.getElementById('chapter-index-badge').textContent = `第 ${chapterData.index + 1} / ${state.currentBook.totalChapters} 章`;
    document.getElementById('chapter-wordcount-badge').textContent = `${chapterData.wordCount.toLocaleString()} 字`;
    document.getElementById('chapter-main-title').textContent = displayChTitle;

    const bodyEl = document.getElementById('chapter-body');
    bodyEl.innerHTML = '';

    const isPdf = state.currentBook.format === 'pdf';
    const pdfMode = state.pdfViewMode || 'reflow';

    // Render interactive PDF Reflow / Raw / Native switcher bar at top of PDF chapters
    if (isPdf) {
      const pdfSrc =
        state.currentBook.rawPdfUrl && state.currentBook.rawPdfUrl.startsWith('/api/')
          ? `${getApiBase()}${state.currentBook.rawPdfUrl}`
          : state.currentBook.rawPdfUrl || '';

      const pdfBar = document.createElement('div');
      pdfBar.className = 'pdf-reflow-banner';
      pdfBar.style.cssText =
        'display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 0.5rem; margin: 0 0 1.25rem; padding: 0.55rem 0.85rem; border-radius: 10px; background: var(--bg-elevated); border: 1px solid var(--border-subtle); font-size: 0.8rem;';

      const modeDesc =
        pdfMode === 'reflow'
          ? '📐 <strong>PDF 智慧重排模式</strong>（自動合併斷行、過濾頁碼，支援直橫排與字級縮放）'
          : pdfMode === 'raw'
          ? '📝 <strong>PDF 原始斷行模式</strong>（保留原始每行換行與頁碼標記）'
          : `📄 <strong>原版 PDF 檢視模式</strong>${
              state.currentBook.pdfPageCount ? `（共 ${state.currentBook.pdfPageCount} 頁）` : ''
            }`;

      pdfBar.innerHTML = `
        <div style="color: var(--text-secondary);">${modeDesc}</div>
        <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem;">
          <button type="button" class="btn ${pdfMode === 'reflow' ? 'btn-pill-active' : ''}" data-pdf-switch="reflow" style="padding: 0.22rem 0.6rem; font-size: 0.76rem;">📐 智慧重排</button>
          <button type="button" class="btn ${pdfMode === 'raw' ? 'btn-pill-active' : ''}" data-pdf-switch="raw" style="padding: 0.22rem 0.6rem; font-size: 0.76rem;">📝 原始斷行</button>
          ${
            pdfSrc
              ? `<button type="button" class="btn ${pdfMode === 'native' ? 'btn-pill-active' : ''}" data-pdf-switch="native" style="padding: 0.22rem 0.6rem; font-size: 0.76rem;">📄 原版 PDF</button>
                 <a href="${escapeHtml(pdfSrc)}" target="_blank" rel="noopener" style="margin-left: 0.25rem; color: var(--accent); font-weight: 600; text-decoration: none; font-size: 0.76rem;">↗ 新分頁開啟</a>`
              : ''
          }
        </div>
      `;

      pdfBar.querySelectorAll('[data-pdf-switch]').forEach((switchBtn) => {
        switchBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          setPdfViewMode(switchBtn.dataset.pdfSwitch);
        });
      });

      bodyEl.appendChild(pdfBar);
    }

    // 1. Native PDF Viewer Mode
    if (isPdf && state.currentBook.rawPdfUrl && pdfMode === 'native') {
      const pdfSrc = state.currentBook.rawPdfUrl.startsWith('/api/')
        ? `${getApiBase()}${state.currentBook.rawPdfUrl}`
        : state.currentBook.rawPdfUrl;

      const pdfWrapper = document.createElement('div');
      pdfWrapper.style.cssText =
        'margin: 0.25rem 0 1.5rem; border-radius: 12px; overflow: hidden; border: 1px solid var(--border-subtle); background: #2a2a2a;';
      pdfWrapper.innerHTML = `
        <iframe
          src="${escapeHtml(pdfSrc)}"
          style="width: 100%; height: 80vh; border: none; display: block;"
          title="${escapeHtml(displayBookTitle)}"
        ></iframe>
      `;
      bodyEl.appendChild(pdfWrapper);
    } else if (chapterData.blocks && Array.isArray(chapterData.blocks) && chapterData.blocks.length > 0) {
      // 2. Rich EPUB blocks
      chapterData.blocks.forEach((block) => {
        if (block.type === 'image' && block.src) {
          const fig = document.createElement('div');
          fig.className = 'epub-illustration';
          const img = document.createElement('img');
          img.src = block.src.startsWith('/api/') ? `${getApiBase()}${block.src}` : block.src;
          img.alt = block.alt || '';
          img.loading = 'lazy';
          fig.appendChild(img);
          bodyEl.appendChild(fig);
        } else if (block.text) {
          if (block.type === 'heading' && block.text.trim() === displayChTitle.trim()) {
            return;
          }
          const el = document.createElement(block.type === 'heading' ? 'h3' : 'p');
          el.textContent = block.text;
          bodyEl.appendChild(el);
        }
      });
    } else if (isPdf && (state.currentBook.totalWords || 0) === 0 && (chapterData.wordCount || 0) === 0) {
      // Scanned / Image-only PDF notice when user manually clicked Reflow/Raw
      const notice = document.createElement('div');
      notice.style.cssText =
        'padding: 1.5rem; border-radius: 10px; background: var(--bg-subtle); border: 1px dashed var(--border-subtle); text-align: center; color: var(--text-secondary);';
      notice.innerHTML = `
        <p style="margin-bottom: 0.75rem; text-indent: 0;">此 PDF 為純掃描圖片檔（未內嵌文字圖層），無法直接重排文字。</p>
        <button type="button" class="btn btn-primary" id="fallback-native-pdf-btn">📄 切換回原版 PDF 檢視器</button>
      `;
      bodyEl.appendChild(notice);
      const fbBtn = notice.querySelector('#fallback-native-pdf-btn');
      if (fbBtn) {
        fbBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          setPdfViewMode('native');
        });
      }
    } else if (pdfMode === 'raw') {
      // 3. Raw Line-Break Mode (preserves original PDF/TXT line breaks without merging)
      const sourceText = chapterData.rawLineContent || chapterData.content || '';
      const rawLines = sourceText.split(/\n+/);
      rawLines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const p = document.createElement('p');
        p.textContent = trimmed;
        bodyEl.appendChild(p);
      });
    } else {
      // 4. Smart Reflow Mode (merges broken lines into natural paragraphs, detects sub-headings)
      const rawText = chapterData.content || '';
      const reflowedResult = reflowPdfTextClient(rawText, {
        stripHeadersFooters: isPdf,
        mergeBrokenLines: true
      });
      const paragraphs =
        reflowedResult.paragraphs.length > 0
          ? reflowedResult.paragraphs
          : rawText.split(/\n+/).map((s) => s.trim()).filter(Boolean);

      paragraphs.forEach((para) => {
        const trimmed = para.trim();
        if (!trimmed) return;
        if (
          PDF_CHAPTER_HEADING_REGEX_CLIENT.test(trimmed) &&
          trimmed.length <= 50 &&
          trimmed !== displayChTitle.trim()
        ) {
          const h3 = document.createElement('h3');
          h3.textContent = trimmed;
          bodyEl.appendChild(h3);
        } else {
          const p = document.createElement('p');
          p.textContent = trimmed;
          bodyEl.appendChild(p);
        }
      });
    }

    // Apply saved text highlights & render handwriting SVG strokes for this chapter
    applyChapterHighlightsToDOM();
    renderChapterHandwritingSVG();

    // Update Prev / Next buttons
    const prevBtn = document.getElementById('prev-chapter-btn');
    const nextBtn = document.getElementById('next-chapter-btn');
    prevBtn.disabled = chapterData.prevIndex === null;
    nextBtn.disabled = chapterData.nextIndex === null;

    // Highlight active chapter in TOC drawer
    highlightActiveTocItem();

    // Restore target scroll position
    state.isRestoringScroll = true;
    requestAnimationFrame(() => {
      if (isVerticalMode()) {
        window.scrollTo({ top: 0, behavior: 'instant' });
        const { maxScroll } = getVerticalScrollInfo();
        const targetPx =
          targetScrollPercent > 0 ? Math.round((targetScrollPercent / 100) * maxScroll) : 0;
        scrollVerticalTo(targetPx, 'instant');
      } else {
        if (targetScrollPercent > 0) {
          const maxScroll = Math.max(
            0,
            document.documentElement.scrollHeight - window.innerHeight
          );
          window.scrollTo({
            top: Math.round((targetScrollPercent / 100) * maxScroll),
            behavior: 'instant'
          });
        } else {
          window.scrollTo({ top: 0, behavior: 'instant' });
        }
      }
      renderChapterHandwritingSVG();
      updateScrollRibbon();
      setTimeout(() => {
        state.isRestoringScroll = false;
        scheduleProgressSync();
      }, 150);
    });
  }

  function closeReaderView() {
    scheduleProgressSync();
    hideSelectionPopover();
    document.getElementById('reader-view').classList.remove('active');
    document.getElementById('reader-settings-popover').classList.remove('open');
    closeDrawer();
    document.getElementById('library-view').style.display = 'block';
    renderLibrary();
  }

  function isVerticalMode() {
    return state.settings.writingMode === 'vertical';
  }

  function getVerticalScrollInfo() {
    const canvasEl = document.getElementById('reader-canvas');
    if (!canvasEl) return { scrolled: 0, maxScroll: 0, viewportSize: 1 };
    const maxScroll = Math.max(0, canvasEl.scrollWidth - canvasEl.clientWidth);
    const viewportSize = Math.max(1, canvasEl.clientWidth);
    if (maxScroll <= 0) {
      return { scrolled: 0, maxScroll: 0, viewportSize };
    }
    const raw = canvasEl.scrollLeft;
    const scrolled = raw <= 0 ? Math.min(maxScroll, Math.abs(raw)) : Math.max(0, maxScroll - raw);
    return { scrolled, maxScroll, viewportSize };
  }

  function scrollVerticalTo(targetScrolledFromRight, behavior = 'smooth') {
    const canvasEl = document.getElementById('reader-canvas');
    if (!canvasEl) return;
    const maxScroll = Math.max(0, canvasEl.scrollWidth - canvasEl.clientWidth);
    const clamped = Math.max(0, Math.min(maxScroll, targetScrolledFromRight));
    canvasEl.scrollTo({ left: -clamped, behavior });
  }

  function calculateCurrentScrollPercent() {
    if (isVerticalMode()) {
      const { scrolled, maxScroll } = getVerticalScrollInfo();
      if (maxScroll <= 0) return 0;
      const pct = Math.round((scrolled / maxScroll) * 100);
      return Math.max(0, Math.min(100, pct));
    }
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    if (maxScroll <= 0) return 0;
    const pct = Math.round((window.scrollY / maxScroll) * 100);
    return Math.max(0, Math.min(100, pct));
  }

  function updateScrollRibbon() {
    const pct = calculateCurrentScrollPercent();
    const fill = document.getElementById('reader-ribbon-fill');
    if (fill) fill.style.width = `${pct}%`;
  }

  // ==========================================================================
  // 8B. Highlighter, Text Notes, Freehand Handwriting & Eraser Engine
  // ==========================================================================
  const STROKE_COLORS = {
    yellow: '#EAB308',
    green: '#22C55E',
    blue: '#3B82F6',
    pink: '#EC4899'
  };

  function getBookAnnotations(bookId) {
    if (!state.annotations[bookId]) {
      state.annotations[bookId] = { highlights: [], strokes: {} };
    }
    if (!Array.isArray(state.annotations[bookId].highlights)) {
      state.annotations[bookId].highlights = [];
    }
    if (!state.annotations[bookId].strokes || typeof state.annotations[bookId].strokes !== 'object') {
      state.annotations[bookId].strokes = {};
    }
    return state.annotations[bookId];
  }

  function setAnnotationTool(tool) {
    state.annotTool = tool;
    document.querySelectorAll('[data-annot-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.annotTool === tool);
    });

    const svgEl = document.getElementById('handwriting-svg');
    if (svgEl) {
      svgEl.classList.remove('drawing-active', 'eraser-active');
      if (tool === 'pen' || tool === 'highlighter') {
        svgEl.classList.add('drawing-active');
      } else if (tool === 'eraser') {
        svgEl.classList.add('eraser-active');
      }
    }

    const topBtn = document.getElementById('reader-annotate-btn');
    if (topBtn) {
      topBtn.classList.toggle('btn-pill-active', state.annotToolbarOpen || tool !== 'read');
    }
  }

  function setAnnotationColor(color) {
    state.annotColor = color;
    document.querySelectorAll('[data-annot-color]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.annotColor === color);
    });
  }

  function applyChapterHighlightsToDOM() {
    if (!state.currentBook || !state.currentChapter) return;
    const bodyEl = document.getElementById('chapter-body');
    if (!bodyEl) return;

    // First unwrap any existing mark.reader-highlight tags to avoid nested duplicates
    bodyEl.querySelectorAll('mark.reader-highlight').forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      }
    });

    const bookAnnot = getBookAnnotations(state.currentBook.id);
    const chIdx = state.currentChapter.index;
    const chHighlights = bookAnnot.highlights.filter((h) => h.chapterIndex === chIdx && h.text);
    if (chHighlights.length === 0) return;

    const paragraphs = Array.from(bodyEl.querySelectorAll('p, h3'));
    chHighlights.forEach((hl) => {
      const targetStr = convertStr(hl.text);
      if (!targetStr) return;

      for (const p of paragraphs) {
        if (!p.textContent.includes(targetStr)) continue;
        // Walk text nodes inside paragraph
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, null);
        let textNode;
        let matched = false;
        while ((textNode = walker.nextNode())) {
          const val = textNode.nodeValue;
          const pos = val.indexOf(targetStr);
          if (pos !== -1) {
            const range = document.createRange();
            range.setStart(textNode, pos);
            range.setEnd(textNode, pos + targetStr.length);

            const mark = document.createElement('mark');
            mark.className = `reader-highlight hl-${hl.color || 'yellow'}${hl.note ? ' has-note' : ''}`;
            mark.dataset.hlId = hl.id;
            if (hl.note) mark.title = `筆記：${hl.note}`;
            range.surroundContents(mark);
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
    });
  }

  function addOrUpdateHighlight({ text, color = 'yellow', note = '', existingId = null }) {
    if (!state.currentBook || !state.currentChapter) return null;
    const bookAnnot = getBookAnnotations(state.currentBook.id);
    const chIdx = state.currentChapter.index;

    if (existingId) {
      const found = bookAnnot.highlights.find((h) => h.id === existingId);
      if (found) {
        if (color) found.color = color;
        if (note !== undefined) found.note = note;
        found.updatedAt = new Date().toISOString();
        applyChapterHighlightsToDOM();
        pushCloudSync();
        renderDrawerNotes();
        return found;
      }
    }

    const cleanText = (text || '').trim();
    if (!cleanText) return null;

    // Check if identical highlight text in same chapter already exists
    const existingSame = bookAnnot.highlights.find(
      (h) => h.chapterIndex === chIdx && convertStr(h.text) === convertStr(cleanText)
    );
    if (existingSame) {
      existingSame.color = color || existingSame.color;
      if (note) existingSame.note = note;
      existingSame.updatedAt = new Date().toISOString();
      applyChapterHighlightsToDOM();
      pushCloudSync();
      renderDrawerNotes();
      return existingSame;
    }

    const newHl = {
      id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      chapterIndex: chIdx,
      chapterTitle: state.currentChapter.originalTitle || state.currentChapter.title,
      text: cleanText,
      color: color || state.annotColor || 'yellow',
      note: (note || '').trim(),
      scrollPercent: calculateCurrentScrollPercent(),
      createdAt: new Date().toISOString()
    };

    bookAnnot.highlights.unshift(newHl);
    applyChapterHighlightsToDOM();
    pushCloudSync();
    renderDrawerNotes();
    return newHl;
  }

  function removeHighlightById(hlId) {
    if (!state.currentBook) return;
    const bookAnnot = getBookAnnotations(state.currentBook.id);
    bookAnnot.highlights = bookAnnot.highlights.filter((h) => h.id !== hlId);
    applyChapterHighlightsToDOM();
    pushCloudSync();
    renderDrawerNotes();
    showToast('🧹 已擦除螢光筆與筆記');
  }

  function showSelectionPopover(rect, selectedText, existingHl = null) {
    const popover = document.getElementById('text-selection-popover');
    const noteEditor = document.getElementById('sel-note-editor');
    const noteInput = document.getElementById('sel-note-input');
    const removeBtn = document.getElementById('sel-remove-hl-btn');
    if (!popover) return;

    state.pendingSelectionText = selectedText || (existingHl ? existingHl.text : '');
    state.editingHighlightId = existingHl ? existingHl.id : null;

    removeBtn.style.display = existingHl ? 'inline-flex' : 'none';
    if (existingHl && existingHl.note) {
      noteEditor.style.display = 'flex';
      noteInput.value = existingHl.note;
    } else {
      noteEditor.style.display = 'none';
      noteInput.value = '';
    }

    popover.classList.add('open');

    // Position above or below selection rect
    const popWidth = 310;
    const left = Math.max(
      12,
      Math.min(window.innerWidth - popWidth - 12, rect.left + rect.width / 2 - popWidth / 2)
    );
    const top = rect.top > 110 ? rect.top - 54 : rect.bottom + 10;
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(Math.max(64, top))}px`;
  }

  function hideSelectionPopover() {
    const popover = document.getElementById('text-selection-popover');
    if (popover) popover.classList.remove('open');
    state.pendingSelectionText = '';
    state.editingHighlightId = null;
  }

  // Handwriting SVG Vector Layer (Normalized coordinates: x in [0..1000], y in [0..stageHeight] scaled)
  function renderChapterHandwritingSVG() {
    const svgEl = document.getElementById('handwriting-svg');
    const stageEl = document.getElementById('chapter-stage');
    if (!svgEl || !stageEl || !state.currentBook || !state.currentChapter) return;

    const bookAnnot = getBookAnnotations(state.currentBook.id);
    const chIdx = state.currentChapter.index;
    const strokes = bookAnnot.strokes[chIdx] || [];

    svgEl.innerHTML = '';
    const rect = stageEl.getBoundingClientRect();
    const stageWidth = Math.max(
      1,
      Math.round(rect.width) || stageEl.scrollWidth || stageEl.clientWidth || 720
    );
    const stageHeight = Math.max(
      1,
      Math.round(rect.height) || stageEl.scrollHeight || stageEl.clientHeight || 900
    );
    svgEl.setAttribute('viewBox', `0 0 ${stageWidth} ${stageHeight}`);

    strokes.forEach((st) => {
      if (!st.points || st.points.length < 2) return;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const d = st.points
        .map((pt, idx) => {
          const x = (pt[0] * stageWidth).toFixed(1);
          const y = (pt[1] * stageHeight).toFixed(1);
          return `${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
        })
        .join(' ');
      path.setAttribute('d', d);
      path.dataset.strokeId = st.id;
      const hex = STROKE_COLORS[st.color] || STROKE_COLORS.yellow;
      if (st.tool === 'highlighter') {
        path.setAttribute('stroke', hex);
        path.setAttribute('stroke-width', '20');
        path.setAttribute('stroke-opacity', '0.38');
      } else {
        path.setAttribute('stroke', hex);
        path.setAttribute('stroke-width', '3.2');
        path.setAttribute('stroke-opacity', '0.92');
      }
      svgEl.appendChild(path);
    });
  }

  // ==========================================================================
  // 9. TOC, Bookmarks & Notes Drawer
  // ==========================================================================
  function openDrawer(tab = 'toc') {
    state.activeDrawerTab = tab;
    document.getElementById('drawer-backdrop').classList.add('open');
    document.getElementById('toc-drawer').classList.add('open');
    switchDrawerTab(tab);
  }

  function closeDrawer() {
    document.getElementById('drawer-backdrop').classList.remove('open');
    document.getElementById('toc-drawer').classList.remove('open');
  }

  function switchDrawerTab(tab) {
    state.activeDrawerTab = tab;
    const tocBtn = document.getElementById('tab-toc-btn');
    const bmBtn = document.getElementById('tab-bookmarks-btn');
    const notesBtn = document.getElementById('tab-notes-btn');
    const tocList = document.getElementById('drawer-toc-list');
    const bmList = document.getElementById('drawer-bookmarks-list');
    const notesList = document.getElementById('drawer-notes-list');
    const searchBox = document.getElementById('toc-search-box');

    tocBtn.classList.toggle('active', tab === 'toc');
    bmBtn.classList.toggle('active', tab === 'bookmarks');
    if (notesBtn) notesBtn.classList.toggle('active', tab === 'notes');

    tocList.style.display = tab === 'toc' ? 'block' : 'none';
    bmList.style.display = tab === 'bookmarks' ? 'block' : 'none';
    if (notesList) notesList.style.display = tab === 'notes' ? 'block' : 'none';
    searchBox.style.display = tab === 'toc' ? 'block' : 'none';

    if (tab === 'toc') {
      renderDrawerToc();
    } else if (tab === 'bookmarks') {
      renderDrawerBookmarks();
    } else if (tab === 'notes') {
      renderDrawerNotes();
    }
  }

  function renderDrawerNotes() {
    const listEl = document.getElementById('drawer-notes-list');
    if (!listEl || !state.currentBook) return;
    const bookId = state.currentBook.id;
    const bookAnnot = getBookAnnotations(bookId);
    const hlList = bookAnnot.highlights || [];
    const strokeChapters = Object.entries(bookAnnot.strokes || {}).filter(
      ([_, arr]) => Array.isArray(arr) && arr.length > 0
    );

    listEl.innerHTML = '';

    if (hlList.length === 0 && strokeChapters.length === 0) {
      listEl.innerHTML = `
        <div style="text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); font-size: 0.85rem; line-height: 1.6;">
          尚無螢光筆畫線或手寫筆記。<br/>
          💡 <b>使用方式：</b><br/>
          1. 直接在書頁<b>選取任何文字</b>即可標記四色螢光筆或撰寫想法筆記。<br/>
          2. 點擊上方「<b>🖍️ 畫線/手寫</b>」工具列，即可開啟手寫鋼筆、塗抹螢光筆與橡皮擦！
        </div>
      `;
      return;
    }

    // Render Handwriting Stroke Chapters summary if any
    strokeChapters.forEach(([chIdxStr, arr]) => {
      const chIdx = parseInt(chIdxStr, 10);
      const chObj = state.currentBook.chapters?.[chIdx];
      const chTitle = convertStr(chObj ? chObj.originalTitle || chObj.title : `第 ${chIdx + 1} 章`);

      const card = document.createElement('div');
      card.className = 'bookmark-card';
      card.innerHTML = `
        <div class="bookmark-card-top">
          <span>✍️ 手寫批註 · ${escapeHtml(chTitle)} (${arr.length} 筆畫)</span>
          <button type="button" class="clear-ch-strokes-btn" title="擦除此章所有手寫筆跡" style="color: var(--text-muted); padding: 0 0.25rem;">🧹</button>
        </div>
        <div class="bookmark-excerpt" style="font-size: 0.8rem; color: var(--text-secondary);">點擊跳轉至此章節檢視手寫筆記</div>
      `;
      card.addEventListener('click', (e) => {
        if (e.target.closest('.clear-ch-strokes-btn')) {
          delete bookAnnot.strokes[chIdx];
          if (state.currentChapter && state.currentChapter.index === chIdx) {
            renderChapterHandwritingSVG();
          }
          pushCloudSync();
          renderDrawerNotes();
          showToast('🧹 已清除該章節手寫筆跡');
          return;
        }
        closeDrawer();
        loadAndRenderChapter(chIdx, 0);
      });
      listEl.appendChild(card);
    });

    // Render Text Highlights & Notes
    hlList.forEach((hl) => {
      const colorBadge =
        hl.color === 'green'
          ? '🟢'
          : hl.color === 'blue'
          ? '🔵'
          : hl.color === 'pink'
          ? '🌸'
          : '🟡';
      const card = document.createElement('div');
      card.className = 'bookmark-card';
      card.innerHTML = `
        <div class="bookmark-card-top">
          <span>${colorBadge} ${escapeHtml(convertStr(hl.chapterTitle || `第 ${(hl.chapterIndex || 0) + 1} 章`))}</span>
          <button type="button" class="delete-hl-btn" title="擦除此螢光筆筆記" style="color: var(--text-muted); padding: 0 0.25rem;">✕</button>
        </div>
        <div class="bookmark-excerpt">「${escapeHtml(convertStr(hl.text || ''))}」</div>
        ${
          hl.note
            ? `<div style="margin: 0.35rem 0; padding: 0.4rem 0.6rem; background: var(--bg-subtle); border-radius: 6px; font-size: 0.8rem; color: var(--text-primary);">📝 ${escapeHtml(
                convertStr(hl.note)
              )}</div>`
            : ''
        }
        <div class="bookmark-time">${formatRelativeTime(hl.createdAt)}</div>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('.delete-hl-btn')) {
          removeHighlightById(hl.id);
          return;
        }
        closeDrawer();
        loadAndRenderChapter(hl.chapterIndex || 0, hl.scrollPercent || 0);
      });

      listEl.appendChild(card);
    });
  }

  function renderDrawerToc() {
    const listEl = document.getElementById('drawer-toc-list');
    if (!state.currentBook || !state.currentBook.chapters) {
      listEl.innerHTML = '';
      return;
    }

    const q = state.tocSearchQuery.trim();
    const matchToc = q ? compileBooleanQueryClient(q) : null;
    listEl.innerHTML = '';

    state.currentBook.chapters.forEach((ch) => {
      const displayTitle = convertStr(ch.originalTitle || ch.title);
      if (matchToc && !matchToc(`${displayTitle} ${ch.originalTitle || ''}`.toLowerCase())) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `toc-item ${
        state.currentChapter && state.currentChapter.index === ch.index ? 'active' : ''
      }`;
      btn.dataset.chIndex = ch.index;
      btn.innerHTML = `
        <span class="toc-item-title">${escapeHtml(displayTitle)}</span>
        <span class="toc-item-words">${ch.wordCount || 0} 字</span>
      `;
      btn.addEventListener('click', () => {
        closeDrawer();
        loadAndRenderChapter(ch.index, 0);
      });
      listEl.appendChild(btn);
    });
  }

  function highlightActiveTocItem() {
    const listEl = document.getElementById('drawer-toc-list');
    if (!listEl || !state.currentChapter) return;
    listEl.querySelectorAll('.toc-item').forEach((el) => {
      if (parseInt(el.dataset.chIndex, 10) === state.currentChapter.index) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });
  }

  function addBookmarkAtCurrentPosition() {
    if (!state.currentBook || !state.currentChapter) return;
    const bookId = state.currentBook.id;
    const scrollPercent = calculateCurrentScrollPercent();

    // Grab a short text snippet near current viewport
    let excerpt = state.currentChapter.content
      ? state.currentChapter.content.slice(0, 90).replace(/\s+/g, ' ')
      : state.currentChapter.title;

    const paragraphs = document.querySelectorAll('#chapter-body p');
    for (const p of paragraphs) {
      const rect = p.getBoundingClientRect();
      if (isVerticalMode()) {
        if (rect.right >= window.innerWidth * 0.35 && rect.left <= window.innerWidth * 0.92) {
          excerpt = p.textContent.trim().slice(0, 90);
          break;
        }
      } else {
        if (rect.top >= 40 && rect.top <= window.innerHeight * 0.6) {
          excerpt = p.textContent.trim().slice(0, 90);
          break;
        }
      }
    }

    if (!state.bookmarks[bookId]) {
      state.bookmarks[bookId] = [];
    }

    const newBm = {
      id: `bm_${Date.now()}`,
      chapterIndex: state.currentChapter.index,
      chapterTitle: state.currentChapter.originalTitle || state.currentChapter.title,
      scrollPercent,
      excerpt,
      createdAt: new Date().toISOString()
    };

    state.bookmarks[bookId].unshift(newBm);
    pushCloudSync();
    renderDrawerBookmarks();
    showToast(`🔖 已加入書籤：${convertStr(newBm.chapterTitle)} (${scrollPercent}%)`);
  }

  function renderDrawerBookmarks() {
    const listEl = document.getElementById('drawer-bookmarks-list');
    if (!state.currentBook) return;
    const bookId = state.currentBook.id;
    const bmList = state.bookmarks[bookId] || [];

    listEl.innerHTML = '';
    if (bmList.length === 0) {
      listEl.innerHTML = `
        <div style="text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); font-size: 0.85rem;">
          尚無書籤紀錄。<br/>閱讀時點擊上方「🔖 書籤」即可記錄目前段落位置並自動雲端同步。
        </div>
      `;
      return;
    }

    bmList.forEach((bm) => {
      const card = document.createElement('div');
      card.className = 'bookmark-card';
      card.innerHTML = `
        <div class="bookmark-card-top">
          <span>${escapeHtml(convertStr(bm.chapterTitle))} · ${bm.scrollPercent || 0}%</span>
          <button type="button" class="delete-bm-btn" title="刪除書籤" style="color: var(--text-muted); padding: 0 0.25rem;">✕</button>
        </div>
        <div class="bookmark-excerpt">「${escapeHtml(convertStr(bm.excerpt || ''))}」</div>
        <div class="bookmark-time">${formatRelativeTime(bm.createdAt)}</div>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('.delete-bm-btn')) {
          state.bookmarks[bookId] = state.bookmarks[bookId].filter((item) => item.id !== bm.id);
          pushCloudSync();
          renderDrawerBookmarks();
          showToast('已刪除書籤');
          return;
        }
        closeDrawer();
        loadAndRenderChapter(bm.chapterIndex, bm.scrollPercent || 0);
      });

      listEl.appendChild(card);
    });
  }

  // ==========================================================================
  // 10. Reader Typography, Theme & Conversion Settings
  // ==========================================================================
  const THEME_LABELS = {
    sepia: '暖調宣紙',
    day: '晨光純白',
    sage: '松石護眼',
    night: '靜夜深墨'
  };

  const CONVERT_LABELS = {
    s2twp: '簡→繁 (台灣)',
    s2t: '簡→繁 (標準)',
    none: '顯示原文'
  };

  function applyReaderSettingsToDOM() {
    const s = state.settings;
    document.body.setAttribute('data-theme', s.theme || 'sepia');

    const root = document.documentElement;
    root.style.setProperty('--reader-font-size', `${s.fontSize || 19}px`);
    root.style.setProperty('--reader-line-height', `${s.lineHeight || 1.85}`);
    root.style.setProperty('--reader-max-width', `${s.maxWidth || 760}px`);

    const fontMap = {
      serif: "var(--font-serif)",
      sans: "var(--font-sans)",
      kai: "var(--font-kai)"
    };
    root.style.setProperty('--reader-font-family', fontMap[s.fontFamily] || fontMap.serif);

    // Apply Vertical / Horizontal writing mode
    const writingMode = s.writingMode === 'vertical' ? 'vertical' : 'horizontal';
    const canvasEl = document.getElementById('reader-canvas');
    if (canvasEl) {
      canvasEl.classList.toggle('vertical-mode', writingMode === 'vertical');
    }

    document.querySelectorAll('[data-dir-opt]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.dirOpt === writingMode);
    });

    const dirLabel = document.getElementById('direction-name-label');
    if (dirLabel) {
      dirLabel.textContent =
        writingMode === 'vertical' ? '傳統直排 (由上而下，由右至左)' : '現代橫排 (由上而下)';
    }

    const dirBtn = document.getElementById('reader-direction-toggle');
    const dirBtnText = document.getElementById('reader-direction-text');
    if (dirBtn) {
      dirBtn.classList.toggle('btn-pill-active', writingMode === 'vertical');
    }
    if (dirBtnText) {
      dirBtnText.textContent = writingMode === 'vertical' ? '▤ 直排' : '☰ 橫排';
    }

    const prevChBtn = document.getElementById('prev-chapter-btn');
    const nextChBtn = document.getElementById('next-chapter-btn');
    if (prevChBtn && nextChBtn) {
      if (writingMode === 'vertical') {
        nextChBtn.textContent = '← 下一章';
        prevChBtn.textContent = '上一章 →';
      } else {
        prevChBtn.textContent = '← 上一章';
        nextChBtn.textContent = '下一章 →';
      }
    }

    // Update Settings Popover UI active states
    const themeLabel = document.getElementById('theme-name-label');
    if (themeLabel) themeLabel.textContent = THEME_LABELS[s.theme] || '暖調宣紙';

    document.querySelectorAll('[data-theme-opt]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeOpt === s.theme);
    });

    document.querySelectorAll('[data-convert-opt]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.convertOpt === s.convertMode);
    });

    document.querySelectorAll('[data-font-opt]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.fontOpt === s.fontFamily);
    });

    document.querySelectorAll('[data-lh-opt]').forEach((btn) => {
      btn.classList.toggle('active', parseFloat(btn.dataset.lhOpt) === parseFloat(s.lineHeight));
    });

    document.querySelectorAll('[data-width-opt]').forEach((btn) => {
      btn.classList.toggle('active', parseInt(btn.dataset.widthOpt, 10) === parseInt(s.maxWidth, 10));
    });

    const flipMode = s.clickFlip || 'both';
    document.querySelectorAll('[data-flip-opt]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.flipOpt === flipMode);
    });
    const flipLabel = document.getElementById('click-flip-label');
    if (flipLabel) {
      flipLabel.textContent =
        flipMode === 'both'
          ? '點右下一頁 / 點左回翻'
          : flipMode === 'left_next'
          ? '點左下一頁 / 點右回翻'
          : flipMode === 'next_only'
          ? '全頁點擊下一頁'
          : '已關閉點擊翻頁';
    }

    const fsDisplay = document.getElementById('font-size-display');
    const fsVal = document.getElementById('font-size-val');
    if (fsDisplay) fsDisplay.textContent = `${s.fontSize}px`;
    if (fsVal) fsVal.textContent = `${s.fontSize} px`;

    updatePdfModeButtonUI();
    updateGlobalConvertButtonUI();
  }

  function setWritingMode(newMode) {
    const isReading =
      document.getElementById('reader-view').classList.contains('active') && state.currentChapter;
    const currentScrollPct = isReading ? calculateCurrentScrollPercent() : 0;

    state.settings.writingMode = newMode === 'vertical' ? 'vertical' : 'horizontal';
    applyReaderSettingsToDOM();
    pushCloudSync();

    showToast(
      state.settings.writingMode === 'vertical'
        ? '▤ 已切換為「直排閱讀模式（傳統直書右起）」'
        : '☰ 已切換為「橫排閱讀模式（現代橫書）」'
    );

    if (isReading) {
      state.isRestoringScroll = true;
      requestAnimationFrame(() => {
        if (isVerticalMode()) {
          window.scrollTo({ top: 0, behavior: 'instant' });
          const { maxScroll } = getVerticalScrollInfo();
          scrollVerticalTo(Math.round((currentScrollPct / 100) * maxScroll), 'instant');
        } else {
          const maxScroll = Math.max(
            0,
            document.documentElement.scrollHeight - window.innerHeight
          );
          window.scrollTo({
            top: Math.round((currentScrollPct / 100) * maxScroll),
            behavior: 'instant'
          });
        }
        renderChapterHandwritingSVG();
        updateScrollRibbon();
        setTimeout(() => {
          state.isRestoringScroll = false;
          scheduleProgressSync();
        }, 120);
      });
    }
  }

  function toggleWritingMode() {
    setWritingMode(state.settings.writingMode === 'vertical' ? 'horizontal' : 'vertical');
  }

  function updateGlobalConvertButtonUI() {
    const mode = state.settings.convertMode || 's2twp';
    const globalBtn = document.getElementById('global-convert-btn');
    const globalLabel = document.getElementById('global-convert-label');
    const readerBtn = document.getElementById('reader-convert-toggle');
    const readerLabel = document.getElementById('reader-convert-text');

    if (globalLabel) globalLabel.textContent = CONVERT_LABELS[mode] || '簡→繁 (台灣)';
    if (globalBtn) globalBtn.classList.toggle('btn-pill-active', mode !== 'none');

    if (readerLabel) {
      readerLabel.textContent = mode === 'none' ? '原文' : mode === 's2t' ? '簡→繁' : '簡→繁(台)';
    }
    if (readerBtn) readerBtn.classList.toggle('btn-pill-active', mode !== 'none');
  }

  async function cycleConvertMode() {
    const order = ['s2twp', 's2t', 'none'];
    const nextIdx = (order.indexOf(state.settings.convertMode) + 1) % order.length;
    await setConvertMode(order[nextIdx]);
  }

  async function setConvertMode(newMode) {
    state.settings.convertMode = newMode;
    applyReaderSettingsToDOM();
    pushCloudSync();

    showToast(`已切換為：${CONVERT_LABELS[newMode]}`);

    if (document.getElementById('reader-view').classList.contains('active') && state.currentChapter) {
      const currentScroll = calculateCurrentScrollPercent();
      await loadAndRenderChapter(state.currentChapter.index, currentScroll);
      renderDrawerToc();
    } else {
      await loadLibrary();
    }
  }

  // ==========================================================================
  // 11. UI Event Listeners & Modal Handlers
  // ==========================================================================
  function showToast(msg) {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = 'toast-msg';
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 2800);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function bindEvents() {
    // Search Box with 400ms debounce for 50,000+ books
    const searchInput = document.getElementById('search-input');
    const searchClear = document.getElementById('search-clear-btn');
    let searchDebounceTimer = null;

    searchInput.addEventListener('input', () => {
      state.searchQuery = searchInput.value;
      searchClear.style.display = state.searchQuery ? 'block' : 'none';
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        state.currentPage = 1;
        loadLibrary(1);
      }, 350);
    });

    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      state.searchQuery = '';
      searchClear.style.display = 'none';
      state.currentPage = 1;
      loadLibrary(1);
    });

    // Format & Sort Selectors
    document.getElementById('format-filter').addEventListener('change', (e) => {
      state.selectedFormat = e.target.value;
      state.currentPage = 1;
      loadLibrary(1);
    });

    document.getElementById('sort-select').addEventListener('change', (e) => {
      state.sortBy = e.target.value;
      state.currentPage = 1;
      loadLibrary(1);
    });

    // Pagination Controls
    const prevPageBtn = document.getElementById('prev-page-btn');
    const nextPageBtn = document.getElementById('next-page-btn');
    if (prevPageBtn) {
      prevPageBtn.addEventListener('click', () => {
        if (state.currentPage > 1) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
          loadLibrary(state.currentPage - 1);
        }
      });
    }
    if (nextPageBtn) {
      nextPageBtn.addEventListener('click', () => {
        if (state.currentPage < state.totalPages) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
          loadLibrary(state.currentPage + 1);
        }
      });
    }

    // Global & Reader Simplified-to-Traditional Toggle
    document.getElementById('global-convert-btn').addEventListener('click', cycleConvertMode);
    document.getElementById('reader-convert-toggle').addEventListener('click', cycleConvertMode);

    // Reader Vertical / Horizontal Writing Mode Toggle
    const readerDirToggle = document.getElementById('reader-direction-toggle');
    if (readerDirToggle) {
      readerDirToggle.addEventListener('click', toggleWritingMode);
    }

    // PDF Smart Reflow / Raw Line / Native Viewer Mode Toggle
    const pdfModeBtn = document.getElementById('reader-pdf-mode-btn');
    if (pdfModeBtn) {
      pdfModeBtn.addEventListener('click', () => {
        cyclePdfViewMode();
      });
    }

    // Manual Cloud Sync Button
    document.getElementById('sync-now-btn').addEventListener('click', () => pullCloudSync(false));
    document.getElementById('refresh-sync-btn').addEventListener('click', () => pullCloudSync(false));

    // Reader Navigation Controls
    document.getElementById('reader-back-btn').addEventListener('click', closeReaderView);

    document.getElementById('prev-chapter-btn').addEventListener('click', () => {
      if (state.currentChapter && state.currentChapter.prevIndex !== null) {
        loadAndRenderChapter(state.currentChapter.prevIndex, 0);
      }
    });

    document.getElementById('next-chapter-btn').addEventListener('click', () => {
      if (state.currentChapter && state.currentChapter.nextIndex !== null) {
        loadAndRenderChapter(state.currentChapter.nextIndex, 0);
      }
    });

    // Keyboard navigation in Reader View
    window.addEventListener('keydown', (e) => {
      if (!document.getElementById('reader-view').classList.contains('active')) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === 'ArrowLeft') {
        if (isVerticalMode()) {
          e.preventDefault();
          flipToNextPageOrChapter();
        } else if (state.currentChapter?.prevIndex !== null) {
          loadAndRenderChapter(state.currentChapter.prevIndex, 0);
        }
      } else if (e.key === 'ArrowRight') {
        if (isVerticalMode()) {
          e.preventDefault();
          flipToPrevPageOrChapter();
        } else if (state.currentChapter?.nextIndex !== null) {
          loadAndRenderChapter(state.currentChapter.nextIndex, 0);
        }
      } else if (e.key === 'Escape') {
        closeDrawer();
        document.getElementById('reader-settings-popover').classList.remove('open');
      }
    });

    // Scroll listener for progress ribbon & auto-sync (both window and vertical #reader-canvas)
    const handleReaderScroll = () => {
      if (!document.getElementById('reader-view').classList.contains('active')) return;
      updateScrollRibbon();
      if (!state.isRestoringScroll) {
        scheduleProgressSync();
      }
    };

    window.addEventListener('scroll', handleReaderScroll, { passive: true });
    const readerCanvasEl = document.getElementById('reader-canvas');
    if (readerCanvasEl) {
      readerCanvasEl.addEventListener('scroll', handleReaderScroll, { passive: true });

      // Translate vertical mouse wheel to horizontal scroll when in Vertical Reading Mode
      readerCanvasEl.addEventListener(
        'wheel',
        (e) => {
          if (!isVerticalMode()) return;
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.preventDefault();
            readerCanvasEl.scrollLeft -= e.deltaY;
          }
        },
        { passive: false }
      );
    }

    // Helper functions for page flipping (scroll within chapter, change chapter at boundary)
    function flipToNextPageOrChapter() {
      if (isVerticalMode()) {
        const { scrolled, maxScroll, viewportSize } = getVerticalScrollInfo();
        const remainingLeft = maxScroll - scrolled;
        if (remainingLeft <= 40) {
          if (state.currentChapter && state.currentChapter.nextIndex !== null) {
            loadAndRenderChapter(state.currentChapter.nextIndex, 0);
            showToast(`已翻至下一章：${convertStr(state.currentChapter?.title || '')}`);
          } else {
            showToast('已是全書最後一章');
          }
        } else {
          const step = Math.max(160, Math.floor(viewportSize * 0.85));
          scrollVerticalTo(Math.min(maxScroll, scrolled + step), 'smooth');
        }
        return;
      }

      const scrollY = window.scrollY || window.pageYOffset;
      const viewportHeight = window.innerHeight;
      const totalHeight = document.documentElement.scrollHeight;
      const maxScroll = totalHeight - viewportHeight;

      // Distance from bottom of current chapter
      const remainingBottom = maxScroll - scrollY;

      // If already at or very near bottom (within 40px), transition to next chapter
      if (remainingBottom <= 40) {
        if (state.currentChapter && state.currentChapter.nextIndex !== null) {
          loadAndRenderChapter(state.currentChapter.nextIndex, 0);
          showToast(`已翻至下一章：${convertStr(state.currentChapter?.title || '')}`);
        } else {
          showToast('已是全書最後一章');
        }
      } else {
        // Page down by 85% of screen height (leaving 15% overlap for reading continuity)
        const step = Math.max(160, Math.floor(viewportHeight * 0.85));
        const target = Math.min(maxScroll, scrollY + step);
        window.scrollTo({ top: target, behavior: 'smooth' });
      }
    }

    function flipToPrevPageOrChapter() {
      if (isVerticalMode()) {
        const { scrolled, viewportSize } = getVerticalScrollInfo();
        if (scrolled <= 40) {
          if (state.currentChapter && state.currentChapter.prevIndex !== null) {
            loadAndRenderChapter(state.currentChapter.prevIndex, 100);
            showToast(`已翻至上一章：${convertStr(state.currentChapter?.title || '')}`);
          } else {
            showToast('已是第一章起點');
          }
        } else {
          const step = Math.max(160, Math.floor(viewportSize * 0.85));
          scrollVerticalTo(Math.max(0, scrolled - step), 'smooth');
        }
        return;
      }

      const scrollY = window.scrollY || window.pageYOffset;
      const viewportHeight = window.innerHeight;

      // If already at or very near top (within 40px), transition to previous chapter
      if (scrollY <= 40) {
        if (state.currentChapter && state.currentChapter.prevIndex !== null) {
          // Open previous chapter at 100% (the bottom of previous chapter)
          loadAndRenderChapter(state.currentChapter.prevIndex, 100);
          showToast(`已翻至上一章：${convertStr(state.currentChapter?.title || '')}`);
        } else {
          showToast('已是第一章頂部');
        }
      } else {
        // Page up by 85% of screen height
        const step = Math.max(160, Math.floor(viewportHeight * 0.85));
        const target = Math.max(0, scrollY - step);
        window.scrollTo({ top: target, behavior: 'smooth' });
      }
    }

    // Tap reader canvas to flip page/chapter (or interact with highlights)
    document.getElementById('reader-canvas').addEventListener('click', (e) => {
      // Ignore if user clicked a button, link, or annotation UI
      if (e.target.closest('button, a, #annotation-toolbar, #text-selection-popover')) return;

      // Check if user clicked on an existing text highlight
      const markEl = e.target.closest('mark.reader-highlight');
      if (markEl && state.currentBook) {
        e.stopPropagation();
        const hlId = markEl.dataset.hlId;
        if (state.annotTool === 'eraser') {
          removeHighlightById(hlId);
          return;
        }
        const bookAnnot = getBookAnnotations(state.currentBook.id);
        const existingHl = bookAnnot.highlights.find((h) => h.id === hlId);
        if (existingHl) {
          showSelectionPopover(markEl.getBoundingClientRect(), existingHl.text, existingHl);
          return;
        }
      }

      // Close text selection popover if open
      const selPopover = document.getElementById('text-selection-popover');
      if (selPopover && selPopover.classList.contains('open')) {
        hideSelectionPopover();
        return;
      }

      const selection = window.getSelection();
      if (selection && selection.toString().trim().length > 0) return;

      const popover = document.getElementById('reader-settings-popover');
      if (popover.classList.contains('open')) {
        popover.classList.remove('open');
        return;
      }

      // Do not flip page when actively using highlighter/pen/eraser tools
      if (state.annotTool !== 'read') return;

      const flipMode = state.settings.clickFlip || 'both';
      if (flipMode === 'off') return;

      const winWidth = window.innerWidth || document.documentElement.clientWidth;
      const clickX = e.clientX;
      const ratio = clickX / winWidth;

      if (flipMode === 'next_only') {
        flipToNextPageOrChapter();
        return;
      }

      if (flipMode === 'left_next') {
        // Left 65% flips to next page/chapter, Right 35% flips to prev page/chapter
        if (ratio <= 0.65) {
          flipToNextPageOrChapter();
        } else {
          flipToPrevPageOrChapter();
        }
        return;
      }

      // 'both' mode: Right 65% flips to next page/chapter, Left 35% flips to prev page/chapter
      if (ratio >= 0.35) {
        flipToNextPageOrChapter();
      } else {
        flipToPrevPageOrChapter();
      }
    });

    // Text Selection for Highlighter & Notes
    const handleTextSelectionEnd = () => {
      setTimeout(() => {
        if (!state.currentBook || !state.currentChapter) return;
        if (state.annotTool === 'pen' || state.annotTool === 'eraser') return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const selectedText = sel.toString().trim();
        if (!selectedText || selectedText.length < 1) return;

        const chapterBody = document.getElementById('chapter-body');
        if (!chapterBody || !chapterBody.contains(sel.anchorNode)) return;

        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        if (state.annotTool === 'highlighter') {
          // Instant highlight when highlighter tool is active
          addOrUpdateHighlight({ text: selectedText, color: state.annotColor });
          sel.removeAllRanges();
          showToast('🖍️ 已標記螢光筆');
        } else {
          showSelectionPopover(rect, selectedText, null);
        }
      }, 30);
    };

    const chapterBodyEl = document.getElementById('chapter-body');
    if (chapterBodyEl) {
      chapterBodyEl.addEventListener('mouseup', handleTextSelectionEnd);
      chapterBodyEl.addEventListener('touchend', handleTextSelectionEnd);
    }

    // Text Selection Popover Actions
    document.querySelectorAll('[data-sel-hl]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = btn.dataset.selHl;
        const noteInput = document.getElementById('sel-note-input');
        const noteEditor = document.getElementById('sel-note-editor');
        const noteVal = noteEditor && noteEditor.style.display !== 'none' ? noteInput.value : undefined;
        addOrUpdateHighlight({
          text: state.pendingSelectionText,
          color,
          note: noteVal,
          existingId: state.editingHighlightId
        });
        window.getSelection()?.removeAllRanges();
        hideSelectionPopover();
        showToast('🖍️ 已儲存螢光筆畫線');
      });
    });

    const selAddNoteBtn = document.getElementById('sel-add-note-btn');
    if (selAddNoteBtn) {
      selAddNoteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const noteEditor = document.getElementById('sel-note-editor');
        const noteInput = document.getElementById('sel-note-input');
        if (noteEditor) {
          noteEditor.style.display = 'flex';
          noteInput?.focus();
        }
      });
    }

    const selRemoveHlBtn = document.getElementById('sel-remove-hl-btn');
    if (selRemoveHlBtn) {
      selRemoveHlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.editingHighlightId) {
          removeHighlightById(state.editingHighlightId);
        }
        hideSelectionPopover();
      });
    }

    const selNoteSaveBtn = document.getElementById('sel-note-save');
    if (selNoteSaveBtn) {
      selNoteSaveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const noteVal = document.getElementById('sel-note-input')?.value || '';
        addOrUpdateHighlight({
          text: state.pendingSelectionText,
          color: state.annotColor || 'yellow',
          note: noteVal,
          existingId: state.editingHighlightId
        });
        window.getSelection()?.removeAllRanges();
        hideSelectionPopover();
        showToast('📝 已儲存筆記與畫線');
      });
    }

    const selNoteCancelBtn = document.getElementById('sel-note-cancel');
    if (selNoteCancelBtn) {
      selNoteCancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideSelectionPopover();
      });
    }

    // Annotation & E-Reader Handwriting Toolbar Controls
    const readerAnnotBtn = document.getElementById('reader-annotate-btn');
    const annotToolbar = document.getElementById('annotation-toolbar');
    if (readerAnnotBtn && annotToolbar) {
      readerAnnotBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = annotToolbar.style.display !== 'none';
        if (isOpen) {
          annotToolbar.style.display = 'none';
          setAnnotationTool('read');
        } else {
          annotToolbar.style.display = 'flex';
          setAnnotationTool('highlighter');
        }
      });
    }

    document.querySelectorAll('[data-annot-tool]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setAnnotationTool(btn.dataset.annotTool);
      });
    });

    document.querySelectorAll('[data-annot-color]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setAnnotationColor(btn.dataset.annotColor);
      });
    });

    const annotUndoBtn = document.getElementById('annot-undo-btn');
    if (annotUndoBtn) {
      annotUndoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!state.currentBook || !state.currentChapter) return;
        const bookAnnot = getBookAnnotations(state.currentBook.id);
        const chIdx = state.currentChapter.index;
        const strokes = bookAnnot.strokes[chIdx] || [];
        if (strokes.length > 0) {
          strokes.pop();
          renderChapterHandwritingSVG();
          pushCloudSync();
          renderDrawerNotes();
          showToast('↩️ 已復原上一筆手寫');
        } else {
          showToast('本章目前無手寫筆跡可復原');
        }
      });
    }

    const annotClearBtn = document.getElementById('annot-clear-btn');
    if (annotClearBtn) {
      annotClearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!state.currentBook || !state.currentChapter) return;
        const bookAnnot = getBookAnnotations(state.currentBook.id);
        const chIdx = state.currentChapter.index;
        const hasStrokes = (bookAnnot.strokes[chIdx] || []).length > 0;
        if (!hasStrokes) {
          showToast('本章目前無手寫筆跡');
          return;
        }
        bookAnnot.strokes[chIdx] = [];
        renderChapterHandwritingSVG();
        pushCloudSync();
        renderDrawerNotes();
        showToast('🗑️ 已清空本章手寫筆跡');
      });
    }

    const annotListBtn = document.getElementById('annot-list-btn');
    if (annotListBtn) {
      annotListBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openDrawer('notes');
      });
    }

    const annotCloseBtn = document.getElementById('annot-close-btn');
    if (annotCloseBtn && annotToolbar) {
      annotCloseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        annotToolbar.style.display = 'none';
        setAnnotationTool('read');
      });
    }

    // Handwriting SVG Pointer Events (Stylus / Apple Pencil / E-Reader Pen / Touch / Mouse)
    const svgEl = document.getElementById('handwriting-svg');
    const stageEl = document.getElementById('chapter-stage');
    if (svgEl && stageEl) {
      let currentPoints = [];
      let activePathEl = null;

      const getNormalizedPoint = (e) => {
        const rect = stageEl.getBoundingClientRect();
        const w = Math.max(1, rect.width);
        const h = Math.max(1, rect.height);
        const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / w));
        const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / h));
        return [Number(nx.toFixed(4)), Number(ny.toFixed(4))];
      };

      const eraseStrokeNearPoint = (nx, ny) => {
        if (!state.currentBook || !state.currentChapter) return;
        const bookAnnot = getBookAnnotations(state.currentBook.id);
        const chIdx = state.currentChapter.index;
        const strokes = bookAnnot.strokes[chIdx] || [];
        if (strokes.length === 0) return;

        const rect = stageEl.getBoundingClientRect();
        const w = Math.max(1, rect.width);
        const h = Math.max(1, rect.height);
        const px = nx * w;
        const py = ny * h;
        const hitRadiusSq = 22 * 22;

        const beforeLen = strokes.length;
        bookAnnot.strokes[chIdx] = strokes.filter((st) => {
          return !st.points.some((pt) => {
            const dx = pt[0] * w - px;
            const dy = pt[1] * h - py;
            return dx * dx + dy * dy <= hitRadiusSq;
          });
        });

        if (bookAnnot.strokes[chIdx].length !== beforeLen) {
          renderChapterHandwritingSVG();
          pushCloudSync();
          renderDrawerNotes();
        }
      };

      svgEl.addEventListener('pointerdown', (e) => {
        if (state.annotTool !== 'pen' && state.annotTool !== 'highlighter' && state.annotTool !== 'eraser') {
          return;
        }
        e.preventDefault();
        svgEl.setPointerCapture(e.pointerId);
        state.isDrawingStroke = true;

        const pt = getNormalizedPoint(e);
        if (state.annotTool === 'eraser') {
          eraseStrokeNearPoint(pt[0], pt[1]);
          return;
        }

        currentPoints = [pt];
        const sRect = stageEl.getBoundingClientRect();
        const stageWidth = Math.max(
          1,
          Math.round(sRect.width) || stageEl.scrollWidth || stageEl.clientWidth || 720
        );
        const stageHeight = Math.max(
          1,
          Math.round(sRect.height) || stageEl.scrollHeight || stageEl.clientHeight || 900
        );
        svgEl.setAttribute('viewBox', `0 0 ${stageWidth} ${stageHeight}`);

        activePathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const hex = STROKE_COLORS[state.annotColor] || STROKE_COLORS.yellow;
        if (state.annotTool === 'highlighter') {
          activePathEl.setAttribute('stroke', hex);
          activePathEl.setAttribute('stroke-width', '20');
          activePathEl.setAttribute('stroke-opacity', '0.38');
        } else {
          activePathEl.setAttribute('stroke', hex);
          activePathEl.setAttribute('stroke-width', '3.2');
          activePathEl.setAttribute('stroke-opacity', '0.92');
        }
        activePathEl.setAttribute('d', `M ${(pt[0] * stageWidth).toFixed(1)} ${(pt[1] * stageHeight).toFixed(1)}`);
        svgEl.appendChild(activePathEl);
      });

      svgEl.addEventListener('pointermove', (e) => {
        if (!state.isDrawingStroke) return;
        e.preventDefault();
        const pt = getNormalizedPoint(e);

        if (state.annotTool === 'eraser') {
          eraseStrokeNearPoint(pt[0], pt[1]);
          return;
        }

        if (!activePathEl) return;
        currentPoints.push(pt);
        const sRect = stageEl.getBoundingClientRect();
        const stageWidth = Math.max(
          1,
          Math.round(sRect.width) || stageEl.scrollWidth || stageEl.clientWidth || 720
        );
        const stageHeight = Math.max(
          1,
          Math.round(sRect.height) || stageEl.scrollHeight || stageEl.clientHeight || 900
        );
        const d = currentPoints
          .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${(p[0] * stageWidth).toFixed(1)} ${(p[1] * stageHeight).toFixed(1)}`)
          .join(' ');
        activePathEl.setAttribute('d', d);
      });

      const finishStroke = (e) => {
        if (!state.isDrawingStroke) return;
        state.isDrawingStroke = false;
        try {
          svgEl.releasePointerCapture(e.pointerId);
        } catch (_) {}

        if (state.annotTool === 'eraser') return;

        if (currentPoints.length >= 2 && state.currentBook && state.currentChapter) {
          const bookAnnot = getBookAnnotations(state.currentBook.id);
          const chIdx = state.currentChapter.index;
          if (!Array.isArray(bookAnnot.strokes[chIdx])) {
            bookAnnot.strokes[chIdx] = [];
          }
          bookAnnot.strokes[chIdx].push({
            id: `st_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            tool: state.annotTool === 'highlighter' ? 'highlighter' : 'pen',
            color: state.annotColor || 'yellow',
            points: currentPoints,
            createdAt: new Date().toISOString()
          });
          pushCloudSync();
          renderDrawerNotes();
        } else if (activePathEl) {
          activePathEl.remove();
        }
        currentPoints = [];
        activePathEl = null;
      };

      svgEl.addEventListener('pointerup', finishStroke);
      svgEl.addEventListener('pointercancel', finishStroke);
    }

    // Bookmark, TOC & Notes Drawer Controls
    document.getElementById('reader-add-bookmark-btn').addEventListener('click', addBookmarkAtCurrentPosition);
    document.getElementById('reader-toc-btn').addEventListener('click', () => openDrawer('toc'));
    document.getElementById('footer-toc-btn').addEventListener('click', () => openDrawer('toc'));
    document.getElementById('close-drawer-btn').addEventListener('click', closeDrawer);
    document.getElementById('drawer-backdrop').addEventListener('click', () => {
      closeDrawer();
      closeModals();
    });

    document.getElementById('tab-toc-btn').addEventListener('click', () => switchDrawerTab('toc'));
    document.getElementById('tab-bookmarks-btn').addEventListener('click', () => switchDrawerTab('bookmarks'));
    const tabNotesBtn = document.getElementById('tab-notes-btn');
    if (tabNotesBtn) {
      tabNotesBtn.addEventListener('click', () => switchDrawerTab('notes'));
    }

    document.getElementById('toc-search-input').addEventListener('input', (e) => {
      state.tocSearchQuery = e.target.value;
      renderDrawerToc();
    });

    // Reader Settings Popover Controls
    const settingsBtn = document.getElementById('reader-settings-btn');
    const settingsPopover = document.getElementById('reader-settings-popover');

    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      settingsPopover.classList.toggle('open');
    });

    document.querySelectorAll('[data-dir-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setWritingMode(btn.dataset.dirOpt);
      });
    });

    document.querySelectorAll('[data-pdf-reflow-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setPdfViewMode(btn.dataset.pdfReflowOpt);
      });
    });

    document.querySelectorAll('[data-flip-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.settings.clickFlip = btn.dataset.flipOpt;
        applyReaderSettingsToDOM();
        pushCloudSync();
        const modeText =
          btn.dataset.flipOpt === 'both'
            ? '點右下一頁 / 點左上一頁'
            : btn.dataset.flipOpt === 'left_next'
            ? '點左下一頁 / 點右上一頁'
            : btn.dataset.flipOpt === 'next_only'
            ? '全頁點擊下一頁'
            : '已關閉點擊翻頁';
        showToast(`翻頁模式：${modeText}`);
      });
    });

    document.querySelectorAll('[data-theme-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.settings.theme = btn.dataset.themeOpt;
        applyReaderSettingsToDOM();
        pushCloudSync();
      });
    });

    document.querySelectorAll('[data-convert-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setConvertMode(btn.dataset.convertOpt);
      });
    });

    document.querySelectorAll('[data-font-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.settings.fontFamily = btn.dataset.fontOpt;
        applyReaderSettingsToDOM();
        pushCloudSync();
      });
    });

    document.getElementById('font-dec-btn').addEventListener('click', () => {
      state.settings.fontSize = Math.max(14, (state.settings.fontSize || 19) - 1);
      applyReaderSettingsToDOM();
      pushCloudSync();
    });

    document.getElementById('font-inc-btn').addEventListener('click', () => {
      state.settings.fontSize = Math.min(30, (state.settings.fontSize || 19) + 1);
      applyReaderSettingsToDOM();
      pushCloudSync();
    });

    document.querySelectorAll('[data-lh-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.settings.lineHeight = parseFloat(btn.dataset.lhOpt);
        applyReaderSettingsToDOM();
        pushCloudSync();
      });
    });

    document.querySelectorAll('[data-width-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.settings.maxWidth = parseInt(btn.dataset.widthOpt, 10);
        applyReaderSettingsToDOM();
        pushCloudSync();
      });
    });

    // NAS Connection & Sync Settings Modal
    document.getElementById('nas-settings-btn').addEventListener('click', openNasModal);
    document.getElementById('close-nas-modal-btn').addEventListener('click', closeModals);
    document.getElementById('cancel-nas-modal-btn').addEventListener('click', closeModals);

    document.getElementById('test-webdav-btn').addEventListener('click', async () => {
      const resSpan = document.getElementById('webdav-test-result');
      resSpan.textContent = '連線測試中...';
      resSpan.style.color = 'var(--text-secondary)';

      const inputUrl = document.getElementById('webdav-url-input').value.trim();
      const inputUser = document.getElementById('webdav-user-input').value.trim();
      const inputPass = document.getElementById('webdav-pass-input').value;
      const inputPath = document.getElementById('webdav-path-input').value.trim() || '/';

      if (!inputUrl) {
        resSpan.textContent = '❌ 請先輸入 WebDAV 伺服器網址';
        resSpan.style.color = 'var(--accent)';
        return;
      }

      // If NAS backend server is available, test via backend proxy
      if (state.serverAvailable) {
        try {
          const payload = {
            webdavUrl: inputUrl,
            webdavUsername: inputUser,
            webdavPassword: inputPass,
            webdavBasePath: inputPath
          };
          const res = await apiFetch('/api/webdav/test', {
            method: 'POST',
            body: JSON.stringify(payload)
          });
          resSpan.textContent = `✅ ${res.message}`;
          resSpan.style.color = 'var(--success)';
        } catch (err) {
          resSpan.textContent = `❌ ${err.message}`;
          resSpan.style.color = 'var(--accent)';
        }
        return;
      }

      // If running on static GitHub Pages without backend: test directly from browser
      const tempCfg = {
        webdavUrl: inputUrl,
        webdavUsername: inputUser,
        webdavPassword:
          inputPass === '********' ? state.webdavConfig.webdavPassword : inputPass,
        webdavBasePath: inputPath
      };
      const targetUrl = buildDirectWebdavUrl('/', true, tempCfg);

      try {
        const res = await fetch(targetUrl, {
          method: 'PROPFIND',
          headers: getDirectWebdavHeaders(
            {
              Depth: '1',
              'Content-Type': 'application/xml; charset=utf-8'
            },
            tempCfg
          )
        });

        if (res.ok || res.status === 207) {
          const foundBooks = await listDirectWebdavBooks('/', 0, 2, tempCfg);
          resSpan.textContent = `✅ WebDAV 連線成功！在「${inputPath}」及子資料夾共偵測到 ${foundBooks.length} 本小說。`;
          resSpan.style.color = 'var(--success)';
        } else if (res.status === 405) {
          resSpan.textContent = `❌ HTTP 405：目標路徑 (${targetUrl}) 不支援 PROPFIND，請確認 WebDAV Server 已啟用。`;
          resSpan.style.color = 'var(--accent)';
        } else if (res.status === 401 || res.status === 403) {
          resSpan.textContent = `❌ HTTP ${res.status}：帳號或密碼錯誤，或「${inputUser}」無權限存取「${inputPath}」。`;
          resSpan.style.color = 'var(--accent)';
        } else if (res.status === 404) {
          resSpan.textContent = `❌ HTTP 404：找不到資料夾「${inputPath}」，請檢查路徑名稱是否正確。`;
          resSpan.style.color = 'var(--accent)';
        } else {
          resSpan.textContent = `❌ HTTP ${res.status} ${res.statusText}`;
          resSpan.style.color = 'var(--accent)';
        }
      } catch (err) {
        if (err.name === 'TypeError' && err.message.includes('fetch')) {
          resSpan.innerHTML = `❌ 瀏覽器攔截了跨域或自簽憑證連線。<br/>👉 <a href="${targetUrl}" target="_blank" rel="noopener" style="color: var(--accent); text-decoration: underline; font-weight: 600;">請點此在新分頁開啟 ${targetUrl}</a>，點選「進階 → 繼續前往」信任憑證並輸入帳密驗證；若仍受瀏覽器 CORS 限制，建議於 NAS 啟用 Docker 容器。`;
        } else {
          resSpan.textContent = `❌ ${err.message}`;
        }
        resSpan.style.color = 'var(--accent)';
      }
    });

    document.getElementById('nas-config-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const newSyncKey = document.getElementById('sync-key-input').value.trim() || 'default';
      const newCustomApi = document.getElementById('custom-api-url-input').value.trim();
      const enableWebdav = document.getElementById('enable-webdav-checkbox').checked;
      const webdavUrl = document.getElementById('webdav-url-input').value.trim();
      const webdavUsername = document.getElementById('webdav-user-input').value.trim();
      const webdavPassword = document.getElementById('webdav-pass-input').value;
      const webdavBasePath = document.getElementById('webdav-path-input').value.trim() || '/';

      state.syncKey = newSyncKey;
      state.customApiUrl = newCustomApi;
      localStorage.setItem(STORAGE_KEYS.SYNC_KEY, newSyncKey);
      localStorage.setItem(STORAGE_KEYS.CUSTOM_API, newCustomApi);

      state.webdavConfig = {
        enableWebdav,
        webdavUrl,
        webdavUsername,
        webdavPassword:
          webdavPassword === '********' ? state.webdavConfig.webdavPassword : webdavPassword,
        webdavBasePath
      };
      localStorage.setItem(STORAGE_KEYS.WEBDAV_CFG, JSON.stringify(state.webdavConfig));

      if (state.serverAvailable || newCustomApi) {
        try {
          await apiFetch('/api/config', {
            method: 'POST',
            body: JSON.stringify({
              enableWebdav,
              webdavUrl,
              webdavUsername,
              webdavPassword,
              webdavBasePath
            })
          });
        } catch (_) {}
      }

      closeModals();
      showToast('設定已儲存，正在重新同步書庫與閱讀進度...');
      await loadLibrary();
    });

    // Upload Book Modal
    document.getElementById('upload-book-btn').addEventListener('click', () => {
      document.getElementById('drawer-backdrop').classList.add('open');
      document.getElementById('upload-modal').classList.add('open');
    });
    document.getElementById('close-upload-modal-btn').addEventListener('click', closeModals);
    document.getElementById('cancel-upload-modal-btn').addEventListener('click', closeModals);

    document.getElementById('upload-book-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById('upload-file-input');
      const folderInput = document.getElementById('upload-folder-input');
      const submitBtn = document.getElementById('submit-upload-btn');

      if (!fileInput.files || fileInput.files.length === 0) return;
      const file = fileInput.files[0];
      const folder = folderInput.value.trim() || '個人上傳';

      submitBtn.disabled = true;
      submitBtn.textContent = '正在處理檔案...';

      try {
        const arrayBuffer = await file.arrayBuffer();

        if (state.serverAvailable) {
          // Convert ArrayBuffer to Base64 and upload to NAS /novels folder
          const bytes = new Uint8Array(arrayBuffer);
          let binary = '';
          const chunkSize = 0x8000;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
          }
          const base64Data = btoa(binary);

          await apiFetch('/api/books/upload', {
            method: 'POST',
            body: JSON.stringify({
              filename: file.name,
              folder,
              base64Data
            })
          });

          showToast(`✅ 已成功上傳「${file.name}」至 NAS 書庫`);
          closeModals();
          fileInput.value = '';
          await loadLibrary();
        } else {
          // Pure static mode: parse in memory immediately without backend
          const lowerFileName = file.name.toLowerCase();
          const ext = lowerFileName.endsWith('.epub')
            ? 'epub'
            : lowerFileName.endsWith('.pdf')
            ? 'pdf'
            : lowerFileName.endsWith('.mobi') ||
              lowerFileName.endsWith('.azw3') ||
              lowerFileName.endsWith('.azw')
            ? 'mobi'
            : 'txt';
          let parsed;
          if (ext === 'epub') {
            parsed = await parseEpubClient(arrayBuffer, file.name);
          } else if (ext === 'pdf') {
            parsed = await parsePdfClient(arrayBuffer, file.name);
          } else if (ext === 'mobi') {
            parsed = parseMobiClient(arrayBuffer, file.name);
          } else {
            parsed = parseTxtClient(decodeArrayBufferClient(arrayBuffer), file.name);
          }

          const id = `local_${Date.now()}`;
          const memBook = {
            id,
            source: 'memory',
            relativePath: `${folder}/${file.name}`,
            filename: file.name,
            title: parsed.title,
            originalTitle: parsed.originalTitle,
            author: parsed.author,
            folder,
            originalFolder: folder,
            format: ext,
            rawPdfUrl: parsed.rawPdfUrl || null,
            size: file.size,
            mtime: new Date().toISOString(),
            totalChapters: parsed.totalChapters,
            totalWords: parsed.totalWords,
            chapters: parsed.chapters
          };

          state.inMemoryBooks.set(id, memBook);
          state.books.unshift({
            ...memBook,
            title: convertStr(memBook.originalTitle),
            folder: convertStr(memBook.originalFolder)
          });

          closeModals();
          fileInput.value = '';
          renderLibrary();
          showToast(`✅ 已載入「${convertStr(memBook.originalTitle)}」`);
        }
      } catch (err) {
        showToast(`處理失敗：${err.message}`);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '開始上傳並解析';
      }
    });

    // Sync before page unload or visibility hidden (mobile app switch)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && state.currentBook) {
        scheduleProgressSync();
      }
    });
  }

  function openNasModal() {
    document.getElementById('sync-key-input').value = state.syncKey || 'default';
    document.getElementById('custom-api-url-input').value = state.customApiUrl || '';
    document.getElementById('enable-webdav-checkbox').checked = Boolean(
      state.webdavConfig.enableWebdav
    );
    document.getElementById('webdav-url-input').value = state.webdavConfig.webdavUrl || '';
    document.getElementById('webdav-user-input').value = state.webdavConfig.webdavUsername || '';
    document.getElementById('webdav-pass-input').value = state.webdavConfig.webdavPassword
      ? '********'
      : '';
    document.getElementById('webdav-path-input').value = state.webdavConfig.webdavBasePath || '/';
    document.getElementById('webdav-test-result').textContent = '';

    document.getElementById('drawer-backdrop').classList.add('open');
    document.getElementById('nas-modal').classList.add('open');
  }

  function closeModals() {
    document.getElementById('drawer-backdrop').classList.remove('open');
    document.getElementById('nas-modal').classList.remove('open');
    document.getElementById('upload-modal').classList.remove('open');
  }

  // ==========================================================================
  // 12. Bootstrap Application
  // ==========================================================================
  document.addEventListener('DOMContentLoaded', () => {
    initOpenCC();
    applyReaderSettingsToDOM();
    bindEvents();
    loadLibrary();
  });
})();
