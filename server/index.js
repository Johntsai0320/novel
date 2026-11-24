const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  convertText,
  compileBooleanQuery,
  parseTxtBuffer,
  parseEpubBuffer,
  parseMobiBuffer,
  parsePdfBuffer,
  parseCbzBuffer,
  getEpubAsset,
  getZipAsset
} = require('./parsers');
const {
  listWebdavNovels,
  fetchWebdavFileBuffer,
  saveWebdavSyncJson,
  loadWebdavSyncJson
} = require('./webdavClient');

const app = express();
const PORT = process.env.PORT || 3000;

// Resolve novels directory: priority: env NOVELS_DIR -> /novels (container mount) -> local ../novels
let NOVELS_DIR = process.env.NOVELS_DIR;
if (!NOVELS_DIR) {
  if (fs.existsSync('/novels')) {
    NOVELS_DIR = '/novels';
  } else {
    NOVELS_DIR = path.join(__dirname, '..', 'novels');
  }
}
NOVELS_DIR = path.resolve(NOVELS_DIR);

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

// Ensure directories exist
if (!fs.existsSync(NOVELS_DIR)) fs.mkdirSync(NOVELS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SYNC_FILE = path.join(DATA_DIR, 'sync_store.json');
const CONFIG_FILE = path.join(DATA_DIR, 'nas_config.json');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// In-memory LRU cache for parsed books (max 12 books in RAM)
const MAX_CACHE_ITEMS = 12;
const parsedBookCache = new Map();
const rawBufferCache = new Map();

function setCache(map, key, value, maxItems = MAX_CACHE_ITEMS) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > maxItems) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

/**
 * Load NAS configuration (local folder + optional WebDAV settings)
 */
function loadNasConfig() {
  const defaultCfg = {
    webdavUrl: process.env.WEBDAV_URL || '',
    webdavUsername: process.env.WEBDAV_USERNAME || '',
    webdavPassword: process.env.WEBDAV_PASSWORD || '',
    webdavBasePath: process.env.WEBDAV_BASE_PATH || '/',
    enableWebdav: Boolean(process.env.WEBDAV_URL),
    accessPin: process.env.ACCESS_PIN || ''
  };

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return { ...defaultCfg, ...saved };
    } catch (_) {
      return defaultCfg;
    }
  }
  return defaultCfg;
}

