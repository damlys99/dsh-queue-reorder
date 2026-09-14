/**
 * Offline selftest for dsh-queue-reorder: exercises the host transaction,
 * request decoding, and the browser half's module-loader contract against
 * fakes. Run with `node selftest.mjs`.
 */
import assert from 'node:assert/strict';

import {
  QueueReorderError,
  decodeQueueReorderRequest,
  handleRoute,
  moveQueuedMessage,
} from './lib/index.js';

let passed = 0;
/**
 * Run one assertion body to completion before the next begins: several read the
 * shared DOM stub after awaiting a frame, so an unawaited body would race them.
 * @param name - assertion label.
 * @param fn - assertion body.
 */
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('ok  ' + name);
}

/** @returns a fake live agent with a controllable next-turn queue. */
function fakeAgent(ids, sources = {}) {
  const messages = ids.map((id) => ({ id, source: sources[id] ?? { kind: 'user' } }));
  return {
    session: { header: {} },
    inbox: {
      nextTurn: messages,
      splices: [],
      splice(target, start, deleteCount, inserted) {
        this.splices.push({ target, start, deleteCount, inserted: inserted.map((m) => m.id) });
        this.nextTurn = this.nextTurn.toSpliced(start, deleteCount, ...inserted);
      },
    },
  };
}

const order = (agent) => agent.inbox.nextTurn.map((m) => m.id);

test('moves a message later and records one splice over the affected span', () => {
  const agent = fakeAgent(['a', 'b', 'c']);
  const result = moveQueuedMessage(() => agent, {
    sessionId: 's', itemId: 'a', toIndex: 2, expectedOrder: ['a', 'b', 'c'],
  });
  assert.deepEqual(order(agent), ['b', 'c', 'a']);
  assert.deepEqual(result, { ok: true, order: ['b', 'c', 'a'] });
  assert.deepEqual(agent.inbox.splices, [{ target: 'next-turn', start: 0, deleteCount: 3, inserted: ['b', 'c', 'a'] }]);
});

test('moves a message earlier', () => {
  const agent = fakeAgent(['a', 'b', 'c']);
  moveQueuedMessage(() => agent, { sessionId: 's', itemId: 'c', toIndex: 0, expectedOrder: ['a', 'b', 'c'] });
  assert.deepEqual(order(agent), ['c', 'a', 'b']);
});

test('a swap touches only the pair', () => {
  const agent = fakeAgent(['a', 'b', 'c', 'd']);
  moveQueuedMessage(() => agent, { sessionId: 's', itemId: 'c', toIndex: 1, expectedOrder: ['a', 'b', 'c', 'd'] });
  assert.deepEqual(order(agent), ['a', 'c', 'b', 'd']);
  assert.deepEqual(agent.inbox.splices, [{ target: 'next-turn', start: 1, deleteCount: 2, inserted: ['c', 'b'] }]);
});

test('a no-op move writes nothing', () => {
  const agent = fakeAgent(['a', 'b']);
  moveQueuedMessage(() => agent, { sessionId: 's', itemId: 'a', toIndex: 0, expectedOrder: ['a', 'b'] });
  assert.deepEqual(agent.inbox.splices, []);
});

test('a stale view of the queue is refused', () => {
  const agent = fakeAgent(['a', 'b']);
  assert.throws(
    () => moveQueuedMessage(() => agent, { sessionId: 's', itemId: 'a', toIndex: 1, expectedOrder: ['b', 'a'] }),
    (error) => error instanceof QueueReorderError && error.code === 'QUEUE_CHANGED' && error.status === 409,
  );
  assert.deepEqual(order(agent), ['a', 'b']);
});

test('an unknown item is refused', () => {
  const agent = fakeAgent(['a', 'b']);
  assert.throws(
    () => moveQueuedMessage(() => agent, { sessionId: 's', itemId: 'zz', toIndex: 1, expectedOrder: ['a', 'b'] }),
    (error) => error.code === 'ITEM_NOT_FOUND',
  );
});

