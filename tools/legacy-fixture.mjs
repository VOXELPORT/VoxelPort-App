// A synthetic "previous (Electron) VoxelPort" folder for the tests, made the way Electron makes its files: a Windows-DPAPI-protected AES key in
// `Local State` (protected by PowerShell, which calls the same DPAPI Chromium uses), a made-up device token sealed with that key as
// "v10" + nonce + AES-GCM, a server list, backups and settings. The tests use this and never a real person's data.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ID_A = '11111111-1111-4111-8111-111111111111';
const J = JSON.stringify;

export const newToken = () => 'vp_' + crypto.randomBytes(18).toString('base64url');
/** The 12-character VoxelPort ID the apps show for a token. */
export const vpIdOf = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);

/**
 * `<root>/<name>` holding the old app's files. `key: false` damages `Local State`, so the token cannot be opened.
 * One usable server (`servers/survival`, with two backups) and one whose folder does not exist.
 */
export function makeOldApp(root, name, token, { key = true } = {}) {
  const old = path.join(root, name);
  const servers = path.join(old, 'servers');
  fs.mkdirSync(path.join(servers, 'survival'), { recursive: true });
  fs.writeFileSync(path.join(servers, 'survival', 'server.properties'), 'motd=Old survival\n');
  const aesKey = crypto.randomBytes(32);
  const protectedKey = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('${aesKey.toString('base64')}'), $null, 'CurrentUser'))`], { encoding: 'utf8' }).trim();
  const localState = { os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from(protectedKey, 'base64')]).toString('base64') } };
  fs.writeFileSync(path.join(old, 'Local State'), key ? J(localState) : '{ not json');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
  const sealed = Buffer.concat([Buffer.from('v10'), nonce, cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  fs.writeFileSync(path.join(old, 'device-token.json'), J({ enc: sealed.toString('base64') }));
  const profile = (id, nm, dir) => ({ id, name: nm, type: 'paper', version: '1.21.4', serverDir: dir, port: 25565, minRamMb: 1024, maxRamMb: 2048, createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: '2026-02-01T00:00:00.000Z' });
  fs.writeFileSync(path.join(old, 'server-profiles.json'), J({ version: 2, servers: [profile(ID_A, 'Old Survival', path.join(servers, 'survival')), profile('22222222-2222-4222-8222-222222222222', 'Gone', path.join(servers, 'gone'))] }));
  const bk = path.join(old, 'backups', ID_A);
  fs.mkdirSync(bk, { recursive: true });
  fs.writeFileSync(path.join(bk, '2026-01-02_03-04-05_manual.zip'), 'zip one');
  fs.writeFileSync(path.join(bk, '2026-01-03_03-04-05_auto.zip'), 'zip two');
  fs.writeFileSync(path.join(old, 'preferences.json'), J({ region: 'eu', presence: false, theme: 'light' }));
  fs.writeFileSync(path.join(old, 'custom-address.json'), J({ name: 'mycraft', address: 'mycraft.voxelport.in', region: 'eu' }));
  const cacheKey = crypto.createHash('sha256').update(J([ID_A, token])).digest('hex');
  fs.writeFileSync(path.join(old, 'bedrock-endpoints.json'), J({ [cacheKey]: { publicHost: 'play.voxelport.in', publicPort: 26335 } }));
  return old;
}

/** Every file under `dir` with its hash, as one string: equal strings mean an unchanged folder. */
export function snapshot(dir) {
  const out = [];
  const go = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) go(p); else out.push(`${path.relative(dir, p)}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`); } };
  go(dir);
  return out.sort().join('\n');
}
