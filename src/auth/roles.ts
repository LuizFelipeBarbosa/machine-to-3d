export type Role = 'trainee' | 'author' | 'approver' | 'admin';

export const ROLE_RANK: Record<Role, number> = {
  trainee: 0,
  author: 1,
  approver: 2,
  admin: 3,
};
