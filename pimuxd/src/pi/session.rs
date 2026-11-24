use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_AUTO_ANSWERS: usize = 100;
const MAX_REPLAY_BYTES: usize = 4 * 1024 * 1024;
const MAX_REPLAY_EVENTS: usize = 160;

#[derive(Clone, Copy)]
enum Policy {
    Wait,
    Deny,
    AcceptRecommended,
}

impl Policy {
    fn parse(policy: &str) -> Self {
        match policy {
            "deny" => Self::Deny,
            "acceptRecommended" => Self::AcceptRecommended,
            _ => Self::Wait,
        }
    }

    fn answer(self, msg: &Value) -> Option<(Value, String)> {
        match self {
            Self::Wait => None,
            Self::Deny => Some((json!({"cancelled": true}), "cancelled".into())),
            Self::AcceptRecommended => match msg["method"].as_str()? {
                "confirm" => Some((json!({"confirmed": true}), "Yes".into())),
                "select" => {
                    let mut options = msg["options"].as_array()?.iter().map(ui_string);
                    let first = options.next()?;
                    let recommended = |s: &String| s.to_ascii_lowercase().contains("(recommended)");
                    let answer = if recommended(&first) {
                        first
                    } else {
                        options.find(recommended).unwrap_or(first)
                    };
                    Some((json!({"value": answer}), answer))
                }
                // Free text has no recommended answer.
                _ => None,
            },
        }
    }
}

struct Dialog {
    record: Value,
    expires_at: Option<Instant>,
}

impl Dialog {
    fn new(record: &Value, now: Instant) -> Self {
        // Pi answers timed dialogs itself. Give it the same 500ms grace as the Node daemon.
        let expires_at = record["timeout"].as_f64().and_then(|ms| {
            let ms = ms + 500.0;
            let ms = if (1.0..=i32::MAX as f64).contains(&ms) {
                ms as u64
            } else {
                1
            };
            now.checked_add(Duration::from_millis(ms))
        });
        Self {
            record: record.clone(),
            expires_at,
        }
    }

    fn pending(&self, now: Instant) -> bool {
        !self.expires_at.is_some_and(|end| now >= end)
    }
}

#[derive(PartialEq, Eq)]
enum UiKey {
    Queue,
    Status(String),
    Widget(String),
}

/// Replay state for one Pi RPC process. Pi owns the completed transcript.
pub(crate) struct PiSession {
    root: PathBuf,
    policy: Policy,
    run_started_at: Option<u64>,
    tail: Vec<(usize, Value)>,
    tail_bytes: usize,
    dialogs: Vec<Dialog>,
    ui: Vec<(UiKey, Value)>,
    file: Option<String>,
    id: Option<String>,
    name: Option<String>,
    auto: Vec<Value>,
}

impl PiSession {
    pub fn new(args: &[String], cwd: &str, policy: &str) -> Self {
        let root = std::env::current_dir().unwrap_or_default();
        let (file, id) = target_of(args, &root.join(cwd));
        Self {
            root,
            policy: Policy::parse(policy),
            run_started_at: None,
            tail: Vec::new(),
            tail_bytes: 0,
            dialogs: Vec::new(),
            ui: Vec::new(),
            file,
            id,
            name: None,
            auto: Vec::new(),
        }
    }

    pub fn key_matches(&self, args: &[String], cwd: &str) -> bool {
        let (file, id) = target_of(args, &self.root.join(cwd));
        (id.is_some() && id == self.id)
            || file
                .as_ref()
                .zip(self.file())
                .is_some_and(|(target, held)| {
                    resolve(&self.root, held).as_path() == Path::new(target)
                })
    }

    /// Replay only the records that the client's new snapshot does not have.
    pub fn attach(&mut self, policy: Option<&str>, detached_ms: u64) -> Vec<Value> {
        self.expire_dialogs();
        if let Some(policy) = policy {
            self.policy = Policy::parse(policy);
        }
        let mut info = json!({
            "type": "daemon_attached",
            "detachedMs": detached_ms,
            "auto": std::mem::take(&mut self.auto),
        });
        if let Some(name) = self.name() {
            info["name"] = json!(name);
        }
        if let Some(start) = self.run_started_at {
            info["runStartedAt"] = json!(start);
        }
        let mut replay = vec![info];
        replay.extend(self.ui.iter().map(|(_, msg)| msg.clone()));
        replay.extend(self.tail.iter().map(|(_, msg)| msg.clone()));
        replay.extend(self.dialogs.iter().map(|d| d.record.clone()));
        replay
    }

