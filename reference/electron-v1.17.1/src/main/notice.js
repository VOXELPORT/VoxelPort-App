'use strict';

// Announcements from the relay's operator ("The VoxelPort relay will restart."), with the time left.
// The apps show them as a banner, and this also says them in Minecraft chat so players, who never see
// the app, hear it too.

const MAX_CHAT_LEN = 200;

/** Text that is safe to hand to the server's `say` command: no controls or formatting codes, one line. */
function chatSafe(text) {
  // eslint-disable-next-line no-control-regex
  return String(text == null ? '' : text).replace(/[\x00-\x1f\x7f§]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CHAT_LEN);
}

const PHRASES = {
  en: {
    now: 'now',
    soon: 'in less than a minute',
    minute: 'in 1 minute',
    minutes: (n) => `in ${n} minutes`,
    hours: (n) => `in about ${n} hour${n === 1 ? '' : 's'}`,
  },
  hinglish: {
    now: 'abhi',
    soon: '1 minute se kam mein',
    minute: '1 minute mein',
    minutes: (n) => `${n} minute mein`,
    hours: (n) => `lagbhag ${n} ghante mein`,
  },
};

/** "in 10 minutes" for a number of seconds left, in the given language. */
function timeLeftPhrase(seconds, lang = 'en') {
  const p = PHRASES[lang] || PHRASES.en;
  if (!(seconds > 0)) return p.now;
  if (seconds < 60) return p.soon;
  const minutes = Math.ceil(seconds / 60);
  if (minutes === 1) return p.minute;
  if (minutes < 120) return p.minutes(minutes);
  return p.hours(Math.round(minutes / 60));
}

// A relay that reconnects hands the same notice over again: say it once, not on every reconnect.
const REPEAT_QUIET_MS = 10 * 60 * 1000;
// When to say it again as the time runs out (seconds before), if there was that much time.
const REMINDERS = [300, 60];

/**
 * Says a notice in the Minecraft chat when it arrives, again as the time runs out, and once when the
 * time is up. `say(line)` does the talking; timers can be replaced in tests.
 */
class NoticeAnnouncer {
  constructor({ say, lang = () => 'en', now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.say = say;
    this.lang = lang;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timers = [];
    this.lastText = '';
    this.lastSpokenAt = 0;
  }

  /** A notice frame from the relay: { message, seconds }. An empty message withdraws it. */
  handle(notice) {
    const text = chatSafe(notice && notice.message);
    this.cancel();
    if (!text) { this.lastText = ''; return; }
    const seconds = Number.isFinite(notice.seconds) && notice.seconds > 0 ? Math.floor(notice.seconds) : 0;

    const repeat = text === this.lastText && this.now() - this.lastSpokenAt < REPEAT_QUIET_MS;
    if (!repeat) this._speak(text, seconds, seconds > 0);
    this.lastText = text;

    if (seconds > 0) {
      for (const before of REMINDERS) {
        if (seconds > before + 30) this._later(text, (seconds - before) * 1000, before);
      }
      this._later(text, seconds * 1000, 0);
    }
  }

  cancel() {
    for (const id of this.timers) this.clearTimer(id);
    this.timers = [];
  }

  _later(text, ms, secondsLeft) {
    this.timers.push(this.setTimer(() => this._speak(text, secondsLeft, true), ms));
  }

  _speak(text, secondsLeft, timed) {
    this.lastSpokenAt = this.now();
    const when = timed ? ` (${timeLeftPhrase(secondsLeft, this.lang())})` : '';
    try { this.say(`[VoxelPort] ${text}${when}`); } catch { /* the server may have just stopped */ }
  }
}

module.exports = { chatSafe, timeLeftPhrase, NoticeAnnouncer, MAX_CHAT_LEN };