function saveNasConfig(newCfg) {
  const current = loadNasConfig();
  const merged = { ...current, ...newCfg };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

/**
 * Load & save multi-device reading synchronization store
 */
function loadSyncStore() {
  if (fs.existsSync(SYNC_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8'));
    } catch (_) {
      return { profiles: {} };
    }
  }
  return { profiles: {} };
}

function saveSyncStore(store) {
  fs.writeFileSync(SYNC_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function getProfileData(store, syncKey = 'default') {
  const key = (syncKey || 'default').trim() || 'default';
  if (!store.profiles) store.profiles = {};
  if (!store.profiles[key]) {
    store.profiles[key] = {
      syncKey: key,
      updatedAt: new Date().toISOString(),
      progress: {},
      bookmarks: {},
      annotations: {},
      bookStatus: {},
      settings: {
        theme: 'sepia',
        fontSize: 19,
        lineHeight: 1.85,
        fontFamily: 'serif',
        maxWidth: 760,
        convertMode: 's2twp'
      }
    };
  }
  if (!store.profiles[key].annotations) {
    store.profiles[key].annotations = {};
  }
  if (!store.profiles[key].bookStatus) {
    store.profiles[key].bookStatus = {};
  }
  return store.profiles[key];
}

const VALID_PUB_STATUSES = new Set(['ongoing', 'completed', 'oneshot', 'hiatus']);
const VALID_READ_STATUSES = new Set(['unread', 'reading', 'finished', 'dropped']);

function inferAutoPubStatus(folder, filename) {
  const target = `${folder || ''} ${filename || ''}`;
  if (/完結|完结|完本|全本|全集|大結局|大结局|\(完\)|\[完\]|【完】/i.test(target)) {
    return 'completed';
  }
  if (/連載|连载|更新中/i.test(target)) {
    return 'ongoing';
  }
  if (/全一冊|全一册|單行本|单行本|短篇/i.test(target)) {
    return 'oneshot';
  }
  if (/斷尾|断尾|斷更|断更|太監|太监|棄坑|弃坑/i.test(target)) {
    return 'hiatus';
  }
  return '';
}

function deriveBookPubStatus(item, profile, bookId) {
  const manual = profile?.bookStatus?.[bookId]?.pubStatus;
  if (manual && VALID_PUB_STATUSES.has(manual)) return manual;
  if (item._autoPubStatus !== undefined) return item._autoPubStatus;
  return (item._autoPubStatus = inferAutoPubStatus(item.folder, item.filename));
}

function deriveBookReadStatus(profile, bookId) {
  const manual = profile?.bookStatus?.[bookId]?.readStatus;
  if (manual && VALID_READ_STATUSES.has(manual)) return manual;
  const prog = profile?.progress?.[bookId];
  if (!prog) return 'unread';
  const totalCh = Math.max(1, prog.totalChapters || 1);
  const chIdx = prog.chapterIndex || 0;
  const pct = prog.scrollPercent || 0;
  if (chIdx >= totalCh - 1 && pct >= 92) {
    return 'finished';
  }
  return 'reading';
}

/**
 * Encode / Decode book ID safely
 * Format: source::relativePath (base64url)
 */
function encodeBookId(source, relativePath) {
  return Buffer.from(`${source}::${relativePath}`, 'utf8').toString('base64url');
}

function decodeBookId(bookId) {
  const decoded = Buffer.from(bookId, 'base64url').toString('utf8');
  const sepIndex = decoded.indexOf('::');
  if (sepIndex === -1) {
    return { source: 'local', relativePath: decoded };
  }
  return {
    source: decoded.slice(0, sepIndex),
    relativePath: decoded.slice(sepIndex + 2)
  };
}

/**
 * Recursively scan local NAS mounted directory for .txt, .epub, .pdf, .mobi, .azw3, .cbz files
 */
const SUPPORTED_EXTS = new Set(['.txt', '.epub', '.pdf', '.mobi', '.azw3', '.azw', '.cbz']);
const INDEX_CACHE_FILE = path.join(DATA_DIR, 'library_index_cache.json');

function buildLocalBookItem(baseDir, fullPath, entryName) {
  const ext = path.extname(entryName).toLowerCase();
  const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/');
  const dirName = path.dirname(relPath);
  const folder = dirName === '.' ? '未分類書庫' : dirName;
  const rawFormat = ext.slice(1);
  const normalizedFormat = rawFormat === 'azw' || rawFormat === 'azw3' ? 'mobi' : rawFormat;
  return {
    source: 'local',
    fullPath,
    relativePath: relPath,
    filename: entryName,
    folder,
    format: normalizedFormat,
    size: 0,
    mtime: '',
    _id: encodeBookId('local', relPath),
    _autoPubStatus: inferAutoPubStatus(folder, entryName),
    searchKey: `${entryName} ${folder} ${relPath}`.toLowerCase()
  };
}

function scanLocalNovels(dir, baseDir = dir, results = []) {
  if (!fs.existsSync(dir)) return results;

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return results;
  }

  for (const entry of entries) {
    if (
      entry.name.startsWith('.') ||
      entry.name === '@eaDir' ||
      entry.name === '#recycle'
    ) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanLocalNovels(fullPath, baseDir, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTS.has(ext)) {
        results.push(buildLocalBookItem(baseDir, fullPath, entry.name));
      }
    }
  }
  return results;
}

async function scanLocalNovelsAsync(baseDir) {
  const results = [];
  if (!fs.existsSync(baseDir)) return results;

  const stack = [baseDir];
  let dirsProcessed = 0;

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      if (
        entry.name.startsWith('.') ||
        entry.name === '@eaDir' ||
        entry.name === '#recycle'
      ) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) {
          results.push(buildLocalBookItem(baseDir, fullPath, entry.name));
        }
      }
    }

    dirsProcessed++;
    if (dirsProcessed % 20 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return results;
}

/**
 * Load and parse a book by its encoded bookId
 */
