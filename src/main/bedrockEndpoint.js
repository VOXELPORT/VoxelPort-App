'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteFileSync } = require('./atomicWrite');

// This is an address cache in app data, not a rewrite of a user's Geyser config
// or server metadata. A restored device identity must negotiate its own port.
function cacheKey(profileId, token) {
  return crypto.createHash('sha256').update(JSON.stringify([profileId, token])).digest('hex');
}

function validEndpoint(value) {
  return value && typeof value.publicHost === 'string' && value.publicHost.length <= 253
    && value.publicHost.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    && Number.isInteger(value.publicPort) && value.publicPort >= 1 && value.publicPort <= 65535;
}

function readCache(userDataDir) {
  try {
    const file = path.join(userDataDir, 'bedrock-endpoints.json');
    if (fs.statSync(file).size > 1024 * 1024) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

function readBedrockEndpoint(userDataDir, profileId, token) {
  const value = readCache(userDataDir)[cacheKey(profileId, token)];
  return validEndpoint(value) ? { publicHost: value.publicHost, publicPort: value.publicPort } : null;
}

function rememberBedrockEndpoint(userDataDir, profileId, token, endpoint) {
  if (!validEndpoint(endpoint)) throw new Error('Invalid Bedrock address from relay.');
  const cache = readCache(userDataDir);
  const key = cacheKey(profileId, token);
  if (cache[key]?.publicHost === endpoint.publicHost && cache[key]?.publicPort === endpoint.publicPort) return;
  cache[key] = { publicHost: endpoint.publicHost, publicPort: endpoint.publicPort };
  atomicWriteFileSync(path.join(userDataDir, 'bedrock-endpoints.json'), JSON.stringify(cache, null, 2));
}

function bedrockEndpointReady(launch, endpoint) {
  return Boolean(validEndpoint(launch) && validEndpoint(endpoint) && launch.localPort === endpoint.localPort
    && launch.publicHost === endpoint.publicHost && launch.publicPort === endpoint.publicPort);
}

module.exports = { readBedrockEndpoint, rememberBedrockEndpoint, bedrockEndpointReady };
