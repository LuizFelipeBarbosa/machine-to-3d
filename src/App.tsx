import { useMemo } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Authenticated, AuthLoading, Unauthenticated, useConvex } from 'convex/react';
import { AppNav } from './AppNav';
import { SignIn } from './auth/SignIn';
import { CatalogProvider } from './data/CatalogContext';
import { createConvexCatalog } from './data/convexCatalog';
import { localCatalog } from './data/localCatalog';
import { isConvexMode } from './data/mode';
import { Machine } from './routes/Machine';
import { MachineList } from './routes/MachineList';
import { PlayerRoute } from './routes/Player';
import { Records } from './routes/Records';
import { Users } from './routes/Users';

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<MachineList />} />
      <Route path="/m/:machine" element={<Machine />} />
      <Route path="/m/:machine/:procedure" element={<PlayerRoute />} />
      <Route path="/records" element={isConvexMode ? <Records /> : <Navigate to="/" replace />} />
      <Route path="/users" element={isConvexMode ? <Users /> : <Navigate to="/" replace />} />
      <Route path="/sign-in" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function ServerRoutes() {
  const client = useConvex();
  const catalog = useMemo(() => createConvexCatalog(client), [client]);
  return (
    <>
      <AuthLoading><p className="notice" role="status">Loading session…</p></AuthLoading>
      <Unauthenticated><SignIn /></Unauthenticated>
      <Authenticated>
        <CatalogProvider catalog={catalog}><AppRoutes /></CatalogProvider>
      </Authenticated>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <AppNav />
        <div className="app-content">
          {isConvexMode ? <ServerRoutes /> : (
            <CatalogProvider catalog={localCatalog}><AppRoutes /></CatalogProvider>
          )}
        </div>
      </div>
    </BrowserRouter>
  );
}
