//! The managed Minecraft server process, ported from serverProcess.js (and the stop rules of quitGate.js).
//!
//! * The java command is built from a fixed argument list and run without a shell, so nothing the user
//!   types can become a second command.
//! * Console output is read one line at a time with a hard cap per line, kept in a bounded buffer, and
//!   sent to the UI through a bounded backlog: a flood of output can drop log lines but never grows memory
//!   and never stalls the server.
//! * Stopping is graceful first (`stop` on stdin), then, after a bounded grace period, the process is killed.
//!   Status and exit events are never dropped.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use regex::Regex;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio::task::JoinHandle;

use crate::bedrock::{self, BedrockError, BedrockOptions};
use crate::log_buffer::{cut, LogBuffer};

pub const MAX_COMMAND_LEN: usize = 512;
const MAX_LINE_BYTES: usize = 64 * 1024;
const STDIN_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const READER_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const PLAYER_ACTIONS: [&str; 5] = ["kick", "op", "deop", "ban", "pardon"];

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("fixed pattern"))
}
fn prefix_re() -> &'static Regex { static R: OnceLock<Regex> = OnceLock::new(); re(&R, r"^\[[^\]]*\](?: \[[^\]]*\])?:\s*") }
fn ready_re() -> &'static Regex { static R: OnceLock<Regex> = OnceLock::new(); re(&R, r"^Done \([^)]*\)!") }
fn join_re() -> &'static Regex { static R: OnceLock<Regex> = OnceLock::new(); re(&R, r"^([A-Za-z0-9_.*-]{1,32}) joined the game$") }
fn leave_re() -> &'static Regex { static R: OnceLock<Regex> = OnceLock::new(); re(&R, r"^([A-Za-z0-9_.*-]{1,32}) left the game$") }
fn player_re() -> &'static Regex { static R: OnceLock<Regex> = OnceLock::new(); re(&R, r"^[A-Za-z0-9_.*-]{1,32}$") }
fn jar_re() -> &'static Regex { static R: OnceLock<Regex> = OnceLock::new(); re(&R, r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.jar$") }

/// A server log line without its "[time] [thread/LEVEL]:" front. What the server means is the whole message
/// after that, never a piece of it: chat is "<name> text", so a player typing "Bob joined the game" cannot pass
/// for the server saying it.
pub fn strip_log_prefix(line: &str) -> String {
    prefix_re().replace(line, "").trim_end().to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Stopped,
    Starting,
    Online,
    Stopping,
    Crashed,
}

impl Status {
    /// The words the screen already knows (they match the Electron app's status strings).
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Stopped => "stopped",
            Status::Starting => "starting",
            Status::Online => "online",
            Status::Stopping => "stopping",
            Status::Crashed => "crashed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Status(Status),
    Log(String),
    Players(usize),
    Names(Vec<String>),
    /// The exit code, or None when the process was ended by a signal.
    Exit(Option<i32>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartError {
    AlreadyRunning,
    InvalidServerDir,
    InvalidJavaPath,
    InvalidJar,
    InvalidRam,
    Bedrock(BedrockError),
    Spawn(String),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::AlreadyRunning => f.write_str("A server is already running."),
            StartError::InvalidServerDir => f.write_str("invalid server folder."),
            StartError::InvalidJavaPath => f.write_str("invalid Java path."),
            StartError::InvalidJar => f.write_str("invalid server jar name."),
            StartError::InvalidRam => f.write_str("invalid RAM allocation."),
            StartError::Bedrock(e) => write!(f, "{e}"),
            StartError::Spawn(e) => write!(f, "could not start Java: {e}"),
        }
    }
}

impl std::error::Error for StartError {}

#[derive(Debug, Clone)]
pub struct StartConfig {
    pub server_dir: PathBuf,
    pub jar_name: String,
    pub min_ram_mb: u32,
    pub max_ram_mb: u32,
    /// None means `java` from the PATH; otherwise an absolute path to a file named java or java.exe.
    pub java_path: Option<PathBuf>,
    pub bedrock: Option<BedrockOptions>,
}

impl StartConfig {
    pub fn new(server_dir: impl Into<PathBuf>, min_ram_mb: u32, max_ram_mb: u32) -> Self {
        Self { server_dir: server_dir.into(), jar_name: "server.jar".into(), min_ram_mb, max_ram_mb, java_path: None, bedrock: None }
    }
}

