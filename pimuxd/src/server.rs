use crate::{
    acp,
    agent::Launch,
    journal::{valid_key, Journal},
    jsonl::record,
    pi::{self, PiSession},
    PROTOCOL,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs, io,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{mpsc, oneshot},
};

const MAX_SESSIONS: usize = 64;
const MAX_CONNECTIONS: usize = 128;
const QUEUE: usize = 256;
const CHILD_QUEUE: usize = 8;
const IDLE_MS: u64 = 15 * 60 * 1000;
const RECONNECT_TTL: Duration = Duration::from_secs(60);

type Tx = mpsc::Sender<Value>;
type Shared = Arc<Mutex<Server>>;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_default()
}
fn args(v: &Value) -> Result<Vec<String>> {
    v["args"]
        .as_array()
        .context("expected arguments")?
        .iter()
        .map(|a| Ok(a.as_str().context("expected a string argument")?.to_owned()))
        .collect()
}

// Compare absolute paths without resolving symlinks or requiring the directory to exist.
fn normalize_cwd(cwd: &str) -> Option<PathBuf> {
    let path = Path::new(cwd);
    if !path.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            _ => normalized.push(component.as_os_str()),
        }
    }
    Some(normalized)
}

// Store only the label and a fingerprint, not launch arguments or the environment.
fn acp_backend(op: &Value) -> Value {
    let command = string(op, "command");
    let fallback = std::path::Path::new(command)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("ACP");
    let name = op["acpBackend"]["name"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback);
    let spec = json!([command, op["args"]]);
    json!({"name":name.chars().take(80).collect::<String>(),"fingerprint":format!("{:x}", Sha256::digest(spec.to_string()))})
}