async function getParsedBook(bookId, customWebdavHeader = null) {
  const { source, relativePath } = decodeBookId(bookId);

  let buffer;
  let mtimeKey = '';

  if (source === 'local') {
    const safeRel = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.join(NOVELS_DIR, safeRel);
    if (!fullPath.startsWith(NOVELS_DIR) || !fs.existsSync(fullPath)) {
      throw new Error('找不到指定的小說檔案');
    }
    const stat = fs.statSync(fullPath);
    mtimeKey = `${bookId}:${stat.mtimeMs}:${stat.size}`;
    if (parsedBookCache.has(mtimeKey)) {
      return { parsed: parsedBookCache.get(mtimeKey), buffer: rawBufferCache.get(mtimeKey) };
    }
    buffer = fs.readFileSync(fullPath);
  } else if (source === 'webdav') {
    const cfg = customWebdavHeader || loadNasConfig();
    const webdavCfg = {
      url: cfg.webdavUrl || cfg.url,
      username: cfg.webdavUsername || cfg.username,
      password: cfg.webdavPassword || cfg.password,
      basePath: cfg.webdavBasePath || cfg.basePath || '/'
    };
    mtimeKey = `${bookId}:webdav`;
    if (parsedBookCache.has(mtimeKey)) {
      return { parsed: parsedBookCache.get(mtimeKey), buffer: rawBufferCache.get(mtimeKey) };
    }
    buffer = await fetchWebdavFileBuffer(webdavCfg, relativePath);
  } else {
    throw new Error('不支援的檔案來源');
  }

  const ext = path.extname(relativePath).toLowerCase();
  let parsed;
  if (ext === '.epub') {
    parsed = parseEpubBuffer(buffer, path.basename(relativePath), bookId);
  } else if (ext === '.cbz') {
    parsed = parseCbzBuffer(buffer, path.basename(relativePath), bookId);
  } else if (ext === '.pdf') {
    parsed = await parsePdfBuffer(buffer, path.basename(relativePath), bookId);
  } else if (ext === '.mobi' || ext === '.azw3' || ext === '.azw') {
    parsed = parseMobiBuffer(buffer, path.basename(relativePath));
  } else {
    parsed = parseTxtBuffer(buffer, path.basename(relativePath));
  }

  setCache(parsedBookCache, mtimeKey, parsed);
  if (ext === '.epub' || ext === '.pdf' || ext === '.cbz') {
    setCache(rawBufferCache, mtimeKey, buffer, 8);
  }

  return { parsed, buffer };
}

/**
 * Helper to extract optional runtime WebDAV config passed from frontend headers
 */
