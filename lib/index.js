/**
 * dsh-queue-reorder — host half.
 *
 * One same-origin route that reorders the pending `next-turn` rows of a live
 * Agent's inbox: the prompts a user queued while the agent was busy. The move
 * is refused unless the caller's `expectedOrder` still matches the live queue,
 * so a queue that changed under the caller is never scrambled.
 *
 * Safety rules, each a deliberate refusal rather than a silent surprise:
 * - Only ordinary user prompts move. Steering rows (`next-step`) are untouched.
 * - Subagent-owned queues are refused; their parent owns them.
 * - A span containing any non-user source (a goal round prompt, for instance)
 *   is rejected, because discarding and reinserting such a row would cancel
 *   work the harness still tracks.
 */

/** Same-origin endpoint owned by this plugin's client half. */
export const ROUTE_PATH = '/queue-reorder';

/** Defensive ceiling for one request body and one reordered queue. */
export const MAX_QUEUE_ITEMS = 200;
const MAX_BODY_BYTES = 32 * 1024;

/** Cordis plugin name. */
export const name = 'queue-reorder';

/** Host capabilities required by the route. */
export const inject = ['agents', 'webServer'];

/** Typed failure translated to a narrow HTTP response. */
export class QueueReorderError extends Error {
  /**
   * @param status - HTTP status the route answers with.
   * @param code - stable machine-readable failure code.
   * @param message - human-readable explanation shown by the client dock.
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'QueueReorderError';
  }
}

/** @returns a {@link QueueReorderError} without an `if` ladder at every call. */
function fail(status, code, message) {
  return new QueueReorderError(status, code, message);
}

/** @returns a bounded non-empty string field. */
function stringField(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw fail(400, 'BAD_REQUEST', `${field} must be a non-empty string`);
  }
  return value;
}

/** @returns a non-negative safe-integer field. */
function indexField(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw fail(400, 'BAD_REQUEST', 'toIndex must be a non-negative integer');
  }
  return value;
}

/** @returns the caller's view of the queue, validated as a bounded id list. */
function orderField(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUEUE_ITEMS) {
    throw fail(400, 'BAD_REQUEST', 'expectedOrder must be a non-empty bounded array');
  }
  const order = value.map((item, index) => stringField(item, `expectedOrder[${String(index)}]`));
  if (new Set(order).size !== order.length) throw fail(400, 'BAD_REQUEST', 'expectedOrder contains duplicate ids');
  return order;
}

/**
 * Decode the untrusted JSON body before it reaches the queue layer.
 * @param value - parsed request body.
 * @returns the validated request.
 */
export function decodeQueueReorderRequest(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fail(400, 'BAD_REQUEST', 'request body must be an object');
  }
  return {
    sessionId: stringField(value.sessionId, 'sessionId'),
    itemId: stringField(value.itemId, 'itemId'),
    toIndex: indexField(value.toIndex),
    expectedOrder: orderField(value.expectedOrder),
  };
}

/** @returns queue row identities in current order. */
function idsOf(messages) {
  return messages.map((message) => String(message.id));
}