/// The program and the exact arguments, after every check. Nothing is passed through a shell.
pub fn build_command(cfg: &StartConfig) -> Result<(PathBuf, Vec<String>), StartError> {
    if !cfg.server_dir.is_absolute() {
        return Err(StartError::InvalidServerDir);
    }
    let java = match &cfg.java_path {
        None => PathBuf::from("java"),
        Some(p) => {
            let name = p.file_name().and_then(|n| n.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
            if !p.is_absolute() || (name != "java" && name != "java.exe") {
                return Err(StartError::InvalidJavaPath);
            }
            p.clone()
        }
    };
    if !jar_re().is_match(&cfg.jar_name) {
        return Err(StartError::InvalidJar);
    }
    if cfg.min_ram_mb < 256 || cfg.max_ram_mb < cfg.min_ram_mb || cfg.max_ram_mb > 131_072 {
        return Err(StartError::InvalidRam);
    }
    let bedrock_args = match &cfg.bedrock {
        Some(b) => bedrock::jvm_args(b).map_err(StartError::Bedrock)?,
        None => Vec::new(),
    };
    let mut args = vec![
        format!("-Xms{}M", cfg.min_ram_mb),
        format!("-Xmx{}M", cfg.max_ram_mb),
        // Force UTF-8 end to end. These are JVM options, so they come before -jar.
        "-Dfile.encoding=UTF-8".to_string(),
        "-Dstdout.encoding=UTF-8".to_string(),
        "-Dstderr.encoding=UTF-8".to_string(),
    ];
    args.extend(bedrock_args);
    args.extend(["-jar".to_string(), cfg.jar_name.clone(), "nogui".to_string()]);
    Ok((java, args))
}

/// How a stop ends: ask nicely, wait `grace`, then kill.
#[derive(Debug, Clone, Copy)]
pub struct StopPolicy {
    pub grace: Duration,
}

impl Default for StopPolicy {
    fn default() -> Self {
        Self { grace: Duration::from_secs(20) }
    }
}

/// The bounds that keep memory flat however much the server prints.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Log events waiting for the UI; beyond this, new log lines are dropped from the stream (not from the buffer).
    pub max_pending_logs: usize,
    pub buffer_lines: usize,
    pub buffer_line_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_pending_logs: 10_000, buffer_lines: 5_000, buffer_line_bytes: 4_096 }
    }
}

/// The receiving end of a server's events. Use this instead of the raw channel: it tracks how many log lines
/// are waiting, which is what bounds the backlog.
pub struct EventReceiver {
    rx: mpsc::UnboundedReceiver<Event>,
    pending_logs: Arc<AtomicUsize>,
}

impl EventReceiver {
    pub async fn recv(&mut self) -> Option<Event> {
        let ev = self.rx.recv().await?;
        if matches!(ev, Event::Log(_)) {
            self.pending_logs.fetch_sub(1, Ordering::Relaxed);
        }
        Some(ev)
    }
}

struct State {
    status: Status,
    running: bool,
    generation: u64,
    online: Vec<String>,
    kill: Option<oneshot::Sender<()>>,
    stop_timer: Option<JoinHandle<()>>,
    logs: LogBuffer,
    /// The operating-system id of the running server process, for the performance panel.
    pid: Option<u32>,
}

struct Inner {
    events: mpsc::UnboundedSender<Event>,
    pending_logs: Arc<AtomicUsize>,
    dropped_logs: AtomicU64,
    limits: Limits,
    policy: StopPolicy,
    state: Mutex<State>,
    stdin: AsyncMutex<Option<ChildStdin>>,
}

/// One managed server process. Cheap to clone; every clone is the same process.
#[derive(Clone)]
pub struct ServerProcess {
    inner: Arc<Inner>,
}

impl ServerProcess {
    pub fn new(policy: StopPolicy) -> (Self, EventReceiver) {
        Self::with_limits(policy, Limits::default())
    }

    pub fn with_limits(policy: StopPolicy, limits: Limits) -> (Self, EventReceiver) {
        let (tx, rx) = mpsc::unbounded_channel();
        let pending = Arc::new(AtomicUsize::new(0));
        let inner = Inner {
            events: tx,
            pending_logs: pending.clone(),
            dropped_logs: AtomicU64::new(0),
            limits,
            policy,
            state: Mutex::new(State {
                status: Status::Stopped,
                running: false,
                generation: 0,
                online: Vec::new(),
                kill: None,
                stop_timer: None,
                logs: LogBuffer::new(limits.buffer_lines, limits.buffer_line_bytes),
                pid: None,
            }),
            stdin: AsyncMutex::new(None),
        };
        (Self { inner: Arc::new(inner) }, EventReceiver { rx, pending_logs: pending })
    }

