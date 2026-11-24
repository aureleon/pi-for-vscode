use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

const MAX_CHECKPOINT_BYTES: usize = 7 * 1024 * 1024;
// Leave room for the title and session ID, including JSON escapes.
const HISTORY_BYTES: usize = MAX_CHECKPOINT_BYTES - 128 * 1024;
const MAX_MESSAGE_BYTES: usize = 512 * 1024;
const MAX_BLOCKS: usize = 256;
const MAX_TOOLS: usize = 256;
const MAX_TOOL_TEXT: usize = 20_000;
const MAX_SESSION_ID: usize = 16 * 1024;
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_TOTAL: usize = 16 * 1024 * 1024;
const TOOL_PREFIX: &str = "acp-rust-";
const COMPACTING: &str = "Compacting context…";
const TOOL_NAME: &str = "Tool";

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn prefix(text: &str, limit: usize) -> &str {
    let mut end = limit.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn clip(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.into();
    }
    let mut start = text.len() - limit;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("[Earlier text omitted]\n{}", &text[start..])
}

fn session_id(text: &str) -> Option<String> {
    (!text.is_empty() && text.len() <= MAX_SESSION_ID).then(|| text.into())
}

fn event(kind: &str, mut fields: Value) -> Value {
    fields["type"] = json!(kind);
    json!({"type":"event","event":fields})
}

fn error(message: &str) -> Value {
    json!({"type":"error","message":message})
}

fn note(text: &str) -> Value {
    assistant(vec![json!({"type":"text","text":format!("_{text}_")})])
}

fn assistant(content: Vec<Value>) -> Value {
    json!({"role":"assistant","content":content})
}

// Keep only the fields used by the webview. Image data is sent live, not stored.
fn compact_message(message: &Value) -> Option<Value> {
    let role = message["role"].as_str()?;
    if role == "user" {
        if let Some(text) = message["content"].as_str() {
            return Some(json!({"role":role,"content":clip(text, MAX_MESSAGE_BYTES)}));
        }
    }
    let blocks = message["content"].as_array()?;
    let blocks = &blocks[blocks.len().saturating_sub(MAX_BLOCKS)..];
    let limit = MAX_MESSAGE_BYTES / blocks.len().max(1);
    let content: Vec<_> = blocks
        .iter()
        .filter_map(|b| match (role, b["type"].as_str()?) {
            ("user" | "assistant" | "toolResult", "text") => {
                Some(json!({"type":"text","text":clip(b["text"].as_str()?, limit)}))
            }
            ("user", "image") => Some(json!({"type":"text","text":"[Image omitted]"})),
            ("assistant", "thinking") => {
                Some(json!({"type":"thinking","thinking":clip(b["thinking"].as_str()?, limit)}))
            }
            ("assistant", "toolCall") => Some(json!({"type":"toolCall",
                "id":prefix(b["id"].as_str()?, 256),"name":prefix(b["name"].as_str()?, 100),
                "arguments":{"title":prefix(b["arguments"]["title"].as_str()?, 500)}})),
            _ => None,
        })
        .collect();
    match role {
        "user" => Some(json!({"role":role,"content":content})),
        "assistant" => {
            let mut saved = assistant(content);
            if message["stopReason"] == "aborted" {
                saved["stopReason"] = json!("aborted");
            }
            Some(saved)
        }
        "toolResult" => Some(json!({"role":role,"content":content,
            "toolCallId":prefix(message["toolCallId"].as_str()?, 256),
            "toolName":prefix(message["toolName"].as_str()?, 100),"isError":message["isError"] == true})),
        _ => None,
    }
}

struct Entry {
    message: Value,
    bytes: usize,
}

impl Entry {
    fn new(message: Value) -> Self {
        let bytes = message.to_string().len() + 1;
        Self { message, bytes }
    }
}

fn tool_ids(message: &Value) -> impl Iterator<Item = &str> {
    array(&message["content"])
        .iter()
        .filter(|b| message["role"] == "assistant" && b["type"] == "toolCall")
        .filter_map(|b| b["id"].as_str())
}

// Select a recent suffix by serialized size and drop results whose calls were cut.
fn bounded<'a>(
    entries: impl DoubleEndedIterator<Item = &'a Entry>,
    mut budget: usize,
) -> Vec<&'a Entry> {
    let mut tail = Vec::new();
    for entry in entries.rev() {
        if entry.bytes > budget {
            break;
        }
        budget -= entry.bytes;
        tail.push(entry);
    }
    tail.reverse();
    let mut calls = HashSet::new();
    tail.retain(|entry| {
        let m = &entry.message;
        calls.extend(tool_ids(m));
        m["role"] != "toolResult"
            || m["toolCallId"]
                .as_str()
                .is_some_and(|id| calls.contains(id))
    });
    tail
}

