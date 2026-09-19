import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { FunctionReturnType } from 'convex/server';
import { RequireRole } from '../auth/RequireRole';
import { ROLE_RANK } from '../auth/roles';
import type { Role } from '../auth/roles';
import { errorMessage } from '../lib/errorMessage';

type User = FunctionReturnType<typeof api.users.list>[number];

function UserRow({ user }: { user: User }) {
  const setRole = useMutation(api.users.setRole);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changeRole(role: Role) {
    setPending(true);
    setError(null);
    try {
      await setRole({ userId: user._id, role });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <tr>
      <td>{user.name ?? '—'}</td>
      <td>{user.email ?? '—'}</td>
      <td>
        <select aria-label={`Role for ${user.email ?? user.name ?? user._id}`} value={user.role}
          disabled={pending} onChange={(event) => { void changeRole(event.target.value as Role); }}>
          {Object.keys(ROLE_RANK).map((role) => <option key={role} value={role}>{role}</option>)}
        </select>
        {error && <p className="notice error" role="alert">{error}</p>}
      </td>
    </tr>
  );
}

function UsersTable() {
  const users = useQuery(api.users.list, {});
  if (users === undefined) return <p className="notice" role="status">Loading users…</p>;
  if (users.length === 0) return <p className="notice">No users yet.</p>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption className="sr">Users and their roles</caption>
        <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th></tr></thead>
        <tbody>{users.map((user) => <UserRow key={user._id} user={user} />)}</tbody>
      </table>
    </div>
  );
}

export function Users() {
  return (
    <main className="panel data-page">
      <header className="panel-head"><h1>Users</h1></header>
      <RequireRole minimum="admin"><UsersTable /></RequireRole>
    </main>
  );
}
