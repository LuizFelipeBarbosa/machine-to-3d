import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { CatalogProvider } from './data/CatalogContext';
import { localCatalog } from './data/localCatalog';
import { Machine } from './routes/Machine';
import { MachineList } from './routes/MachineList';
import { PlayerRoute } from './routes/Player';

export default function App() {
  return (
    <BrowserRouter>
      <CatalogProvider catalog={localCatalog}>
        <Routes>
          <Route path="/" element={<MachineList />} />
          <Route path="/m/:machine" element={<Machine />} />
          <Route path="/m/:machine/:procedure" element={<PlayerRoute />} />
        </Routes>
      </CatalogProvider>
    </BrowserRouter>
  );
}
