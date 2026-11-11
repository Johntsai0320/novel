const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  convertText,
  parseTxtBuffer,
  parseEpubBuffer,
  getEpubAsset
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
  return store.profiles[key];
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
 * Recursively scan local NAS mounted directory for .txt and .epub files
 */
function scanLocalNovels(dir, baseDir = dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(scanLocalNovels(fullPath, baseDir));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.txt' || ext === '.epub') {
        const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/');
        const dirName = path.dirname(relPath);
        const folder = dirName === '.' ? '未分類書庫' : dirName;
        const stat = fs.statSync(fullPath);

        results.push({
          source: 'local',
          relativePath: relPath,
          filename: entry.name,
          folder,
          format: ext.slice(1),
          size: stat.size,
          mtime: stat.mtime.toISOString()
        });
      }
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
  const parsed =
    ext === '.epub'
      ? parseEpubBuffer(buffer, path.basename(relativePath), bookId)
      : parseTxtBuffer(buffer, path.basename(relativePath));

  setCache(parsedBookCache, mtimeKey, parsed);
  if (ext === '.epub') {
    setCache(rawBufferCache, mtimeKey, buffer, 6);
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

/**
 * 2. List all books from NAS local folder + optional WebDAV
 */
app.get('/api/books', async (req, res) => {
  try {
    const convertMode = req.query.convert || 's2twp';
    const localFiles = scanLocalNovels(NOVELS_DIR);
    let allFiles = [...localFiles];

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

    let webdavError = null;
    if (activeWebdav && activeWebdav.url) {
      try {
        const remoteFiles = await listWebdavNovels(activeWebdav);
        allFiles = allFiles.concat(remoteFiles);
      } catch (err) {
        webdavError = err.message;
      }
    }

    const books = allFiles.map((item) => {
      const id = encodeBookId(item.source, item.relativePath);
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
        size: item.size,
        mtime: item.mtime
      };
    });

    res.json({
      ok: true,
      total: books.length,
      novelsDir: NOVELS_DIR,
      webdavError,
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
      wordCount: ch.wordCount
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
        content: convertedContent,
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
 * 5. Stream Embedded EPUB Image Assets On-Demand
 */
app.get('/api/books/:id/asset/*assetPath', async (req, res) => {
  try {
    const { id } = req.params;
    const rawParam = req.params.assetPath;
    const assetPath = Array.isArray(rawParam) ? rawParam.join('/') : rawParam || '';
    const headerWebdav = getRequestWebdavConfig(req);

    const { buffer } = await getParsedBook(id, headerWebdav);
    if (!buffer) {
      return res.status(404).end();
    }

    const asset = getEpubAsset(buffer, assetPath);
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
 * 6. Upload .txt or .epub directly to NAS local library via Web UI
 */
app.post('/api/books/upload', (req, res) => {
  try {
    const { filename, folder = '', base64Data } = req.body;
    if (!filename || !base64Data) {
      return res.status(400).json({ ok: false, error: '缺少檔案名稱或內容' });
    }

    const ext = path.extname(filename).toLowerCase();
    if (ext !== '.txt' && ext !== '.epub') {
      return res.status(400).json({ ok: false, error: '僅支援 .txt 與 .epub 格式' });
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
    const { progress, bookmarks, settings, singleProgress } = req.body;

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
});