fn image_size(image: &Value) -> Option<usize> {
    if image["type"] != "image"
        || !matches!(
            image["mimeType"].as_str()?,
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        )
    {
        return None;
    }
    let data = image["data"].as_str()?.as_bytes();
    let unpadded = data
        .strip_suffix(b"==")
        .or_else(|| data.strip_suffix(b"="))
        .unwrap_or(data);
    if data.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4
        || unpadded.is_empty()
        || unpadded.len() % 4 == 1
        || (data.len() != unpadded.len() && data.len() % 4 != 0)
        || !unpadded
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(*b, b'+' | b'/'))
    {
        return None;
    }
    let size = unpadded.len() * 3 / 4;
    (size <= MAX_IMAGE_BYTES).then_some(size)
}

fn choice_kind(value: &Value) -> Option<&'static str> {
    match value["category"].as_str() {
        Some("model") => Some("model"),
        Some("mode") => Some("mode"),
        Some("thought_level") => Some("effort"),
        _ => match value["id"].as_str()? {
            "model" => Some("model"),
            "mode" => Some("mode"),
            "effort" | "effortLevel" | "thought_level" => Some("effort"),
            _ => None,
        },
    }
}

fn config_choices(config: &Value) -> Vec<Value> {
    array(config)
        .iter()
        .filter_map(|c| {
            if c["type"] != "select" || choice_kind(c).is_none() {
                return None;
            }
            let options: Vec<_> = array(&c["options"])
                .iter()
                .flat_map(|o| o["options"].as_array().map(Vec::as_slice).unwrap_or_else(|| std::slice::from_ref(o)))
                .filter_map(|o| {
                    let value = o["value"].as_str()?;
                    if value.len() > 1024 {
                        return None;
                    }
                    let mut option = json!({"value":value,"label":prefix(o["name"].as_str()?, 256)});
                    if let Some(description) = o["description"].as_str() {
                        option["description"] = json!(prefix(description, 1024));
                    }
                    Some(option)
                })
                .take(128)
                .collect();
            let id = c["id"].as_str()?;
            let value = c["currentValue"].as_str()?;
            if id.len() > 256 || value.len() > 1024 {
                return None;
            }
            let mut choice = json!({"id":id,"name":prefix(c["name"].as_str()?, 256),"value":value,"options":options});
            if let Some(category) = c["category"].as_str() {
                choice["category"] = json!(prefix(category, 256));
            }
            Some(choice)
        })
        .take(32)
        .collect()
}

struct Block {
    kind: &'static str,
    text: String,
}

impl Block {
    fn message(&self) -> Value {
        json!({"type":self.kind,(self.kind):self.text})
    }

    fn delta(&self, index: usize, text: &str) -> Value {
        event(
            "message_update",
            json!({"assistantMessageEvent": {
                "type":if self.kind == "text" {"text_delta"} else {"thinking_delta"},
                "contentIndex":index,"delta":text,
            }}),
        )
    }
}

struct Tool {
    id: String,
    title: String,
    text: String,
    done: bool,
}

impl Tool {
    fn result(&self, is_error: bool, fallback: &str, interrupted: bool) -> Value {
        let text = if self.text.is_empty() {
            fallback
        } else {
            &self.text
        };
        self.result_with_text(text, is_error, interrupted)
    }

    fn result_with_text(&self, text: &str, is_error: bool, interrupted: bool) -> Value {
        let mut content = Vec::new();
        if !text.is_empty() {
            content.push(json!({"type":"text","text":text}));
        }
        if interrupted {
            content.push(json!({"type":"text","text":"Tool was interrupted."}));
        }
        json!({"role":"toolResult","toolCallId":self.id,"toolName":TOOL_NAME,"content":content,"isError":is_error})
    }

    fn partial(&self) -> Value {
        event(
            "tool_execution_update",
            json!({"toolCallId":self.id,"toolName":TOOL_NAME,"partialResult":self.result(false, "", false)}),
        )
    }
}

fn tool_text(content: &Value) -> String {
    let mut text = String::new();
    for item in array(content) {
        let (label, part) = match item["type"].as_str() {
            Some("diff") => ("Changed ", item["path"].as_str().unwrap_or_default()),
            Some("content") if item["content"]["type"] == "text" => {
                ("", item["content"]["text"].as_str().unwrap_or_default())
            }
            _ => continue,
        };
        if label.is_empty() && part.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(prefix(label, MAX_TOOL_TEXT - text.len()));
        let clipped = prefix(part, MAX_TOOL_TEXT - text.len());
        text.push_str(clipped);
        if text.len() == MAX_TOOL_TEXT || clipped.len() < part.len() {
            break;
        }
    }
    text
}

