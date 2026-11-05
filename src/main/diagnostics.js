'use strict';

const { explainCrash } = require('./crashExplain');
const { isIP } = require('node:net');

// Reports contain no profiles, configuration files, device IDs or raw tokens.
function redact(text) {
  return String(text)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[private key removed]')
    .replace(/\b(?:vp_[\w-]{10,}|AIza[\w-]{20,}|mfa\.[\w-]{20,}|[\w-]{23,28}\.[\w-]{6}\.[\w-]{25,})\b/g, '[secret removed]')
    .replace(/(authorization\s*[:=]\s*)(?:Bearer|Bot|Basic)\s+[^\s,;]+/gi, '$1[secret removed]')
    .replace(/(["']?[\w-]*(?:token|password|passwd|secret|api[_-]?key)[\w-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[secret removed]')
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, (value) => {
      try {
        const url = new URL(value);
        if (/discord(?:app)?\.com$/.test(url.hostname) && url.pathname.includes('/webhooks/')) return '[webhook removed]';
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        return url.toString();
      } catch { return '[url removed]'; }
    })
    .replace(/[A-Z]:\\Users\\[^\\\r\n]+/gi, 'C:\\Users\\[user]')
    .replace(/\/(?:home|Users)\/[^/\s]+/g, '/home/[user]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email removed]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[uuid removed]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip removed]')
    .replace(/[\da-f:]*:[\da-f:]+(?:%[\w]+)?/gi, value => isIP(value) === 6 ? '[ip removed]' : value)
    .replace(/<@[!&]?\d+>|@everyone|@here/g, '[mention removed]')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function createReport({ version, platform, arch, server, status, lines, now = new Date() }) {
  const clean = redact(lines.join('\n'));
  const diagnoses = explainCrash(clean.split('\n'), { port: server?.port, crashed: status === 'crashed', lang: 'en' });
  const codes = diagnoses.map(item => `VP-${item.id.toUpperCase().replace(/-/g, '_')}: ${item.title}\n${item.detail}`);
  for (const [pattern, code, detail] of [
    [/UnsupportedClassVersionError|compiled by a more recent version/i, 'JAVA_VERSION', 'Check the Java runtime required by this Minecraft or mod version.'],
    // Geyser rejects Bedrock joins when it is built for a different Minecraft
    // version than the server: "This server does not support Java Edition X ...
    // Outdated server! I'm still on Y". The server itself is fine for Java players.
    [/does not support Java Edition|Outdated server! I'm still on|I'm still on \d/i, 'GEYSER_VERSION_MISMATCH', "Geyser doesn't match this server's Minecraft version, so Bedrock players are disconnected (Java players are unaffected). Re-add Bedrock support so Geyser matches the server, or change the server to a version Geyser supports."],
    // A plugin update that was downloaded but couldn't replace the live jar (it was
    // locked) is staged in plugins/update/ and applied on the next restart.
    [/plugins[\\/]update[\\/]|staged (?:the )?update|will be (?:applied|installed) on (?:the )?next restart|update folder/i, 'PLUGIN_UPDATE_STAGED', 'A plugin update has been downloaded and is waiting in plugins/update. Restart the server to apply it. (Informational — not an error.)'],
    [/ECONNREFUSED|connection refused/i, 'CONNECTION_REFUSED', 'Check the destination and confirm the local server is running on the configured port.'],
    [/ENOTFOUND|EAI_AGAIN|no such host|UnknownHostException/i, 'DNS', 'Check the hostname and your DNS connection.'],
    [/ETIMEDOUT|i\/o timeout|handshake timeout|connect timed out/i, 'TIMEOUT', 'Check the destination and connectivity; a timeout alone does not confirm a relay outage.'],
  ]) if (pattern.test(clean)) codes.push(`VP-${code}: ${detail}`);
  return [
    'VoxelPort diagnostic report v1',
    `Created: ${now.toISOString()}`,
    `App: ${version} | OS: ${platform} ${arch}`,
    `Server: ${server?.type || 'external/none'} | Minecraft: ${server?.version || 'unknown'}${server?.build ? ` (build ${server.build})` : ''} | Status: ${status}`,
    'Error codes:',
    codes.join('\n\n') || 'VP-NO_MATCH: No known error signature found; review the log below.',
    '', 'Recent session output (oldest first; bounded excerpt):', clean.slice(-200000),
    '', 'Review this file before sharing. Automatic redaction is best effort.',
    'Attach this .txt file to a Discord support ticket and describe what happened.',
  ].join('\n');
}

module.exports = { redact, createReport };
