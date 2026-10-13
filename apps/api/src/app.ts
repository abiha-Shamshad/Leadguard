// Fastify application: one API service (Section 5). Routes -> services -> repositories.
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { AppError, errorEnvelope, OPERATIONS } from '@leadguard/contracts';
import type { Deps } from './deps.ts';
import { registerAuth } from './plugins/auth.ts';
import { assertAllOperationsRegistered, resetRegistry } from './lib/route.ts';
import { registerSystem } from './modules/system.ts';
import { registerOrg } from './modules/org.ts';
import { registerTeam } from './modules/team.ts';
import { registerSources } from './modules/sources.ts';
import { registerIngest } from './modules/ingest.ts';
import { registerLeads } from './modules/leads.ts';
import { registerInbox } from './modules/inbox.ts';
import { registerRules } from './modules/rules.ts';
import { registerAlerts } from './modules/alerts.ts';
import { registerDashboard } from './modules/dashboard.ts';
import { registerBilling } from './modules/billing.ts';
import { registerWebhooks } from './modules/webhooks.ts';
import { registerExports } from './modules/exports.ts';
import { registerSupport } from './modules/support.ts';

const REQUEST_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export async function buildApp(deps: Deps, opts: { logStream?: NodeJS.WritableStream } = {}): Promise<FastifyInstance> {
  resetRegistry();
  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
      // Section 32: no bodies, auth headers, tokens or contact data in logs.
      redact: { paths: ['req.headers.authorization', 'req.headers["x-leadguard-source-secret"]', 'req.body', 'res.body'], remove: true },
      ...(opts.logStream ? { stream: opts.logStream } : {}),
    },
    disableRequestLogging: true,
    // Product API bodies are small; ingest and webhooks register their own raw-body parsers and limits.
    bodyLimit: 262_144,
    // Fastify accepts a hop count at runtime; its typings only list boolean | string | string[].
    trustProxy: (deps.config.trustProxyHops > 0 ? deps.config.trustProxyHops : false) as unknown as boolean,
    genReqId: req => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && REQUEST_ID_RE.test(h) ? h : `req_${randomBytes(8).toString('hex')}`;
    },
  });

  app.decorateRequest('requestId', '');
  const appOrigin = new URL(deps.config.appUrl).origin;
  app.addHook('onRequest', async (req, reply) => {
    req.requestId = String(req.id);
    reply.header('X-Request-ID', req.requestId);
    // CORS for the web app origin only (product API). The web app normally proxies /api/v1 same-origin.
    if (req.url.startsWith('/api/v1/') && req.headers.origin === appOrigin) {
      reply.header('Access-Control-Allow-Origin', appOrigin).header('Vary', 'Origin')
        .header('Access-Control-Expose-Headers', 'X-Request-ID, Retry-After');
      if (req.method === 'OPTIONS') {
        return reply.code(204)
          .header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH')
          .header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Org-Id, X-Request-ID, X-Support-Grant-Id')
          .header('Access-Control-Max-Age', '600')
          .send();
      }
    }
  });

  // Security headers on every response. The API serves JSON only.
  const production = deps.config.nodeEnv === 'production';
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (production) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/api/v1/') || req.url.startsWith('/files/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // Application logs: request_id, org_id, user_id, route template, status, duration, error code (Section 32).
  app.addHook('onResponse', async (req, reply) => {
    req.log.info({
      request_id: req.requestId,
      org_id: req.actor?.orgId ?? undefined,
      user_id: req.actor?.userId ?? undefined,
      route: req.routeOptions.url ?? 'unmatched',
      method: req.method,
      status: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime),
    }, 'request');
  });

  app.setErrorHandler((err: any, req, reply) => {
    const requestId = req.requestId || String(req.id);
    if (err instanceof AppError) {
      for (const [h, v] of Object.entries(err.headers)) reply.header(h, v);
      req.log.info({ request_id: requestId, error_code: err.code }, 'request rejected');
      // Failed authentication counts against the caller's IP budget (credential stuffing, token guessing).
      if (err.status === 401) void deps.limiter.hit(`unauth:${req.ip}`, deps.config.rateLimits.ipUnauthPerMinute, 60);
      return reply.code(err.status).send(errorEnvelope(err.code, err.message, requestId, err.details, err.retryable));
    }
    if (err?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send(errorEnvelope('PAYLOAD_TOO_LARGE', 'Request body is too large.', requestId));
    }
    if (err?.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err?.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || err instanceof SyntaxError) {
      return reply.code(400).send(errorEnvelope('VALIDATION_FAILED', 'The request body must be valid JSON.', requestId, { fields: { body: 'Invalid JSON.' } }));
    }
    // PostgreSQL data errors (invalid text representation, value too long, check violation) are client errors.
    if (typeof err?.code === 'string' && (/^22/.test(err.code) || err.code === '23514')) {
      req.log.info({ request_id: requestId, pg_code: err.code }, 'invalid input rejected by database');
      return reply.code(400).send(errorEnvelope('VALIDATION_FAILED', 'Some values are not valid. Check the highlighted fields.', requestId));
    }
    if (err?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.code(400).send(errorEnvelope('VALIDATION_FAILED', 'Use Content-Type: application/json.', requestId));
    }
    // Stack trace with scrubbed request context only (no body, no headers).
    req.log.error({ request_id: requestId, route: req.routeOptions?.url, err: { message: err?.message, code: err?.code, stack: err?.stack } }, 'unhandled error');
    return reply.code(503).send(errorEnvelope('SERVICE_UNAVAILABLE', 'Something went wrong on our side. Try again shortly.', requestId, {}, true));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(errorEnvelope('NOT_FOUND', 'Not found.', req.requestId || String(req.id)));
  });

  await registerAuth(app, deps);

  registerSystem(app, deps);
  registerOrg(app, deps);
  registerTeam(app, deps);
  registerSources(app, deps);
  await app.register(async scoped => registerIngest(scoped, deps));
  registerLeads(app, deps);
  registerInbox(app, deps);
  registerRules(app, deps);
  registerAlerts(app, deps);
  registerDashboard(app, deps);
  registerBilling(app, deps);
  await app.register(async scoped => registerWebhooks(scoped, deps));
  registerExports(app, deps);
  registerSupport(app, deps);

  // Every one of the 52 registry operations must have a route (Appendix A, TASK-004 step 4).
  assertAllOperationsRegistered(OPERATIONS.map(o => o.id));
  return app;
}
