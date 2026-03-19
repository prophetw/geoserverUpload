'use strict';

const http = require('node:http');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  allowedSuffixes,
  requiredShapefileSuffixes,
  publishShapefileJobs,
  getPublishedShapeWfsUrls,
  downloadLayerKml,
  sanitizeName,
  splitShapefileName,
} = require('./geoserverService');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '3030', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function toWebRequest(req) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  const init = {
    method: req.method,
    headers: req.headers,
  };

  if (req.method && !['GET', 'HEAD'].includes(req.method)) {
    init.body = req;
    init.duplex = 'half';
  }

  return new Request(url, init);
}

async function readJsonBody(req) {
  const request = toWebRequest(req);
  return request.json();
}

async function readFormDataBody(req) {
  const request = toWebRequest(req);
  return request.formData();
}

function parseJsonField(rawValue, fallbackValue) {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return fallbackValue;
  }
  try {
    return JSON.parse(rawValue);
  } catch {
    throw new HttpError(400, 'Request payload contains invalid JSON.');
  }
}

function normalizeUploadedPath(fileName) {
  const normalized = String(fileName || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..');

  if (normalized.length === 0) {
    throw new Error('Uploaded file name is invalid.');
  }

  return normalized.join('/');
}

function buildGroupKey(dirName, baseName) {
  return `${dirName}::${baseName.toLowerCase()}`;
}

async function prepareUploadJobs({ files, tempDir, groupsConfig, storePrefix, layerPrefix }) {
  const warnings = [];
  const grouped = new Map();
  const seenPaths = new Set();
  const configMap = new Map();

  for (const config of groupsConfig) {
    if (config && typeof config.groupKey === 'string') {
      configMap.set(config.groupKey, config);
    }
  }

  for (const file of files) {
    const relativePath = normalizeUploadedPath(file.name);
    if (seenPaths.has(relativePath)) {
      throw new HttpError(400, `Duplicate uploaded file "${relativePath}".`);
    }
    seenPaths.add(relativePath);

    const nameInfo = splitShapefileName(relativePath);
    if (!nameInfo) {
      warnings.push(`Ignored unsupported file "${relativePath}".`);
      continue;
    }

    const dirName = path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath);
    const groupKey = buildGroupKey(dirName, nameInfo.baseName);
    const diskPath = path.join(tempDir, ...relativePath.split('/'));

    await fsp.mkdir(path.dirname(diskPath), { recursive: true });
    await fsp.writeFile(diskPath, Buffer.from(await file.arrayBuffer()));

    let group = grouped.get(groupKey);
    if (!group) {
      group = {
        groupKey,
        dirName,
        baseName: nameInfo.baseName,
        suffixes: new Set(),
        fileNames: [],
        shpPath: null,
        shpRelativePath: null,
      };
      grouped.set(groupKey, group);
    }

    group.suffixes.add(nameInfo.suffix);
    group.fileNames.push(relativePath);
    if (nameInfo.suffix === '.shp') {
      group.shpPath = diskPath;
      group.shpRelativePath = relativePath;
    }
  }

  const incompleteGroups = [];
  const jobs = [];
  const acceptedGroups = [];

  for (const group of grouped.values()) {
    const missing = requiredShapefileSuffixes.filter((suffix) => !group.suffixes.has(suffix));
    if (missing.length > 0 || !group.shpPath) {
      incompleteGroups.push({
        groupKey: group.groupKey,
        label: group.dirName ? `${group.dirName}/${group.baseName}` : group.baseName,
        missing,
        files: group.fileNames,
      });
      continue;
    }

    const config = configMap.get(group.groupKey);
    const storeName = sanitizeName(config?.storeName) || `${storePrefix}${sanitizeName(group.baseName)}`;
    const layerName = sanitizeName(config?.layerName) || `${layerPrefix}${sanitizeName(group.baseName)}`;

    jobs.push({
      shpPath: group.shpPath,
      sourceLabel: group.shpRelativePath,
      storeName,
      layerName,
    });

    acceptedGroups.push({
      groupKey: group.groupKey,
      label: group.dirName ? `${group.dirName}/${group.baseName}` : group.baseName,
      storeName,
      layerName,
      files: group.fileNames,
    });
  }

  return {
    jobs,
    warnings,
    incompleteGroups,
    acceptedGroups,
  };
}

function createLogger() {
  const entries = [];

  return {
    entries,
    logger: {
      info(message) {
        entries.push({ level: 'info', message });
      },
      warn(message) {
        entries.push({ level: 'warn', message });
      },
      error(message) {
        entries.push({ level: 'error', message });
      },
    },
  };
}

