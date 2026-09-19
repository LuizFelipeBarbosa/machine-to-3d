import type { TestConvexForDataModel } from 'convex-test';
import type { DataModel, Id } from './_generated/dataModel';
import type { Role } from './lib/validators';

type TestConvex = TestConvexForDataModel<DataModel>;

export const modules = import.meta.glob('./**/*.*s');

export async function createUser(
  t: TestConvex,
  fields: { email: string; role?: Role; name?: string },
): Promise<Id<'users'>> {
  return t.run(async (ctx) => ctx.db.insert('users', fields));
}

export function asUser(t: TestConvex, userId: Id<'users'>): TestConvex {
  return t.withIdentity({
    subject: `${userId}|test-session`,
    issuer: 'test',
  });
}
