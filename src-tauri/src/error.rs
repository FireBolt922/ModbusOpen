use serde::Serialize;

/// Every fallible command returns this. Variants map to a sentence a controls
/// engineer can act on — never a raw errno or a `Debug`-formatted Rust error.
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("{0}")]
    SerialPortList(String),
}