function getRequestWebdavConfig(req) {
  const headerVal = req.headers['x-webdav-config'];
  if (!headerVal) return null;
  try {
    return JSON.parse(Buffer.from(headerVal, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

// ============================================================================
// API ROUTES
// ============================================================================

/**
 * 1. Health & Server Info
 */
app.get('/api/health', (req, res) => {
  const cfg = loadNasConfig();
  res.json({
    ok: true,
    mode: 'nas-server',
    novelsDir: NOVELS_DIR,
    webdavEnabled: Boolean(cfg.enableWebdav && cfg.webdavUrl),
    requiresPin: Boolean(cfg.accessPin),
    timestamp: new Date().toISOString()
  });
});

// Global cached file index for high-speed response with 50,000+ novels
let cachedNovelsIndex = null;
let lastScanTime = 0;
let activeScanPromise = null;
const SCAN_CACHE_TTL_MS = 30 * 60 * 1000; // Refresh index in background every 30 minutes

function loadDiskIndexCache() {
  try {
    if (!fs.existsSync(INDEX_CACHE_FILE)) return false;
    const raw = JSON.parse(fs.readFileSync(INDEX_CACHE_FILE, 'utf8'));
    if (raw && raw.novelsDir === NOVELS_DIR && Array.isArray(raw.items)) {
      cachedNovelsIndex = raw.items.map((item) => ({
        ...item,
        fullPath: path.join(NOVELS_DIR, item.relativePath),
        _id: item._id || encodeBookId('local', item.relativePath),
        _autoPubStatus:
          item._autoPubStatus !== undefined
            ? item._autoPubStatus
            : inferAutoPubStatus(item.folder, item.filename),
        searchKey: item.searchKey || `${item.filename} ${item.folder} ${item.relativePath}`.toLowerCase()
      }));
      lastScanTime = raw.scannedAt || 0;
      console.log(`[Cache] Loaded ${cachedNovelsIndex.length} novels from disk index cache.`);
      return true;
    }
  } catch (_) {}
  return false;
}

function saveDiskIndexCache(items) {
  try {
    const slimItems = items.map((item) => ({
      source: item.source,
      relativePath: item.relativePath,
      filename: item.filename,
      folder: item.folder,
      format: item.format,
      _id: item._id,
      _autoPubStatus: item._autoPubStatus
    }));
    fs.writeFile(
      INDEX_CACHE_FILE,
      JSON.stringify({
        novelsDir: NOVELS_DIR,
        scannedAt: Date.now(),
        items: slimItems
      }),
      'utf8',
      () => {}
    );
  } catch (_) {}
}

function refreshNovelsIndexInBackground() {
  if (activeScanPromise) return activeScanPromise;
  activeScanPromise = (async () => {
    try {
      console.log(`[Cache] Async scanning novels directory: ${NOVELS_DIR}`);
      const scanned = await scanLocalNovelsAsync(NOVELS_DIR);
      cachedNovelsIndex = scanned;
      lastScanTime = Date.now();
      console.log(`[Cache] Indexed ${cachedNovelsIndex.length} novels.`);
      saveDiskIndexCache(scanned);
      return scanned;
    } finally {
      activeScanPromise = null;
    }
  })();
  return activeScanPromise;
}

async function getCachedNovelsListAsync() {
  const now = Date.now();
  if (!cachedNovelsIndex) {
    loadDiskIndexCache();
  }
  if (cachedNovelsIndex) {
    if (now - lastScanTime > SCAN_CACHE_TTL_MS) {
      refreshNovelsIndexInBackground().catch(() => {});
    }
    return cachedNovelsIndex;
  }
  return await refreshNovelsIndexInBackground();
}

/**
 * 2. List books with server-side pagination, boolean search, folder & status filtering
 */
app.get('/api/books', async (req, res) => {
  try {
    const convertMode = req.query.convert || 's2twp';
    const syncKey = req.query.syncKey || req.headers['x-sync-key'] || 'default';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 60));
    const search = (req.query.q || '').trim();
    const folderFilter = req.query.folder || 'ALL';
    const formatFilter = req.query.format || 'ALL';
    const pubStatusFilter = req.query.pubStatus || 'ALL';
    const readStatusFilter = req.query.readStatus || 'ALL';
    const sortBy = req.query.sort || 'recent';

    const syncStore = loadSyncStore();
    const profile = getProfileData(syncStore, syncKey);

    const localFiles = await getCachedNovelsListAsync();
    let allFiles = localFiles;

    // Optional WebDAV addition if enabled
    const cfg = loadNasConfig();
    const headerWebdav = getRequestWebdavConfig(req);
    const activeWebdav =
      headerWebdav && headerWebdav.url
        ? headerWebdav
        : cfg.enableWebdav && cfg.webdavUrl
        ? {
            url: cfg.webdavUrl,
            username: cfg.webdavUsername,
            password: cfg.webdavPassword,
            basePath: cfg.webdavBasePath
          }
        : null;

    if (activeWebdav && activeWebdav.url) {
      try {
        const remoteFiles = await listWebdavNovels(activeWebdav);
        allFiles = allFiles.concat(remoteFiles);
      } catch (err) {}
    }

    // Collect top folders and counts without looping entire list repeatedly
    const folderCounts = {};
    for (const item of allFiles) {
      folderCounts[item.folder] = (folderCounts[item.folder] || 0) + 1;
    }

    // Filter books by folder, format, and boolean search first
    let filtered = allFiles;
    if (folderFilter !== 'ALL') {
      filtered = filtered.filter((item) => item.folder === folderFilter);
    }
    if (formatFilter !== 'ALL') {
      filtered = filtered.filter((item) => item.format === formatFilter);
    }
    if (search) {
      const matchQuery = compileBooleanQuery(search);
      filtered = filtered.filter((item) => {
        const target =
          item.searchKey ||
          (item.searchKey = `${item.filename || ''} ${item.folder || ''} ${item.relativePath || ''}`.toLowerCase());
        return matchQuery(target);
      });
    }

    // Compute classification counts and filter by pubStatus / readStatus
    const pubCounts = { ALL: filtered.length, ongoing: 0, completed: 0, oneshot: 0, hiatus: 0 };
    const readCounts = { ALL: filtered.length, unread: 0, reading: 0, finished: 0, dropped: 0 };
    const statusMatched = [];

    for (const item of filtered) {
      const id = item._id || (item._id = encodeBookId(item.source, item.relativePath));
      const pStatus = deriveBookPubStatus(item, profile, id);
      const rStatus = deriveBookReadStatus(profile, id);
      if (pStatus && pubCounts[pStatus] !== undefined) pubCounts[pStatus]++;
      if (rStatus && readCounts[rStatus] !== undefined) readCounts[rStatus]++;

      if (pubStatusFilter !== 'ALL' && pStatus !== pubStatusFilter) continue;
      if (readStatusFilter !== 'ALL' && rStatus !== readStatusFilter) continue;

      statusMatched.push({ item, id, pStatus, rStatus });
    }

    // Sort books
    if (sortBy === 'recent') {
      statusMatched.sort((a, b) => {
        const ta = profile.progress?.[a.id]?.updatedAt || '';
        const tb = profile.progress?.[b.id]?.updatedAt || '';
        if (ta !== tb) return tb.localeCompare(ta);
        return 0;
      });
    } else if (sortBy === 'title') {
      statusMatched.sort((a, b) => a.item.filename.localeCompare(b.item.filename, 'zh-Hant'));
    } else if (sortBy === 'size') {
      statusMatched.sort((a, b) => (b.item.size || 0) - (a.item.size || 0));
    } else if (sortBy === 'mtime') {
      statusMatched.sort((a, b) => (b.item.mtime || '').localeCompare(a.item.mtime || ''));
    }

    const totalCount = statusMatched.length;
    const startIndex = (page - 1) * limit;
    const pagedItems = statusMatched.slice(startIndex, startIndex + limit);

    // Convert & lazily stat only the items on the current page (instant response!)
    const books = pagedItems.map(({ item, id, pStatus, rStatus }) => {
      if (item.source === 'local' && !item.size && item.fullPath) {
        try {
          const st = fs.statSync(item.fullPath);
          item.size = st.size;
          item.mtime = st.mtime.toISOString();
        } catch (_) {}
      }
      const rawTitle = path.basename(item.filename, path.extname(item.filename));
      return {
        id,
        source: item.source,
        relativePath: item.relativePath,
        filename: item.filename,
        title: convertText(rawTitle, convertMode),
        originalTitle: rawTitle,
        folder: convertText(item.folder, convertMode),
        originalFolder: item.folder,
        format: item.format,
        pubStatus: pStatus,
        readStatus: rStatus,
        size: item.size,
        mtime: item.mtime
      };
    });

    res.json({
      ok: true,
      total: totalCount,
      totalAll: allFiles.length,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
      folders: folderCounts,
      statusCounts: { pub: pubCounts, read: readCounts },
      novelsDir: NOVELS_DIR,
      books
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * 3. Get Book Table of Contents & Metadata (No full book download!)
 */
app.get('/api/books/:id/toc', async (req, res) => {
  try {
    const { id } = req.params;
    const convertMode = req.query.convert || 's2twp';
    const headerWebdav = getRequestWebdavConfig(req);

    const { parsed } = await getParsedBook(id, headerWebdav);

    const chapters = parsed.chapters.map((ch) => ({
      index: ch.index,
      title: convertText(ch.title, convertMode),
      originalTitle: ch.title,
      wordCount: ch.wordCount,
      pageCount: ch.pageCount || null
    }));

    res.json({
      ok: true,
      book: {
        id,
        title: convertText(parsed.title, convertMode),
        originalTitle: parsed.title,
        author: convertText(parsed.author, convertMode),
        description: convertText(parsed.description, convertMode),
        format: parsed.format,
        encoding: parsed.encoding,
        isComic: Boolean(parsed.isComic),
        comicPageCount: parsed.comicPageCount || null,
        mangaRtl: parsed.mangaRtl !== undefined ? Boolean(parsed.mangaRtl) : true,
        rawPdfUrl: parsed.rawPdfUrl || null,
        pdfPageCount: parsed.pdfPageCount || null,
        pdfReflowed: Boolean(parsed.pdfReflowed),
        pdfReflowStats: parsed.pdfReflowStats || null,
        totalChapters: parsed.totalChapters,
        totalWords: parsed.totalWords,
        chapters
      }
    });
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

/**
 * 3b. Stream Raw File (e.g. Native PDF Viewer stream or offline original file download)
 */
app.get('/api/books/:id/raw', async (req, res) => {
  try {
    const { id } = req.params;
    const { source, relativePath } = decodeBookId(id);
    const filename = path.basename(relativePath) || 'book';
    const ext = path.extname(filename).toLowerCase();
    const isDownload = req.query.download === '1' || req.query.download === 'true';

    const contentType =
      ext === '.pdf'
        ? 'application/pdf'
        : ext === '.epub'
        ? 'application/epub+zip'
        : ext === '.cbz'
        ? 'application/vnd.comicbook+zip'
        : ext === '.txt'
        ? 'text/plain; charset=utf-8'
        : ext === '.mobi' || ext === '.azw' || ext === '.azw3'
        ? 'application/x-mobipocket-ebook'
        : 'application/octet-stream';

    const asciiFallbackName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || `book${ext}`;
    const disposition = isDownload
      ? `attachment; filename="${asciiFallbackName}"; filename*=UTF-8''${encodeURIComponent(filename)}`
      : 'inline';

    if (source === 'local') {
      const safeRel = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
      const fullPath = path.join(NOVELS_DIR, safeRel);
      if (!fullPath.startsWith(NOVELS_DIR) || !fs.existsSync(fullPath)) {
        return res.status(404).end();
      }
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', disposition);
      return res.sendFile(fullPath);
    }

    const headerWebdav = getRequestWebdavConfig(req);
    let { buffer } = await getParsedBook(id, headerWebdav);
    if (!buffer && source === 'webdav') {
      const cfg = headerWebdav || loadNasConfig();
      buffer = await fetchWebdavFileBuffer(
        {
          url: cfg.webdavUrl || cfg.url,
          username: cfg.webdavUsername || cfg.username,
          password: cfg.webdavPassword || cfg.password,
          basePath: cfg.webdavBasePath || cfg.basePath || '/'
        },
        relativePath
      );
    }
    if (!buffer) return res.status(404).end();

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', disposition);
    res.send(buffer);
  } catch (_) {
    res.status(404).end();
  }
});

/**
 * 4. Stream Single Chapter Content On-Demand (Simplified -> Traditional converted)
 */
app.get('/api/books/:id/chapter/:index', async (req, res) => {
  try {
    const { id, index } = req.params;
    const chIdx = parseInt(index, 10);
    const convertMode = req.query.convert || 's2twp';
    const headerWebdav = getRequestWebdavConfig(req);

    const { parsed } = await getParsedBook(id, headerWebdav);
    if (isNaN(chIdx) || chIdx < 0 || chIdx >= parsed.chapters.length) {
      return res.status(404).json({ ok: false, error: '章節索引超出範圍' });
    }

    const chapter = parsed.chapters[chIdx];
    const convertedContent = convertText(chapter.content, convertMode);
    const convertedRawLineContent = chapter.rawLineContent
      ? convertText(chapter.rawLineContent, convertMode)
      : null;

    let convertedBlocks = null;
    if (chapter.blocks && Array.isArray(chapter.blocks)) {
      convertedBlocks = chapter.blocks.map((b) => {
        if (b.type === 'image') return b;
        return {
          ...b,
          text: convertText(b.text, convertMode)
        };
      });
    }

    res.json({
      ok: true,
      bookId: id,
      bookTitle: convertText(parsed.title, convertMode),
      totalChapters: parsed.totalChapters,
      chapter: {
        index: chapter.index,
        title: convertText(chapter.title, convertMode),
        originalTitle: chapter.title,
        wordCount: chapter.wordCount,
        pageCount: chapter.pageCount || null,
        content: convertedContent,
        rawLineContent: convertedRawLineContent,
        blocks: convertedBlocks,
        prevIndex: chIdx > 0 ? chIdx - 1 : null,
        nextIndex: chIdx < parsed.chapters.length - 1 ? chIdx + 1 : null
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * 5. Stream Embedded EPUB / CBZ Image Assets On-Demand
 */
app.get('/api/books/:id/asset/*assetPath', async (req, res) => {
  try {
    const { id } = req.params;
    const rawParam = req.params.assetPath;
    const assetPath = Array.isArray(rawParam) ? rawParam.join('/') : rawParam || '';
    const headerWebdav = getRequestWebdavConfig(req);

    let { buffer } = await getParsedBook(id, headerWebdav);
    if (!buffer) {
      // Fallback: if rawBufferCache evicted buffer, re-read directly
      const { source, relativePath } = decodeBookId(id);
      if (source === 'local') {
        const safeRel = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
        const fullPath = path.join(NOVELS_DIR, safeRel);
        if (fullPath.startsWith(NOVELS_DIR) && fs.existsSync(fullPath)) {
          buffer = fs.readFileSync(fullPath);
        }
      }
    }
    if (!buffer) {
      return res.status(404).end();
    }

    const asset = (getZipAsset || getEpubAsset)(buffer, assetPath);
    if (!asset) {
      return res.status(404).end();
    }

    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(asset.data);
  } catch (_) {
    res.status(404).end();
  }
});

/**
 * 6. Upload .txt, .epub, .pdf, .mobi, or .cbz directly to NAS local library via Web UI
 */
app.post('/api/books/upload', (req, res) => {
  try {
    const { filename, folder = '', base64Data } = req.body;
    if (!filename || !base64Data) {
      return res.status(400).json({ ok: false, error: '缺少檔案名稱或內容' });
    }

    const ext = path.extname(filename).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) {
      return res.status(400).json({ ok: false, error: '僅支援 .txt, .epub, .pdf, .mobi, .azw3, .cbz 格式' });
    }

    const safeFolder = folder
      ? path.normalize(folder).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\/+/, '')
      : '';
    const targetDir = safeFolder ? path.join(NOVELS_DIR, safeFolder) : NOVELS_DIR;
    if (!targetDir.startsWith(NOVELS_DIR)) {
      return res.status(400).json({ ok: false, error: '不合法的資料夾路徑' });
    }

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const safeFilename = path.basename(filename);
    const targetPath = path.join(targetDir, safeFilename);
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(targetPath, buffer);

    // Update index incrementally so newly uploaded book appears immediately without full 50k+ rescan
    const uploadedItem = buildLocalBookItem(NOVELS_DIR, targetPath, safeFilename);
    if (Array.isArray(cachedNovelsIndex)) {
      const existingIdx = cachedNovelsIndex.findIndex((x) => x._id === uploadedItem._id);
      if (existingIdx >= 0) cachedNovelsIndex[existingIdx] = uploadedItem;
      else cachedNovelsIndex.unshift(uploadedItem);
      saveDiskIndexCache(cachedNovelsIndex);
    } else {
      refreshNovelsIndexInBackground().catch(() => {});
    }

    res.json({
      ok: true,
      message: `已成功儲存至 NAS 書庫：${safeFilename}`
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * 7. Multi-Device Online Reading Record Sync (GET & POST)
 */
app.get('/api/sync', async (req, res) => {
  try {
    const syncKey = req.query.syncKey || req.headers['x-sync-key'] || 'default';
    const store = loadSyncStore();
    const profile = getProfileData(store, syncKey);

    // If WebDAV sync is also active and local profile is empty, try loading from WebDAV
    const cfg = loadNasConfig();
    if (
      Object.keys(profile.progress).length === 0 &&
      cfg.enableWebdav &&
      cfg.webdavUrl
    ) {
      try {
        const remoteStore = await loadWebdavSyncJson({
          url: cfg.webdavUrl,
          username: cfg.webdavUsername,
          password: cfg.webdavPassword,
          basePath: cfg.webdavBasePath
        });
        if (remoteStore && remoteStore.profiles && remoteStore.profiles[syncKey]) {
          store.profiles[syncKey] = remoteStore.profiles[syncKey];
          saveSyncStore(store);
        }
      } catch (_) {
        // Ignore remote sync fetch error
      }
    }

    res.json({
      ok: true,
      syncKey,
      data: getProfileData(store, syncKey)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const syncKey = req.body.syncKey || req.headers['x-sync-key'] || 'default';
    const { progress, bookmarks, annotations, bookStatus, settings, singleProgress } = req.body;

    const store = loadSyncStore();
    const profile = getProfileData(store, syncKey);

    // Merge single book progress update (most common during reading)
    if (singleProgress && singleProgress.bookId) {
      const existing = profile.progress[singleProgress.bookId];
      if (
        !existing ||
        !existing.updatedAt ||
        new Date(singleProgress.updatedAt || Date.now()) >= new Date(existing.updatedAt)
      ) {
        profile.progress[singleProgress.bookId] = {
          ...existing,
          ...singleProgress,
          updatedAt: singleProgress.updatedAt || new Date().toISOString()
        };
      }
    }

    // Merge full progress map if provided
    if (progress && typeof progress === 'object') {
      for (const [bId, item] of Object.entries(progress)) {
        const existing = profile.progress[bId];
        if (
          !existing ||
          !existing.updatedAt ||
          new Date(item.updatedAt || 0) >= new Date(existing.updatedAt)
        ) {
          profile.progress[bId] = { ...existing, ...item };
        }
      }
    }

    // Merge bookmarks map if provided
    if (bookmarks && typeof bookmarks === 'object') {
      profile.bookmarks = {
        ...profile.bookmarks,
        ...bookmarks
      };
    }

    // Merge annotations (highlights, notes, handwriting ink strokes) if provided
    if (annotations && typeof annotations === 'object') {
      profile.annotations = {
        ...(profile.annotations || {}),
        ...annotations
      };
    }

    // Merge bookStatus classification (pubStatus & readStatus) if provided
    if (bookStatus && typeof bookStatus === 'object') {
      if (!profile.bookStatus) profile.bookStatus = {};
      for (const [bId, item] of Object.entries(bookStatus)) {
        if (!item || typeof item !== 'object') continue;
        const existing = profile.bookStatus[bId];
        if (
          !existing ||
          !existing.updatedAt ||
          new Date(item.updatedAt || 0) >= new Date(existing.updatedAt)
        ) {
          profile.bookStatus[bId] = {
            ...existing,
            ...item
          };
        }
      }
    }

    // Merge reader settings if provided
    if (settings && typeof settings === 'object') {
      profile.settings = {
        ...profile.settings,
        ...settings
      };
    }

    profile.updatedAt = new Date().toISOString();
    saveSyncStore(store);

    // Mirror asynchronously to WebDAV NAS folder if configured
    const cfg = loadNasConfig();
    if (cfg.enableWebdav && cfg.webdavUrl) {
      saveWebdavSyncJson(
        {
          url: cfg.webdavUrl,
          username: cfg.webdavUsername,
          password: cfg.webdavPassword,
          basePath: cfg.webdavBasePath
        },
        store
      ).catch(() => {});
    }

    res.json({
      ok: true,
      syncKey,
      updatedAt: profile.updatedAt,
      data: profile
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * 8. NAS & WebDAV Connection Configuration API
 */
app.get('/api/config', (req, res) => {
  const cfg = loadNasConfig();
  res.json({
    ok: true,
    config: {
      novelsDir: NOVELS_DIR,
      webdavUrl: cfg.webdavUrl,
      webdavUsername: cfg.webdavUsername,
      webdavHasPassword: Boolean(cfg.webdavPassword),
      webdavBasePath: cfg.webdavBasePath || '/',
      enableWebdav: Boolean(cfg.enableWebdav)
    }
  });
});

app.post('/api/config', async (req, res) => {
  try {
    const {
      webdavUrl,
      webdavUsername,
      webdavPassword,
      webdavBasePath,
      enableWebdav
    } = req.body;

    const current = loadNasConfig();
    const updated = saveNasConfig({
      webdavUrl: webdavUrl !== undefined ? webdavUrl.trim() : current.webdavUrl,
      webdavUsername: webdavUsername !== undefined ? webdavUsername.trim() : current.webdavUsername,
      webdavPassword:
        webdavPassword !== undefined && webdavPassword !== '********'
          ? webdavPassword
          : current.webdavPassword,
      webdavBasePath: webdavBasePath !== undefined ? webdavBasePath.trim() || '/' : current.webdavBasePath,
      enableWebdav: enableWebdav !== undefined ? Boolean(enableWebdav) : current.enableWebdav
    });

    // Clear cache when config changes
    parsedBookCache.clear();
    rawBufferCache.clear();

    res.json({
      ok: true,
      message: 'NAS 連線設定已儲存',
      config: {
        novelsDir: NOVELS_DIR,
        webdavUrl: updated.webdavUrl,
        webdavUsername: updated.webdavUsername,
        webdavHasPassword: Boolean(updated.webdavPassword),
        webdavBasePath: updated.webdavBasePath,
        enableWebdav: updated.enableWebdav
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/webdav/test', async (req, res) => {
  try {
    const current = loadNasConfig();
    const testCfg = {
      url: (req.body.webdavUrl || current.webdavUrl || '').trim(),
      username: (req.body.webdavUsername ?? current.webdavUsername ?? '').trim(),
      password:
        req.body.webdavPassword && req.body.webdavPassword !== '********'
          ? req.body.webdavPassword
          : current.webdavPassword,
      basePath: (req.body.webdavBasePath || current.webdavBasePath || '/').trim()
    };

    if (!testCfg.url) {
      return res.status(400).json({ ok: false, error: '請輸入 WebDAV 伺服器網址' });
    }

    const files = await listWebdavNovels(testCfg, '/', 0, 1);
    res.json({
      ok: true,
      message: `連線成功！在目標資料夾偵測到 ${files.length} 本小說檔案。`,
      count: files.length
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: `WebDAV 連線測試失敗：${err.message}` });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`📚 雲端書閣 NAS 小說閱讀平台已啟動`);
  console.log(`🌐 存取網址: http://localhost:${PORT}`);
  console.log(`📂 本機 NAS 掛載書庫路徑: ${NOVELS_DIR}`);
  console.log(`💾 閱讀紀錄同步儲存路徑: ${DATA_DIR}`);
  console.log(`====================================================`);
  loadDiskIndexCache();
  refreshNovelsIndexInBackground().catch(() => {});
});