    pub fn client(&mut self, msg: &Value) -> Vec<Value> {
        self.expire_dialogs();
        if msg["type"] == "extension_ui_response" {
            self.dialogs.retain(|d| d.record["id"] != msg["id"]);
        }
        vec![msg.clone()]
    }

    pub fn output(&mut self, msg: &Value, attached: bool) -> Vec<Value> {
        self.expire_dialogs();
        match msg["type"].as_str() {
            Some("agent_start") => {
                let epoch = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default();
                self.run_started_at = Some(epoch.as_millis() as u64);
                self.clear_tail();
            }
            Some("agent_settled") => {
                self.run_started_at = None;
                self.clear_tail();
                self.update_ui(UiKey::Queue, None);
            }
            Some("message_end") => self.clear_tail(),
            Some("queue_update") => self.update_ui(UiKey::Queue, Some(msg)),
            Some("response")
                if msg["command"] == "get_state"
                    && msg["success"] == true
                    && msg["data"].is_object() =>
            {
                let state = &msg["data"];
                self.file = owned_str(&state["sessionFile"]);
                self.id = owned_str(&state["sessionId"]);
                self.name = owned_str(&state["sessionName"]);
            }
            Some("extension_ui_request") => match msg["method"].as_str() {
                Some("select" | "confirm" | "input" | "editor") => {
                    let existing = self
                        .dialogs
                        .iter()
                        .position(|d| d.record["id"] == msg["id"]);
                    if !attached {
                        if let Some(answer) = self.auto_answer(msg) {
                            if let Some(i) = existing {
                                self.dialogs.remove(i);
                            }
                            return vec![answer];
                        }
                    }
                    let dialog = Dialog::new(msg, Instant::now());
                    if let Some(i) = existing {
                        self.dialogs[i] = dialog;
                    } else if self.dialogs.len() < 32 && msg.to_string().len() <= 64 * 1024 {
                        self.dialogs.push(dialog);
                    }
                }
                Some("setStatus") => self.update_ui(
                    UiKey::Status(ui_key(msg, "statusKey")),
                    (!msg["statusText"].is_null()).then_some(msg),
                ),
                Some("setWidget") => self.update_ui(
                    UiKey::Widget(ui_key(msg, "widgetKey")),
                    (!msg["widgetLines"].is_null()).then_some(msg),
                ),
                _ => {}
            },
            Some(
                "message_start"
                | "message_update"
                | "tool_execution_start"
                | "tool_execution_update"
                | "tool_execution_end",
            ) => self.push_tail(msg),
            _ => {}
        }
        Vec::new()
    }

    /// The client already requests state and messages. No daemon polls need filtering.
    pub fn private_output(&self, _msg: &Value) -> bool {
        false
    }

    pub fn detached(&mut self) -> Vec<Value> {
        self.expire_dialogs();
        self.auto.clear();
        let mut answers = Vec::new();
        for dialog in std::mem::take(&mut self.dialogs) {
            if let Some(answer) = self.auto_answer(&dialog.record) {
                answers.push(answer);
            } else {
                self.dialogs.push(dialog);
            }
        }
        answers
    }

    pub fn busy(&self) -> bool {
        self.run_started_at.is_some()
    }

    pub fn waiting(&self) -> usize {
        let now = Instant::now();
        self.dialogs.iter().filter(|d| d.pending(now)).count()
    }

    pub fn file(&self) -> Option<&str> {
        self.file.as_deref()
    }

    pub fn id(&self) -> Option<&str> {
        self.id.as_deref()
    }

    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    fn expire_dialogs(&mut self) {
        let now = Instant::now();
        self.dialogs.retain(|d| d.pending(now));
    }

    fn auto_answer(&mut self, msg: &Value) -> Option<Value> {
        let (mut response, answer) = self.policy.answer(msg)?;
        response["type"] = json!("extension_ui_response");
        if let Some(id) = msg.get("id") {
            response["id"] = id.clone();
        }
        if self.auto.len() < MAX_AUTO_ANSWERS {
            let title = ["title", "message", "method"]
                .iter()
                .find_map(|key| msg.get(key).filter(|v| !v.is_null()))
                .map(ui_string)
                .unwrap_or_default();
            self.auto.push(json!({"title": title, "answer": answer}));
        }
        Some(response)
    }

