'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
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

function parseArgs(argv) {
  const options = {
    directory: path.resolve(process.cwd(), 'shpfiles'),
    geoserverUrl: process.env.GEOSERVER_URL,
    workspace: process.env.GEOSERVER_WORKSPACE,
    username: process.env.GEOSERVER_USER,
    password: process.env.GEOSERVER_PASSWORD,
    storePrefix: '',
    layerPrefix: '',
    overwrite: false,
  };

  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument "${arg}". Expected options to start with "--".`);
    }

    if (arg === '--overwrite') {
      options.overwrite = true;
      i += 1;
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Option "${arg}" expects a value.`);
    }

    switch (arg) {
      case '--directory':
      case '--dir':
        options.directory = path.resolve(process.cwd(), value);
        break;
      case '--geoserver-url':
        options.geoserverUrl = value;
        break;
      case '--workspace':
        options.workspace = value;
        break;
      case '--username':
        options.username = value;
        break;
      case '--password':
        options.password = value;
        break;
      case '--store-prefix':
        options.storePrefix = value;
        break;
      case '--layer-prefix':
        options.layerPrefix = value;
        break;
      default:
        throw new Error(`Unknown option "${arg}".`);
    }

    i += 2;
  }

  if (!options.geoserverUrl) {
    throw new Error('Missing GeoServer URL. Provide "--geoserver-url" or set GEOSERVER_URL.');
  }
  if (!options.workspace) {
    throw new Error('Missing workspace. Provide "--workspace" or set GEOSERVER_WORKSPACE.');
  }
  if (!options.username) {
    throw new Error('Missing username. Provide "--username" or set GEOSERVER_USER.');
  }
  if (!options.password) {
    throw new Error('Missing password. Provide "--password" or set GEOSERVER_PASSWORD.');
  }

  options.geoserverUrl = options.geoserverUrl.replace(/\/+$/, '');

  return options;
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

  const required = ['.shp', '.shx', '.dbf'];
  for (const ext of required) {
    const match = components.find((file) => file.toLowerCase().endsWith(ext));
    if (!match) {
      throw new Error(`Missing required ".${ext.slice(1)}" file for shapefile "${shpPath}".`);
    }
  }

  return components;
}

function sanitizeName(name) {
  return name.trim().replace(/\s+/g, '_');
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

function buildAuthHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  return `Basic ${token}`;
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
    return;
  }

  if (response.status === 409) {
    if (!overwrite) {
      console.warn(
        `Layer "${layerName}" already exists in workspace "${workspace}". Skipping publish (use --overwrite to replace).`,
      );
      return;
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
    return;
  }

  const errorText = await response.text();
  throw new Error(
    `Failed to publish layer "${layerName}". Status ${response.status} ${response.statusText}. Response: ${errorText}`,
  );
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { directory } = options;

    await fsp.access(directory);

    const shapefiles = await collectShapefiles(directory);
    if (shapefiles.length === 0) {
      console.log(`No ".shp" files found under ${directory}. Nothing to do.`);
      return;
    }

    const authHeader = buildAuthHeader(options.username, options.password);
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'geoserver-shp-'));

    console.log(`Found ${shapefiles.length} shapefile(s). Starting upload...`);

    for (const shpPath of shapefiles) {
      const parsed = path.parse(shpPath);
      const rawBaseName = parsed.name;
      const baseName = rawBaseName.trim();
      const relative = path.relative(directory, shpPath);
      const storeName = `${options.storePrefix}${sanitizeName(baseName)}`;
      const layerName = `${options.layerPrefix}${sanitizeName(baseName)}`;

      console.log(`Processing "${relative}" -> store "${storeName}", layer "${layerName}"`);

      let componentPaths;
      try {
        componentPaths = await gatherComponents(shpPath);
      } catch (error) {
        console.error(`Skipping "${relative}": ${error.message}`);
        continue;
      }

      let zipPath;
      try {
        zipPath = await createZip(componentPaths, tempDir, `${storeName}-${Date.now()}`);
      } catch (error) {
        console.error(`Failed to zip shapefile "${relative}": ${error.message}`);
        continue;
      }

      try {
        await uploadDatastoreZip({
          geoserverUrl: options.geoserverUrl,
          workspace: options.workspace,
          storeName,
          zipPath,
          authHeader,
          overwrite: options.overwrite,
        });
        await publishLayer({
          geoserverUrl: options.geoserverUrl,
          workspace: options.workspace,
          storeName,
          layerName,
          authHeader,
          overwrite: options.overwrite,
          nativeName: rawBaseName,
        });
        console.log(`✓ Published layer "${layerName}"`);
      } catch (error) {
        console.error(`✗ Failed for "${relative}": ${error.message}`);
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

    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }

    console.log('Finished processing shapefiles.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

main();