struct Child {
    tx: Tx,
    kill: oneshot::Sender<()>,
    generation: u64,
}
struct Viewer {
    tx: Tx,
    _disconnect: oneshot::Sender<()>,
}
struct Controller {
    id: u64,
    can_reveal: bool,
}
struct Session {
    key: String,
    cwd: String,
    started: u64,
    detached: Option<u64>,
    last_activity: u64,
    controller: Option<Controller>,
    reconnect_until: Option<Instant>,
    clients: HashMap<u64, Viewer>,
    child: Option<Child>,
    pi: Option<PiSession>,
    checkpoint: Value,
    acp_backend: Value,
    title: String,
    busy: bool,
    operation: bool,
    permissions: Vec<Value>,
    failed: bool,
    held_work: bool,
    detached_work: bool,
    journal_failed: bool,
    forgotten: bool,
}
impl Session {
    fn new(key: String, cwd: String, pi: Option<PiSession>) -> Self {
        Self {
            key,
            cwd,
            started: now(),
            detached: None,
            last_activity: now(),
            controller: None,
            reconnect_until: None,
            clients: HashMap::new(),
            child: None,
            pi,
            checkpoint: Value::Null,
            acp_backend: Value::Null,
            title: "New session".into(),
            busy: false,
            operation: false,
            permissions: Vec::new(),
            failed: false,
            held_work: false,
            detached_work: false,
            journal_failed: false,
            forgotten: false,
        }
    }
    fn active(&self) -> bool {
        self.busy
            || self.operation
            || self.held_work
            || !self.permissions.is_empty()
            || self
                .pi
                .as_ref()
                .is_some_and(|p| p.busy() || p.waiting() > 0)
    }
    fn list(&self) -> Value {
        let p = self.pi.as_ref();
        json!({"key":self.key,"cwd":self.cwd,"name":p.and_then(PiSession::name).unwrap_or(&self.title),
            "file":p.and_then(PiSession::file),"id":p.and_then(PiSession::id),"backend":if p.is_some(){"pi"}else{"acp"},
            "busy":self.active(),"waiting":p.map_or(self.permissions.len(), PiSession::waiting),"failed":self.failed,
            "attached":self.controller.is_some(),"observers":self.clients.len().saturating_sub(usize::from(self.controller.is_some())),
            "canReveal":self.reveal_target().is_some(),
            "detachedAt":self.detached,"startedAt":self.started,"acpBackend":self.acp_backend,
            "canRestoreContext": self.child.is_none() && self.can_restore_context() })
    }
    fn controller_id(&self) -> Option<u64> {
        self.controller.as_ref().map(|c| c.id)
    }
    fn reveal_target(&self) -> Option<&Tx> {
        let controller = self.controller.as_ref().filter(|c| c.can_reveal)?;
        let tx = &self.clients.get(&controller.id)?.tx;
        (!tx.is_closed()).then_some(tx)
    }
    fn reveal(&mut self, reconnect: bool) -> &'static str {
        if !self.forgotten {
            if let Some(tx) = self.reveal_target() {
                if tx.try_send(json!({"type":"daemon_reveal"})).is_ok() {
                    return "revealed";
                }
            } else if reconnect && self.controller.is_none() && self.detached.is_some() {
                self.reconnect_until = Some(Instant::now() + RECONNECT_TTL);
                return "queued";
            }
        }
        "unavailable"
    }
    fn take_reconnect(&mut self, cwds: &HashSet<PathBuf>, now: Instant) -> Option<Value> {
        if self.forgotten
            || self.controller.is_some()
            || self.detached.is_none()
            || !self.reconnect_until.is_some_and(|until| now < until)
            || !normalize_cwd(&self.cwd).is_some_and(|cwd| cwds.contains(&cwd))
        {
            return None;
        }
        self.reconnect_until = None;
        Some(self.list())
    }
    fn can_restore_context(&self) -> bool {
        !self.journal_failed
            && self.checkpoint["agentSessionId"].is_string()
            && self.acp_backend["fingerprint"].is_string()
            && self.checkpoint["acpBackend"]["fingerprint"] == self.acp_backend["fingerprint"]
    }
    fn send(&self, m: Value) -> bool {
        self.child
            .as_ref()
            .is_some_and(|c| c.tx.try_send(m).is_ok())
    }
    fn publish(&mut self, m: Value, controller_only: bool) {
        let controller = self.controller_id();
        self.clients.retain(|&id, viewer| {
            (controller_only && Some(id) != controller)
                || viewer.tx.try_send(m.clone()).is_ok()
        });
        if controller.is_some_and(|id| !self.clients.contains_key(&id)) {
            self.controller = None;
            self.detached = Some(now());
            self.detached_work = self.active();
            if let Some(pi) = &mut self.pi {
                for item in pi.detached() {
                    self.send(item);
                }
            }
        }
    }
    fn archived(&self) -> Vec<Value> {
        let mut messages = self.checkpoint["messages"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if self.checkpoint["busy"] == true {
            messages.push(json!({"role":"assistant","content":[{"type":"text","text":"_The daemon or agent stopped during this turn. The prompt was not resent._"}]}));
        }
        vec![
            json!({"type":"acpTitle","title":self.title,"busy":false}),
            json!({"type":"init","cwd":self.cwd,"messages":messages,"state":{"sessionName":self.title,"isStreaming":false}}),
            json!({"type":"acpStatus","ready":false,"error":if self.journal_failed {"Could not save this chat. Check the journal directory."} else {"Agent is stopped. Reopen the saved chat to continue."},"recoverable":!self.journal_failed,
                "canRestoreContext":self.can_restore_context()}),
        ]
    }
}
struct Server {
    sessions: HashMap<String, Session>,
    journal: Journal,
    seq: u64,
    logs: VecDeque<(String, Value)>,
    finished: Vec<Value>,
    shutdown: bool,
}
impl Server {
    fn log(&mut self, key: &str, message: &str) {
        self.seq += 1;
        if self.logs.len() == 1024 {
            self.logs.pop_front();
        }
        self.logs
            .push_back((key.to_owned(), json!({"id": self.seq, "message":message})));
    }
    fn remove(&mut self, key: &str) -> Result<()> {
        self.journal.remove(key)?;
        if let Some(s) = self.sessions.get_mut(key).filter(|s| s.child.is_some()) {
            // Keep the Pi file reserved until the process exits. A new writer must not race it.
            s.forgotten = true;
            s.clients.clear();
            s.controller = None;
            s.reconnect_until = None;
            if let Some(c) = &mut s.child {
                let (dead, _) = oneshot::channel();
                let _ = std::mem::replace(&mut c.kill, dead).send(());
            }
        } else {
            self.sessions.remove(key);
        }
        self.log(key, "session stopped");
        Ok(())
    }
}

