'use strict';

const { Buffer } = require('node:buffer');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const allowedSuffixes = [
  '.shp',
  '.shx',
  '.dbf',
  '.prj',
  '.cpg',
  '.sbn',
  '.sbx',
  '.qix',
  '.qpj',
  '.fix',
  '.aih',
  '.ain',
  '.shp.xml',
  '.qmd',
];

const requiredShapefileSuffixes = ['.shp', '.shx', '.dbf'];
const sortedAllowedSuffixes = [...allowedSuffixes].sort((left, right) => right.length - left.length);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function logMessage(logger, level, message) {
  if (!logger || typeof logger[level] !== 'function') {
    return;
  }
  logger[level](message);
}

function normalizeGeoserverUrl(url) {
  if (!url || typeof url !== 'string') {
    return url;
  }
  return url.replace(/\/+$/, '');
}

function validateConnectionOptions({ geoserverUrl, workspace, username, password }) {
  if (!geoserverUrl) {
    throw new Error('Missing GeoServer URL.');
  }
  if (!workspace) {
    throw new Error('Missing workspace.');
  }
  if (!username) {
    throw new Error('Missing username.');
  }
  if (!password) {
    throw new Error('Missing password.');
  }
}

function sanitizeName(name) {
  return String(name ?? '').trim().replace(/\s+/g, '_');
}

function splitShapefileName(fileName) {
  const baseName = path.basename(fileName);
  const lowerName = baseName.toLowerCase();

  for (const suffix of sortedAllowedSuffixes) {
    if (lowerName.endsWith(suffix) && lowerName.length > suffix.length) {
      return {
        suffix,
        baseName: baseName.slice(0, baseName.length - suffix.length),
      };
    }
  }

  return null;
}

function buildAuthHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

function buildFeatureProbeUrl(geoserverUrl, workspace, layerName) {
  const url = new URL(`${normalizeGeoserverUrl(geoserverUrl)}/wfs`);
  url.searchParams.set('service', 'WFS');
  url.searchParams.set('version', '2.0.0');
  url.searchParams.set('request', 'GetFeature');
  url.searchParams.set('typeNames', `${workspace}:${layerName}`);
  url.searchParams.set('outputFormat', 'application/json');
  url.searchParams.set('count', '1');
  url.searchParams.set('maxFeatures', '1');
  return url.toString();
}

async function collectShapefiles(rootDir) {
  const result = [];

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.shp')) {
        result.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return result;
}

async function gatherComponents(shpPath) {
  const dir = path.dirname(shpPath);
  const baseName = path.parse(shpPath).name;
  const baseLower = baseName.toLowerCase();
  const components = [];

  const entries = await fsp.readdir(dir);
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    const suffix = lower.slice(baseLower.length);
    if (!lower.startsWith(baseLower)) {
      continue;
    }

    if (allowedSuffixes.includes(suffix)) {
      components.push(path.join(dir, entry));
    }
  }

  for (const ext of requiredShapefileSuffixes) {
    const match = components.find((file) => file.toLowerCase().endsWith(ext));
    if (!match) {
      throw new Error(`Missing required "${ext}" file for shapefile "${shpPath}".`);
    }
  }

  return components;
}

async function createZip(componentPaths, tempDir, name) {
  await fsp.mkdir(tempDir, { recursive: true });
  const zipPath = path.join(tempDir, `${name}.zip`);

  try {
    await fsp.rm(zipPath, { force: true });
  } catch {
    // ignore
  }

  await execFileAsync('zip', ['-j', zipPath, ...componentPaths], { cwd: '/' });
  return zipPath;
}

