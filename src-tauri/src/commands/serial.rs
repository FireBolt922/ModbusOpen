use serde::Serialize;

use crate::error::AppError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub port_name: String,
    pub port_type: String,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}

impl From<serialport::SerialPortInfo> for SerialPortInfo {
    fn from(info: serialport::SerialPortInfo) -> Self {
        let (port_type, manufacturer, product) = match info.port_type {
            serialport::SerialPortType::UsbPort(usb) => {
                ("USB".to_string(), usb.manufacturer, usb.product)
            }
            serialport::SerialPortType::BluetoothPort => ("Bluetooth".to_string(), None, None),
            serialport::SerialPortType::PciPort => ("PCI".to_string(), None, None),
            serialport::SerialPortType::Unknown => ("Unknown".to_string(), None, None),
        };
        Self {
            port_name: info.port_name,
            port_type,
            manufacturer,
            product,
        }
    }
}

/// Lists serial ports currently visible to the OS. Returns an empty list
/// rather than an error when the platform reports none — an empty port list
/// is a normal state (no RS-485 adapter plugged in), not a failure.
#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<SerialPortInfo>, AppError> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(SerialPortInfo::from).collect())
        .map_err(|e| AppError::SerialPortList(format!("Couldn't list serial ports: {e}")))
}