fn spawn_child(
    shared: &Shared,
    key: &str,
    generation: u64,
    op: &Value,
    acp: bool,
    recovery: Option<Value>,
) -> Result<Child> {
    let launch_args = args(op)?;
    let cwd = string(op, "cwd");
    let command = string(op, "command");
    if command.is_empty() || cwd.is_empty() {
        bail!("command and cwd are required");
    }
    let env = op["env"].as_object().context("expected environment")?;
    let launch = Launch {
        cwd: cwd.to_owned(),
        command: command.to_owned(),
        args: launch_args,
        env: env
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
            .collect(),
    };
    let mut cmd = if acp {
        acp::command(&launch)
    } else {
        pi::command(&launch)
    };
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    use std::os::unix::process::CommandExt;
    cmd.as_std_mut().process_group(0);
    let mut proc = cmd.spawn().context("could not start agent process")?;
    let pid = proc.id();
    let mut stdin = proc.stdin.take().unwrap();
    let mut stdout = BufReader::new(proc.stdout.take().unwrap());
    let mut stderr = BufReader::new(proc.stderr.take().unwrap());
    let (tx, mut rx) = mpsc::channel::<Value>(CHILD_QUEUE);
    let (kill, mut stop) = oneshot::channel();
    let restore = op["restoreContext"] == true;
    let shared = shared.clone();
    let key = key.to_owned();
    let stderr_task = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
    });
    tokio::spawn(async move {
        let emit = |m| on_output(&shared, &key, generation, m);
        let failure = if acp {
            acp::run(
                launch,
                recovery,
                restore,
                &mut stdin,
                &mut stdout,
                &mut rx,
                &mut stop,
                emit,
            )
            .await
            .err()
        } else {
            pi::run(stdin, &mut stdout, rx, &mut stop, emit).await;
            None
        };
        if let Some(pid) = pid {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
        }
        let code = match tokio::time::timeout(Duration::from_secs(1), proc.wait()).await {
            Ok(Ok(status)) => status.code(),
            _ => {
                if let Some(pid) = pid {
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGKILL);
                    }
                }
                let _ = proc.wait().await;
                None
            }
        };
        stderr_task.abort();
        let mut st = shared.lock().unwrap();
        if let Some(s) = st
            .sessions
            .get_mut(&key)
            .filter(|s| s.child.as_ref().is_some_and(|c| c.generation == generation))
        {
            s.child = None;
            if s.forgotten {
                st.sessions.remove(&key);
            } else if s.pi.is_some() {
                s.publish(
                    json!({"type":"daemon_exit","code":code,"signal":null}),
                    false,
                );
                if let Some(file) =
                    s.pi.as_ref()
                        .and_then(PiSession::file)
                        .filter(|_| s.detached_work && s.detached.is_some())
                {
                    let entry = json!({"file":file,"cwd":s.cwd,"name":s.pi.as_ref().and_then(PiSession::name),"detachedAt":s.detached,
                        "finishedAt":now(),"auto":[],"code":code});
                    if st.finished.len() == 256 {
                        st.finished.remove(0);
                    }
                    st.finished.push(entry);
                }
                st.sessions.remove(&key);
            } else {
                s.failed = true;
                s.busy = false;
                s.operation = false;
                s.held_work = false;
                s.permissions.clear();
                for mut msg in s.archived() {
                    if msg["type"] == "acpStatus" {
                        if let Some(failure) = &failure {
                            msg["error"] = json!(failure.to_string());
                        }
                    }
                    s.publish(msg, false);
                }
            }
            st.log(&key, "agent process exited");
        }
    });
    Ok(Child {
        tx,
        kill,
        generation,
    })
}