test('a goal-owned row inside the span is refused rather than cancelled', () => {
  const agent = fakeAgent(['a', 'g'], { g: { kind: 'goal', goalId: 'goal-1' } });
  assert.throws(
    () => moveQueuedMessage(() => agent, { sessionId: 's', itemId: 'a', toIndex: 1, expectedOrder: ['a', 'g'] }),
    (error) => error.code === 'NON_USER_MESSAGE',
  );
  assert.deepEqual(order(agent), ['a', 'g']);
});

test('a subagent queue is refused', () => {
  const agent = fakeAgent(['a', 'b']);
  agent.session.header.origin = 'subagent';
  assert.throws(
    () => moveQueuedMessage(() => agent, { sessionId: 's', itemId: 'a', toIndex: 1, expectedOrder: ['a', 'b'] }),
    (error) => error.code === 'SUBAGENT_UNSUPPORTED',
  );
});

test('a cold session is refused', () => {
  assert.throws(
    () => moveQueuedMessage(() => undefined, { sessionId: 's', itemId: 'a', toIndex: 1, expectedOrder: ['a', 'b'] }),
    (error) => error.status === 404 && error.code === 'AGENT_NOT_FOUND',
  );
});

test('out-of-range targets are refused', () => {
  const agent = fakeAgent(['a', 'b']);
  assert.throws(
    () => moveQueuedMessage(() => agent, { sessionId: 's', itemId: 'a', toIndex: 5, expectedOrder: ['a', 'b'] }),
    (error) => error.code === 'INVALID_TARGET',
  );
});

test('request decoding rejects junk', () => {
  const bad = [
    null,
    [],
    {},
    { sessionId: 's', itemId: 'a', toIndex: -1, expectedOrder: ['a'] },
    { sessionId: 's', itemId: 'a', toIndex: 1.5, expectedOrder: ['a'] },
    { sessionId: 's', itemId: 'a', toIndex: 0, expectedOrder: [] },
    { sessionId: 's', itemId: 'a', toIndex: 0, expectedOrder: ['a', 'a'] },
    { sessionId: '', itemId: 'a', toIndex: 0, expectedOrder: ['a'] },
  ];
  for (const value of bad) {
    assert.throws(() => decodeQueueReorderRequest(value), (error) => error.status === 400, 'rejected ' + JSON.stringify(value));
  }
  assert.deepEqual(
    decodeQueueReorderRequest({ sessionId: 's', itemId: 'a', toIndex: 1, expectedOrder: ['a', 'b'] }),
    { sessionId: 's', itemId: 'a', toIndex: 1, expectedOrder: ['a', 'b'] },
  );
});

/** @returns a fake EventEmitter-shaped request carrying one JSON body. */
function fakeRequest(method, contentTypeHeader, rawBody) {
  const listeners = new Map();
  const request = {
    method,
    headers: contentTypeHeader === null ? {} : { 'content-type': contentTypeHeader },
    on(event, handler) {
      listeners.set(event, handler);
      return request;
    },
  };
  setImmediate(() => {
    if (rawBody !== undefined) listeners.get('data')?.(Buffer.from(rawBody, 'utf8'));
    listeners.get('end')?.();
  });
  return request;
}

/** @returns a fake response recording status and body. */
function fakeResponse() {
  return {
    status: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body ?? ''; },
  };
}

/** @returns the parsed response body. */
const bodyOf = (response) => JSON.parse(response.body);

