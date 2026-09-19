import { Password } from '@convex-dev/auth/providers/Password';
import { convexAuth } from '@convex-dev/auth/server';
import { ConvexError } from 'convex/values';
import { roleForNewUser } from './lib/authz';

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
  callbacks: {
    async afterUserCreatedOrUpdated(ctx, { userId, existingUserId }) {
      if (existingUserId !== null) {
        return;
      }

      const user = await ctx.db.get(userId);
      if (user === null) {
        throw new ConvexError('User not found');
      }

      // Password does not verify email ownership. Whoever registers with
      // ADMIN_EMAIL first becomes admin, so the admin must sign up right after deploy.
      await ctx.db.patch(userId, {
        role: roleForNewUser(user.email, process.env.ADMIN_EMAIL),
      });
    },
  },
});
