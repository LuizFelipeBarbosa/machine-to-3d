import { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuthActions } from '@convex-dev/auth/react';
import { Authenticated } from 'convex/react';
import { useMe } from './auth/useMe';
import { isConvexMode } from './data/mode';
import { errorMessage } from './lib/errorMessage';

function AccountNav() {
  const { me } = useMe();
  const { signOut } = useAuthActions();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function leave() {
    setPending(true);
    setError(null);
    try {
      await signOut();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <nav aria-label="Main navigation">
        <NavLink to="/" end>Machines</NavLink>
        <NavLink to="/records">Records</NavLink>
        {me?.role === 'admin' && <NavLink to="/users">Users</NavLink>}
        {me?.role === 'admin' && <NavLink to="/admin/machines">Machines admin</NavLink>}
      </nav>
      <span className="account-label">{me?.email ?? me?.name} {me && `· ${me.role}`}</span>
      <button className="btn" type="button" disabled={pending} onClick={() => { void leave(); }}>
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
      {error && <p className="notice error" role="alert">{error}</p>}
    </>
  );
}

export function AppNav() {
  return (
    <header className="app-nav">
      <Link className="brand" to="/">Bench guide</Link>
      {isConvexMode ? (
        <Authenticated><AccountNav /></Authenticated>
      ) : (
        <>
          <nav aria-label="Main navigation"><NavLink to="/" end>Machines</NavLink></nav>
          <span className="account-label">Local demo</span>
        </>
      )}
    </header>
  );
}