// Owns the ACP transcript and UI projection. The transport owns requests and permissions.
pub(super) struct Session {
    cwd: String,
    messages: VecDeque<Entry>,
    history_bytes: usize,
    blocks: Vec<Block>,
    block_bytes: usize,
    text_clipped: bool,
    message_id: Option<String>,
    tools: Vec<Tool>,
    tool_index: HashMap<String, usize>,
    next_tool: u64,
    busy: bool,
    ready: bool,
    title: String,
    custom_title: bool,
    title_pending: bool,
    title_version: u64,
    recovering: bool,
    agent_session_id: Option<String>,
    images: bool,
    compact: bool,
    commands: Vec<Value>,
    choices: Vec<Value>,
    usage: Option<f64>,
    operation: String,
    compacting: bool,
    compaction_status: Option<String>,
}

impl Session {
    pub(super) fn new(cwd: String, recovery: Option<Value>) -> Self {
        let mut session = Self {
            cwd,
            messages: VecDeque::new(),
            history_bytes: 0,
            blocks: Vec::new(),
            block_bytes: 0,
            text_clipped: false,
            message_id: None,
            tools: Vec::new(),
            tool_index: HashMap::new(),
            next_tool: 0,
            busy: false,
            ready: false,
            title: "New session".into(),
            custom_title: false,
            title_pending: false,
            title_version: 0,
            recovering: recovery.is_some(),
            agent_session_id: None,
            images: false,
            compact: false,
            commands: Vec::new(),
            choices: Vec::new(),
            usage: None,
            operation: String::new(),
            compacting: false,
            compaction_status: None,
        };
        if let Some(saved) = recovery {
            if let Some(title) = saved["title"].as_str() {
                session.title = prefix(title, 200).into();
                session.custom_title = true;
            }
            session.agent_session_id = saved["agentSessionId"].as_str().and_then(session_id);
            for message in array(&saved["messages"]).iter().filter_map(compact_message) {
                for id in tool_ids(&message) {
                    if let Some(n) = id
                        .strip_prefix(TOOL_PREFIX)
                        .and_then(|n| n.parse::<u64>().ok())
                    {
                        session.next_tool = session.next_tool.max(n);
                    }
                }
                session.push(message);
            }
            if saved["interrupted"] == true || saved["busy"] == true {
                session.push(note(
                    "The previous ACP turn was interrupted. Its prompt was not resent.",
                ));
            }
        }
        session
    }

    pub(super) fn replay(&self) -> Vec<Value> {
        let messages: Vec<_> = bounded(self.messages.iter(), HISTORY_BYTES)
            .into_iter()
            .map(|entry| &entry.message)
            .collect();
        let tool_ids: HashSet<_> = messages.iter().flat_map(|m| tool_ids(m)).collect();
        let mut output = vec![
            self.title(),
            json!({"type":"init","cwd":self.cwd,"messages":messages,
                "state":{"sessionName":self.title,"isStreaming":self.busy}}),
        ];
        for (index, block) in self.blocks.iter().enumerate() {
            output.push(block.delta(index, &block.text));
        }
        for tool in &self.tools {
            if !tool.done && tool_ids.contains(tool.id.as_str()) {
                output.push(event(
                    "tool_execution_start",
                    json!({"toolCallId":tool.id,"toolName":TOOL_NAME}),
                ));
                if !tool.text.is_empty() {
                    output.push(tool.partial());
                }
            }
        }
        output.extend([self.composer(), self.operation(), self.status()]);
        if !self.ready {
            output.push(json!({"type":"starting"}));
        }
        output
    }

    pub(super) fn ready(
        &mut self,
        init: &Value,
        started: &Value,
        session_id_value: &str,
        restored: bool,
    ) -> Vec<Value> {
        let capabilities = &init["agentCapabilities"];
        self.agent_session_id = if capabilities["loadSession"] == true {
            session_id(session_id_value)
        } else {
            None
        };
        if !self.custom_title {
            let info = &init["agentInfo"];
            let title = ["title", "name"]
                .iter()
                .filter_map(|&key| info[key].as_str())
                .find(|s| !s.is_empty());
            self.title = prefix(title.unwrap_or("New session"), 200).into();
        }
        self.images = capabilities["promptCapabilities"]["image"] == true;
        self.compact = array(&capabilities["_meta"]["kiro"]["extensionMethods"])
            .iter()
            .any(|m| m == "_kiro/session/compact");
        self.choices = config_choices(&started["configOptions"]);
        self.commands.clear();
        self.usage = None;
        if !restored && self.recovering {
            self.push(note(
                "New ACP session. The agent cannot see the earlier messages.",
            ));
        }
        self.recovering = false;
        self.ready = true;
        self.committed(self.replay())
    }

