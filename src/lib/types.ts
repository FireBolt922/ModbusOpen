// Mirrors src-tauri/src/commands/serial.rs::SerialPortInfo
export type SerialPortInfo = {
  portName: string;
  portType: "USB" | "Bluetooth" | "PCI" | "Unknown";
  manufacturer: string | null;
  product: string | null;
};
