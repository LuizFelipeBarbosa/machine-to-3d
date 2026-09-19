import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import { hasRole, requireUser, roleForNewUser } from './lib/authz';
import schema from './schema';
import { asUser, createUser, modules } from './test.setup';

describe('users.me', () => {
  test('returns null when signed out', async () => {
    const t = convexTest(schema, modules);

    expect(await t.query(api.users.me, {})).toBeNull();
  });

  test('returns the signed-in user and their role', async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t, {
      email: 'author@example.com',
      name: 'Author',
      role: 'author',
    });

    expect(await asUser(t, userId).query(api.users.me, {})).toEqual({
      _id: userId,
      email: 'author@example.com',
      name: 'Author',
      role: 'author',
    });
  });

  test('defaults a missing role to trainee', async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t, { email: 'legacy@example.com' });

    expect(await asUser(t, userId).query(api.users.me, {})).toEqual({
      _id: userId,
      email: 'legacy@example.com',
      role: 'trainee',
    });
  });

  test('returns null when the token refers to a deleted user', async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t, { email: 'deleted@example.com' });
    await t.run(async (ctx) => ctx.db.delete(userId));

    expect(await asUser(t, userId).query(api.users.me, {})).toBeNull();
  });
});

describe('users.list', () => {
  test('rejects a trainee', async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t, {
      email: 'trainee@example.com',
      role: 'trainee',
    });

    await expect(asUser(t, userId).query(api.users.list, {})).rejects.toMatchObject({
      data: 'Not authorized',
    });
  });

  test('rejects a signed-out caller', async () => {
    const t = convexTest(schema, modules);

    await expect(t.query(api.users.list, {})).rejects.toMatchObject({
      data: 'Not signed in',
    });
  });

  test('returns all users to an admin in email order', async () => {
    const t = convexTest(schema, modules);
    const adminId = await createUser(t, {
      email: 'z-admin@example.com',
      name: 'Admin',
      role: 'admin',
    });
    const traineeId = await createUser(t, { email: 'a-trainee@example.com' });

    expect(await asUser(t, adminId).query(api.users.list, {})).toEqual([
      { _id: traineeId, email: 'a-trainee@example.com', role: 'trainee' },
      { _id: adminId, email: 'z-admin@example.com', name: 'Admin', role: 'admin' },
    ]);
  });
});

