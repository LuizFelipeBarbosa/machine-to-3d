import { getAuthUserId } from '@convex-dev/auth/server';
import { ConvexError } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Role } from './validators';

export const ROLE_RANK: Record<Role, number> = {
  trainee: 0,
  author: 1,
  approver: 2,
  admin: 3,
};

export function roleForNewUser(
  email: string | undefined,
  adminEmail: string | undefined,
): Role {
  const normalizedEmail = email?.trim().toLowerCase();
  const normalizedAdminEmail = adminEmail?.trim().toLowerCase();

  if (normalizedEmail && normalizedAdminEmail === normalizedEmail) {
    return 'admin';
  }

  return 'trainee';
}

export async function requireUser(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<'users'>> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError('Not signed in');
  }

  const user = await ctx.db.get(userId);
  if (user === null) {
    throw new ConvexError('Not signed in');
  }

  return user;
}

export function hasRole(user: Doc<'users'>, minimum: Role): boolean {
  const role: Role = user.role ?? 'trainee';
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export async function requireRole(
  ctx: QueryCtx | MutationCtx,
  minimum: Role,
): Promise<Doc<'users'>> {
  const user = await requireUser(ctx);
  if (!hasRole(user, minimum)) {
    throw new ConvexError('Not authorized');
  }

  return user;
}