async function handlePublish(req, res) {
  const formData = await readFormDataBody(req);
  const connection = parseJsonField(formData.get('connection'), null);
  const options = parseJsonField(formData.get('options'), {});
  const groupsConfig = parseJsonField(formData.get('groups'), []);
  const files = formData.getAll('shapefiles').filter((value) => value && typeof value.arrayBuffer === 'function');

  if (!connection) {
    throw new HttpError(400, 'Missing connection settings.');
  }
  if (files.length === 0) {
    throw new HttpError(400, 'No shapefile components were uploaded.');
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'geoserver-upload-ui-'));

  try {
    const { jobs, warnings, incompleteGroups, acceptedGroups } = await prepareUploadJobs({
      files,
      tempDir,
      groupsConfig: Array.isArray(groupsConfig) ? groupsConfig : [],
      storePrefix: typeof options.storePrefix === 'string' ? options.storePrefix : '',
      layerPrefix: typeof options.layerPrefix === 'string' ? options.layerPrefix : '',
    });

    if (jobs.length === 0 && incompleteGroups.length === 0) {
      throw new HttpError(400, 'No supported shapefile components were found in the upload.');
    }

    if (incompleteGroups.length > 0) {
      sendJson(res, 400, {
        success: false,
        error: 'Some shapefile groups are incomplete. Each group must include .shp, .shx, and .dbf.',
        warnings,
        incompleteGroups,
      });
      return;
    }

    const { entries, logger } = createLogger();
    const summary = await publishShapefileJobs({
      geoserverUrl: connection.geoserverUrl,
      workspace: connection.workspace,
      username: connection.username,
      password: connection.password,
      jobs,
      overwrite: Boolean(options.overwrite),
      logger,
    });

    sendJson(res, 200, {
      success: summary.failureCount === 0,
      summary,
      warnings,
      acceptedGroups,
      logs: entries,
    });
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function handleWfsQuery(req, res) {
  const payload = await readJsonBody(req);
  const connection = payload?.connection;
  const maxFeatures = Number.parseInt(String(payload?.maxFeatures ?? '1000'), 10);

  if (!connection) {
    throw new HttpError(400, 'Missing connection settings.');
  }
  if (!Number.isInteger(maxFeatures) || maxFeatures <= 0) {
    throw new HttpError(400, 'maxFeatures must be a positive integer.');
  }

  const entries = await getPublishedShapeWfsUrls({
    geoserverUrl: connection.geoserverUrl,
    workspace: connection.workspace,
    username: connection.username,
    password: connection.password,
    maxFeatures,
  });

  sendJson(res, 200, {
    success: true,
    count: entries.length,
    data: entries,
  });
}

async function handleKmlDownload(req, res) {
  const payload = await readJsonBody(req);
  const connection = payload?.connection;
  const layerName = typeof payload?.layerName === 'string' ? payload.layerName.trim() : '';
  const maxFeatures = Number.parseInt(String(payload?.maxFeatures ?? '1000'), 10);

  if (!connection) {
    throw new HttpError(400, 'Missing connection settings.');
  }
  if (!layerName) {
    throw new HttpError(400, 'Missing layer name.');
  }
  if (!Number.isInteger(maxFeatures) || maxFeatures <= 0) {
    throw new HttpError(400, 'maxFeatures must be a positive integer.');
  }

  const { buffer, fileName, contentType } = await downloadLayerKml({
    geoserverUrl: connection.geoserverUrl,
    workspace: connection.workspace,
    username: connection.username,
    password: connection.password,
    layerName,
    maxFeatures,
  });

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename="${fileName.replace(/"/g, '_')}"`,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

async function serveStatic(req, res, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const targetPath = path.normalize(path.join(PUBLIC_DIR, relativePath));
  const publicRoot = `${PUBLIC_DIR}${path.sep}`;

  if (targetPath !== PUBLIC_DIR && !targetPath.startsWith(publicRoot)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const stats = await fsp.stat(targetPath);
    if (!stats.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }

    const content = await fsp.readFile(targetPath);
    const contentType = mimeTypes[path.extname(targetPath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      sendText(res, 404, 'Not found');
      return;
    }
    throw error;
  }
}

async function requestHandler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/meta') {
      sendJson(res, 200, {
        success: true,
        data: {
          allowedSuffixes,
          requiredShapefileSuffixes,
        },
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/publish') {
      await handlePublish(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/wfs-urls') {
      await handleWfsQuery(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/download-kml') {
      await handleKmlDownload(req, res);
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(req, res, url.pathname);
      return;
    }

    sendText(res, 405, 'Method not allowed');
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    sendJson(res, statusCode, {
      success: false,
      error: error.message,
    });
  }
}

const server = http.createServer((req, res) => {
  requestHandler(req, res);
});

server.on('error', (error) => {
  console.error(`Failed to start server: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`GeoServer Upload UI is running at http://${HOST}:${PORT}`);
});
