import { getAuthUserId } from '@convex-dev/auth/server';
import { ConvexError, v } from 'convex/values';
import type { Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { requireRole } from './lib/authz';
import { roleValidator } from './lib/validators';
import type { Role } from './lib/validators';

const userSummaryValidator = v.object({
  _id: v.id('users'),
  name: v.optional(v.string()),
  email: v.optional(v.string()),
  role: roleValidator,
});

type UserSummary = Infer<typeof userSummaryValidator>;

function summarizeUser(user: Doc<'users'>): UserSummary {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role ?? 'trainee',
  };
}

export const me = query({
  args: {},
  returns: v.union(userSummaryValidator, v.null()),
  handler: async (ctx: QueryCtx): Promise<UserSummary | null> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }

    const user = await ctx.db.get(userId);
    return user === null ? null : summarizeUser(user);
  },
});

export const list = query({
  args: {},
  returns: v.array(userSummaryValidator),
  handler: async (ctx: QueryCtx): Promise<UserSummary[]> => {
    await requireRole(ctx, 'admin');
    const users: Doc<'users'>[] = await ctx.db
      .query('users')
      .withIndex('email')
      .order('asc')
      .collect();

    return users.map(summarizeUser);
  },
});

export const setRole = mutation({
  args: {
    userId: v.id('users'),
    role: roleValidator,
  },
  returns: v.null(),
  handler: async (
    ctx: MutationCtx,
    { userId, role }: { userId: Id<'users'>; role: Role },
  ): Promise<null> => {
    await requireRole(ctx, 'admin');
    const target = await ctx.db.get(userId);
    if (target === null) {
      throw new ConvexError('User not found');
    }

    if (target.role === 'admin' && role !== 'admin') {
      // There is no role index. Read users in this transaction so concurrent
      // demotions cannot both remove the last remaining admin.
      const users: Doc<'users'>[] = await ctx.db.query('users').collect();
      const hasAnotherAdmin = users.some(
        (user) => user._id !== userId && user.role === 'admin',
      );
      if (!hasAnotherAdmin) {
        throw new ConvexError('Cannot remove the last admin');
      }
    }

    await ctx.db.patch(userId, { role });
    return null;
  },
});
