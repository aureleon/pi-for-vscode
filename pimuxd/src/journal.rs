use anyhow::{bail, Result};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

pub const MAX_CHECKPOINT: usize = 8 * 1024 * 1024;

pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 96
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub struct Journal(PathBuf);

impl Journal {
    pub fn new(directory: &Path) -> Result<Self> {
        let path = directory.join("journal");
        fs::create_dir_all(&path)?;
        let meta = fs::symlink_metadata(&path)?;
        use std::os::unix::fs::MetadataExt;
        // The journal can contain private prompts and paths.
        if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } {
            bail!("journal directory must belong to this user");
        }
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        Ok(Self(path))
    }

    pub fn save(&self, key: &str, snapshot: &Value) -> Result<()> {
        if !valid_key(key) {
            bail!("invalid session key");
        }
        let bytes = serde_json::to_vec(snapshot)?;
        if bytes.len() > MAX_CHECKPOINT {
            bail!("session checkpoint exceeds 8 MiB");
        }
        let pending = self.0.join(format!("{key}.next"));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&pending)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(pending, self.0.join(format!("{key}.json")))?;
        fs::File::open(&self.0)?.sync_all()?;
        Ok(())
    }

    pub fn load(&self) -> Result<Vec<Value>> {
        let mut snapshots = Vec::new();
        for entry in fs::read_dir(&self.0)? {
            let entry = entry?;
            let path = entry.path();
            let Some(key) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .filter(|s| valid_key(s))
            else {
                continue;
            };
            if path.extension().and_then(|s| s.to_str()) != Some("json")
                || !entry.file_type()?.is_file()
                || entry.metadata()?.len() > MAX_CHECKPOINT as u64
            {
                continue;
            }
            match fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            {
                Some(v) if v["key"].as_str() == Some(key) => snapshots.push(v),
                _ => eprintln!("pimuxd: ignoring unreadable checkpoint for {key}"),
            }
        }
        Ok(snapshots)
    }

    pub fn remove(&self, key: &str) -> Result<()> {
        if !valid_key(key) {
            bail!("invalid session key");
        }
        match fs::remove_file(self.0.join(format!("{key}.json"))) {
            Ok(()) => fs::File::open(&self.0)?.sync_all()?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::valid_key;
    #[test]
    fn session_keys_are_safe_file_names() {
        assert!(valid_key("acp-1"));
        for bad in ["", "..", "../other", "foo/bar", "foo.next", "é"] {
            assert!(!valid_key(bad));
        }
    }
}
