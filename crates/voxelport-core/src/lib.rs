//! VoxelPort's native core. Nothing here knows about the window: the desktop shell calls in and listens
//! for events, which keeps every rule testable without a UI.

pub mod bedrock;
pub mod log_buffer;
pub mod server_process;

pub use server_process::{Event, EventReceiver, ServerProcess, StartConfig, Status, StopPolicy};