    pub fn status(&self) -> Status {
        self.inner.state.lock().unwrap().status
    }

    pub fn is_running(&self) -> bool {
        self.inner.state.lock().unwrap().running
    }

    /// The operating-system id of the running server process (None when nothing runs).
    pub fn pid(&self) -> Option<u32> {
        self.inner.state.lock().unwrap().pid
    }

    pub fn online_names(&self) -> Vec<String> {
        self.inner.state.lock().unwrap().online.clone()
    }

    /// The newest console lines (what a reopened console screen shows first).
    pub fn recent_logs(&self) -> Vec<String> {
        self.inner.state.lock().unwrap().logs.snapshot()
    }

    /// Log lines left out of the live stream because the UI was not keeping up (they are still in the buffer).
    pub fn dropped_log_events(&self) -> u64 {
        self.inner.dropped_logs.load(Ordering::Relaxed)
    }

    /// Start java with the checked arguments. A refused start says why in the console and leaves the status "crashed",
    /// as the Electron app does.
    pub async fn start(&self, cfg: &StartConfig) -> Result<(), StartError> {
        if self.is_running() {
            return Err(StartError::AlreadyRunning);
        }
        let (program, args) = match build_command(cfg) {
            Ok(v) => v,
            Err(e) => {
                self.emit_log(format!("Refusing to start: {e}"));
                self.set_status(Status::Crashed);
                return Err(e);
            }
        };
        let mut cmd = Command::new(program);
        cmd.args(args).current_dir(&cfg.server_dir);
        self.start_command(cmd).await
    }