fn on_output(shared: &Shared, key: &str, generation: u64, m: Value) {
    let mut state = shared.lock().unwrap();
    let Server {
        sessions, journal, ..
    } = &mut *state;
    let Some(s) = sessions
        .get_mut(key)
        .filter(|s| s.child.as_ref().is_some_and(|c| c.generation == generation))
    else {
        return;
    };
    if s.forgotten {
        return;
    }
    s.last_activity = now();
    if let Some(pi) = &mut s.pi {
        let private = pi.private_output(&m);
        let out = pi.output(&m, s.controller.is_some());
        for item in out {
            s.send(item);
        }
        if !private {
            let private_to_controller = matches!(
                m["type"].as_str(),
                Some("response" | "extension_ui_request")
            );
            s.publish(m, private_to_controller);
        }
        return;
    }
    match string(&m, "type") {
        "pimuxCheckpoint" => {
            let saved = json!({"key":key,"cwd":s.cwd,"startedAt":s.started,"title":m["title"],"agentSessionId":m["agentSessionId"],
                "messages":m["messages"],"busy":m["busy"],"acpBackend":s.acp_backend});
            if let Err(err) = journal.save(key, &saved) {
                eprintln!("pimuxd: checkpoint failed for {key}: {err}");
                s.journal_failed = true;
                if let Some(c) = s.child.take() {
                    let _ = c.kill.send(());
                }
                s.failed = true;
                s.busy = false;
                s.operation = false;
                s.permissions.clear();
                for msg in s.archived() {
                    s.publish(msg, false);
                }
            } else {
                s.checkpoint = saved;
            }
            return;
        }
        "acpTitle" => {
            s.title = string(&m, "title").to_owned();
            s.busy = m["busy"] == true;
        }
        "acpStatus" => s.failed = m["error"].is_string(),
        "acpOperation" => s.operation = !string(&m, "message").is_empty(),
        "permission" => { /* ready can replay the same request */ }
        _ => {}
    }
    if m["type"] == "permission" || m["type"] == "permissionClosed" {
        // The worker may replay permissions on ready. Use their identities rather than counting repeats.
        s.permissions.retain(|id| id != &m["id"]);
        if m["type"] == "permission" {
            s.permissions.push(m["id"].clone());
        }
    }
    let permission = m["type"] == "permission" || m["type"] == "permissionClosed";
    s.publish(m, permission);
}

fn attach(
    state: &mut Server,
    id: u64,
    key: &str,
    tx: Tx,
    disconnect: oneshot::Sender<()>,
    observe: bool,
    op: &Value,
) -> Result<()> {
    let s = state.sessions.get_mut(key).context("session not found")?;
    if s.forgotten {
        bail!("the previous agent is still stopping; try again shortly");
    }
    let takeover = !observe && s.controller.is_some();
    if takeover {
        if op["takeover"] != true || s.pi.is_none() {
            bail!("session already has a controller");
        }
        if let Some(old) = s.controller.take().and_then(|c| s.clients.remove(&c.id)) {
            let _ = old.tx.try_send(
                json!({"type":"daemon_exit","error":"This session moved to another window."}),
            );
        }
    }
    let detached_ms = s.detached.map(|since| now().saturating_sub(since));
    if s.pi.is_none() {
        tx.try_send(
            json!({"type":"acp_attached","key":key,"readOnly":observe,"acpBackend":s.acp_backend}),
        )?;
        if s.child.is_none() {
            for m in s.archived() {
                tx.try_send(m)?;
            }
        } else {
            s.send(json!({"type":"ready"}));
        }
    } else if observe {
        tx.try_send(json!({"type":"daemon_observing","session":s.list()}))?;
    } else if takeover || detached_ms.is_some() {
        for m in
            s.pi.as_mut()
                .unwrap()
                .attach(op["policy"].as_str(), detached_ms.unwrap_or_default())
        {
            tx.try_send(m)?;
        }
    }
    if !observe {
        let can_reveal = op["canReveal"] == true;
        // A restored VS Code tab can attach before the window claims the reconnect request.
        if can_reveal && s.reconnect_until.is_some_and(|until| Instant::now() < until) {
            tx.try_send(json!({"type":"daemon_reveal"}))?;
        }
        s.controller = Some(Controller { id, can_reveal });
        s.reconnect_until = None;
        s.detached = None;
        s.held_work = false;
        s.detached_work = false;
    }
    s.clients.insert(
        id,
        Viewer {
            tx,
            _disconnect: disconnect,
        },
    );
    state.log(
        key,
        if observe {
            "observer attached"
        } else {
            "controller attached"
        },
    );
    Ok(())
}

fn open(shared: &Shared, state: &mut Server, op: &Value) -> Result<String> {
    let acp = op["op"] == "acp_open";
    let cwd = string(op, "cwd");
    let args = args(op)?;
    if !acp {
        if let Some(s) = state
            .sessions
            .values()
            .find(|s| s.pi.as_ref().is_some_and(|p| p.key_matches(&args, cwd)))
        {
            return Ok(s.key.clone());
        }
    }
    if state.sessions.len() >= MAX_SESSIONS {
        bail!("pimuxd session limit reached");
    }
    state.seq += 1;
    let key = if acp {
        string(op, "key").to_owned()
    } else {
        format!("p-{}-{}", now(), state.seq)
    };
    if !valid_key(&key) || state.sessions.contains_key(&key) {
        bail!("invalid or duplicate session key");
    }
    let pi = (!acp).then(|| PiSession::new(&args, cwd, string(op, "policy")));
    let mut s = Session::new(key.clone(), cwd.into(), pi);
    if acp {
        s.acp_backend = acp_backend(op);
    }
    s.child = Some(spawn_child(shared, &key, state.seq, op, acp, None)?);
    state.sessions.insert(key.clone(), s);
    state.log(&key, "agent process started");
    Ok(key)
}

