'use strict';

const { Buffer } = require('node:buffer');

function parseArgs(argv) {
  const options = {
    geoserverUrl: process.env.GEOSERVER_URL,
    workspace: process.env.GEOSERVER_WORKSPACE,
    username: process.env.GEOSERVER_USER,
    password: process.env.GEOSERVER_PASSWORD,
    pretty: false,
    maxFeatures: 1000, // 默认改为1000条
  };

  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument "${arg}". Options must start with "--".`);
    }

    if (arg === '--pretty') {
      options.pretty = true;
      i += 1;
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Option "${arg}" expects a value.`);
    }

    switch (arg) {
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
      case '--max-features':
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) {
          throw new Error(`--max-features must be a positive integer, got "${value}"`);
        }
        options.maxFeatures = num;
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

function buildAuthHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

async function fetchFeatureTypes({ geoserverUrl, workspace, authHeader }) {
  const baseUrl = `${geoserverUrl}/rest/workspaces/${encodeURIComponent(workspace)}/featuretypes.json`;
  // 添加分页参数以获取所有数据
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
  const url = new URL(`${geoserverUrl}/wfs`);
  url.searchParams.set('service', 'WFS');
  url.searchParams.set('version', '2.0.0');
  url.searchParams.set('request', 'GetFeature');
  url.searchParams.set('typeNames', `${workspace}:${layerName}`);
  url.searchParams.set('outputFormat', 'application/json');
  url.searchParams.set('maxFeatures', maxFeatures.toString());
  return url.toString();
}

async function getPublishedShapeWfsUrls({ geoserverUrl, workspace, username, password, maxFeatures = 1000 }) {
  const authHeader = buildAuthHeader(username, password);
  const featureTypes = await fetchFeatureTypes({ geoserverUrl, workspace, authHeader });

  return featureTypes.map((featureType) => {
    const layerName = extractLayerName(featureType);
    const title = typeof featureType.title === 'string' ? featureType.title : undefined;
    const layerId = `${workspace}:${layerName}`;
    return {
      layer: layerId,
      wfsUrl: buildWfsUrl(geoserverUrl, workspace, layerName, maxFeatures),
      title,
    };
  });
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const entries = await getPublishedShapeWfsUrls(options);

    if (entries.length === 0) {
      if (options.pretty) {
        console.log(JSON.stringify({
          success: true,
          message: `Workspace "${options.workspace}" has no published feature types.`,
          data: []
        }, null, 2));
      } else {
        console.log(JSON.stringify({
          success: true,
          message: `Workspace "${options.workspace}" has no published feature types.`,
          data: []
        }));
      }
      return;
    }

    const result = {
      success: true,
      count: entries.length,
      message: `Found ${entries.length} published feature type(s)`,
      data: entries
    };

    if (options.pretty) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(JSON.stringify(result));
    }
  } catch (error) {
    const errorResult = {
      success: false,
      error: error.message,
      data: null
    };

    if (options.pretty) {
      console.log(JSON.stringify(errorResult, null, 2));
    } else {
      console.log(JSON.stringify(errorResult));
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getPublishedShapeWfsUrls,
  buildWfsUrl,
};
