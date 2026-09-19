import { anyApi } from 'convex/server';
import type { ApiFromModules } from 'convex/server';
import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { describe, expect, test } from 'vitest';
import type * as files from './files';
import schema from './schema';
import { asUser, createUser, modules } from './test.setup';

const api = anyApi as unknown as ApiFromModules<{
  files: typeof files;
}>;

async function setup() {
  const t = convexTest(schema, modules);
  const authorId = await createUser(t, { email: 'author@example.com', role: 'author' });
  const traineeId = await createUser(t, { email: 'trainee@example.com', role: 'trainee' });
  const fileId = await t.run((ctx) => ctx.storage.store(new Blob(['media'])));
  return { t, author: asUser(t, authorId), trainee: asUser(t, traineeId), fileId };
}

describe('files.mediaUrl', () => {
  test('rejects a trainee', async () => {
    const { trainee, fileId } = await setup();
    const url = trainee.query(api.files.mediaUrl, { fileId });
    await expect(url).rejects.toBeInstanceOf(ConvexError);
    await expect(url).rejects.toMatchObject({ data: 'Not authorized' });
  });

  test('returns a stored file URL for an author', async () => {
    const { t, author, fileId } = await setup();
    const url = await author.query(api.files.mediaUrl, { fileId });
    expect(url).toEqual(expect.any(String));
    expect(url).toBe(await t.run((ctx) => ctx.storage.getUrl(fileId)));
  });
});
