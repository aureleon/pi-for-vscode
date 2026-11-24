use std::io;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

const MAX_LINE: usize = 32 * 1024 * 1024;

// The caller clears completed records. Keep partial records when select cancels this read.
pub(crate) async fn record(
    reader: &mut (impl AsyncBufRead + Unpin),
    line: &mut Vec<u8>,
) -> io::Result<bool> {
    loop {
        let part = reader.fill_buf().await?;
        if part.is_empty() {
            return Ok(!line.is_empty());
        }
        let end = part.iter().position(|&b| b == b'\n');
        let len = end.map_or(part.len(), |i| i + 1);
        if line.len() + len > MAX_LINE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "JSONL record exceeds 32 MiB",
            ));
        }
        line.extend_from_slice(&part[..len]);
        reader.consume(len);
        if end.is_some() {
            return Ok(true);
        }
    }
}
