//! Running an `embedded-test` suite from the browser.
//!
//! The protocol is semihosting, and it is small: the firmware calls `SYS_GET_CMDLINE` and
//! waits to be told what to do. Answer `"list"` and it replies with a JSON test list
//! through a vendor semihosting call (`0x100`); answer `"run <name>"` and it runs that one
//! test and exits, success or error being the result. probe-rs's own implementation is
//! `probe-rs-tools/src/bin/probe-rs/rpc/functions/test.rs`, built on a `RunLoop` the
//! worker does not have — so the loop here is the worker's own, written to the same
//! protocol rather than lifted.
//!
//! `catch_hardfault` matters: a test that faults instead of panicking would otherwise run
//! away, and the vector catch turns that into a halt this loop can report.

use std::time::Duration;

use probe_rs::semihosting::SemihostingCommand;
use probe_rs::{BreakpointCause, Core, CoreStatus, HaltReason, VectorCatchCondition};
use probe_rs_rpc::test::{Test, TestDefinitions, TestOutcome, TestResult, Tests};

use crate::log;
use crate::semihosting::{ConsoleSemihosting, Outcome};

/// The vendor semihosting operation `embedded-test` uses to hand over its test list.
const SEMIHOSTING_USER_LIST: u32 = 0x100;

/// How long to wait for the firmware to produce its test list.
const LIST_TIMEOUT: Duration = Duration::from_secs(5);

/// What a halt handler decided.
enum Step<T> {
    /// Resume and keep waiting.
    Continue,
    /// The run is over with this value.
    Done(T),
}

/// Ask the target for vector catches so a faulting test halts instead of running away.
///
/// Not every core supports every condition, and a target that refuses one is not a reason
/// to abandon the run, so failures are logged rather than propagated — which is also how
/// the rest of this worker treats optional core features.
async fn enable_vector_catches(core: &mut Core<'_>) {
    for condition in [
        VectorCatchCondition::HardFault,
        VectorCatchCondition::CoreReset,
    ] {
        if let Err(e) = core.enable_vector_catch(condition).await {
            log(&format!(
                "tests: {condition:?} vector catch unavailable: {e}"
            ));
        }
    }
}

/// Run the core until `on_halt` says the run is finished, or the deadline passes.
///
/// The shape mirrors the monitor loop: poll, and when the core halts on a semihosting
/// call let the handler decide. Anything else halting the core is a failure — a test
/// binary that stops for another reason has gone wrong.
async fn run_until<T, F>(
    core: &mut Core<'_>,
    timeout: Duration,
    mut on_halt: F,
) -> Result<Option<T>, probe_rs::Error>
where
    F: AsyncFnMut(SemihostingCommand, &mut Core<'_>) -> Result<Step<T>, probe_rs::Error>,
{
    let started = web_time::Instant::now();
    core.run().await?;

    while started.elapsed() < timeout {
        match core.status().await? {
            CoreStatus::Halted(HaltReason::Breakpoint(BreakpointCause::Semihosting(cmd))) => {
                match on_halt(cmd, core).await? {
                    Step::Done(value) => return Ok(Some(value)),
                    Step::Continue => core.run().await?,
                }
            }
            CoreStatus::Halted(reason) => {
                return Err(probe_rs::Error::Other(format!(
                    "the core halted unexpectedly while running tests: {reason:?}. A failing \
                     test should signal failure by panicking, not by faulting"
                )));
            }
            _ => probe_rs::probe::usb_util::wait(Duration::from_millis(5)).await,
        }
    }
    Ok(None)
}

/// Read the JSON test list the target wrote, and acknowledge it.
async fn read_test_list(
    details: probe_rs::semihosting::UnknownCommandDetails,
    core: &mut Core<'_>,
) -> Result<TestDefinitions, probe_rs::Error> {
    let buffer = details.get_buffer(core).await?;
    let bytes = buffer.read(core).await?;
    let list: TestDefinitions = serde_json::from_slice(&bytes).map_err(|e| {
        probe_rs::Error::Other(format!("the target's test list did not parse: {e}"))
    })?;
    // Tell the target the call succeeded, or it will sit waiting.
    details.write_status(core, 0).await?;
    Ok(list)
}

/// Ask the firmware which tests it has.
pub async fn list_tests(core: &mut Core<'_>) -> Result<Tests, probe_rs::Error> {
    enable_vector_catches(core).await;
    core.reset_and_halt(Duration::from_millis(500)).await?;

    let mut asked = false;
    let mut console = ConsoleSemihosting::default();

    let found = run_until(core, LIST_TIMEOUT, async |cmd, core: &mut Core<'_>| {
        match cmd {
            SemihostingCommand::GetCommandLine(request) if !asked => {
                asked = true;
                request.write_command_line_to_target(core, "list").await?;
                Ok(Step::Continue)
            }
            SemihostingCommand::Unknown(details)
                if details.operation == SEMIHOSTING_USER_LIST && asked =>
            {
                let list = read_test_list(details, core).await?;
                if list.version != 1 {
                    return Err(probe_rs::Error::Other(format!(
                        "unsupported embedded-test list version {}",
                        list.version
                    )));
                }
                Ok(Step::Done(Tests::from(list)))
            }
            SemihostingCommand::ExitSuccess | SemihostingCommand::ExitError(_) => {
                Err(probe_rs::Error::Other(
                    "the firmware exited instead of listing its tests; is it an embedded-test \
                     binary?"
                        .into(),
                ))
            }
            // Anything else is ordinary console traffic during start-up.
            other => match console.handle(other, core).await? {
                Outcome::Continue(_) => Ok(Step::Continue),
                Outcome::Exit(_) => Err(probe_rs::Error::Other(
                    "the firmware exited while listing tests".into(),
                )),
            },
        }
    })
    .await?;

    found.ok_or_else(|| {
        probe_rs::Error::Other("the target did not send a test list before the timeout".into())
    })
}