    fn clear_tail(&mut self) {
        self.tail.clear();
        self.tail_bytes = 0;
    }

    fn push_tail(&mut self, msg: &Value) {
        let bytes = msg.to_string().len();
        if bytes > MAX_REPLAY_BYTES {
            return;
        }
        while self.tail_bytes + bytes > MAX_REPLAY_BYTES || self.tail.len() >= MAX_REPLAY_EVENTS {
            self.tail_bytes -= self.tail.remove(0).0;
        }
        self.tail_bytes += bytes;
        self.tail.push((bytes, msg.clone()));
    }

    // Keep insertion order so replay matches the original order of UI slots.
    fn update_ui(&mut self, key: UiKey, msg: Option<&Value>) {
        let msg = msg.filter(|msg| msg.to_string().len() <= 64 * 1024);
        match (self.ui.iter().position(|(k, _)| *k == key), msg) {
            (Some(i), Some(msg)) => self.ui[i].1 = msg.clone(),
            (Some(i), None) => {
                self.ui.remove(i);
            }
            (None, Some(msg)) if self.ui.len() < 32 => self.ui.push((key, msg.clone())),
            (None, _) => {}
        }
    }
}

fn owned_str(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn ui_key(msg: &Value, key: &str) -> String {
    msg.get(key).map_or_else(|| "undefined".into(), ui_string)
}

fn ui_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(items) => items
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    ui_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => value.to_string(),
    }
}

fn target_of(args: &[String], cwd: &Path) -> (Option<String>, Option<String>) {
    let mut file = None;
    let mut id = None;
    for (i, arg) in args.iter().enumerate() {
        let (flag, val) = match arg.split_once('=') {
            Some((flag, val)) => (flag, Some(val)),
            None => (arg.as_str(), args.get(i + 1).map(String::as_str)),
        };
        let Some(val) = val.filter(|s| !s.is_empty()) else {
            continue;
        };
        match flag {
            // --session also takes an id prefix. Only a path names a file.
            "--session" if Path::new(val).is_absolute() || val.ends_with(".jsonl") => {
                file = Some(resolve(cwd, val).to_string_lossy().into_owned());
            }
            "--session-id" => id = Some(val.to_owned()),
            _ => {}
        }
    }
    (file, id)
}

