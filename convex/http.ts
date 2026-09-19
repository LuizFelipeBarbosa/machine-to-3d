import { httpRouter } from 'convex/server';
import { auth } from './auth';
import { registerWorkerRoutes } from './workerRoutes';

const http = httpRouter();
auth.addHttpRoutes(http);
registerWorkerRoutes(http);

export default http;