describe('users.setRole', () => {
  test.each(['trainee', 'author', 'approver'] as const)(
    'rejects a caller with role %s',
    async (role) => {
      const t = convexTest(schema, modules);
      const userId = await createUser(t, { email: 'user@example.com', role });

      await expect(
        asUser(t, userId).mutation(api.users.setRole, { userId, role: 'admin' }),
      ).rejects.toMatchObject({ data: 'Not authorized' });

      expect(await t.run(async (ctx) => ctx.db.get(userId))).toMatchObject({ role });
    },
  );

  test('lets an admin promote a trainee to author', async () => {
    const t = convexTest(schema, modules);
    const adminId = await createUser(t, { email: 'admin@example.com', role: 'admin' });
    const userId = await createUser(t, {
      email: 'trainee@example.com',
      role: 'trainee',
    });

    expect(
      await asUser(t, adminId).mutation(api.users.setRole, { userId, role: 'author' }),
    ).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(userId))).toMatchObject({
      role: 'author',
    });
  });

  test('does not let the last admin demote themselves', async () => {
    const t = convexTest(schema, modules);
    const adminId = await createUser(t, { email: 'admin@example.com', role: 'admin' });
    await createUser(t, { email: 'trainee@example.com', role: 'trainee' });

    const demotion = asUser(t, adminId).mutation(api.users.setRole, {
      userId: adminId,
      role: 'trainee',
    });
    await expect(demotion).rejects.toBeInstanceOf(ConvexError);
    await expect(demotion).rejects.toMatchObject({ data: 'Cannot remove the last admin' });
    expect(await t.run(async (ctx) => ctx.db.get(adminId))).toMatchObject({
      role: 'admin',
    });
  });

  test('lets the last admin keep their admin role', async () => {
    const t = convexTest(schema, modules);
    const adminId = await createUser(t, { email: 'admin@example.com', role: 'admin' });

    expect(
      await asUser(t, adminId).mutation(api.users.setRole, {
        userId: adminId,
        role: 'admin',
      }),
    ).toBeNull();
  });

  test('lets one of two admins demote the other', async () => {
    const t = convexTest(schema, modules);
    const adminId = await createUser(t, { email: 'admin@example.com', role: 'admin' });
    const otherAdminId = await createUser(t, {
      email: 'other-admin@example.com',
      role: 'admin',
    });

    await asUser(t, adminId).mutation(api.users.setRole, {
      userId: otherAdminId,
      role: 'approver',
    });

    expect(await t.run(async (ctx) => ctx.db.get(otherAdminId))).toMatchObject({
      role: 'approver',
    });
    expect(await t.run(async (ctx) => ctx.db.get(adminId))).toMatchObject({
      role: 'admin',
    });
    await expect(
      asUser(t, adminId).mutation(api.users.setRole, {
        userId: adminId,
        role: 'trainee',
      }),
    ).rejects.toMatchObject({ data: 'Cannot remove the last admin' });
  });

  test('reports a missing target user', async () => {
    const t = convexTest(schema, modules);
    const adminId = await createUser(t, { email: 'admin@example.com', role: 'admin' });
    const userId = await createUser(t, { email: 'deleted@example.com' });
    await t.run(async (ctx) => ctx.db.delete(userId));

    await expect(
      asUser(t, adminId).mutation(api.users.setRole, { userId, role: 'author' }),
    ).rejects.toMatchObject({ data: 'User not found' });
  });
});

describe('authorization helpers', () => {
  test('rejects an identity whose user no longer exists', async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t, { email: 'deleted@example.com', role: 'admin' });
    await t.run(async (ctx) => ctx.db.delete(userId));

    await expect(asUser(t, userId).run(requireUser)).rejects.toMatchObject({
      data: 'Not signed in',
    });
    await expect(asUser(t, userId).query(api.users.list, {})).rejects.toMatchObject({
      data: 'Not signed in',
    });
  });

  test('uses role ranks and defaults a missing role to trainee', async () => {
    const t = convexTest(schema, modules);
    const authorId = await createUser(t, { email: 'author@example.com', role: 'author' });
    const legacyId = await createUser(t, { email: 'legacy@example.com' });
    const author = await asUser(t, authorId).run(requireUser);
    const legacy = await asUser(t, legacyId).run(requireUser);

    expect(hasRole(author, 'trainee')).toBe(true);
    expect(hasRole(author, 'author')).toBe(true);
    expect(hasRole(author, 'approver')).toBe(false);
    expect(hasRole(author, 'admin')).toBe(false);
    expect(hasRole(legacy, 'trainee')).toBe(true);
    expect(hasRole(legacy, 'author')).toBe(false);
  });
});

describe('roleForNewUser', () => {
  test('matches ADMIN_EMAIL case-insensitively and trims both emails', () => {
    expect(roleForNewUser('  ADMIN@Example.com ', ' admin@example.COM  ')).toBe('admin');
  });

  test('uses trainee for a different email', () => {
    expect(roleForNewUser('user@example.com', 'admin@example.com')).toBe('trainee');
  });

  test('uses trainee when either email is missing or blank', () => {
    expect(roleForNewUser(undefined, 'admin@example.com')).toBe('trainee');
    expect(roleForNewUser('admin@example.com', undefined)).toBe('trainee');
    expect(roleForNewUser(undefined, undefined)).toBe('trainee');
    expect(roleForNewUser('', '')).toBe('trainee');
    expect(roleForNewUser(' ', '  ')).toBe('trainee');
    expect(roleForNewUser('admin@example.com', ' ')).toBe('trainee');
  });
});
