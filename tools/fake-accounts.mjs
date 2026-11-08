// A stand-in for the accounts service, for testing the Tauri build's Discord gate without Discord.
//   node tools/fake-accounts.mjs [port]         (default 8799)
// It checks PKCE like the real one does: the exchange only succeeds if sha256(verifier) matches the challenge the
// sign-in started with. The "browser" step is a 302 straight back to the app's loopback port.
// It also stands in for web control (the /api/app/control/* routes): a queue of commands the test fills through
// /__control/enqueue, a long poll that holds for /__control/hold milliseconds (the real one holds 25 s), the last
// report, the results the app sent back, and invite links.
import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.argv[2] || 8799);
const SESSION = 'fake-session-' + crypto.randomBytes(16).toString('hex');
const challenges = new Map(); // one-time code -> challenge
let backup = null;
let member = true;
const log = [];

// web control
const control = { queue: [], nextId: 1, results: [], report: null, polls: { started: 0, finished: 0 }, perk: true, watching: false, hold: 300, invites: [], nextInvite: 1, vps: new Set() };

const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const standing = { plan: { id: 'free', name: 'Free' }, rank: 'free' };
const config = () => ({ graceUntil: null, serverNow: Date.now(), inviteUrl: 'https://discord.gg/JAUfmey2fP' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${port}`);
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
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

    // ── web control ──
    if (u.pathname.startsWith('/api/app/control/')) {
      if (!authed) return send(res, 401, { error: 'Sign in again.' });
      const vp = u.searchParams.get('vp') || (body ? JSON.parse(body).vp : '');
      if (!/^[0-9a-f]{12}$/.test(String(vp))) return send(res, 400, { error: 'Bad id.' });
      control.vps.add(vp);
      if (u.pathname === '/api/app/control/poll') {
        control.polls.started++;
        const until = Date.now() + control.hold;
        while (Date.now() < until && control.queue.length === 0) await sleep(50);
        control.polls.finished++;
        const commands = control.queue.splice(0);
        return send(res, 200, { commands, watching: control.watching, perk: control.perk });
      }
      if (u.pathname === '/api/app/control/result') { control.results.push(JSON.parse(body)); return send(res, 200, { ok: true }); }
      if (u.pathname === '/api/app/control/report') { control.report = JSON.parse(body); return send(res, 200, { ok: true, watching: control.watching }); }
      if (u.pathname === '/api/app/control/invites') {
        if (!control.perk) return send(res, 403, { error: 'Web control is a Supporter+ perk. Get Supporter+ to switch it on.' });
        if (req.method === 'GET') return send(res, 200, { invites: control.invites });
        if (req.method === 'POST') {
          const b = JSON.parse(body);
          const inv = { id: control.nextInvite++, label: String(b.label || ''), state: 'active', expiresAt: b.days ? Date.now() + b.days * 86400000 : null, days: b.days };
          control.invites.push(inv);
          return send(res, 200, { id: inv.id, url: `https://web.voxelport.in/j/fake${inv.id}` });
        }
      }
      const m = u.pathname.match(/^\/api\/app\/control\/invites\/(\d+)$/);
      if (m && req.method === 'DELETE') { control.invites = control.invites.filter((i) => i.id !== Number(m[1])); return send(res, 200, { ok: true }); }
      return send(res, 404, {});
    }
    if (u.pathname === '/__control/enqueue') { const b = JSON.parse(body || '{}'); const cmd = { id: control.nextId++, action: b.action, arg: b.arg ?? null }; control.queue.push(cmd); return send(res, 200, cmd); }
    if (u.pathname === '/__control/state') return send(res, 200, { results: control.results, report: control.report, polls: control.polls, vps: [...control.vps], invites: control.invites });
    if (u.pathname === '/__control/set') { const q = Object.fromEntries(u.searchParams); if ('perk' in q) control.perk = q.perk === '1'; if ('watching' in q) control.watching = q.watching === '1'; if ('hold' in q) control.hold = Number(q.hold); return send(res, 200, { perk: control.perk, watching: control.watching, hold: control.hold }); }
    if (u.pathname === '/__control/reset') { control.results = []; control.report = null; control.polls = { started: 0, finished: 0 }; control.queue = []; return send(res, 200, { ok: true }); }

    if (u.pathname === '/__log') return send(res, 200, { log, backup: !!backup });
    if (u.pathname === '/__member') { member = u.searchParams.get('v') === '1'; return send(res, 200, { member }); }
    send(res, 404, {});
  });
}).listen(port, '127.0.0.1', () => console.log(`fake accounts on http://127.0.0.1:${port}`));
