use std::collections::HashMap;
use tokio::process::Command;

#[derive(Clone)]
pub(crate) struct Launch {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: HashMap<String, String>,
}

impl Launch {
    pub fn command(&self, prefix: &[&str]) -> Command {
        let mut command = Command::new(&self.command);
        command
            .args(prefix)
            .args(&self.args)
            .current_dir(&self.cwd)
            .env_clear()
            .envs(&self.env);
        command
    }
}