    pub(super) fn is_busy(&self) -> bool {
        self.busy
    }

    pub(super) fn start_turn(&mut self, text: &str, images: &[Value]) -> Vec<Value> {
        if !self.can_operate() {
            return vec![
                error("Wait for the ACP agent to finish, then try again."),
                self.composer(),
            ];
        }
        let valid = images.is_empty()
            || (self.images
                && images.len() <= 16
                && images
                    .iter()
                    .map(image_size)
                    .sum::<Option<usize>>()
                    .is_some_and(|n| n <= MAX_IMAGE_TOTAL));
        if !valid {
            return vec![error("These images cannot be sent. Check agent support and the 8 MiB per image and 16 MiB total limits."), self.composer()];
        }
        if text.trim().is_empty() && images.is_empty() {
            return Vec::new();
        }
        self.busy = true;
        let text = clip(text, MAX_MESSAGE_BYTES);
        let (saved, live) = if images.is_empty() {
            let message = json!({"role":"user","content":text});
            (message.clone(), message)
        } else {
            let mut saved = vec![json!({"type":"text","text":text})];
            let mut live = saved.clone();
            for image in images {
                saved.push(json!({"type":"text","text":"[Image omitted]"}));
                live.push(
                    json!({"type":"image","mimeType":image["mimeType"],"data":image["data"]}),
                );
            }
            (
                json!({"role":"user","content":saved}),
                json!({"role":"user","content":live}),
            )
        };
        self.push(saved);
        self.committed(vec![
            event("agent_start", json!({})),
            self.title(),
            event("message_start", json!({"message":live})),
        ])
    }

    pub(super) fn update(&mut self, update: &Value) -> Vec<Value> {
        match update["sessionUpdate"].as_str() {
            Some("config_option_update") => self.set_config_result(update),
            Some("available_commands_update") => {
                self.commands = array(&update["availableCommands"])
                    .iter()
                    .filter_map(|c| {
                        let name = c["name"].as_str()?;
                        if name.is_empty()
                            || name.len() > 256
                            || !name
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
                        {
                            return None;
                        }
                        let mut command = json!({"name":name});
                        if let Some(description) = c["description"].as_str() {
                            command["description"] = json!(prefix(description, 1024));
                        }
                        Some(command)
                    })
                    .take(80)
                    .collect();
                vec![self.composer()]
            }
            Some("usage_update") => {
                let size = update["size"].as_f64().unwrap_or_default();
                self.set_usage(
                    update["used"]
                        .as_f64()
                        .filter(|_| size > 0.0)
                        .map(|used| used / size * 100.0),
                )
            }
            Some("session_info_update") => {
                let kiro = &update["_meta"]["kiro"];
                match kiro["kind"].as_str() {
                    Some("context_usage") => self.set_usage(kiro["usagePercentage"].as_f64()),
                    Some(kind) if kind.contains("compaction") => {
                        self.compaction_update(&kiro["status"], &kiro["error"])
                    }
                    _ => Vec::new(),
                }
            }
            Some("compaction_update") => {
                self.compaction_update(&update["status"], &update["error"])
            }
            Some("agent_message_chunk") if self.busy => self.text_update("text", update),
            Some("agent_thought_chunk") if self.busy => self.text_update("thinking", update),
            Some("tool_call" | "tool_call_update") if self.busy => self.tool_update(update),
            _ => Vec::new(),
        }
    }

    pub(super) fn finish_turn(&mut self, interrupted: bool, message: Option<&str>) -> Vec<Value> {
        if !self.busy {
            return Vec::new();
        }
        let mut output = Vec::new();
        self.flush_text(&mut output);
        for tool in std::mem::take(&mut self.tools) {
            if !tool.done {
                self.add(
                    tool.result(true, "Tool did not finish.", false),
                    &mut output,
                );
            }
        }
        self.tool_index.clear();
        if let Some(message) = message.filter(|m| !m.is_empty()) {
            self.add(note(prefix(message, MAX_TOOL_TEXT)), &mut output);
        }
        if interrupted {
            self.add(
                json!({"role":"assistant","content":[],"stopReason":"aborted"}),
                &mut output,
            );
        }
        self.busy = false;
        output.extend([event("agent_settled", json!({})), self.title()]);
        self.committed(output)
    }

