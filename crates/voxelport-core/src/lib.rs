//! VoxelPort's native core. Nothing here knows about the window: the desktop shell calls in and listens
//! for events, which keeps every rule testable without a UI.

pub mod account;
pub mod addon_registry;
pub mod addons;
pub mod backups;
pub mod bds;
pub mod bds_allowlist;
pub mod bedrock_endpoint;
pub mod bedrock_install;
pub mod bedrock;
pub mod crash_explain;
pub mod diagnostics;
pub mod cracked;
mod fsutil;
pub mod gate;
pub mod identity;
pub mod java;
pub mod log_buffer;
pub mod mc_versions;
pub mod modpack;
pub mod net;
pub mod notice;
pub mod perf;
pub mod presence;
pub mod profiles;
pub mod regions;
pub mod relay_url;
pub mod removal;
pub mod runtime_info;
pub mod server_files;
pub mod server_install;
pub mod settings;
pub mod support;
pub mod tunnel;
pub mod updater;
pub mod server_process;
pub mod voice;
pub mod whitelist;

pub use fsutil::atomic_write;
pub use server_process::{Event, EventReceiver, ServerProcess, StartConfig, Status, StopPolicy};
