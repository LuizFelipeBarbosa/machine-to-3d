import type { ReactNode } from 'react';
import { ROLE_RANK } from './roles';
import type { Role } from './roles';
import { useMe } from './useMe';

export function RequireRole({ minimum, children }: { minimum: Role; children: ReactNode }) {
  const { me, loading } = useMe();
  if (loading) return <p className="notice" role="status">Loading account…</p>;
  if (!me || ROLE_RANK[me.role] < ROLE_RANK[minimum]) {
    return <p className="notice" role="alert">Not authorized</p>;
  }
  return children;
}
