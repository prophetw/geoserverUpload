'use strict';

const { getPublishedShapeWfsUrls, buildWfsUrl, normalizeGeoserverUrl } = require('./geoserverService');

function parseArgs(argv) {
  const options = {
    geoserverUrl: process.env.GEOSERVER_URL,
    workspace: process.env.GEOSERVER_WORKSPACE,
    username: process.env.GEOSERVER_USER,
    password: process.env.GEOSERVER_PASSWORD,
    pretty: false,
    maxFeatures: 1000,
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
      case '--max-features': {
        const num = parseInt(value, 10);
        if (Number.isNaN(num) || num <= 0) {
          throw new Error(`--max-features must be a positive integer, got "${value}"`);
        }
        options.maxFeatures = num;
        break;
      }
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

  options.geoserverUrl = normalizeGeoserverUrl(options.geoserverUrl);

  return options;
}

async function main() {
  let options;
  const prettyRequested = process.argv.slice(2).includes('--pretty');

  try {
    options = parseArgs(process.argv.slice(2));
    const entries = await getPublishedShapeWfsUrls(options);

    if (entries.length === 0) {
      const result = {
        success: true,
        message: `Workspace "${options.workspace}" has no published feature types.`,
        data: [],
      };
      console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
      return;
    }

    const result = {
      success: true,
      count: entries.length,
      message: `Found ${entries.length} published feature type(s)`,
      data: entries,
    };

    console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
  } catch (error) {
    const errorResult = {
      success: false,
      error: error.message,
      data: null,
    };

    console.log(JSON.stringify(errorResult, null, options?.pretty || prettyRequested ? 2 : 0));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  getPublishedShapeWfsUrls,
  buildWfsUrl,
};
