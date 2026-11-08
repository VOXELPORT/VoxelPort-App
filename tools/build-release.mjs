// Builds the installer, signs it for updates, and writes everything a release needs into release-out/:
//   VoxelPort-Setup.exe                          the installer under a stable name (for the website's download link)
//   VoxelPort_<version>_x64-setup.exe            the same bytes under the versioned name latest.json points at
//   latest.json                                  the update manifest the app reads
//   SHA256SUMS.txt                               checksums of the two files
//
//   node tools/build-release.mjs [--key-dir <folder>] [--repo <owner/name>]
//
// The signing key is read from the folder that holds update.key and update.key.password (default: ~/.voxelport-update-signing). It is
// never copied anywhere, and nothing is uploaded or published: attaching these files to a release is a separate, deliberate step.
// The signature is bound to the version (the app refuses one that is not), and the build fails loudly if there is no key.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.join(import.meta.dirname, '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const keyDir = arg('--key-dir', path.join(os.homedir(), '.voxelport-update-signing'));
const github = arg('--repo', 'VOXELPORT/VoxelPort-App');
const keyFile = path.join(keyDir, 'update.key');
const passwordFile = path.join(keyDir, 'update.key.password');
if (!fs.existsSync(keyFile) || !fs.existsSync(passwordFile)) throw new Error(`No signing key in ${keyDir}. Make one with: npx tauri signer generate -w <folder>/update.key`);

const conf = JSON.parse(fs.readFileSync(path.join(repo, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = conf.version;
const cargo = fs.readFileSync(path.join(repo, 'src-tauri', 'Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)?.[1];
if (cargo !== version) throw new Error(`The version in Cargo.toml (${cargo}) and tauri.conf.json (${version}) differ.`);
const source = fs.readFileSync(path.join(repo, 'src-tauri', 'src', 'updatesetup.rs'), 'utf8');
const pub = source.match(/pub const UPDATE_PUBLIC_KEY: &str = "([^"]*)";/)?.[1];
const wanted = fs.readFileSync(`${keyFile}.pub`, 'utf8').trim();
if (!pub) throw new Error('UPDATE_PUBLIC_KEY in src-tauri/src/updatesetup.rs is empty: a build without it would never install an update.');
if (pub !== wanted) throw new Error('UPDATE_PUBLIC_KEY in src-tauri/src/updatesetup.rs is not the public half of the key in the key folder: updates signed now would be refused by the app.');

const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PATH: keyFile, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: fs.readFileSync(passwordFile, 'utf8').trim() };
const cli = path.join(repo, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
console.log(`Building VoxelPort ${version} …`);
execFileSync(process.execPath, [cli, 'build', '--config', 'src-tauri/tauri.release.conf.json', '--bundles', 'nsis'], { cwd: repo, env, stdio: 'inherit' });

const bundleDir = path.join(repo, 'target', 'release', 'bundle', 'nsis');
const versioned = `VoxelPort_${version}_x64-setup.exe`;
const built = path.join(bundleDir, versioned);
if (!fs.existsSync(built)) throw new Error(`Expected ${built}`);

// The signature the build wrote is over the installer's bytes but is not bound to a version: sign again with the version.
const out = path.join(repo, 'release-out');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(built, path.join(out, versioned));
fs.copyFileSync(built, path.join(out, 'VoxelPort-Setup.exe'));
execFileSync(process.execPath, [cli, 'signer', 'sign', '--app-version', version, path.join(out, versioned)], { cwd: repo, env, stdio: ['ignore', 'pipe', 'inherit'] });
const signature = fs.readFileSync(path.join(out, `${versioned}.sig`), 'utf8').trim();

const manifest = {
  version,
  notes: `VoxelPort ${version}`,
  pub_date: new Date().toISOString(),
  platforms: { 'windows-x86_64': { signature, url: `https://github.com/${github}/releases/download/v${version}/${versioned}` } },
};
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(manifest, null, 2));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(out, f))).digest('hex');
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), `${sha('VoxelPort-Setup.exe')}  VoxelPort-Setup.exe\n${sha(versioned)}  ${versioned}\n`);

console.log(`\nDone. Files in ${out}:`);
for (const f of fs.readdirSync(out)) console.log(`  ${f}  (${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} KB)`);
console.log(`\nNothing was uploaded. Attach latest.json and ${versioned} to the GitHub release tagged v${version} (and VoxelPort-Setup.exe for the download link).`);