async function uploadDatastoreZip({ geoserverUrl, workspace, storeName, zipPath, authHeader, overwrite }) {
  const params = new URLSearchParams();
  params.set('charset', 'UTF-8');
  params.set('configure', 'none');
  if (overwrite) {
    params.set('update', 'overwrite');
  }

  const target = `${geoserverUrl}/rest/workspaces/${encodeURIComponent(workspace)}/datastores/${encodeURIComponent(storeName)}/file.shp?${params.toString()}`;
  const zipBuffer = await fsp.readFile(zipPath);
  const response = await fetch(target, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/zip',
      Authorization: authHeader,
      'Content-Length': String(zipBuffer.length),
    },
    body: zipBuffer,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Upload failed for datastore "${storeName}". Status ${response.status} ${response.statusText}. Response: ${text}`,
    );
  }
}

async function publishLayer({
  geoserverUrl,
  workspace,
  storeName,
  layerName,
  nativeName,
  authHeader,
  overwrite,
}) {
  const featurePayload = {
    featureType: {
      name: layerName,
      nativeName,
      enabled: true,
    },
  };

  const publishUrl = `${geoserverUrl}/rest/workspaces/${encodeURIComponent(workspace)}/datastores/${encodeURIComponent(storeName)}/featuretypes?recalculate=nativebbox,latlonbbox`;
  const response = await fetch(publishUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify(featurePayload),
  });

  if (response.ok) {
    return { action: 'created' };
  }

  if (response.status === 409) {
    if (!overwrite) {
      return { action: 'skipped-existing' };
    }

    const adjustUrl = `${geoserverUrl}/rest/workspaces/${encodeURIComponent(workspace)}/datastores/${encodeURIComponent(storeName)}/featuretypes/${encodeURIComponent(layerName)}?recalculate=nativebbox,latlonbbox`;
    const adjustResponse = await fetch(adjustUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(featurePayload),
    });

    if (!adjustResponse.ok) {
      const body = await adjustResponse.text();
      throw new Error(
        `Failed to update existing layer "${layerName}". Status ${adjustResponse.status} ${adjustResponse.statusText}. Response: ${body}`,
      );
    }

    return { action: 'updated' };
  }

  const errorText = await response.text();
  throw new Error(
    `Failed to publish layer "${layerName}". Status ${response.status} ${response.statusText}. Response: ${errorText}`,
  );
}

function summarizePublishResults(results) {
  const successCount = results.filter((item) => item.success).length;
  return {
    total: results.length,
    successCount,
    failureCount: results.length - successCount,
    results,
  };
}

async function publishShapefileJobs({
  geoserverUrl,
  workspace,
  username,
  password,
  jobs,
  overwrite = false,
  logger = console,
}) {
  validateConnectionOptions({ geoserverUrl, workspace, username, password });
  const normalizedUrl = normalizeGeoserverUrl(geoserverUrl);
  const authHeader = buildAuthHeader(username, password);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'geoserver-shp-'));
  const results = [];

  try {
    for (const job of jobs) {
      const rawBaseName = path.parse(job.shpPath).name;
      const sourceLabel = job.sourceLabel || path.basename(job.shpPath);
      const storeName = sanitizeName(job.storeName || rawBaseName);
      const layerName = sanitizeName(job.layerName || rawBaseName);

      logMessage(logger, 'info', `Processing "${sourceLabel}" -> store "${storeName}", layer "${layerName}"`);

      let componentPaths;
      try {
        componentPaths = await gatherComponents(job.shpPath);
      } catch (error) {
        const result = {
          sourcePath: sourceLabel,
          baseName: rawBaseName,
          storeName,
          layerName,
          success: false,
          error: error.message,
        };
        results.push(result);
        logMessage(logger, 'error', `Skipping "${sourceLabel}": ${error.message}`);
        continue;
      }

      let zipPath;
      try {
        zipPath = await createZip(componentPaths, tempDir, `${storeName}-${Date.now()}-${results.length}`);
      } catch (error) {
        const result = {
          sourcePath: sourceLabel,
          baseName: rawBaseName,
          storeName,
          layerName,
          success: false,
          error: `Failed to zip shapefile: ${error.message}`,
        };
        results.push(result);
        logMessage(logger, 'error', `Failed to zip shapefile "${sourceLabel}": ${error.message}`);
        continue;
      }

      try {
        await uploadDatastoreZip({
          geoserverUrl: normalizedUrl,
          workspace,
          storeName,
          zipPath,
          authHeader,
          overwrite,
        });

        const publishResult = await publishLayer({
          geoserverUrl: normalizedUrl,
          workspace,
          storeName,
          layerName,
          authHeader,
          overwrite,
          nativeName: rawBaseName,
        });

        const readiness = await warmupLayerQuery({
          geoserverUrl: normalizedUrl,
          workspace,
          layerName,
          authHeader,
          logger,
        });

        const result = {
          sourcePath: sourceLabel,
          baseName: rawBaseName,
          storeName,
          layerName,
          success: true,
          action: publishResult.action,
          readiness: readiness.ready ? 'ready' : 'pending',
          readinessError: readiness.error,
        };
        results.push(result);

        if (publishResult.action === 'updated') {
          logMessage(logger, 'info', `Updated existing layer "${layerName}"`);
        } else if (publishResult.action === 'skipped-existing') {
          logMessage(logger, 'warn', `Layer "${layerName}" already exists. Skipped publish because overwrite is disabled.`);
        } else {
          logMessage(logger, 'info', `Published layer "${layerName}"`);
        }
      } catch (error) {
        const result = {
          sourcePath: sourceLabel,
          baseName: rawBaseName,
          storeName,
          layerName,
          success: false,
          error: error.message,
        };
        results.push(result);
        logMessage(logger, 'error', `Failed for "${sourceLabel}": ${error.message}`);
      } finally {
        if (zipPath) {
          try {
            await fsp.rm(zipPath, { force: true });
          } catch {
            // ignore
          }
        }
      }
    }
  } finally {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  return summarizePublishResults(results);
}

async function publishDirectory({
  directory,
  geoserverUrl,
  workspace,
  username,
  password,
  storePrefix = '',
  layerPrefix = '',
  overwrite = false,
  logger = console,
}) {
  validateConnectionOptions({ geoserverUrl, workspace, username, password });
  await fsp.access(directory, fs.constants.R_OK);

  const shapefiles = await collectShapefiles(directory);
  if (shapefiles.length === 0) {
    return {
      directory,
      ...summarizePublishResults([]),
    };
  }

  const jobs = shapefiles.map((shpPath) => {
    const baseName = path.parse(shpPath).name;
    return {
      shpPath,
      sourceLabel: path.relative(directory, shpPath),
      storeName: `${storePrefix}${sanitizeName(baseName)}`,
      layerName: `${layerPrefix}${sanitizeName(baseName)}`,
    };
  });

  const summary = await publishShapefileJobs({
    geoserverUrl,
    workspace,
    username,
    password,
    jobs,
    overwrite,
    logger,
  });

  return {
    directory,
    ...summary,
  };
}

async function fetchFeatureTypes({ geoserverUrl, workspace, authHeader }) {
  const baseUrl = `${geoserverUrl}/rest/workspaces/${encodeURIComponent(workspace)}/featuretypes.json`;
  const url = `${baseUrl}?count=10000&startIndex=0`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authHeader,
    },
  });

  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to fetch feature types for workspace "${workspace}". Status ${response.status} ${response.statusText}. Response: ${body}`,
    );
  }

  const payload = await response.json();
  const raw = payload?.featureTypes?.featureType ?? [];
  if (Array.isArray(raw)) {
    return raw;
  }
  return raw ? [raw] : [];
}

