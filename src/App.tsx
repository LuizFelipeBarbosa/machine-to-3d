import { useMemo } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Authenticated, AuthLoading, Unauthenticated, useConvex } from 'convex/react';
import { AppNav } from './AppNav';
import { MachineAdmin } from './admin/MachineAdmin';
import { SignIn } from './auth/SignIn';
import { CatalogProvider } from './data/CatalogContext';
import { createConvexCatalog } from './data/convexCatalog';
import { localCatalog } from './data/localCatalog';
import { isConvexMode } from './data/mode';
import { Editor } from './routes/Editor';
import { MachineWorkspace } from './machine/MachineWorkspace';
import { Jobs, JobDetail } from './routes/Jobs';
import { MachineList } from './routes/MachineList';
import { NewJob } from './routes/NewJob';
import { Records } from './routes/Records';
import { Users } from './routes/Users';

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<MachineList />} />
      <Route path="/admin/machines" element={<MachineAdmin />} />
      <Route path="/m/:machine/:procedure?" element={<MachineWorkspace />} />
      <Route path="/m/:machine/:procedure/edit" element={<Editor />} />
      <Route path="/records" element={isConvexMode ? <Records /> : <Navigate to="/" replace />} />
      <Route path="/jobs" element={isConvexMode ? <Jobs /> : <Navigate to="/" replace />} />
      <Route path="/jobs/new" element={isConvexMode ? <NewJob /> : <Navigate to="/" replace />} />
      <Route path="/jobs/:id" element={isConvexMode ? <JobDetail /> : <Navigate to="/" replace />} />
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
