//! Announcements from the relay's operator ("The VoxelPort relay will restart."), with the time left. The apps show them as a
//! banner, and this also says them in Minecraft chat so players, who never see the app, hear it too. Ported from `notice.js`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio::time::Instant;

pub const MAX_CHAT_LEN: usize = 200;
/// A relay that reconnects hands the same notice over again: say it once, not on every reconnect.
const REPEAT_QUIET: Duration = Duration::from_secs(10 * 60);
/// When to say it again as the time runs out (seconds before), if there was that much time.
const REMINDERS: [u64; 2] = [300, 60];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    English,
    Hinglish,
}

/// Text that is safe to hand to the server's `say` command: no controls or formatting codes, one line.
pub fn chat_safe(text: &str) -> String {
    let spaced: String = text.chars().map(|c| if (c as u32) <= 0x1f || c == '\u{7f}' || c == '§' { ' ' } else { c }).collect();
    spaced.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_CHAT_LEN).collect()
}

/// "in 10 minutes" for a number of seconds left, in the given language.
pub fn time_left_phrase(seconds: u64, lang: Lang) -> String {
    let en = lang == Lang::English;
    if seconds == 0 {
        return if en { "now" } else { "abhi" }.into();
    }
    if seconds < 60 {
        return if en { "in less than a minute" } else { "1 minute se kam mein" }.into();
    }
    let minutes = seconds.div_ceil(60);
    if minutes == 1 {
        return if en { "in 1 minute" } else { "1 minute mein" }.into();
    }
    if minutes < 120 {
        return if en { format!("in {minutes} minutes") } else { format!("{minutes} minute mein") };
    }
    let hours = (minutes as f64 / 60.0).round() as u64;
    if en { format!("in about {hours} hour{}", if hours == 1 { "" } else { "s" }) } else { format!("lagbhag {hours} ghante mein") }
}

#[derive(Default)]
struct Inner {
    timers: Vec<JoinHandle<()>>,
    last_text: String,
    last_spoken_at: Option<Instant>,
}

/// Says a notice in the Minecraft chat when it arrives, again as the time runs out, and once when the time is up. `say(line)` does
/// the talking. Must be used inside a tokio runtime.
#[derive(Clone)]
pub struct NoticeAnnouncer {
    say: Arc<dyn Fn(String) + Send + Sync>,
    lang: Arc<dyn Fn() -> Lang + Send + Sync>,
    inner: Arc<Mutex<Inner>>,
}

impl NoticeAnnouncer {
    pub fn new(say: impl Fn(String) + Send + Sync + 'static, lang: impl Fn() -> Lang + Send + Sync + 'static) -> Self {
        Self { say: Arc::new(say), lang: Arc::new(lang), inner: Arc::new(Mutex::new(Inner::default())) }
    }

    /// A notice frame from the relay. An empty message withdraws it.
    pub fn handle(&self, message: &str, seconds: u64) {
        let text = chat_safe(message);
        self.cancel();
        if text.is_empty() {
            self.inner.lock().unwrap().last_text.clear();
            return;
        }
        let repeat = {
            let g = self.inner.lock().unwrap();
            text == g.last_text && g.last_spoken_at.is_some_and(|at| at.elapsed() < REPEAT_QUIET)
        };
        if !repeat {
            self.speak(&text, seconds, seconds > 0);
        }
        self.inner.lock().unwrap().last_text = text.clone();
        if seconds > 0 {
            for before in REMINDERS {
                if seconds > before + 30 {
                    self.later(&text, Duration::from_secs(seconds - before), before);
                }
            }
            self.later(&text, Duration::from_secs(seconds), 0);
        }
    }

    pub fn cancel(&self) {
        for t in self.inner.lock().unwrap().timers.drain(..) {
            t.abort();
        }
    }

