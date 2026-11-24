mod acp;
mod agent;
mod journal;
mod jsonl;
mod pi;
mod server;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{env, path::PathBuf, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    process::Command,
};

pub const PROTOCOL: u64 = 6;

fn directory() -> Result<PathBuf> {
    if let Some(path) = env::var_os("PIMUXD_DIR") {
        return Ok(path.into());
    }
    Ok(PathBuf::from(env::var_os("HOME").context("HOME is not set")?).join(".pi/vscode-daemon"))
}

async fn request(dir: &std::path::Path, record: Value) -> Result<Value> {
    let mut sock = UnixStream::connect(dir.join("daemon.sock"))
        .await
        .context("cannot connect to pimuxd")?;
    sock.write_all(format!("{record}\n").as_bytes()).await?;
    let mut line = String::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        BufReader::new(sock).read_line(&mut line),
    )
    .await??;
    let response: Value = serde_json::from_str(&line)?;
    if let Some(err) = response["error"].as_str() {
        bail!("{err}");
    }
    Ok(response)
}

async fn open_acp(dir: &std::path::Path, command: &str, args: &[&str]) -> Result<()> {
    let status = request(dir, json!({"op":"hello"})).await?;
    if status["protocol"] != PROTOCOL {
        bail!("The running daemon does not support native ACP");
    }
    let uid = std::process::id();
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let key = format!("acp-{uid}-{epoch}");
    let cwd = env::current_dir()?;
    let env: std::collections::BTreeMap<_, _> = env::vars_os()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
        .collect();
    let mut sock = UnixStream::connect(dir.join("daemon.sock"))
        .await
        .context("cannot connect to pimuxd")?;
    let open = json!({"op":"acp_open","key":key,"command":command,"args":args,"cwd":cwd,"env":env});
    sock.write_all(format!("{open}\n").as_bytes()).await?;
    let mut reader = BufReader::new(sock);
    // ACP initialize and session/new each have a 30-second deadline.
    tokio::time::timeout(std::time::Duration::from_secs(65), async {
        let mut line = Vec::new();
        while jsonl::record(&mut reader, &mut line).await? {
            let m: Value = serde_json::from_slice(&line)?;
            line.clear();
            match m["type"].as_str() {
                Some("acp_attachError") => bail!(
                    "{}",
                    m["message"]
                        .as_str()
                        .unwrap_or("Could not open the ACP session")
                ),
                Some("acpStatus") if m["ready"] == true => {
                    println!("{key}");
                    return Ok(());
                }
                Some("acpStatus") if m["error"].is_string() => {
                    bail!("{}", m["error"].as_str().unwrap())
                }
                _ => {}
            }
        }
        bail!("Daemon disconnected before the ACP agent was ready")
    })
    .await??;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let dir = directory()?;
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["serve"] => server::serve(dir).await?,
        ["start"] => {
            if let Ok(status) = request(&dir, json!({"op":"list"})).await {
                if status["protocol"] != PROTOCOL { bail!("another daemon is running with a different protocol"); }
                println!("pimuxd is already running"); return Ok(());
            }
            use std::os::unix::process::CommandExt;
            let mut cmd = Command::new(env::current_exe()?);
            cmd.arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            // Detach from the SSH terminal before the server starts its children.
            unsafe { cmd.as_std_mut().pre_exec(|| if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }); }
            let mut child = cmd.spawn()?;
            for _ in 0..50 {
                if let Ok(status) = request(&dir, json!({"op":"list"})).await {
                    if status["protocol"] != PROTOCOL { bail!("another daemon is running with a different protocol"); }
                    println!("pimuxd is running"); return Ok(());
                }
                if let Some(status) = child.try_wait()? { bail!("pimuxd exited during startup ({status})"); }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            bail!("pimuxd did not start");
        }
        ["status"] | ["sessions", "--json"] => println!("{}", serde_json::to_string_pretty(&request(&dir, json!({"op":"list"})).await?)?),
        ["sessions"] => {
            let list = request(&dir, json!({"op":"list"})).await?;
            for row in list["sessions"].as_array().into_iter().flatten() {
                let status = if row["waiting"].as_u64().unwrap_or(0) > 0 { "waiting for approval" }
                    else if row["busy"] == true { "running" }
                    else if row["failed"] == true { "stopped" } else { "idle" };
                println!("{}\t{}\t{}\t{}\t{}", row["key"].as_str().unwrap_or("?"), row["backend"].as_str().unwrap_or("pi"), status,
                    if row["attached"] == true { "attached" } else { "detached" }, row["name"].as_str().unwrap_or("Untitled"));
            }
        }
        ["acp", "open", "--", command, rest @ ..] => open_acp(&dir, command, rest).await?,
        ["inspect", key] => println!("{}", serde_json::to_string_pretty(&request(&dir, json!({"op":"inspect", "key":key})).await?)?),
        ["logs", key] | ["logs", key, "--follow"] => {
            if !journal::valid_key(key) { bail!("invalid session key"); }
            let mut seen = 0;
            // The daemon's bounded log never contains agent stderr, prompts, or tool output.
            loop {
                let log = request(&dir, json!({"op":"logs", "key":key})).await?;
                for record in log["entries"].as_array().into_iter().flatten() {
                    let id = record["id"].as_u64().unwrap_or(0);
                    if id > seen { println!("{}", record["message"].as_str().unwrap_or("")); seen = id; }
                }
                if args.len() != 3 { break; }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
        ["stop", key] => { request(&dir, json!({"op":"stop","key":key})).await?; }
        ["forget", key] => { request(&dir, json!({"op":"kill","key":key})).await?; }
        ["shutdown"] | ["shutdown", "--force"] => {
            let list = request(&dir, json!({"op":"list"})).await?;
            match list["protocol"].as_u64() {
                Some(4 | 5 | PROTOCOL) => { request(&dir, json!({"op":"shutdown","force":args.len()==2})).await?; }
                Some(3) if args.len() == 2 => {
                    eprintln!("Stopping the legacy daemon discards its in-memory ACP history.");
                    request(&dir, json!({"op":"retire"})).await?;
                }
                Some(3) => {
                    if request(&dir, json!({"op":"shutdown"})).await?["ok"] != true {
                        bail!("legacy daemon still holds sessions. Stop them or use shutdown --force");
                    }
                }
                _ => bail!("use the running daemon's version to stop it"),
            }
        }
        ["--version"] => println!("pimuxd {}", env!("CARGO_PKG_VERSION")),
        ["--help"] | [] => println!("pimuxd <start|serve|status|sessions [--json]|acp open -- COMMAND [ARGS...]|inspect ID|logs ID [--follow]|stop ID|forget ID|shutdown [--force]>"),
        _ => bail!("unknown command. See pimuxd --help"),
    }
    Ok(())
}
