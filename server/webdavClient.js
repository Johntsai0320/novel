const path = require('path');
const cheerio = require('cheerio');

// Allow connecting to private NAS / Tailscale HTTPS endpoints with self-signed certificates
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/**
 * Normalize WebDAV base URL and relative path into a full request URL.
 * Intelligently handles cases where the user includes part of the path in baseUrl.
 */
function buildWebdavUrl(baseUrl, remotePath = '/', isDirectory = false) {
  const parsedUrl = new URL(baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`);
  const origin = parsedUrl.origin;
  const urlPath = decodeURIComponent(parsedUrl.pathname || '/').replace(/\/+$/, '');

  let cleanRel = ('/' + remotePath.replace(/^\/+/, '')).replace(/\/+/g, '/');

  // Avoid duplicating base path if user put /WebDAV/小說 in both URL and basePath
  let combinedPath = cleanRel;
  if (urlPath && urlPath !== '/') {
    if (!cleanRel.startsWith(urlPath)) {
      combinedPath = path.posix.join(urlPath, cleanRel);
    }
  }

  const encodedSegments = combinedPath
    .split('/')
    .map((seg) => (seg ? encodeURIComponent(decodeURIComponent(seg)) : ''))
    .join('/');

  let finalUrl = `${origin}${encodedSegments.startsWith('/') ? '' : '/'}${encodedSegments}`;
  if (isDirectory && !finalUrl.endsWith('/')) {
    finalUrl += '/';
  }
  return finalUrl;
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
 * List files in a WebDAV directory (supports recursive listing up to maxDepth = 4)
 */
async function listWebdavNovels(config, subPath = '/', currentDepth = 0, maxDepth = 4) {
  const { url, username, password, basePath = '/' } = config;
  if (!url) return [];

  const targetDir = path.posix.join('/', basePath || '/', subPath || '/');
  const fullUrl = buildWebdavUrl(url, targetDir, true);

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

  const fullUrlObj = new URL(fullUrl);
  const currentReqPath = decodeURIComponent(fullUrlObj.pathname).replace(/\/+$/, '');

  // Parse WebDAV multistatus response nodes
  $('response, d\\:response, D\\:response, lp1\\:response').each((idx, el) => {
    const hrefRaw = $(el).find('href, d\\:href, D\\:href').first().text().trim();
    if (!hrefRaw) return;

    const decodedHref = decodeURIComponent(hrefRaw);
    const isCollection =
      $(el).find('collection, d\\:collection, D\\:collection').length > 0 ||
      decodedHref.endsWith('/');

    const hrefPath = decodedHref.replace(/^https?:\/\/[^/]+/i, '').replace(/\/+$/, '');
    // Skip the current directory entry itself
    if (hrefPath === currentReqPath || (idx === 0 && isCollection)) {
      return;
    }

    const baseName = path.posix.basename(hrefPath);
    if (!baseName || baseName.startsWith('.') || baseName === '@eaDir' || baseName === '#recycle') {
      return;
    }

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
  const fullUrl = buildWebdavUrl(url, targetFile, false);

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
  const fullUrl = buildWebdavUrl(url, targetFile, false);

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
  const fullUrl = buildWebdavUrl(url, targetFile, false);

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
