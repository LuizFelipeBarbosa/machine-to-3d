import { ConvexError } from 'convex/values';

export function errorMessage(error: unknown): string {
  return error instanceof ConvexError ? String(error.data) : 'Something went wrong';
}
