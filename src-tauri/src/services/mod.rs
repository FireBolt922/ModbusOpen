//! Linux service control.
//!
//! Lets an operator see, start and stop the systemd units that run capture and
//! sync on the machine, without leaving the app or opening a terminal.
//!
//! Three properties define the feature:
//!
//! - **Linux only.** Every path into [`systemctl`] is gated, so a macOS or
//!   Windows build never spawns a process even if the UI gate is bypassed.
//! - **Read-mostly.** The app starts and stops units. It never enables,
//!   disables, masks or edits a unit file — making a service permanently
//!   disabled stays a deliberate act by the operator in a terminal, and the app
//!   only reads the result back.
//! - **Self-healing.** A stop is a 30-minute hold, not a decision. If nobody
//!   starts the service again, [`manager::spawn_auto_restart`] does — including
//!   after the app itself was closed and reopened.
//!
//! See `docs/04-ux-flows.md#services` for the screens and
//! `docs/05-data-model.md#service-control` for the wire types.

pub mod config;
pub mod manager;
pub mod systemctl;