/** @returns whether two id lists are the same order. */
function sameOrder(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Refuse queues this plugin does not own. */
function assertOrdinary(agent) {
  if (agent.session.header.origin === 'subagent') {
    throw fail(409, 'SUBAGENT_UNSUPPORTED', 'subagent queues are owned by their parent session');
  }
}

/** Refuse a span that would discard a row the harness still tracks as work. */
function assertUserSources(messages, start, end) {
  for (let index = start; index <= end; index += 1) {
    if (messages[index]?.source?.kind !== 'user') {
      throw fail(409, 'NON_USER_MESSAGE', 'that queue row is not a user prompt; moving it would cancel work the harness still tracks');
    }
  }
}

/**
 * Move one pending next-turn message to a new position.
 *
 * The whole move is one `agent/inbox/spliced` event over the smallest span
 * that contains both ends, so the durable inbox projection is the only state
 * that changes and the transcript records exactly one mutation.
 *
 * @param resolveAgent - live agent lookup for a session id.
 * @param request - validated move request.
 * @returns the accepted order after the move.
 */
export function moveQueuedMessage(resolveAgent, request) {
  const agent = resolveAgent(request.sessionId);
  if (agent === undefined) throw fail(404, 'AGENT_NOT_FOUND', 'the session no longer has a live agent');
  assertOrdinary(agent);
  const current = [...agent.inbox.nextTurn];
  if (current.length === 0) throw fail(409, 'QUEUE_EMPTY', 'the queue is empty');
  if (!sameOrder(idsOf(current), request.expectedOrder)) {
    throw fail(409, 'QUEUE_CHANGED', 'the queue changed before this operation; retry from the latest order');
  }
  if (request.toIndex >= current.length) throw fail(400, 'INVALID_TARGET', 'the target position is outside the current queue');
  const from = current.findIndex((message) => String(message.id) === request.itemId);
  if (from < 0) throw fail(409, 'ITEM_NOT_FOUND', 'the queued item is no longer pending');
  if (from === request.toIndex) return { ok: true, order: idsOf(current) };

  const start = Math.min(from, request.toIndex);
  const end = Math.max(from, request.toIndex);
  assertUserSources(current, start, end);
  const replacement = current.slice(start, end + 1);
  const [moving] = replacement.splice(from - start, 1);
  if (moving === undefined) throw fail(409, 'ITEM_NOT_FOUND', 'the queued item is no longer pending');
  replacement.splice(request.toIndex - start, 0, moving);
  agent.inbox.splice('next-turn', start, end - start + 1, replacement);
  return { ok: true, order: idsOf(agent.inbox.nextTurn) };
}

/** @returns the request's content type, normalized. */
function contentType(request) {
  const raw = request.headers?.['content-type'];
  return Array.isArray(raw) ? raw[0] ?? '' : raw ?? '';
}

/**
 * Read one bounded JSON request body.
 * @param request - incoming HTTP request.
 * @returns the parsed body.
 */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    let failed = false;
    request.on('data', (chunk) => {
      if (failed) return;
      const data = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      bytes += data.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        failed = true;
        reject(fail(413, 'BODY_TOO_LARGE', 'request body is too large'));
        return;
      }
      text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    });
    request.on('end', () => {
      if (failed) return;
      try {
        text += decoder.decode();
        resolve(JSON.parse(text));
      } catch {
        reject(fail(400, 'BAD_JSON', 'request body is not valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

/** Write one JSON response. */
function respondJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

/**
 * Answer one reorder request. Every failure keeps its own status and code so
 * the dock can say what actually went wrong.
 * @param resolveAgent - live agent lookup for a session id.
 * @param request - incoming HTTP request.
 * @param response - HTTP response owned by this handler.
 */
export async function handleRoute(resolveAgent, request, response) {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' });
    response.end();
    return;
  }
  if (!contentType(request).toLowerCase().startsWith('application/json')) {
    respondJson(response, 415, { ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'application/json is required' } });
    return;
  }
  try {
    const decoded = decodeQueueReorderRequest(await readJsonBody(request));
    respondJson(response, 200, moveQueuedMessage(resolveAgent, decoded));
  } catch (error) {
    if (error instanceof QueueReorderError) {
      respondJson(response, error.status, { ok: false, error: { code: error.code, message: error.message } });
      return;
    }
    respondJson(response, 500, { ok: false, error: { code: 'INTERNAL', message: 'queue reorder failed' } });
  }
}

/**
 * Register the same-origin reorder route.
 * @param ctx - plugin context carrying the agent registry and web server.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (request, response) => void handleRoute((sessionId) => ctx.agents.get(sessionId), request, response),
    }),
    'queue-reorder: HTTP route',
  );
}