function extractLayerName(featureType) {
  if (featureType.name && typeof featureType.name === 'string') {
    return featureType.name;
  }

  const href = featureType.href;
  if (typeof href === 'string' && href.length > 0) {
    const parsed = new URL(href);
    const pathname = parsed.pathname;
    const lastSlash = pathname.lastIndexOf('/');
    const lastSegment = lastSlash >= 0 ? pathname.slice(lastSlash + 1) : pathname;
    const withoutExt = lastSegment.replace(/\.[^.]+$/u, '');
    if (withoutExt) {
      return decodeURIComponent(withoutExt);
    }
  }

  throw new Error('Unable to determine layer name from feature type payload.');
}

function buildWfsUrl(geoserverUrl, workspace, layerName, maxFeatures = 1000) {
  const url = new URL(`${normalizeGeoserverUrl(geoserverUrl)}/wfs`);
  url.searchParams.set('service', 'WFS');
  url.searchParams.set('version', '2.0.0');
  url.searchParams.set('request', 'GetFeature');
  url.searchParams.set('typeNames', `${workspace}:${layerName}`);
  url.searchParams.set('outputFormat', 'application/json');
  url.searchParams.set('maxFeatures', String(maxFeatures));
  return url.toString();
}

function buildKmlUrl(geoserverUrl, workspace, layerName, maxFeatures = 1000) {
  const url = new URL(`${normalizeGeoserverUrl(geoserverUrl)}/wfs`);
  url.searchParams.set('service', 'WFS');
  url.searchParams.set('version', '1.0.0');
  url.searchParams.set('request', 'GetFeature');
  url.searchParams.set('typeName', `${workspace}:${layerName}`);
  url.searchParams.set('outputFormat', 'application/vnd.google-earth.kml+xml');
  url.searchParams.set('maxFeatures', String(maxFeatures));
  return url.toString();
}

