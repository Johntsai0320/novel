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
  // 1. OpenCC Simplified -> Traditional Converter Setup
  // ==========================================================================
  let openccS2TWP = null;
  let openccS2T = null;

  function initOpenCC() {
    if (window.OpenCC && window.OpenCC.Converter) {
      try {
        openccS2TWP = window.OpenCC.Converter({ from: 'cn', to: 'twp' });
        openccS2T = window.OpenCC.Converter({ from: 'cn', to: 'tw' });
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
    if (openccS2TWP) return openccS2TWP(text);
    return text;
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
      enableWebdav: true,
      webdavUrl: 'https://100.85.142.30:5006',
      webdavUsername: 'novel',
      webdavPassword: '',
      webdavBasePath: '/WebDAV/小說'
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
    settings: {
      theme: 'sepia',
      fontSize: 19,
      lineHeight: 1.85,
      fontFamily: 'serif',
      maxWidth: 760,
      convertMode: 's2twp'
    },

    // Active Reader Session
    currentBook: null,      // { id, title, originalTitle, author, totalChapters, chapters: [...] }
    currentChapter: null,   // { index, title, originalTitle, content, blocks, wordCount, prevIndex, nextIndex }
    activeDrawerTab: 'toc',
    tocSearchQuery: '',
    isRestoringScroll: false
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

      if (!/\.(txt|epub)$/i.test(baseName)) return;

      const ext = baseName.toLowerCase().endsWith('.epub') ? 'epub' : 'txt';
      const rawTitle = baseName.replace(/\.(txt|epub)$/i, '');
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

    if (!state.books || state.books.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <h3>找不到符合條件的小說檔案</h3>
          <p>您可以嘗試清除搜尋關鍵字、切換分類標籤，或點擊上方「上傳小說」按鈕。</p>
        </div>
      `;
      return;
    }

    state.books.forEach((book) => {
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
        const parsed =
          bookMeta.format === 'epub'
            ? await parseEpubClient(arrayBuf, bookMeta.filename)
            : parseTxtClient(decodeArrayBufferClient(arrayBuf), bookMeta.filename);
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

    if (chapterData.blocks && Array.isArray(chapterData.blocks) && chapterData.blocks.length > 0) {
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
          // Avoid repeating the chapter title if the first heading matches
          if (block.type === 'heading' && block.text.trim() === displayChTitle.trim()) {
            return;
          }
          const el = document.createElement(block.type === 'heading' ? 'h3' : 'p');
          el.textContent = block.text;
          bodyEl.appendChild(el);
        }
      });
    } else {
      const paragraphs = (chapterData.content || '').split(/\n+/);
      paragraphs.forEach((para) => {
        const trimmed = para.trim();
        if (!trimmed) return;
        const p = document.createElement('p');
        p.textContent = trimmed;
        bodyEl.appendChild(p);
      });
    }

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
      updateScrollRibbon();
      setTimeout(() => {
        state.isRestoringScroll = false;
        scheduleProgressSync();
      }, 150);
    });
  }

  function closeReaderView() {
    scheduleProgressSync();
    document.getElementById('reader-view').classList.remove('active');
    document.getElementById('reader-settings-popover').classList.remove('open');
    closeDrawer();
    document.getElementById('library-view').style.display = 'block';
    renderLibrary();
  }

  function calculateCurrentScrollPercent() {
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
  // 9. TOC & Bookmarks Drawer
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
    const tocList = document.getElementById('drawer-toc-list');
    const bmList = document.getElementById('drawer-bookmarks-list');
    const searchBox = document.getElementById('toc-search-box');

    if (tab === 'toc') {
      tocBtn.classList.add('active');
      bmBtn.classList.remove('active');
      tocList.style.display = 'block';
      bmList.style.display = 'none';
      searchBox.style.display = 'block';
      renderDrawerToc();
    } else {
      bmBtn.classList.add('active');
      tocBtn.classList.remove('active');
      bmList.style.display = 'block';
      tocList.style.display = 'none';
      searchBox.style.display = 'none';
      renderDrawerBookmarks();
    }
  }

  function renderDrawerToc() {
    const listEl = document.getElementById('drawer-toc-list');
    if (!state.currentBook || !state.currentBook.chapters) {
      listEl.innerHTML = '';
      return;
    }

    const q = state.tocSearchQuery.trim().toLowerCase();
    listEl.innerHTML = '';

    state.currentBook.chapters.forEach((ch) => {
      const displayTitle = convertStr(ch.originalTitle || ch.title);
      if (q && !displayTitle.toLowerCase().includes(q)) return;

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
      if (rect.top >= 40 && rect.top <= window.innerHeight * 0.6) {
        excerpt = p.textContent.trim().slice(0, 90);
        break;
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

    const fsDisplay = document.getElementById('font-size-display');
    const fsVal = document.getElementById('font-size-val');
    if (fsDisplay) fsDisplay.textContent = `${s.fontSize}px`;
    if (fsVal) fsVal.textContent = `${s.fontSize} px`;

    updateGlobalConvertButtonUI();
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

      if (e.key === 'ArrowLeft' && state.currentChapter?.prevIndex !== null) {
        loadAndRenderChapter(state.currentChapter.prevIndex, 0);
      } else if (e.key === 'ArrowRight' && state.currentChapter?.nextIndex !== null) {
        loadAndRenderChapter(state.currentChapter.nextIndex, 0);
      } else if (e.key === 'Escape') {
        closeDrawer();
        document.getElementById('reader-settings-popover').classList.remove('open');
      }
    });

    // Scroll listener for progress ribbon & auto-sync
    window.addEventListener(
      'scroll',
      () => {
        if (!document.getElementById('reader-view').classList.contains('active')) return;
        updateScrollRibbon();
        if (!state.isRestoringScroll) {
          scheduleProgressSync();
        }
      },
      { passive: true }
    );

    // Tap center of reader canvas on mobile to toggle topbar visibility
    document.getElementById('reader-canvas').addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      const popover = document.getElementById('reader-settings-popover');
      if (popover.classList.contains('open')) {
        popover.classList.remove('open');
        return;
      }
    });

    // Bookmark & TOC Drawer Controls
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
          const ext = file.name.toLowerCase().endsWith('.epub') ? 'epub' : 'txt';
          const parsed =
            ext === 'epub'
              ? await parseEpubClient(arrayBuffer, file.name)
              : parseTxtClient(decodeArrayBufferClient(arrayBuffer), file.name);

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