async fn connection(shared: Shared, sock: UnixStream, id: u64) -> Result<()> {
    let (read, mut write) = sock.into_split();
    let mut reader = BufReader::new(read);
    let mut line = Vec::new();
    if !tokio::time::timeout(Duration::from_secs(10), record(&mut reader, &mut line)).await?? {
        return Ok(());
    }
    let op: Value = serde_json::from_slice(&line)?;
    line.clear();
    let kind = string(&op, "op");
    let key = string(&op, "key");
    let (tx, mut rx) = mpsc::channel::<Value>(QUEUE);
    let (disconnect, mut stopped) = oneshot::channel();
    let result: Result<String> = (|| {
        let mut state = shared.lock().unwrap();
        if state.shutdown
            && matches!(
                kind,
                "open" | "pi_attach" | "acp_open" | "acp_attach" | "acp_observe" | "observe"
            )
        {
            bail!("daemon is stopping");
        }
        match kind {
            "open" | "acp_open" => {
                let key = open(&shared, &mut state, &op)?;
                attach(&mut state, id, &key, tx.clone(), disconnect, false, &op)?;
                Ok(key)
            }
            "pi_attach" => {
                let s = state.sessions.get(key)
                    .filter(|s| s.pi.is_some())
                    .context("Pi session not found")?;
                if s.controller.is_some() {
                    bail!("session already has a controller");
                }
                if s.detached.is_none() {
                    bail!("Pi session is not detached");
                }
                attach(&mut state, id, key, tx.clone(), disconnect, false, &op)?;
                Ok(key.to_owned())
            }
            "acp_attach" | "acp_observe" | "observe" => {
                if kind != "observe" && !state.sessions.get(key).is_some_and(|s| s.pi.is_none()) {
                    bail!("ACP session not found");
                }
                attach(
                    &mut state,
                    id,
                    key,
                    tx.clone(),
                    disconnect,
                    kind != "acp_attach",
                    &op,
                )?;
                Ok(key.to_owned())
            }
            _ => {
                let answer = match kind {
                    "list" | "hello" => {
                        let mut answer = json!({"protocol":PROTOCOL,"minProtocol":PROTOCOL,"version":env!("CARGO_PKG_VERSION"),
                            "pid":std::process::id(),"sessions":state.sessions.values().map(Session::list).collect::<Vec<_>>(),
                            "finished":state.finished,"canNavigate":true});
                        if let ("list", Some(cwds)) = (kind, op["reconnectCwds"].as_array()) {
                            let cwds = cwds.iter().filter_map(Value::as_str).filter_map(normalize_cwd).collect();
                            let now = Instant::now();
                            let reconnect: Vec<_> = state.sessions.values_mut()
                                .filter_map(|s| s.take_reconnect(&cwds, now))
                                .collect();
                            if !reconnect.is_empty() {
                                answer["reconnect"] = json!(reconnect);
                            }
                        }
                        answer
                    }
                    "reveal" => {
                        let status = state.sessions.get_mut(key).map_or("unavailable", |s| s.reveal(op["reconnect"] == true));
                        json!({"status":status})
                    }
                    "inspect" => {
                        let s = state.sessions.get(key).context("session not found")?;
                        json!({"session":s.list(),"messages":s.checkpoint["messages"],"interrupted":s.child.is_none()&&s.checkpoint["busy"]==true})
                    }
                    "logs" => {
                        json!({"entries":state.logs.iter().filter(|(k,_)|k==key).map(|(_,m)|m).collect::<Vec<_>>()})
                    }
                    "stop" => {
                        let s = state.sessions.get_mut(key).context("session not found")?;
                        if let Some(c) = &mut s.child {
                            let (dead, _) = oneshot::channel();
                            let _ = std::mem::replace(&mut c.kill, dead).send(());
                        }
                        json!({"ok":true})
                    }
                    "kill" => {
                        state.remove(key)?;
                        json!({"ok":true})
                    }
                    "ack" => {
                        if let Some(files) = op["files"].as_array() {
                            state.finished.retain(|m| !files.contains(&m["file"]));
                        }
                        json!({})
                    }
                    "shutdown" => {
                        if op["force"] != true && state.sessions.values().any(|s| s.child.is_some())
                        {
                            bail!("live sessions exist. Stop them or use shutdown --force");
                        }
                        state.shutdown = true;
                        json!({"ok":true})
                    }
                    _ => bail!("unknown operation"),
                };
                tx.try_send(answer)?;
                Ok(String::new())
            }
        }
    })();
    let key = match result {
        Ok(key) => key,
        Err(e) => {
            let msg = if matches!(kind, "open" | "pi_attach") {
                json!({"type":"daemon_exit","error":e.to_string()})
            } else if kind.starts_with("acp_") {
                json!({"type":"acp_attachError","message":e.to_string()})
            } else {
                json!({"error":e.to_string()})
            };
            write.write_all(format!("{msg}\n").as_bytes()).await?;
            return Ok(());
        }
    };
    drop(tx);
    if key.is_empty() {
        if let Some(msg) = rx.recv().await {
            write.write_all(format!("{msg}\n").as_bytes()).await?;
        }
        return Ok(());
    }
    let writer = async {
        while let Some(m) = rx.recv().await {
            write.write_all(format!("{m}\n").as_bytes()).await?;
        }
        Ok::<(), io::Error>(())
    };
    let receive = async {
        while record(&mut reader, &mut line).await? {
            let m = serde_json::from_slice::<Value>(&line);
            line.clear();
            if let Ok(m) = m {
                if !input(&shared, &key, id, &m) {
                    break;
                }
            }
        }
        Ok::<(), io::Error>(())
    };
    tokio::select! { _=writer=>{}, _=receive=>{}, _=&mut stopped=>{} }
    let mut state = shared.lock().unwrap();
    if let Some(s) = state.sessions.get_mut(&key) {
        s.clients.remove(&id);
        if s.controller_id() == Some(id) {
            s.controller = None;
            s.detached = Some(now());
            s.detached_work = s.active();
            if let Some(pi) = &mut s.pi {
                for item in pi.detached() {
                    s.send(item);
                }
            }
            state.log(&key, "controller detached");
        }
    }
    Ok(())
}