async function warmupLayerQuery({
  geoserverUrl,
  workspace,
  layerName,
  username,
  password,
  authHeader,
  logger,
  attempts = 3,
  delayMs = 800,
}) {
  const normalizedUrl = normalizeGeoserverUrl(geoserverUrl);
  const finalAuthHeader = authHeader || buildAuthHeader(username, password);
  let lastMessage = 'Layer has not responded to WFS requests yet.';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(buildFeatureProbeUrl(normalizedUrl, workspace, layerName), {
        headers: {
          Accept: 'application/json',
          Authorization: finalAuthHeader,
        },
      });

      if (response.ok) {
        await response.text();
        if (attempt > 1) {
          logMessage(logger, 'info', `Layer "${layerName}" became queryable after ${attempt} attempts.`);
        }
        return {
          ready: true,
          attempt,
        };
      }

      lastMessage = `Status ${response.status} ${response.statusText}`;
      await response.text();
    } catch (error) {
      lastMessage = error.message;
    }

    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  logMessage(
    logger,
    'warn',
    `Layer "${layerName}" was published, but WFS was not ready after ${attempts} attempts: ${lastMessage}`,
  );

  return {
    ready: false,
    error: lastMessage,
  };
}

async function downloadLayerKml({
  geoserverUrl,
  workspace,
  layerName,
  username,
  password,
  authHeader,
  logger,
  maxFeatures = 1000,
}) {
  validateConnectionOptions({ geoserverUrl, workspace, username, password });
  if (!layerName) {
    throw new Error('Missing layer name.');
  }

  const normalizedUrl = normalizeGeoserverUrl(geoserverUrl);
  const finalAuthHeader = authHeader || buildAuthHeader(username, password);

  await warmupLayerQuery({
    geoserverUrl: normalizedUrl,
    workspace,
    layerName,
    authHeader: finalAuthHeader,
    logger,
    attempts: 2,
    delayMs: 1000,
  });

  const response = await fetch(buildKmlUrl(normalizedUrl, workspace, layerName, maxFeatures), {
    headers: {
      Accept: 'application/vnd.google-earth.kml+xml',
      Authorization: finalAuthHeader,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to download KML for layer "${layerName}". Status ${response.status} ${response.statusText}. Response: ${body}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    fileName: `${sanitizeName(layerName) || 'layer'}.kml`,
    contentType: response.headers.get('content-type') || 'application/vnd.google-earth.kml+xml; charset=utf-8',
  };
}

async function getPublishedShapeWfsUrls({ geoserverUrl, workspace, username, password, maxFeatures = 1000 }) {
  validateConnectionOptions({ geoserverUrl, workspace, username, password });
  const normalizedUrl = normalizeGeoserverUrl(geoserverUrl);
  const authHeader = buildAuthHeader(username, password);
  const featureTypes = await fetchFeatureTypes({ geoserverUrl: normalizedUrl, workspace, authHeader });

  return featureTypes.map((featureType) => {
    const layerName = extractLayerName(featureType);
    const title = typeof featureType.title === 'string' ? featureType.title : undefined;
    const layerId = `${workspace}:${layerName}`;
    return {
      layer: layerId,
      layerName,
      wfsUrl: buildWfsUrl(normalizedUrl, workspace, layerName, maxFeatures),
      kmlUrl: buildKmlUrl(normalizedUrl, workspace, layerName, maxFeatures),
      title,
    };
  });
}

module.exports = {
  allowedSuffixes,
  requiredShapefileSuffixes,
  sanitizeName,
  splitShapefileName,
  buildAuthHeader,
  normalizeGeoserverUrl,
  collectShapefiles,
  gatherComponents,
  publishDirectory,
  publishShapefileJobs,
  getPublishedShapeWfsUrls,
  buildWfsUrl,
  buildKmlUrl,
  warmupLayerQuery,
  downloadLayerKml,
};
