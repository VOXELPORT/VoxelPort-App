//! VoxelPort's native core. Nothing here knows about the window: the desktop shell calls in and listens
//! for events, which keeps every rule testable without a UI.

pub mod account;
pub mod addon_registry;
pub mod backups;
pub mod bedrock;
pub mod cracked;
mod fsutil;
pub mod gate;
pub mod identity;
pub mod java;
pub mod log_buffer;
pub mod mc_versions;
pub mod net;
pub mod profiles;
pub mod removal;
pub mod server_files;
pub mod server_install;
pub mod settings;
pub mod server_process;
pub mod whitelist;

pub use fsutil::atomic_write;
pub use server_process::{Event, EventReceiver, ServerProcess, StartConfig, Status, StopPolicy};