await (async () => {
  const agent = fakeAgent(['a', 'b', 'c']);
  const resolveAgent = () => agent;

  const good = fakeResponse();
  await handleRoute(resolveAgent, fakeRequest('POST', 'application/json', JSON.stringify({
    sessionId: 's', itemId: 'c', toIndex: 0, expectedOrder: ['a', 'b', 'c'],
  })), good);
  await test('POST /queue-reorder answers 200 with the new order', () => {
    assert.equal(good.status, 200);
    assert.deepEqual(bodyOf(good), { ok: true, order: ['c', 'a', 'b'] });
  });

  const wrongMethod = fakeResponse();
  await handleRoute(resolveAgent, fakeRequest('GET', null, undefined), wrongMethod);
  await test('a non-POST method answers 405', () => {
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, 'POST');
  });

  const wrongType = fakeResponse();
  await handleRoute(resolveAgent, fakeRequest('POST', 'text/plain', '{}'), wrongType);
  await test('a non-JSON content type answers 415', () => {
    assert.equal(wrongType.status, 415);
    assert.equal(bodyOf(wrongType).error.code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  const badJson = fakeResponse();
  await handleRoute(resolveAgent, fakeRequest('POST', 'application/json', '{nope'), badJson);
  await test('an unparsable body answers 400', () => {
    assert.equal(badJson.status, 400);
    assert.equal(bodyOf(badJson).error.code, 'BAD_JSON');
  });

  const stale = fakeResponse();
  await handleRoute(resolveAgent, fakeRequest('POST', 'application/json', JSON.stringify({
    sessionId: 's', itemId: 'a', toIndex: 2, expectedOrder: ['b', 'a', 'c'],
  })), stale);
  await test('a stale order answers 409 with QUEUE_CHANGED', () => {
    assert.equal(stale.status, 409);
    assert.equal(bodyOf(stale).error.code, 'QUEUE_CHANGED');
  });

  // --- browser half: module contract + dock decoration against DOM stubs ---
  /** Minimal DOM node: exactly the query/insert/remove surface the decorator uses. */
  class FakeNode {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parent = null;
      this.style = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.className = '';
      this.innerHTML = '';
      this.disabled = false;
      this.title = '';
      this.draggable = false;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    prepend(...nodes) { for (const node of [...nodes].reverse()) { node.parent = this; this.children.unshift(node); } }
    remove() {
      if (this.parent === null) return;
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
      this.parent = null;
    }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    click() { this.listeners.get('click')?.(); }
    get lastElementChild() { return this.children.length === 0 ? null : this.children[this.children.length - 1]; }
    querySelector(selector) { return descendants(this).find((node) => matches(node, selector)) ?? null; }
    querySelectorAll(selector) { return descendants(this).filter((node) => matches(node, selector)); }
  }
  const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
  const matches = (node, selector) => {
    if (!selector.startsWith('[')) return node.tagName === selector.toUpperCase();
    const body = selector.slice(1, -1);
    const equals = body.indexOf('=');
    if (equals < 0) return node.hasAttribute(body);
    const name = body.slice(0, equals);
    const value = body.slice(equals + 1).replace(/^["']|["']$/g, '');
    return node.getAttribute(name) === value;
  };

  const fakeDocument = {
    body: new FakeNode('body'),
    createElement: (tag) => new FakeNode(tag),
    querySelector: (selector) => fakeDocument.body.querySelector(selector),
    querySelectorAll: (selector) => fakeDocument.body.querySelectorAll(selector),
  };
  globalThis.document = fakeDocument;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  const fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const registrations = [];
  globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
  await import('./lib/client.js');

  await test('the client bundle registers itself under the package id', () => {
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].id, 'dsh-queue-reorder');
  });

  const plugin = registrations[0].factory((specifier) => {
    throw new Error('the browser half must require no module; it asked for ' + specifier);
  });

  await test('the client half exports apply, inject and the move helper', () => {
    assert.equal(typeof plugin.apply, 'function');
    assert.deepEqual(plugin.inject, ['slots', 'sessions']);
    assert.equal(typeof plugin.nextOrder, 'function');
  });

  await test('nextOrder moves one id and refuses no-ops and out-of-range targets', () => {
    assert.deepEqual(plugin.nextOrder(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
    assert.deepEqual(plugin.nextOrder(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
    assert.equal(plugin.nextOrder(['a', 'b'], 1, 1), null);
    assert.equal(plugin.nextOrder(['a', 'b'], 0, 5), null);
    assert.equal(plugin.nextOrder(['a', 'b'], -1, 0), null);
  });

  /** Mount the official dock shape: one panel, one list, N queued rows with action strips. */
  function mountDock(count) {
    fakeDocument.body = new FakeNode('body');
    const dock = new FakeNode('div');
    dock.setAttribute('data-queue-dock', '');
    const panel = new FakeNode('div');
    const list = new FakeNode('ul');
    for (let index = 0; index < count; index += 1) {
      const row = new FakeNode('li');
      const actions = new FakeNode('div');
      const donor = new FakeNode('button');
      donor.className = 'official-action';
      actions.append(donor);
      row.append(actions);
      list.append(row);
    }
    panel.append(list);
    dock.append(panel);
    fakeDocument.body.append(dock);
    return dock;
  }

  const notifications = [];
  const slotEntries = [];
  const ctx = {
    effect: (fn) => { fn(); return () => {}; },
    sessions: { scope: () => undefined },
    slots: {
      inject: (slotName, fn) => { assert.equal(slotName, 'conversation.input.dock'); fn(); },
      register: (entry, component) => slotEntries.push({ entry, component }),
    },
  };
  plugin.apply(ctx);

  await test('the client half registers a bridge that does not take over the official dock', () => {
    assert.equal(slotEntries.length, 1);
    assert.equal(slotEntries[0].entry.name, 'conversation.input.dock');
    assert.equal(slotEntries[0].entry.id, 'queue-reorder');
    assert.equal(slotEntries[0].entry.order, 1000);
    assert.equal(typeof slotEntries[0].entry.inject, 'function');
  });

  const bridge = slotEntries[0].component;
  /** Publish one session snapshot through the bridge, as the slot runtime does. */
  const publish = (ids, mutable = true) => bridge({
    sessionId: 'session-1',
    notify: (level, text) => { notifications.push({ level, text }); },
    useSession: (selector) => selector({
      queue: ids.map((id) => ({ id, messageId: id, placement: 'queued', content: [{ type: 'text', text: id }], preview: id, text: id })),
      subagent: mutable ? null : { address: { mode: 'owned' } },
    }),
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const listOf = () => fakeDocument.body.querySelector('[data-queue-dock]').querySelector('ul');
  const ownedCount = () => fakeDocument.body.querySelectorAll('[data-queue-reorder]').length;

  mountDock(3);
  await tick();

  await test('the bridge publishes the queued ids and renders nothing', () => {
    assert.equal(publish(['m1', 'm2', 'm3']), null);
    assert.deepEqual(plugin.queueState.ids, ['m1', 'm2', 'm3']);
    assert.equal(plugin.queueState.sessionId, 'session-1');
    assert.equal(plugin.queueState.mutable, true);
  });

  await tick();

  await test('every queued row gains one dock-styled move control, ends disabled', () => {
    const rows = [...listOf().children];
    assert.equal(rows.length, 3);
    for (const row of rows) {
      const group = row.lastElementChild.querySelector('[data-queue-reorder]');
      assert.equal(group.getAttribute('data-queue-reorder'), 'group', 'exactly one control group per row');
      assert.equal(group.children.length, 2);
      assert.equal(group.children[0].className, 'official-action', 'wears the official action class');
      assert.equal(row.draggable, true, 'the row itself is draggable');
    }
    assert.equal(rows[0].lastElementChild.querySelector('[data-queue-reorder]').children[0].disabled, true);
    assert.equal(rows[0].lastElementChild.querySelector('[data-queue-reorder]').children[1].disabled, false);
    assert.equal(rows[2].lastElementChild.querySelector('[data-queue-reorder]').children[1].disabled, true);
  });

  await test('re-syncing does not duplicate the controls', async () => {
    publish(['m1', 'm2', 'm3']);
    await tick();
    for (const row of listOf().children) {
      assert.equal(row.lastElementChild.children.filter((child) => child.getAttribute('data-queue-reorder') === 'group').length, 1);
    }
  });

  await tick();

  await test('clicking ↓ asks the host to move that row later', () => {
    fetchCalls.length = 0;
    const row = listOf().children[1];
    row.lastElementChild.querySelector('[data-queue-reorder]').children[1].click();
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, '/queue-reorder');
    assert.deepEqual(fetchCalls[0].body, { sessionId: 'session-1', itemId: 'm2', toIndex: 2, expectedOrder: ['m1', 'm2', 'm3'] });
  });

  await tick();

  await test('dragging a row onto another sends that move instead', () => {
    fetchCalls.length = 0;
    const rows = [...listOf().children];
    const dataTransfer = { effectAllowed: '', setData() {}, getData: () => '0' };
    rows[0].ondragstart({ dataTransfer });
    rows[2].ondrop({ preventDefault() {}, dataTransfer });
    assert.deepEqual(fetchCalls[0].body, { sessionId: 'session-1', itemId: 'm1', toIndex: 2, expectedOrder: ['m1', 'm2', 'm3'] });
  });

  await tick();

  await test('a refused move reports through the dock notice channel', async () => {
    fetchCalls.length = 0;
    notifications.length = 0;
    globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'QUEUE_CHANGED', message: 'the queue changed' } }) });
    listOf().children[0].lastElementChild.querySelector('[data-queue-reorder]').children[1].click();
    await tick();
    assert.deepEqual(notifications, [{ level: 'error', text: 'the queue changed' }]);
  });

  await test('one queued row leaves the dock untouched', async () => {
    mountDock(1);
    publish(['solo']);
    await tick();
    assert.equal(ownedCount(), 0);
  });

  await test('a queue owned by a parent session stays undecorated', async () => {
    mountDock(2);
    publish(['a', 'b'], false);
    await tick();
    assert.equal(ownedCount(), 0);
  });

  await test('a row that stops being last becomes movable again', async () => {
    mountDock(2);
    publish(['m1', 'm2']);
    await tick();
    const downOf = (index) => listOf().children[index].lastElementChild.querySelector('[data-queue-reorder]').children[1];
    assert.equal(downOf(1).disabled, true, 'the last row cannot move later');
    const row = new FakeNode('li');
    const actions = new FakeNode('div');
    actions.append(new FakeNode('button'));
    row.append(actions);
    listOf().append(row);
    publish(['m1', 'm2', 'm3']);
    await tick();
    assert.equal(downOf(1).disabled, false, 'the same row is no longer last');
    assert.equal(downOf(2).disabled, true, 'the new row is');
  });

  await test('moves use the live row position after the host reorders rows in place', async () => {
    mountDock(3);
    publish(['m1', 'm2', 'm3']);
    await tick();
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const list = listOf();
    const moved = list.children[0];
    list.append(list.children.shift());
    publish(['m2', 'm3', 'm1']);
    await tick();
    fetchCalls.length = 0;
    moved.lastElementChild.querySelector('[data-queue-reorder]').children[0].click();
    assert.equal(fetchCalls.length, 1, 'the moved row can still be reordered');
    assert.deepEqual(fetchCalls[0].body, { sessionId: 'session-1', itemId: 'm1', toIndex: 1, expectedOrder: ['m2', 'm3', 'm1'] });
  });

  await test('every queued row gains a draggable grip handle', async () => {
    mountDock(3);
    publish(['m1', 'm2', 'm3']);
    await tick();
    for (const row of listOf().children) {
      const grip = row.querySelector('[data-queue-reorder="grip"]');
      assert.notEqual(grip, null, 'grip present');
      assert.equal(grip.draggable, true);
      assert.equal(row.children[0], grip, 'the handle leads the row');
      assert.equal(row.querySelectorAll('[data-queue-reorder="grip"]').length, 1, 'exactly one handle');
    }
  });

  await test('dragging over a row marks it, and the mark is cleared on drop', async () => {
    mountDock(2);
    publish(['m1', 'm2']);
    await tick();
    const rows = [...listOf().children];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData() {}, getData: () => null };
    rows[1].ondragover({ preventDefault() {}, dataTransfer });
    assert.match(rows[1].style.outline, /dashed/, 'the row under the drag is marked');
    assert.equal(rows[0].style.outline, undefined, 'only one row wears the mark');
    rows[0].ondragover({ preventDefault() {}, dataTransfer });
    assert.equal(rows[1].style.outline, '', 'the previous mark moved with the pointer');
    assert.match(rows[0].style.outline, /dashed/);
    rows[0].ondrop({ preventDefault() {}, dataTransfer });
    assert.equal(rows[0].style.outline, '', 'dropping clears the mark');
  });

  console.log('\n' + String(passed) + ' assertions passed');
})().catch((error) => {
  console.error('\nFAILED: ' + (error instanceof Error ? error.stack : String(error)));
  process.exitCode = 1;
});