    pub(super) fn rename(&mut self, name: &str) -> Vec<Value> {
        let title = prefix(name.trim(), 200);
        if title.is_empty() {
            return Vec::new();
        }
        self.title = title.into();
        self.custom_title = true;
        self.title_version = self.title_version.wrapping_add(1);
        self.committed(vec![
            json!({"type":"state","state":{"sessionName":title}}),
            self.title(),
        ])
    }

    pub(super) fn title_version(&self) -> u64 {
        self.title_version
    }

    pub(super) fn set_title_pending(&mut self, pending: bool) -> Vec<Value> {
        self.title_pending = pending;
        vec![self.composer()]
    }

    // Use recent text only, with no tool output or image placeholders in the helper prompt.
    pub(super) fn title_seed(&self) -> String {
        const LIMIT: usize = 4000;
        let mut seed = String::new();
        for entry in self.messages.iter().rev() {
            let message = &entry.message;
            if message["role"] != "user" {
                continue;
            }
            let content = &message["content"];
            // Image prompts have exactly one user text block before the placeholders.
            let text = content.as_str().or_else(|| content[0]["text"].as_str());
            let Some(text) = text.map(str::trim).filter(|s| !s.is_empty()) else {
                continue;
            };
            let available = LIMIT - seed.len() - usize::from(!seed.is_empty());
            let mut start = text.len().saturating_sub(available);
            while !text.is_char_boundary(start) {
                start += 1;
            }
            if start < text.len() {
                if !seed.is_empty() {
                    seed.insert(0, '\n');
                }
                seed.insert_str(0, &text[start..]);
            }
            if start != 0 || seed.len() + 1 >= LIMIT {
                break;
            }
        }
        seed
    }

    pub(super) fn checkpoint(&self) -> Value {
        let active = self.active_message().map(Entry::new);
        let pending: Vec<_> = self
            .tools
            .iter()
            .filter(|tool| !tool.done)
            .map(|tool| (tool, Entry::new(tool.result_with_text("", true, true))))
            .collect();
        // Reserve room for interruption markers, so large tool output cannot evict active text.
        let reserve: usize = pending.iter().map(|(_, marker)| marker.bytes).sum();
        let core = bounded(
            self.messages.iter().chain(active.iter()),
            HISTORY_BYTES - reserve,
        );
        let calls: HashSet<_> = core
            .iter()
            .flat_map(|entry| tool_ids(&entry.message))
            .collect();
        let mut budget =
            HISTORY_BYTES - reserve - core.iter().map(|entry| entry.bytes).sum::<usize>();
        let mut results = Vec::new();
        for (tool, marker) in pending {
            if !calls.contains(tool.id.as_str()) {
                budget += marker.bytes;
                continue;
            }
            let result = Entry::new(tool.result(true, "", true));
            if result.bytes <= budget + marker.bytes {
                budget -= result.bytes - marker.bytes;
                results.push(result.message);
            } else {
                results.push(marker.message);
            }
        }
        let messages: Vec<_> = core
            .into_iter()
            .map(|entry| &entry.message)
            .chain(results.iter())
            .collect();
        let mut record = json!({"type":"pimuxCheckpoint","messages":messages,"title":self.title,"busy":self.busy});
        if let Some(id) = &self.agent_session_id {
            record["agentSessionId"] = json!(id);
        }
        record
    }

    pub(super) fn set_operation(&mut self, message: &str) -> Vec<Value> {
        if message == COMPACTING {
            self.compaction_status = None;
        }
        self.operation = prefix(message, 1024).into();
        vec![self.operation(), self.composer()]
    }

    pub(super) fn can_set_config(&self, id: &str, value: &str) -> bool {
        self.can_operate()
            && self.choices.iter().any(|c| {
                c["id"] == id
                    && c["value"] != value
                    && array(&c["options"]).iter().any(|o| o["value"] == value)
            })
    }

    fn set_config_result(&mut self, result: &Value) -> Vec<Value> {
        if !result["configOptions"].is_array() {
            return Vec::new();
        }
        self.choices = config_choices(&result["configOptions"]);
        vec![self.composer()]
    }

    pub(super) fn can_compact(&self) -> bool {
        self.compact && self.can_operate()
    }

    pub(super) fn finish_compaction(&mut self, success: bool) -> Vec<Value> {
        let mut output = Vec::new();
        self.operation.clear();
        if success && self.compaction_status.is_none() {
            self.compaction_status = Some("completed".into());
            self.add(note("Context compacted."), &mut output);
        } else if !success {
            self.compacting = false;
        }
        let changed = !output.is_empty();
        output.extend([self.operation(), self.composer()]);
        if changed {
            self.committed(output)
        } else {
            output
        }
    }

