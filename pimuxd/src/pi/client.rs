use crate::{agent::Launch, jsonl::record};
use serde_json::Value;
use tokio::{
    io::{AsyncBufRead, AsyncWriteExt},
    process::{ChildStdin, Command},
    sync::{mpsc, oneshot},
};

pub(crate) fn command(launch: &Launch) -> Command {
    launch.command(&["--mode", "rpc"])
}

pub(crate) async fn run(
    mut stdin: ChildStdin,
    stdout: &mut (impl AsyncBufRead + Unpin),
    mut input: mpsc::Receiver<Value>,
    stop: &mut oneshot::Receiver<()>,
    mut emit: impl FnMut(Value),
) {
    let writer = tokio::spawn(async move {
        while let Some(rec) = input.recv().await {
            if stdin
                .write_all(format!("{rec}\n").as_bytes())
                .await
                .is_err()
            {
                break;
            }
        }
    });
    let mut line = Vec::new();
    loop {
        tokio::select! {
            _ = &mut *stop => break,
            next = record(stdout, &mut line) => {
                if !matches!(next, Ok(true)) { break; }
                if let Ok(m) = serde_json::from_slice(&line) { emit(m); }
                line.clear();
            }
        }
    }
    writer.abort();
}
