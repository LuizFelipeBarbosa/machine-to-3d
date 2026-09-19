import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireRole, requireUser } from './lib/authz';

export const generateUploadUrl = mutation({
  args: { kind: v.union(v.literal('model'), v.literal('media')) },
  returns: v.string(),
  handler: async (ctx, { kind }) => {
    await requireRole(ctx, kind === 'model' ? 'admin' : 'author');
    return ctx.storage.generateUploadUrl();
  },
});

export const mediaUrl = query({
  args: { fileId: v.id('_storage') },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { fileId }) => {
    await requireUser(ctx);
    return ctx.storage.getUrl(fileId);
  },
});
