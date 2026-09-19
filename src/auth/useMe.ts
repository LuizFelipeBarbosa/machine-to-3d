import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';

export function useMe() {
  const me = useQuery(api.users.me, {});
  return { me, loading: me === undefined };
}