    pub(super) fn tool_title(&self, id: &str) -> Option<&str> {
        self.tool_index
            .get(id)
            .map(|&index| self.tools[index].title.as_str())
    }

    fn can_operate(&self) -> bool {
        self.ready && !self.busy && self.operation.is_empty() && !self.compacting
    }

    fn status(&self) -> Value {
        json!({"type":"acpStatus","ready":self.ready})
    }

    fn title(&self) -> Value {
        json!({"type":"acpTitle","title":self.title,"busy":self.busy})
    }

    fn operation(&self) -> Value {
        json!({"type":"acpOperation","message":if self.compacting && self.operation.is_empty() { COMPACTING } else { &self.operation }})
    }

    fn composer(&self) -> Value {
        let selected = |kind| {
            let choice = self.choices.iter().find(|c| choice_kind(c) == Some(kind))?;
            let options = array(&choice["options"]);
            options
                .iter()
                .find(|o| o["value"] == choice["value"])
                .and_then(|o| o["label"].as_str())
                .or_else(|| choice["value"].as_str())
        };
        let model = selected("model");
        let effort = selected("effort");
        let mut commands = if self.ready {
            self.commands.clone()
        } else {
            Vec::new()
        };
        let compact = self.ready && self.compact;
        if self.ready {
            for (enabled, name, description) in [
                (
                    model.is_some_and(|s| !s.is_empty()),
                    "model",
                    "Choose the session model",
                ),
                (
                    effort.is_some_and(|s| !s.is_empty()),
                    "effort",
                    "Choose the reasoning effort",
                ),
                (self.usage.is_some(), "context", "Show context usage"),
                (compact, "compact", "Compact the session context"),
            ] {
                if enabled && !commands.iter().any(|c| c["name"] == name) {
                    commands.push(json!({"name":name,"description":description}));
                }
            }
        }
        let mut capabilities = json!({"images":self.ready && self.images,"compact":compact,"commands":commands,
            "canTitle":self.ready && !self.title_pending,
            "config":self.ready && self.operation.is_empty() && !self.compacting && self.choices.iter().any(|c| array(&c["options"]).len() > 1)});
        if let Some(model) = model {
            capabilities["model"] = json!(model);
        }
        if let Some(effort) = effort {
            capabilities["effort"] = json!(effort);
        }
        if let Some(usage) = self.usage {
            capabilities["usage"] = json!(usage);
        }
        json!({"type":"acpComposer","choices":self.choices,"capabilities":capabilities})
    }

    fn set_usage(&mut self, percent: Option<f64>) -> Vec<Value> {
        let Some(percent) = percent.filter(|p| p.is_finite()) else {
            return Vec::new();
        };
        self.usage = Some(percent.clamp(0.0, 100.0));
        vec![self.composer()]
    }

    fn compaction_update(&mut self, status: &Value, message: &Value) -> Vec<Value> {
        let status = match status.as_str() {
            Some("in_progress" | "started") => "started",
            Some("completed" | "succeeded") => "completed",
            Some("failed") => "failed",
            Some("cancelled") => "cancelled",
            _ => return Vec::new(),
        };
        if self.compaction_status.as_deref() == Some(status) {
            return Vec::new();
        }
        self.compaction_status = Some(status.into());
        self.compacting = status == "started";
        let mut output = Vec::new();
        if status == "completed" {
            self.flush_text(&mut output);
            self.add(note("Context compacted."), &mut output);
        } else if status == "failed" {
            let detail = message.as_str().filter(|m| !m.is_empty());
            output.push(error(&detail.map_or_else(
                || "Compaction failed.".into(),
                |m| format!("Compaction failed: {}", prefix(m, 1024)),
            )));
        }
        output.extend([self.operation(), self.composer()]);
        if status == "completed" {
            self.committed(output)
        } else {
            output
        }
    }

    fn text_update(&mut self, kind: &'static str, update: &Value) -> Vec<Value> {
        let content = &update["content"];
        let Some(text) = content["text"]
            .as_str()
            .filter(|s| !s.is_empty() && content["type"] == "text")
        else {
            return Vec::new();
        };
        let mut output = Vec::new();
        if let Some(id) = update["messageId"]
            .as_str()
            .filter(|s| s.len() <= MAX_SESSION_ID)
        {
            if self.message_id.as_deref() != Some(id) {
                self.flush_text(&mut output);
                self.message_id = Some(id.into());
            }
        }
        if self.text_clipped {
            return output;
        }
        let can_merge = self.blocks.last().is_some_and(|b| b.kind == kind);
        let limit = MAX_MESSAGE_BYTES - self.block_bytes;
        let mut delta = if can_merge || self.blocks.len() < MAX_BLOCKS {
            prefix(text, limit).to_owned()
        } else {
            String::new()
        };
        self.block_bytes += delta.len();
        if delta.len() < text.len() {
            self.text_clipped = true;
            delta.push_str("\n[Further text omitted]");
        }
        if !can_merge && self.blocks.len() < MAX_BLOCKS {
            self.blocks.push(Block {
                kind,
                text: String::new(),
            });
        }
        let index = self.blocks.len() - 1;
        let block = &mut self.blocks[index];
        block.text.push_str(&delta);
        output.push(block.delta(index, &delta));
        output
    }

