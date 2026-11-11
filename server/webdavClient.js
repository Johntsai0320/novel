const path = require('path');
const cheerio = require('cheerio');

/**
 * Normalize WebDAV base URL and relative path into a full request URL
 */
function buildWebdavUrl(baseUrl, remotePath = '/') {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const cleanRel = ('/' + remotePath.replace(/^\/+/, '')).replace(/\/+/g, '/');
  const encodedSegments = cleanRel
    .split('/')
    .map((seg) => (seg ? encodeURIComponent(decodeURIComponent(seg)) : ''))
    .join('/');
  return `${cleanBase}${encodedSegments}`;
}

/**
 * Build Basic Authorization header for WebDAV
 */
function getAuthHeaders(username, password, extra = {}) {
  const headers = { ...extra };
  if (username || password) {
    const token = Buffer.from(`${username || ''}:${password || ''}`, 'utf8').toString('base64');
    headers['Authorization'] = `Basic ${token}`;
  }
  return headers;
}

/**
 * List files in a WebDAV directory (supports recursive listing up to maxDepth)
 */
async function listWebdavNovels(config, subPath = '/', currentDepth = 0, maxDepth = 2) {
  const { url, username, password, basePath = '/' } = config;
  if (!url) return [];

  const targetDir = path.posix.join('/', basePath || '/', subPath || '/');
  const fullUrl = buildWebdavUrl(url, targetDir);

  const response = await fetch(fullUrl, {
    method: 'PROPFIND',
    headers: getAuthHeaders(username, password, {
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8'
    })
  });

  if (!response.ok && response.status !== 207) {
    throw new Error(`WebDAV 連線回應錯誤 (${response.status} ${response.statusText})`);
  }

  const xmlText = await response.text();
  const $ = cheerio.load(xmlText, { xmlMode: true });

  const results = [];
  const subDirs = [];

  // Parse WebDAV multistatus response nodes
  $('response, d\\:response, D\\:response').each((idx, el) => {
    const hrefRaw = $(el).find('href, d\\:href, D\\:href').first().text().trim();
    if (!hrefRaw) return;

    const decodedHref = decodeURIComponent(hrefRaw);
    const isCollection =
      $(el).find('collection, d\\:collection, D\\:collection').length > 0 ||
      decodedHref.endsWith('/');

    // Skip the current directory entry itself (usually index 0)
    const normalizedTarget = targetDir.replace(/\/+$/, '');
    const hrefPath = decodedHref.replace(/^https?:\/\/[^/]+/i, '').replace(/\/+$/, '');
    if (idx === 0 || hrefPath.endsWith(normalizedTarget)) {
      return;
    }

    const baseName = path.posix.basename(hrefPath);
    if (!baseName || baseName.startsWith('.')) return;

    const relFromSub = path.posix.join(subPath, baseName);

    if (isCollection) {
      if (currentDepth < maxDepth) {
        subDirs.push(relFromSub);
      }
      return;
    }

    const ext = path.posix.extname(baseName).toLowerCase();
    if (ext !== '.txt' && ext !== '.epub') return;

    const sizeText =
      $(el).find('getcontentlength, d\\:getcontentlength, D\\:getcontentlength').first().text().trim() || '0';
    const lastModText =
      $(el).find('getlastmodified, d\\:getlastmodified, D\\:getlastmodified').first().text().trim() || '';

    const folderCategory =
      subPath === '/' || !subPath ? 'WebDAV 根目錄' : subPath.replace(/^\/+|\/+$/g, '');

    results.push({
      source: 'webdav',
      relativePath: relFromSub.replace(/^\/+/, ''),
      filename: baseName,
      folder: folderCategory,
      format: ext.slice(1),
      size: parseInt(sizeText, 10) || 0,
      mtime: lastModText ? new Date(lastModText).toISOString() : new Date().toISOString()
    });
  });

  for (const dir of subDirs) {
    try {
      const childFiles = await listWebdavNovels(config, dir, currentDepth + 1, maxDepth);
      results.push(...childFiles);
    } catch (_) {
      // Ignore inaccessible subdirectory
    }
  }

  return results;
}

/**
 * Fetch a file buffer from WebDAV into memory (no local file download required)
 */
async function fetchWebdavFileBuffer(config, relativePath) {
  const { url, username, password, basePath = '/' } = config;
  const targetFile = path.posix.join('/', basePath || '/', relativePath);
  const fullUrl = buildWebdavUrl(url, targetFile);

  const response = await fetch(fullUrl, {
    method: 'GET',
    headers: getAuthHeaders(username, password)
  });

  if (!response.ok) {
    throw new Error(`無法從 WebDAV 讀取檔案 (${response.status} ${response.statusText})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Save or load JSON sync state directly on the NAS WebDAV folder
 */
async function saveWebdavSyncJson(config, syncData) {
  if (!config || !config.url) return false;
  const { url, username, password, basePath = '/' } = config;
  const targetFile = path.posix.join('/', basePath || '/', '.novel-reader-sync.json');
  const fullUrl = buildWebdavUrl(url, targetFile);

  const response = await fetch(fullUrl, {
    method: 'PUT',
    headers: getAuthHeaders(username, password, {
      'Content-Type': 'application/json; charset=utf-8'
    }),
    body: JSON.stringify(syncData, null, 2)
  });

  return response.ok || response.status === 201 || response.status === 204;
}

async function loadWebdavSyncJson(config) {
  if (!config || !config.url) return null;
  const { url, username, password, basePath = '/' } = config;
  const targetFile = path.posix.join('/', basePath || '/', '.novel-reader-sync.json');
  const fullUrl = buildWebdavUrl(url, targetFile);

  const response = await fetch(fullUrl, {
    method: 'GET',
    headers: getAuthHeaders(username, password)
  });

  if (!response.ok) return null;
  return await response.json();
}

module.exports = {
  listWebdavNovels,
  fetchWebdavFileBuffer,
  saveWebdavSyncJson,
  loadWebdavSyncJson
};
