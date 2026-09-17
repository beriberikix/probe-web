//! Console-only semihosting for the in-worker monitor loop.
//!
//! A browser has no host filesystem or sockets, so this mirrors the console
//! subset of probe-rs's `SemihostingFileManager`: `:tt` opens map to
//! stdout/stderr, writes are published on `SemihostingTopic`, exits end the
//! monitor. Every other file operation is refused (the target sees a failed
//! call) and the core keeps running.

use std::num::NonZeroU32;

use probe_rs::{Core, semihosting::SemihostingCommand};
use probe_rs_rpc::monitor::{MonitorExitReason, SemihostingEvent, SemihostingExitError};

use crate::log;

#[derive(Clone, Copy)]
enum Stream {
    Stdout,
    Stderr,
}

impl Stream {
    fn name(self) -> &'static str {
        match self {
            Stream::Stdout => "stdout",
            Stream::Stderr => "stderr",
        }
    }
}

#[derive(Default)]
pub struct ConsoleSemihosting {
    /// Index + 1 is the handle returned to the target.
    handles: Vec<Option<Stream>>,
}

/// What the monitor loop should do after servicing a semihosting halt.
pub enum Outcome {
    /// Resume the core; publish these events first.
    Continue(Vec<SemihostingEvent>),
    /// The target asked to exit.
    Exit(MonitorExitReason),
}

impl ConsoleSemihosting {
    pub async fn handle(&mut self, cmd: SemihostingCommand, core: &mut Core<'_>) -> Result<Outcome, probe_rs::Error> {
        let mut events = Vec::new();
        let output = |stream: Stream, data: String| SemihostingEvent::Output { stream: stream.name().into(), data };
        match cmd {
            SemihostingCommand::ExitSuccess => return Ok(Outcome::Exit(MonitorExitReason::SemihostingExit(Ok(())))),
            SemihostingCommand::ExitError(d) => {
                return Ok(Outcome::Exit(MonitorExitReason::SemihostingExit(Err(SemihostingExitError {
                    reason: d.reason,
                    subcode: d.exit_status.or(d.subcode),
                }))));
            }
            SemihostingCommand::WriteConsole(req) => events.push(output(Stream::Stdout, req.read(core).await?)),
            SemihostingCommand::Open(req) => {
                let path = req.path(core).await?;
                let stream = match (path.as_str(), req.mode().as_bytes().first()) {
                    (":tt", Some(b'w')) => Some(Stream::Stdout),
                    (":tt", Some(b'a')) => Some(Stream::Stderr),
                    _ => {
                        log(&format!("semihosting: refusing open of {path:?} (mode {}); only :tt is available in the browser", req.mode()));
                        None
                    }
                };
                if let Some(stream) = stream {
                    self.handles.push(Some(stream));
                    let handle = NonZeroU32::new(self.handles.len() as u32).unwrap_or(NonZeroU32::MIN);
                    req.respond_with_handle(core, handle).await?;
                }
            }
            SemihostingCommand::Close(req) => {
                let h = req.file_handle(core).await? as usize;
                if let Some(slot) = h.checked_sub(1).and_then(|i| self.handles.get_mut(i)) {
                    if slot.take().is_some() {
                        while matches!(self.handles.last(), Some(None)) {
                            self.handles.pop();
                        }
                        req.success(core).await?;
                    }
                }
            }
            SemihostingCommand::Write(req) => {
                let stream = (req.file_handle() as usize)
                    .checked_sub(1)
                    .and_then(|i| self.handles.get(i).copied().flatten());
                match stream {
                    Some(stream) => {
                        let buf = req.read(core).await?;
                        events.push(output(stream, String::from_utf8_lossy(&buf).into_owned()));
                        // Status = number of bytes NOT written.
                        req.write_status(core, 0).await?;
                    }
                    None => log(&format!("semihosting: write to unknown handle {}", req.file_handle())),
                }
            }
            SemihostingCommand::Errno(_) => {}
            SemihostingCommand::GetCommandLine(_) => log("semihosting: SYS_GET_CMDLINE is not supported; continuing"),
            SemihostingCommand::Unknown(d) => log(&format!(
                "semihosting: unsupported operation {:#x} (parameter {:#x}); continuing",
                d.operation, d.parameter
            )),
        }
        Ok(Outcome::Continue(events))
    }
}