    /// Run an already-built command as the managed process. The checks live in [`build_command`]; this is public so
    /// tests can run a stand-in server.
    pub async fn start_command(&self, mut cmd: Command) -> Result<(), StartError> {
        {
            let mut st = self.inner.state.lock().unwrap();
            if st.running {
                return Err(StartError::AlreadyRunning);
            }
            st.running = true;
            st.generation += 1;
            st.online.clear();
        }
        self.set_status(Status::Starting);

        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashes up beside the app

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                self.emit_log(format!("Failed to start Java: {e}"));
                self.finish(Some(-1)).await;
                return Err(StartError::Spawn(e.to_string()));
            }
        };

        self.inner.state.lock().unwrap().pid = child.id();
        *self.inner.stdin.lock().await = child.stdin.take();
        let out = child.stdout.take().map(|s| self.spawn_reader(s));
        let err = child.stderr.take().map(|s| self.spawn_reader(s));

        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        self.inner.state.lock().unwrap().kill = Some(kill_tx);

        let me = self.clone();
        tokio::spawn(async move {
            let kill = async {
                if kill_rx.await.is_err() {
                    std::future::pending::<()>().await; // sender gone without a kill: never kill
                }
            };
            let waited = tokio::select! {
                s = child.wait() => s,
                _ = kill => {
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            // Let the readers finish what is already in the pipe, but not forever: a grandchild can hold it open.
            let _ = tokio::time::timeout(READER_DRAIN_TIMEOUT, async {
                if let Some(h) = out { let _ = h.await; }
                if let Some(h) = err { let _ = h.await; }
            })
            .await;
            me.finish(waited.ok().and_then(|s| s.code())).await;
        });
        Ok(())
    }

    /// Ask the server to stop (`stop` on its console). If it is still alive after the grace period it is killed.
    pub async fn stop(&self) {
        let generation = {
            let mut st = self.inner.state.lock().unwrap();
            if !st.running {
                return;
            }
            st.status = Status::Stopping;
            st.generation
        };
        self.emit(Event::Status(Status::Stopping));
        self.send_command("stop").await;

        let me = self.clone();
        let grace = self.inner.policy.grace;
        let timer = tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            me.kill_if(generation);
        });
        let mut st = self.inner.state.lock().unwrap();
        if let Some(old) = st.stop_timer.replace(timer) {
            old.abort();
        }
    }

    /// End the process now, without asking. Last resort: prefer [`stop`].
    pub fn kill(&self) {
        let mut st = self.inner.state.lock().unwrap();
        if let Some(tx) = st.kill.take() {
            let _ = tx.send(());
        }
    }

    fn kill_if(&self, generation: u64) {
        let mut st = self.inner.state.lock().unwrap();
        if st.running && st.generation == generation {
            if let Some(tx) = st.kill.take() {
                let _ = tx.send(());
            }
        }
    }

    /// Console input is Minecraft command input, sent only to the child's stdin, never to a shell. It is length
    /// bounded, and an embedded newline or control character is stripped rather than allowed to smuggle a second
    /// command into one call. Returns whether anything was sent.
    pub async fn send_command(&self, command: &str) -> bool {
        let line: String = command.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(MAX_COMMAND_LEN).collect();
        if line.is_empty() {
            return false;
        }
        let mut guard = self.inner.stdin.lock().await;
        let Some(stdin) = guard.as_mut() else { return false };
        let write = async {
            stdin.write_all(line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await
        };
        match tokio::time::timeout(STDIN_WRITE_TIMEOUT, write).await {
            Ok(Ok(())) => true,
            Ok(Err(e)) => {
                drop(guard);
                self.emit_log(format!("Could not send to the server: {e}"));
                false
            }
            Err(_) => {
                drop(guard);
                self.emit_log("Could not send to the server: it is not reading its console.".to_string());
                false
            }
        }
    }

    /// A console player button (kick, op, ban...). The name must look like one a server prints, so it can never
    /// carry a second command.
    pub async fn player_action(&self, action: &str, name: &str) -> bool {
        if !self.is_running() || !PLAYER_ACTIONS.contains(&action) || !player_re().is_match(name) {
            return false;
        }
        self.send_command(&format!("{action} {name}")).await
    }

    // ----- internals -----

    fn emit(&self, ev: Event) {
        let _ = self.inner.events.send(ev); // status and exit events are never dropped
    }

    fn set_status(&self, status: Status) {
        self.inner.state.lock().unwrap().status = status;
        self.emit(Event::Status(status));
    }

    fn emit_log(&self, line: String) {
        self.inner.state.lock().unwrap().logs.push(&line);
        if self.inner.pending_logs.load(Ordering::Relaxed) >= self.inner.limits.max_pending_logs {
            self.inner.dropped_logs.fetch_add(1, Ordering::Relaxed);
            return;
        }
        self.inner.pending_logs.fetch_add(1, Ordering::Relaxed);
        let _ = self.inner.events.send(Event::Log(cut(&line, self.inner.limits.buffer_line_bytes)));
    }

    fn on_line(&self, line: String) {
        if line.is_empty() {
            return;
        }
        let message = strip_log_prefix(&line);
        self.emit_log(line);

        let became_ready = {
            let mut st = self.inner.state.lock().unwrap();
            if st.status == Status::Starting && ready_re().is_match(&message) {
                st.status = Status::Online;
                true
            } else {
                false
            }
        };
        if became_ready {
            self.emit(Event::Status(Status::Online));
        }
        if let Some(c) = join_re().captures(&message) {
            let name = c[1].to_string();
            let names = {
                let mut st = self.inner.state.lock().unwrap();
                if !st.online.contains(&name) {
                    st.online.push(name);
                }
                st.online.clone()
            };
            self.emit(Event::Players(names.len()));
            self.emit(Event::Names(names));
        }
        if let Some(c) = leave_re().captures(&message) {
            let name = c[1].to_string();
            let names = {
                let mut st = self.inner.state.lock().unwrap();
                st.online.retain(|n| *n != name);
                st.online.clone()
            };
            self.emit(Event::Players(names.len()));
            self.emit(Event::Names(names));
        }
    }

    fn spawn_reader<R: AsyncRead + Unpin + Send + 'static>(&self, stream: R) -> JoinHandle<()> {
        let me = self.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::with_capacity(16 * 1024, stream);
            let mut line: Vec<u8> = Vec::new();
            let mut over = false;
            loop {
                let chunk = match reader.fill_buf().await {
                    Ok(c) if !c.is_empty() => c,
                    _ => break,
                };
                let (data, consumed, complete) = match chunk.iter().position(|b| *b == b'\n') {
                    Some(i) => (&chunk[..i], i + 1, true),
                    None => (chunk, chunk.len(), false),
                };
                let room = MAX_LINE_BYTES.saturating_sub(line.len());
                if data.len() > room {
                    line.extend_from_slice(&data[..room]);
                    over = true;
                } else {
                    line.extend_from_slice(data);
                }
                reader.consume(consumed);
                if complete {
                    me.on_line(finish_line(&mut line, &mut over));
                }
            }
            if !line.is_empty() {
                me.on_line(finish_line(&mut line, &mut over));
            }
        })
    }

    /// However it ends, "exit" is said once.
    async fn finish(&self, code: Option<i32>) {
        let status = {
            let mut st = self.inner.state.lock().unwrap();
            let crashed = st.status != Status::Stopping && code != Some(0);
            st.running = false;
            st.pid = None;
            st.kill = None;
            if let Some(t) = st.stop_timer.take() {
                t.abort();
            }
            st.online.clear();
            st.status = if crashed { Status::Crashed } else { Status::Stopped };
            st.status
        };
        *self.inner.stdin.lock().await = None;
        self.emit(Event::Status(status));
        self.emit(Event::Players(0));
        self.emit(Event::Names(Vec::new()));
        self.emit(Event::Exit(code));
    }
}