// Resolve lexically like path.resolve. The file does not need to exist yet.
fn resolve(cwd: &Path, file: &str) -> PathBuf {
    let mut path = PathBuf::new();
    for part in cwd.join(file).components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir if path.file_name().is_some_and(|n| n != "..") => {
                path.pop();
            }
            Component::ParentDir if path.has_root() => {}
            _ => path.push(part.as_os_str()),
        }
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| (*s).into()).collect()
    }

    fn dialog(id: &str, method: &str) -> Value {
        json!({"type": "extension_ui_request", "id": id, "method": method, "title": id})
    }

    #[test]
    fn session_key_tracks_get_state() {
        let mut pi = PiSession::new(
            &args(&["--session=dir/../chat.jsonl", "--session-id", "one"]),
            "/work",
            "wait",
        );
        assert_eq!(pi.file(), Some("/work/chat.jsonl"));
        assert!(pi.key_matches(&args(&["--session", "/work/./chat.jsonl"]), "/elsewhere"));
        assert!(pi.key_matches(&args(&["--session-id=one"]), "/elsewhere"));
        assert!(!pi.key_matches(&args(&["--session", "one"]), "/work"));
        assert!(!pi.key_matches(&args(&["--session=chat.jsonl"]), "/elsewhere"));
        assert!(!pi.key_matches(&[], "/work"));

        let request = json!({"type": "get_state", "id": "vsc-1"});
        assert_eq!(pi.client(&request), vec![request]);
        let response = json!({"type": "response", "id": "vsc-1", "command": "get_state", "success": true,
            "data": {"sessionFile": "/work/other.jsonl", "sessionId": "two", "sessionName": "Other"}});
        assert!(!pi.private_output(&response));
        assert!(pi.output(&response, true).is_empty());
        assert_eq!(pi.id(), Some("two"));
        assert_eq!(pi.name(), Some("Other"));
        assert!(!pi.key_matches(&args(&["--session-id=one"]), "/work"));
        assert!(pi.key_matches(&args(&["--session=other.jsonl"]), "/work"));
        assert_eq!(pi.attach(None, 10)[0]["name"], "Other");
    }

    #[test]
    fn replays_ui_then_unfinished_output_then_dialogs() {
        let mut pi = PiSession::new(&[], "/work", "wait");
        let mut status = json!({"type": "extension_ui_request", "method": "setStatus", "statusKey": "a", "statusText": "old"});
        let mut widget = json!({"type": "extension_ui_request", "method": "setWidget", "widgetKey": "a", "widgetLines": ["body"]});
        let queue = json!({"type": "queue_update", "followUp": ["next"]});
        let tail = json!({"type": "tool_execution_update", "toolCallId": "2"});
        let prompt = dialog("ask", "input");
        pi.output(&status, true);
        pi.output(&widget, true);
        status["statusText"] = json!("new");
        pi.output(&status, true);
        pi.output(&queue, true);
        pi.output(&json!({"type": "agent_start"}), true);
        pi.output(&json!({"type": "message_start"}), false);
        pi.output(&json!({"type": "message_end"}), false);
        pi.output(&tail, false);
        pi.output(&prompt, false);
        pi.output(&json!({"type": "agent_end"}), false);
        assert!(pi.busy());
        let replay = pi.attach(None, 300);
        assert_eq!(replay[0]["type"], "daemon_attached");
        assert_eq!(replay[0]["detachedMs"], 300);
        assert!(replay[0]["runStartedAt"].is_u64());
        assert_eq!(
            &replay[1..],
            &[status.clone(), widget.clone(), queue, tail, prompt]
        );

        let answer = json!({"type": "extension_ui_response", "id": "ask", "value": "text"});
        assert_eq!(pi.client(&answer), vec![answer]);
        widget["widgetLines"] = Value::Null;
        pi.output(&widget, true);
        pi.output(&json!({"type": "agent_settled"}), true);
        assert!(!pi.busy());
        assert_eq!(pi.waiting(), 0);
        assert_eq!(
            pi.attach(None, 0),
            vec![
                json!({"type": "daemon_attached", "detachedMs": 0, "auto": []}),
                status
            ]
        );
    }

    #[test]
    fn auto_answers_only_detached_and_reports_once() {
        let mut pi = PiSession::new(&[], "/work", "acceptRecommended");
        let mut select = dialog("options", "select");
        select["options"] = json!(["first", "second (RECOMMENDED)"]);
        assert!(pi.output(&select, true).is_empty());
        let input = dialog("text", "input");
        pi.output(&input, true);
        assert_eq!(pi.waiting(), 2);
        assert_eq!(
            pi.detached(),
            vec![
                json!({"type": "extension_ui_response", "id": "options", "value": "second (RECOMMENDED)"})
            ]
        );
        assert_eq!(
            pi.output(&dialog("ok", "confirm"), false),
            vec![json!({"type": "extension_ui_response", "id": "ok", "confirmed": true})]
        );
        assert_eq!(pi.waiting(), 1);
        let replay = pi.attach(Some("deny"), 20);
        assert_eq!(
            replay[0]["auto"],
            json!([
                {"title": "options", "answer": "second (RECOMMENDED)"},
                {"title": "ok", "answer": "Yes"},
            ])
        );
        assert_eq!(&replay[1..], &[input]);
        assert_eq!(pi.attach(None, 0)[0]["auto"], json!([]));
        assert_eq!(
            pi.detached(),
            vec![json!({"type": "extension_ui_response", "id": "text", "cancelled": true})]
        );
        assert_eq!(pi.waiting(), 0);
    }

    #[test]
    fn expired_dialog_does_not_wait_or_replay() {
        let mut pi = PiSession::new(&[], "/work", "acceptRecommended");
        let mut prompt = dialog("timed", "confirm");
        prompt["timeout"] = json!(100);
        let now = Instant::now();
        assert!(Dialog::new(&prompt, now).pending(now + Duration::from_millis(599)));
        assert!(!Dialog::new(&prompt, now).pending(now + Duration::from_millis(600)));

        let before = now - Duration::from_secs(1);
        pi.dialogs.push(Dialog::new(&prompt, before));
        assert_eq!(pi.waiting(), 0);
        assert!(pi.detached().is_empty());
        assert_eq!(pi.attach(None, 0).len(), 1);
    }
}
