// A stand-in for the accounts service, for testing the Tauri build's Discord gate without Discord.
//   node tools/fake-accounts.mjs [port]         (default 8799)
// It checks PKCE like the real one does: the exchange only succeeds if sha256(verifier) matches the challenge the
// sign-in started with. The "browser" step is a 302 straight back to the app's loopback port.
import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.argv[2] || 8799);
const SESSION = 'fake-session-' + crypto.randomBytes(16).toString('hex');
const challenges = new Map(); // one-time code -> challenge
let backup = null;
let member = true;
const log = [];

const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const standing = { plan: { id: 'free', name: 'Free' }, rank: 'free' };
const config = () => ({ graceUntil: null, serverNow: Date.now(), inviteUrl: 'https://discord.gg/JAUfmey2fP' });

http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${port}`);
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    log.push(`${req.method} ${u.pathname}`);
    const authed = req.headers.authorization === `Bearer ${SESSION}`;
    if (u.pathname === '/api/auth/discord/start') {
      const code = crypto.randomBytes(32).toString('base64url');
      challenges.set(code, u.searchParams.get('challenge'));
      res.writeHead(302, { location: `http://127.0.0.1:${u.searchParams.get('port')}/?code=${code}` });
      return res.end();
    }
    if (u.pathname === '/api/app/exchange') {
      const b = JSON.parse(body || '{}');
      const challenge = challenges.get(b.code);
      challenges.delete(b.code);
      const ok = challenge && crypto.createHash('sha256').update(String(b.verifier)).digest('base64url') === challenge && /^vp_/.test(b.deviceToken);
      if (!ok) return send(res, 400, { error: 'Sign-in expired. Please try again.' });
      return send(res, 200, { session: SESSION, member, reason: member ? null : 'not_in_server', discordName: 'E2E Player', ...standing, ...config() });
    }
    if (u.pathname === '/api/app/config') return send(res, 200, config());
    if (u.pathname === '/api/app/status') return authed ? send(res, 200, { member, reason: member ? null : 'not_in_server', discordName: 'E2E Player', ...standing, ...config() }) : send(res, 401, { error: 'Sign in again.' });
    if (u.pathname === '/api/app/signout') return send(res, 200, { ok: true });
    if (u.pathname === '/api/app/identity') {
      if (!authed) return send(res, 401, { error: 'Sign in again.' });
      if (req.method === 'PUT') { const b = JSON.parse(body); backup = { vpId: b.vpId, blob: b.blob, updatedAt: Date.now() }; return send(res, 200, { ok: true, updatedAt: backup.updatedAt }); }
      if (req.method === 'GET') return backup ? send(res, 200, backup) : send(res, 404, { error: 'There is no address backup for this account.' });
      if (req.method === 'DELETE') { backup = null; return send(res, 200, { ok: true }); }
    }
    if (u.pathname === '/__log') return send(res, 200, { log, backup: !!backup });
    if (u.pathname === '/__member') { member = u.searchParams.get('v') === '1'; return send(res, 200, { member }); }
    send(res, 404, {});
  });
}).listen(port, '127.0.0.1', () => console.log(`fake accounts on http://127.0.0.1:${port}`));