    fn tool_update(&mut self, update: &Value) -> Vec<Value> {
        let Some(id) = update["toolCallId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= MAX_SESSION_ID)
        else {
            return Vec::new();
        };
        let mut output = Vec::new();
        let (index, created) = if let Some(&index) = self.tool_index.get(id) {
            if self.tools[index].done {
                return output;
            }
            (index, false)
        } else {
            if self.tools.len() >= MAX_TOOLS {
                return output;
            }
            self.flush_text(&mut output);
            self.next_tool = self.next_tool.wrapping_add(1);
            let title = update["title"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("Tool call");
            let tool = Tool {
                id: format!("{TOOL_PREFIX}{}", self.next_tool),
                title: prefix(title, 500).into(),
                text: String::new(),
                done: false,
            };
            self.add(assistant(vec![json!({"type":"toolCall","id":tool.id,"name":TOOL_NAME,"arguments":{"title":tool.title}})]), &mut output);
            output.push(event(
                "tool_execution_start",
                json!({"toolCallId":tool.id,"toolName":TOOL_NAME}),
            ));
            let index = self.tools.len();
            self.tools.push(tool);
            self.tool_index.insert(id.into(), index);
            (index, true)
        };
        let tool = &mut self.tools[index];
        let has_content = update["content"].is_array();
        if has_content {
            tool.text = tool_text(&update["content"]);
        }
        let finished = matches!(update["status"].as_str(), Some("completed" | "failed"));
        if finished {
            tool.done = true;
            let result = tool.result(update["status"] == "failed", "", false);
            tool.text = String::new();
            self.flush_text(&mut output);
            self.add(result, &mut output);
        } else if has_content {
            output.push(tool.partial());
        }
        if created || finished {
            self.committed(output)
        } else {
            output
        }
    }

    fn active_message(&self) -> Option<Value> {
        (!self.blocks.is_empty())
            .then(|| assistant(self.blocks.iter().map(Block::message).collect()))
    }

    fn flush_text(&mut self, output: &mut Vec<Value>) {
        let message = self.active_message();
        self.blocks.clear();
        self.block_bytes = 0;
        self.text_clipped = false;
        self.message_id = None;
        if let Some(message) = message {
            self.add(message, output);
        }
    }

    fn push(&mut self, message: Value) {
        let entry = Entry::new(message);
        self.history_bytes += entry.bytes;
        self.messages.push_back(entry);
        while self.history_bytes > HISTORY_BYTES {
            self.history_bytes -= self.messages.pop_front().unwrap().bytes;
        }
    }

    fn add(&mut self, message: Value, output: &mut Vec<Value>) {
        output.push(event("message_end", json!({"message":message})));
        self.push(message);
    }

    // Journal structural changes before the webview sees them. Stream updates are
    // checkpointed by the transport's timer.
    fn committed(&self, mut output: Vec<Value>) -> Vec<Value> {
        output.insert(0, self.checkpoint());
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready_session() -> Session {
        let mut session = Session::new("/work".into(), None);
        let output = session.ready(
            &json!({"agentInfo":{"title":"ACP test"},"agentCapabilities":{
                "loadSession":true,"promptCapabilities":{"image":true},
                "_meta":{"kiro":{"extensionMethods":["_kiro/session/compact"]}},
            }}),
            &Value::Null,
            "test-session",
            false,
        );
        assert_eq!(output[0]["type"], "pimuxCheckpoint");
        assert_eq!(output[0]["agentSessionId"], "test-session");
        session
    }

    fn chunk(text: &str) -> Value {
        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}})
    }

