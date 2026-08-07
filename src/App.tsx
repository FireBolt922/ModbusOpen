import { HashRouter, Route, Routes } from "react-router-dom";
import Home from "@/routes/Home";
import ScannerSetup from "@/routes/scanner/Setup";
import ScannerWorkspace from "@/routes/scanner/Workspace";
import SimulatorSetup from "@/routes/simulator/Setup";
import SimulatorWorkspace from "@/routes/simulator/Workspace";

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/scan" element={<ScannerSetup />} />
        <Route path="/scan/workspace" element={<ScannerWorkspace />} />
        <Route path="/simulate" element={<SimulatorSetup />} />
        <Route path="/simulate/workspace" element={<SimulatorWorkspace />} />
      </Routes>
    </HashRouter>
  );
}

export default App;