    fn later(&self, text: &str, after: Duration, seconds_left: u64) {
        let (me, text) = (self.clone(), text.to_string());
        let deadline = Instant::now() + after; // measured from now, not from whenever the task first runs
        let task = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            me.speak(&text, seconds_left, true);
        });
        self.inner.lock().unwrap().timers.push(task);
    }

    fn speak(&self, text: &str, seconds_left: u64, timed: bool) {
        self.inner.lock().unwrap().last_spoken_at = Some(Instant::now());
        let when = if timed { format!(" ({})", time_left_phrase(seconds_left, (self.lang)())) } else { String::new() };
        (self.say)(format!("[VoxelPort] {text}{when}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn announcer() -> (NoticeAnnouncer, Arc<Mutex<Vec<String>>>, Arc<Mutex<Lang>>) {
        let said = Arc::new(Mutex::new(Vec::new()));
        let lang = Arc::new(Mutex::new(Lang::English));
        let (s2, l2) = (said.clone(), lang.clone());
        (NoticeAnnouncer::new(move |l| s2.lock().unwrap().push(l), move || *l2.lock().unwrap()), said, lang)
    }

    async fn pass(secs: u64) {
        tokio::time::advance(Duration::from_secs(secs)).await;
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
    }

    #[test]
    fn chat_text_has_no_controls_formatting_codes_or_line_breaks_and_is_cut() {
        assert_eq!(chat_safe("  Relay\u{7} will\n restart §c now  "), "Relay will restart c now");
        assert_eq!(chat_safe("/op me\nsecond line"), "/op me second line", "a newline cannot start a second command");
        assert_eq!(chat_safe(&"x".repeat(500)).chars().count(), 200);
        assert_eq!(chat_safe(""), "");
    }

    #[test]
    fn the_time_left_reads_naturally_in_both_languages() {
        for (secs, en, hn) in [
            (0, "now", "abhi"),
            (30, "in less than a minute", "1 minute se kam mein"),
            (59, "in less than a minute", "1 minute se kam mein"),
            (60, "in 1 minute", "1 minute mein"),
            (61, "in 2 minutes", "2 minute mein"),
            (600, "in 10 minutes", "10 minute mein"),
            (7199, "in about 2 hours", "lagbhag 2 ghante mein"),
            (3 * 3600, "in about 3 hours", "lagbhag 3 ghante mein"),
            (7260, "in about 2 hours", "lagbhag 2 ghante mein"),
        ] {
            assert_eq!(time_left_phrase(secs, Lang::English), en, "{secs}");
            assert_eq!(time_left_phrase(secs, Lang::Hinglish), hn, "{secs}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_timed_notice_is_said_at_once_again_at_five_minutes_and_one_and_when_the_time_is_up() {
        let (a, said, _) = announcer();
        a.handle("The relay will restart.", 900);
        assert_eq!(*said.lock().unwrap(), ["[VoxelPort] The relay will restart. (in 15 minutes)"]);
        pass(600).await;
        assert_eq!(said.lock().unwrap().len(), 2);
        assert_eq!(said.lock().unwrap()[1], "[VoxelPort] The relay will restart. (in 5 minutes)");
        pass(240).await;
        assert_eq!(said.lock().unwrap()[2], "[VoxelPort] The relay will restart. (in 1 minute)");
        pass(60).await;
        assert_eq!(said.lock().unwrap()[3], "[VoxelPort] The relay will restart. (now)");
        pass(3600).await;
        assert_eq!(said.lock().unwrap().len(), 4, "nothing more afterwards");
    }

    #[tokio::test(start_paused = true)]
    async fn a_short_notice_gets_no_reminders_that_would_come_too_soon_after_it() {
        let (a, said, _) = announcer();
        a.handle("Restarting.", 100);
        pass(40).await;
        assert_eq!(said.lock().unwrap().len(), 2, "the 60 s reminder (100 > 90): said at 40 s");
        a.handle("Other.", 80);
        let n = said.lock().unwrap().len();
        pass(100).await;
        assert_eq!(said.lock().unwrap().len(), n + 1, "80 s: said at the end only, no reminder (80 is not more than 90)");
    }

    #[tokio::test(start_paused = true)]
    async fn a_notice_with_no_time_is_said_once_without_a_countdown() {
        let (a, said, _) = announcer();
        a.handle("Maintenance tonight.", 0);
        pass(3600).await;
        assert_eq!(*said.lock().unwrap(), ["[VoxelPort] Maintenance tonight."]);
    }

    #[tokio::test(start_paused = true)]
    async fn the_same_notice_handed_over_again_by_a_reconnect_is_not_repeated_but_a_new_one_is() {
        let (a, said, _) = announcer();
        a.handle("The relay will restart.", 1200);
        a.handle("The relay will restart.", 1190);
        assert_eq!(said.lock().unwrap().len(), 1, "a reconnect repeats it: said once");
        a.handle("Different news.", 0);
        assert_eq!(said.lock().unwrap().len(), 2);
        pass(11 * 60).await;
        a.handle("Different news.", 0);
        assert_eq!(said.lock().unwrap().len(), 3, "after ten quiet minutes it may be said again");
    }

    #[tokio::test(start_paused = true)]
    async fn an_empty_message_withdraws_the_notice_and_its_reminders() {
        let (a, said, _) = announcer();
        a.handle("The relay will restart.", 900);
        a.handle("", 0);
        pass(1000).await;
        assert_eq!(said.lock().unwrap().len(), 1, "only the first announcement was said");
        a.handle("The relay will restart.", 0);
        assert_eq!(said.lock().unwrap().len(), 2, "after a withdrawal the same words count as new");
        a.cancel();
    }

    #[tokio::test(start_paused = true)]
    async fn the_language_is_read_when_it_speaks_not_when_it_was_queued() {
        let (a, said, lang) = announcer();
        a.handle("Relay restart.", 900);
        *lang.lock().unwrap() = Lang::Hinglish;
        pass(840).await;
        assert!(said.lock().unwrap()[1].ends_with("(5 minute mein)"), "{:?}", said.lock().unwrap());
        assert!(said.lock().unwrap()[2].ends_with("(1 minute mein)"), "{:?}", said.lock().unwrap());
        assert!(said.lock().unwrap()[0].ends_with("(in 15 minutes)"));
    }
}
