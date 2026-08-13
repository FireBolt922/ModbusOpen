import { HashRouter, Route, Routes } from "react-router-dom";
import AppVersion from "@/components/AppVersion";
import Home from "@/routes/Home";
import MeterEditorPage from "@/routes/meters/Editor";
import MeterLibraryPage from "@/routes/meters/Library";
import ScannerSetup from "@/routes/scanner/Setup";
import ScannerWorkspace from "@/routes/scanner/Workspace";
import ServicesPage from "@/routes/services/Services";
import SimulatorSetup from "@/routes/simulator/Setup";
import SimulatorWorkspace from "@/routes/simulator/Workspace";

function App() {
  return (
    <>
      <HashRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/scan" element={<ScannerSetup />} />
          <Route path="/scan/workspace" element={<ScannerWorkspace />} />
          <Route path="/simulate" element={<SimulatorSetup />} />
          <Route path="/simulate/workspace" element={<SimulatorWorkspace />} />
          <Route path="/meters" element={<MeterLibraryPage />} />
          <Route path="/meters/edit/:id" element={<MeterEditorPage />} />
          {/* Both tabs are real URLs; the page picks the child off the path. */}
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/services/configure" element={<ServicesPage />} />
        </Routes>
      </HashRouter>
      <AppVersion />
    </>
  );
}

export default App;
