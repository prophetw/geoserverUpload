'use strict';

const path = require('node:path');

const { publishDirectory, normalizeGeoserverUrl } = require('./geoserverService');

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

  options.geoserverUrl = normalizeGeoserverUrl(options.geoserverUrl);

  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const summary = await publishDirectory({
      ...options,
      logger: console,
    });

    if (summary.total === 0) {
      console.log(`No ".shp" files found under ${options.directory}. Nothing to do.`);
      return;
    }

    console.log(
      `Finished processing shapefiles. Success: ${summary.successCount}, Failed: ${summary.failureCount}.`,
    );

    if (summary.failureCount > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
};