fn input(shared: &Shared, key: &str, id: u64, m: &Value) -> bool {
    let mut state = shared.lock().unwrap();
    if state.shutdown {
        return false;
    }
    let Some(s) = state.sessions.get_mut(key) else {
        return false;
    };
    if s.controller_id() != Some(id) {
        return s.clients.contains_key(&id);
    }
    match string(m, "type") {
        "daemon_kill" | "acp_close" => {
            let _ = state.remove(key);
            return false;
        }
        "daemon_detach" => {
            s.held_work = m["keep"] == true;
            return false;
        }
        "acp_relaunch" if s.pi.is_none() && s.child.is_none() && !s.journal_failed => {
            let mut op = m.clone();
            op["cwd"] = json!(s.cwd);
            let backend = acp_backend(&op);
            let same_backend = s.acp_backend["fingerprint"] == backend["fingerprint"];
            if op["restoreContext"] == true && (!same_backend || !s.can_restore_context()) {
                s.publish(json!({"type":"error","message":"The saved agent does not match this profile. Start without earlier context."}), true);
                return true;
            }
            let recovery = json!({"title":s.title,"messages":s.checkpoint["messages"].as_array().cloned().unwrap_or_default(),
                "agentSessionId":if op["restoreContext"] == true {s.checkpoint["agentSessionId"].clone()} else {Value::Null},"interrupted":s.checkpoint["busy"]==true});
            state.seq += 1;
            let result = spawn_child(shared, key, state.seq, &op, true, Some(recovery));
            let s = state.sessions.get_mut(key).unwrap();
            match result {
                Ok(c) => {
                    s.child = Some(c);
                    s.failed = false;
                    s.acp_backend = backend;
                    s.publish(
                        json!({"type":"acpBackend","acpBackend":s.acp_backend}),
                        false,
                    );
                    state.log(key, "agent reopened from journal");
                }
                Err(e) => s.publish(json!({"type":"error","message":e.to_string()}), true),
            };
            return true;
        }
        "ready" if s.pi.is_none() && s.child.is_none() => {
            for m in s.archived() {
                s.publish(m, false);
            }
            return true;
        }
        _ => {}
    }
    let records = if let Some(pi) = &mut s.pi {
        pi.client(m)
    } else {
        vec![m.clone()]
    };
    for record in records {
        if !s.send(record) {
            s.publish(json!({"type":"error","message":"Agent input is unavailable or its queue is full."}),true);
            break;
        }
    }
    true
}