/// Run one test and report whether it did what it was expected to do.
pub async fn run_test(core: &mut Core<'_>, test: Test) -> Result<TestResult, probe_rs::Error> {
    enable_vector_catches(core).await;
    core.reset_and_halt(Duration::from_millis(500)).await?;

    // embedded-test declares a per-test timeout; a minute is probe-rs's own default.
    let timeout = Duration::from_secs(test.timeout.unwrap_or(60) as u64);
    let expected = test.expected_outcome;
    let command = match test.address {
        Some(address) => format!("run_addr {address}"),
        None => format!("run {}", test.name),
    };

    let mut asked = false;
    let mut console = ConsoleSemihosting::default();

    let outcome = run_until(core, timeout, async |cmd, core: &mut Core<'_>| match cmd {
        SemihostingCommand::GetCommandLine(request) if !asked => {
            asked = true;
            request.write_command_line_to_target(core, &command).await?;
            Ok(Step::Continue)
        }
        SemihostingCommand::ExitSuccess if asked => Ok(Step::Done(TestOutcome::Pass)),
        SemihostingCommand::ExitError(_) if asked => Ok(Step::Done(TestOutcome::Panic)),
        other => match console.handle(other, core).await? {
            Outcome::Continue(_) => Ok(Step::Continue),
            Outcome::Exit(_) => Ok(Step::Done(TestOutcome::Panic)),
        },
    })
    .await?;

    Ok(match outcome {
        Some(outcome) if outcome == expected => TestResult::Success,
        // A test that is expected to panic and passes is as much a failure as the reverse.
        Some(outcome) => TestResult::Failed(format!(
            "expected the test to {expected:?} but it did {outcome:?}"
        )),
        None => TestResult::Failed(format!("the test did not finish within {timeout:?}")),
    })
}

/// Start one test by address and leave it running, for a debugger to take over.
pub async fn kickoff(core: &mut Core<'_>, address: u64) -> Result<(), probe_rs::Error> {
    core.run().await?;
    core.wait_for_core_halted(Duration::from_secs(1)).await?;

    let CoreStatus::Halted(HaltReason::Breakpoint(BreakpointCause::Semihosting(
        SemihostingCommand::GetCommandLine(request),
    ))) = core.status().await?
    else {
        return Err(probe_rs::Error::Other(
            "could not start the test: the target did not halt asking for a command line".into(),
        ));
    };

    request
        .write_command_line_to_target(core, &format!("run_addr {address}"))
        .await?;
    core.run().await?;
    Ok(())
}
