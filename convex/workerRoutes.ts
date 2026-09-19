import type { FunctionArgs, HttpRouter } from 'convex/server';
import { ConvexError } from 'convex/values';
import { internal } from './_generated/api';
import { httpAction } from './_generated/server';
import type { ActionCtx } from './_generated/server';

async function secretDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function errorResponse(error: unknown): Response {
  if (error instanceof ConvexError) {
    return Response.json({ error: error.data }, { status: error.data === 'Lease lost' ? 409 : 400 });
  }
  console.error(error);
  return Response.json({ error: 'Internal error' }, { status: 500 });
}

function withWorkerAuth(handler: (ctx: ActionCtx, req: Request) => Promise<Response>) {
  return httpAction(async (ctx, req) => {
    try {
      const secret = process.env.WORKER_SECRET;
      const suppliedSecret = req.headers.get('X-Worker-Secret');
      if (!secret || suppliedSecret === null) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const [expectedDigest, suppliedDigest] = await Promise.all([
        secretDigest(secret), secretDigest(suppliedSecret),
      ]);
      if (expectedDigest !== suppliedDigest) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      return await handler(ctx, req);
    } catch (error) {
      return errorResponse(error);
    }
  });
}

async function readBody(
  req: Request,
  requiredStrings: string[],
  requiredObjects: string[] = [],
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new ConvexError('Invalid JSON body');
    throw error;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ConvexError('JSON body must be an object');
  }
  const fields = body as Record<string, unknown>;
  for (const field of requiredStrings) {
    if (typeof fields[field] !== 'string' || fields[field] === '') {
      throw new ConvexError(`${field} is required and must be a non-empty string`);
    }
  }
  for (const field of requiredObjects) {
    if (fields[field] === null || typeof fields[field] !== 'object' || Array.isArray(fields[field])) {
      throw new ConvexError(`${field} is required and must be an object`);
    }
  }
  return fields;
}

async function claim(ctx: ActionCtx, req: Request): Promise<Response> {
  const { workerId, leaseSeconds = 300 } = await readBody(req, ['workerId']) as
    FunctionArgs<typeof internal.draftJobs.claim>;
  const job = await ctx.runMutation(internal.draftJobs.claim, { workerId, leaseSeconds });
  return job === null
    ? new Response(null, { status: 204, headers: { 'Content-Type': 'application/json' } })
    : Response.json(job);
}

async function heartbeat(ctx: ActionCtx, req: Request): Promise<Response> {
  const { jobId, workerId } = await readBody(req, ['jobId', 'workerId']) as
    FunctionArgs<typeof internal.draftJobs.heartbeat>;
  return Response.json(await ctx.runMutation(internal.draftJobs.heartbeat, { jobId, workerId }));
}

async function event(ctx: ActionCtx, req: Request): Promise<Response> {
  const { jobId, workerId, level, message } = await readBody(req, ['jobId', 'workerId', 'level', 'message']) as
    FunctionArgs<typeof internal.draftJobs.appendEvent>;
  await ctx.runMutation(internal.draftJobs.appendEvent, { jobId, workerId, level, message });
  return new Response(null, { status: 204, headers: { 'Content-Type': 'application/json' } });
}

async function stage(ctx: ActionCtx, req: Request): Promise<Response> {
  const { jobId, workerId, stage, codexSessionId } = await readBody(req, ['jobId', 'workerId', 'stage']) as
    FunctionArgs<typeof internal.draftJobs.setStage>;
  await ctx.runMutation(internal.draftJobs.setStage, { jobId, workerId, stage, codexSessionId });
  return new Response(null, { status: 204, headers: { 'Content-Type': 'application/json' } });
}

async function uploadUrl(ctx: ActionCtx, req: Request): Promise<Response> {
  const { jobId, workerId } = await readBody(req, ['jobId', 'workerId']) as
    FunctionArgs<typeof internal.draftJobs.checkLease>;
  await ctx.runQuery(internal.draftJobs.checkLease, { jobId, workerId });
  const url = await ctx.storage.generateUploadUrl();
  return Response.json({ url });
}

async function deliver(ctx: ActionCtx, req: Request): Promise<Response> {
  const { jobId, workerId, modelChanged, model, procedure, mediaFileIds, sourceContentHash, report } =
    await readBody(req, ['jobId', 'workerId'], ['procedure']) as FunctionArgs<typeof internal.draftJobs.deliver>;
  return Response.json(await ctx.runMutation(internal.draftJobs.deliver, {
    jobId, workerId, modelChanged, model, procedure, mediaFileIds, sourceContentHash, report,
  }));
}

async function fail(ctx: ActionCtx, req: Request): Promise<Response> {
  const { jobId, workerId, error } = await readBody(req, ['jobId', 'workerId', 'error']) as
    FunctionArgs<typeof internal.draftJobs.fail>;
  await ctx.runMutation(internal.draftJobs.fail, { jobId, workerId, error });
  return new Response(null, { status: 204, headers: { 'Content-Type': 'application/json' } });
}

export function registerWorkerRoutes(http: HttpRouter): void {
  http.route({ path: '/worker/claim', method: 'POST', handler: withWorkerAuth(claim) });
  http.route({ path: '/worker/heartbeat', method: 'POST', handler: withWorkerAuth(heartbeat) });
  http.route({ path: '/worker/event', method: 'POST', handler: withWorkerAuth(event) });
  http.route({ path: '/worker/stage', method: 'POST', handler: withWorkerAuth(stage) });
  http.route({ path: '/worker/upload-url', method: 'POST', handler: withWorkerAuth(uploadUrl) });
  http.route({ path: '/worker/deliver', method: 'POST', handler: withWorkerAuth(deliver) });
  http.route({ path: '/worker/fail', method: 'POST', handler: withWorkerAuth(fail) });

  const methodNotAllowed = withWorkerAuth(async () => Response.json(
    { error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } },
  ));
  for (const path of [
    '/worker/claim', '/worker/heartbeat', '/worker/event', '/worker/stage',
    '/worker/upload-url', '/worker/deliver', '/worker/fail',
  ]) {
    // Convex handles HEAD through the GET route.
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'] as const) {
      http.route({ path, method, handler: methodNotAllowed });
    }
  }
}
