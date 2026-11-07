'use strict';

const fs = require('fs');
const path = require('path');
const addons = require('./addons');
const { atomicWriteFileSync } = require('./atomicWrite');

const supported = (type) => ['paper', 'fabric'].includes(type);
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return ''; throw err; } };

function voicePlan(profile, bedrockPort = null) {
  if (!supported(profile.type)) return null;
  const base = profile.type === 'paper' ? 'plugins' : 'config';
  const simple = path.join(profile.serverDir, base, 'voicechat', 'voicechat-server.properties');
  const plasmo = path.join(profile.serverDir, base, profile.type === 'paper' ? 'PlasmoVoice' : 'plasmovoice', 'config.toml');
  const jarDir = path.join(profile.serverDir, profile.type === 'paper' ? 'plugins' : 'mods');
  const jars = fs.existsSync(jarDir) ? fs.readdirSync(jarDir) : [];
  const hasSimple = jars.some((n) => /^(?:voicechat|simple-voice-chat)[-\w.+]*\.jar$/i.test(n));
  const hasPlasmo = jars.some((n) => /^plasmovoice[-\w.+]*\.jar$/i.test(n));
  if (hasSimple && hasPlasmo) throw new Error('Two voice plugins are installed. Keep one voice plugin to use automatic setup.');
  const plugin = hasPlasmo ? 'plasmo' : hasSimple ? 'simple' : profile.voice?.plugin || 'simple';
  // Use a predictable local port distinct from Bedrock and server query.
  const properties = read(path.join(profile.serverDir, 'server.properties'));
  const queryPort = Number(properties.match(/^query\.port\s*=\s*(\d+)/m)?.[1] || 25565);
  let port = profile.voice?.port || 24454;
  while (port === bedrockPort || port === queryPort) port = port === 65535 ? 1024 : port + 1;
  return { plugin, port, file: plugin === 'plasmo' ? plasmo : simple, installed: plugin === 'plasmo' ? hasPlasmo : hasSimple };
}

function setProperties(text, values) {
  const remaining = { ...values };
  const lines = text.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*([^#!\s=:]+)\s*[=:]/);
    if (!match || !(match[1] in values)) return line;
    const key = match[1];
    delete remaining[key];
    return `${key}=${values[key]}`;
  });
  while (lines.at(-1) === '') lines.pop();
  return [...lines, ...Object.entries(remaining).map(([k, v]) => `${k}=${v}`), ''].join('\n');
}

function setTomlSection(text, section, values) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  const settings = Object.entries(values).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  if (start < 0) return text.trimEnd() + `\n\n[${section}]\n${settings.join('\n')}\n`;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const kept = lines.slice(start + 1, end).filter((line) => !Object.keys(values).some((k) => new RegExp(`^\\s*${k}\\s*=`).test(line)));
  lines.splice(start + 1, end - start - 1, ...settings, ...kept);
  return lines.join('\n');
}

async function configureVoice({ profile, plan, host, publicPort, running, isCurrent = () => true, install = addons.installAddon }) {
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || !Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) throw new Error('Invalid voice address from relay.');
  if (!isCurrent()) return null;
  let installed = false;
  if (!plan.installed) {
    await install({ serverDir: profile.serverDir, type: profile.type, version: profile.version,
      projectId: plan.plugin === 'plasmo' ? 'plasmovoice' : 'simple-voice-chat',
      title: plan.plugin === 'plasmo' ? 'Plasmo Voice' : 'Simple Voice Chat', running });
    installed = true;
  }
  if (!isCurrent()) return null;
  const before = read(plan.file);
  const after = plan.plugin === 'simple'
    ? setProperties(before, { bind_address: '127.0.0.1', port: plan.port, voice_host: `${host}:${publicPort}` })
    : setTomlSection(setTomlSection(before, 'host', { ip: '127.0.0.1', port: plan.port }), 'host.public', { ip: host, port: publicPort });
  if (before !== after) {
    fs.mkdirSync(path.dirname(plan.file), { recursive: true });
    if (before && !fs.existsSync(plan.file + '.voxelport-backup')) fs.writeFileSync(plan.file + '.voxelport-backup', before, { flag: 'wx' });
    atomicWriteFileSync(plan.file, after);
  }
  return { changed: installed || before !== after, plugin: plan.plugin, port: plan.port };
}

module.exports = { supported, voicePlan, configureVoice, setProperties, setTomlSection };