    #[test]
    fn replays_partial_text_and_tools_then_checkpoints_interrupted_turn() {
        let mut session = ready_session();
        let output = session.start_turn("prompt", &[]);
        assert_eq!(output[0]["busy"], true);
        assert_eq!(session.update(&chunk("before"))[0]["type"], "event");
        let output = session
            .update(&json!({"sessionUpdate":"tool_call","toolCallId":"tool-1","title":"Read"}));
        let call = output[0]["messages"][2]["content"][0]["id"].clone();
        session.update(&json!({"sessionUpdate":"tool_call_update","toolCallId":"tool-1","content":[{"type":"diff","path":"file"}]}));
        session.update(&chunk("after"));
        let replay = session.replay();
        let snapshot = replay.iter().find(|m| m["type"] == "init").unwrap();
        assert_eq!(snapshot["messages"].as_array().unwrap().len(), 3);
        assert!(replay
            .iter()
            .any(|m| m["event"]["assistantMessageEvent"]["delta"] == "after"));
        assert!(replay
            .iter()
            .any(|m| m["event"]["partialResult"]["content"][0]["text"] == "Changed file"));
        let saved = session.checkpoint();
        assert_eq!(saved["messages"][4]["toolCallId"], call);
        assert_eq!(
            saved["messages"][4]["content"][1]["text"],
            "Tool was interrupted."
        );
        let output = session.finish_turn(true, None);
        assert_eq!(output[0]["busy"], false);
        assert_eq!(output[0]["messages"][3]["content"][0]["text"], "after");
        assert_eq!(output[0]["messages"][4]["toolCallId"], call);
        assert_eq!(output[0]["messages"][5]["stopReason"], "aborted");
        let restored = Session::new("/work".into(), Some(saved));
        assert!(restored.checkpoint()["messages"][5]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("was interrupted"));
    }

    #[test]
    fn projects_grouped_choices_usage_and_compaction() {
        let mut session = ready_session();
        let output = session.update(&json!({"sessionUpdate":"config_option_update","configOptions":[
            {"type":"select","id":"model","category":"model","name":"Model","currentValue":"auto","options":[
                {"group":"models","options":[{"value":"auto","name":"Auto"},{"value":"manual","name":"Manual"}]}
            ]},
            {"type":"select","id":"effortLevel","name":"Effort","currentValue":"low","options":[{"value":"low","name":"Low"}]},
            {"type":"select","id":"autopilot","name":"Autopilot","currentValue":"on","options":[]},
        ]}));
        assert_eq!(output[0]["choices"].as_array().unwrap().len(), 2);
        assert_eq!(output[0]["capabilities"]["model"], "Auto");
        assert_eq!(output[0]["capabilities"]["effort"], "Low");
        assert!(session.can_set_config("model", "manual"));
        let output = session.update(
            &json!({"sessionUpdate":"session_info_update","_meta":{"kiro":{
                "kind":"context_usage","usagePercentage":24.5,
            }}}),
        );
        assert_eq!(output[0]["capabilities"]["usage"], 24.5);
        session.set_operation(COMPACTING);
        let output = session.finish_compaction(true);
        assert_eq!(
            output[0]["messages"][0]["content"][0]["text"],
            "_Context compacted._"
        );
        let update = json!({"sessionUpdate":"compaction_update","status":"succeeded"});
        assert!(session.update(&update).is_empty());
        assert!(session.can_compact());
    }

    #[test]
    fn bounds_serialized_checkpoint_and_keeps_active_text() {
        let mut session = ready_session();
        session.start_turn("prompt", &[]);
        session.update(&json!({"sessionUpdate":"tool_call","toolCallId":"old"}));
        let text = "\u{0}".repeat(MAX_MESSAGE_BYTES + 1);
        for i in 0..4 {
            let mut update = chunk(&text);
            update["messageId"] = json!(i.to_string());
            session.update(&update);
        }
        session.update(
            &json!({"sessionUpdate":"tool_call_update","toolCallId":"old","status":"completed"}),
        );
        session.update(&chunk("latest"));
        let saved = session.checkpoint();
        let messages = array(&saved["messages"]);
        assert!(saved.to_string().len() < MAX_CHECKPOINT_BYTES);
        assert!(messages.iter().all(|m| m["role"] != "toolResult"));
        assert_eq!(messages.last().unwrap()["content"][0]["text"], "latest");
    }

    #[test]
    fn title_helper_uses_user_text_without_image_data() {
        let mut session = ready_session();
        let image = json!({"type":"image","mimeType":"image/png","data":"aGVsbG8="});
        let output = session.start_turn("image prompt", &[image]);
        assert_eq!(
            output[0]["messages"][0]["content"][1]["text"],
            "[Image omitted]"
        );
        assert_eq!(session.title_seed(), "image prompt");
        assert_eq!(
            session.set_title_pending(true)[0]["capabilities"]["canTitle"],
            false
        );
        let before = session.title_version();
        session.rename("Updated title");
        assert_eq!(session.title_version(), before + 1);
        assert_eq!(
            session.set_title_pending(false)[0]["capabilities"]["canTitle"],
            true
        );
    }
}