fn finish_line(buf: &mut Vec<u8>, over: &mut bool) -> String {
    while buf.last() == Some(&b'\r') {
        buf.pop();
    }
    let mut s = String::from_utf8_lossy(buf).into_owned();
    if *over {
        s.push_str(" …[line cut]");
    }
    buf.clear();
    *over = false;
    s
}

/// Where the server's files live, for callers that need to build a [`StartConfig`] from a profile.
pub fn server_dir_of(profile_dir: &Path) -> PathBuf {
    profile_dir.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chat_message_cannot_pose_as_the_server() {
        assert_eq!(strip_log_prefix("[12:00:00] [Server thread/INFO]: Bob joined the game"), "Bob joined the game");
        assert_eq!(strip_log_prefix("[12:00:00 INFO]: Done (1.2s)! For help"), "Done (1.2s)! For help");
        let chat = strip_log_prefix("[12:00:00] [Server thread/INFO]: <Bob> Alice joined the game");
        assert!(join_re().captures(&chat).is_none());
    }

    #[test]
    fn the_command_is_a_fixed_argument_list() {
        let mut cfg = StartConfig::new(std::env::temp_dir(), 1024, 2048);
        cfg.bedrock = Some(BedrockOptions { local_port: 19133, public: None });
        let (program, args) = build_command(&cfg).unwrap();
        assert_eq!(program, PathBuf::from("java"));
        assert_eq!(&args[..2], ["-Xms1024M", "-Xmx2048M"]);
        let jar = args.iter().position(|a| a == "-jar").unwrap();
        assert_eq!(&args[jar..], ["-jar", "server.jar", "nogui"]);
        assert!(args[..jar].iter().all(|a| a.starts_with("-D") || a.starts_with("-X")), "only JVM options come before -jar");
        assert!(args.contains(&"-DgeyserTransport=nethernet".to_string()));
    }

    #[test]
    fn unsafe_start_requests_are_refused() {
        let ok = StartConfig::new(std::env::temp_dir(), 1024, 2048);
        assert!(build_command(&ok).is_ok());

        let mut relative = ok.clone();
        relative.server_dir = PathBuf::from("servers/one");
        assert_eq!(build_command(&relative).unwrap_err(), StartError::InvalidServerDir);

        let mut bad_java = ok.clone();
        bad_java.java_path = Some(std::env::temp_dir().join("powershell.exe"));
        assert_eq!(build_command(&bad_java).unwrap_err(), StartError::InvalidJavaPath);
        bad_java.java_path = Some(PathBuf::from("java"));
        assert_eq!(build_command(&bad_java).unwrap_err(), StartError::InvalidJavaPath);

        for jar in ["../evil.jar", "a b.jar", "server.exe", "-Dx.jar", ""] {
            let mut c = ok.clone();
            c.jar_name = jar.into();
            assert_eq!(build_command(&c).unwrap_err(), StartError::InvalidJar, "{jar:?}");
        }
        for (min, max) in [(100, 2048), (2048, 1024), (1024, 200_000)] {
            let mut c = ok.clone();
            c.min_ram_mb = min;
            c.max_ram_mb = max;
            assert_eq!(build_command(&c).unwrap_err(), StartError::InvalidRam);
        }
    }

    #[test]
    fn an_absolute_java_with_the_right_name_is_accepted() {
        let mut cfg = StartConfig::new(std::env::temp_dir(), 1024, 2048);
        cfg.java_path = Some(std::env::temp_dir().join("jre").join(if cfg!(windows) { "java.exe" } else { "java" }));
        assert!(build_command(&cfg).is_ok());
    }
}