pub async fn serve(dir: PathBuf) -> Result<()> {
    fs::create_dir_all(&dir)?;
    let stat = fs::symlink_metadata(&dir)?;
    if !stat.is_dir() || stat.uid() != unsafe { libc::geteuid() } {
        bail!("daemon directory must belong to this user");
    }
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join("pimuxd.lock"))?;
    use std::os::fd::AsRawFd;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        bail!("another pimuxd is starting or running");
    }
    let path = dir.join("daemon.sock");
    if path.symlink_metadata().is_ok() {
        match UnixStream::connect(&path).await {
            Ok(_) => bail!("another daemon already owns the socket"),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
                ) => {}
            Err(e) => return Err(e).context("could not check the existing daemon socket"),
        }
        use std::os::unix::fs::FileTypeExt;
        if !fs::symlink_metadata(&path)?.file_type().is_socket() {
            bail!("not a socket: {}", path.display());
        }
        fs::remove_file(&path)?;
    }
    let journal = Journal::new(&dir)?;
    let mut sessions = HashMap::new();
    for v in journal.load()? {
        let key = string(&v, "key").to_owned();
        let mut s = Session::new(key.clone(), string(&v, "cwd").into(), None);
        s.acp_backend = v["acpBackend"].clone();
        s.started = v["startedAt"].as_u64().unwrap_or_else(now);
        s.detached = Some(now());
        s.failed = true;
        s.title = string(&v, "title").into();
        s.checkpoint = v;
        sessions.insert(key, s);
    }
    let socket = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let shared = Arc::new(Mutex::new(Server {
        sessions,
        journal,
        seq: 0,
        logs: VecDeque::new(),
        finished: Vec::new(),
        shutdown: false,
    }));
    let gate = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut id = 0;
    loop {
        tokio::select! {
            result=socket.accept()=>{
                let (sock,_)=result?;let Ok(permit)=gate.clone().try_acquire_owned() else {continue;};
                let shared=shared.clone();id+=1;
                tokio::spawn(async move{let _permit=permit;let _=connection(shared,sock,id).await;});
            }
            _=term.recv()=>break,
            _=tokio::signal::ctrl_c()=>break,
            _=tick.tick()=>{
                let mut s=shared.lock().unwrap();
                if s.shutdown {break;}
                s.finished.retain(|f|now().saturating_sub(f["finishedAt"].as_u64().unwrap_or(0))<259_200_000);
                let instant = Instant::now();
                for session in s.sessions.values_mut() {
                    if session.reconnect_until.is_some_and(|until| instant >= until) {
                        session.reconnect_until = None;
                    }
                    if session.controller.is_none() && !session.busy && !session.operation && session.permissions.is_empty()
                        && !session.pi.as_ref().is_some_and(|p| p.busy() || p.waiting() > 0) && session.child.is_some() &&
                        session.detached.is_some_and(|t|now().saturating_sub(t.max(session.last_activity))>=if session.pi.is_some(){60_000}else{IDLE_MS}) {
                        if let Some(child)=&mut session.child { let (dead,_)=oneshot::channel(); let _=std::mem::replace(&mut child.kill,dead).send(()); }
                    }
                }
            }
        }
    }
    drop(socket);
    fs::remove_file(&path)?;
    let mut stopped = Vec::new();
    {
        let mut state = shared.lock().unwrap();
        for s in state.sessions.values_mut() {
            if let Some(c) = &mut s.child {
                let (dead, _) = oneshot::channel();
                stopped.push(std::mem::replace(&mut c.kill, dead));
            }
        }
    }
    for stop in stopped {
        let _ = stop.send(());
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while tokio::time::Instant::now() < deadline {
        if shared
            .lock()
            .unwrap()
            .sessions
            .values()
            .all(|s| s.child.is_none())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Ok(())
}
