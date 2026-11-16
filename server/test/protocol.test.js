'use strict';

// Drives the server over stdio the way an editor does. Runs against the
// sources, and against the bundle too when it has been built.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const URI = 'file:///project/a.ts';
const pos = (line, character) => ({ line, character });
const at = (line, character) => ({ start: pos(line, character), end: pos(line, character) });

function startServer(script) {
  const child = spawn(process.execPath, [script, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();
  const applyEdits = [];

  const send = (message) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...message });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString())[1]);
      if (buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
      buffer = buffer.subarray(headerEnd + 4 + length);
      if (message.method === 'workspace/applyEdit') {
        applyEdits.push(message.params);
        send({ id: message.id, result: { applied: true } });
      } else if (message.id !== undefined && !message.method) {
        pending.get(message.id)(message.result);
        pending.delete(message.id);
      }
    }
  });

  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
  const notify = (method, params) => send({ method, params });
  const onType = (line, character, ch = '{') => request('textDocument/onTypeFormatting', {
    textDocument: { uri: URI }, position: pos(line, character), ch, options: { tabSize: 2, insertSpaces: true },
  });

  let version = 0;
  return {
    applyEdits,
    onType,
    notify,
    async init(initializationOptions) {
      const result = await request('initialize', { processId: process.pid, rootUri: null, capabilities: {}, initializationOptions });
      notify('initialized', {});
      return result;
    },
    open(text, languageId = 'typescript') {
      notify('textDocument/didOpen', { textDocument: { uri: URI, languageId, version, text } });
    },
    change(...contentChanges) {
      notify('textDocument/didChange', { textDocument: { uri: URI, version: ++version }, contentChanges });
      return version;
    },
    // The server handles messages in order, so once this answer is back every
    // earlier notification has been handled and its requests have been sent.
    sync: () => onType(0, 0, 'x'),
    async stop() {
      await request('shutdown', null);
      notify('exit');
    },
  };
}

const servers = [['source', path.join(__dirname, '..', 'src', 'server.js')]];
const bundle = path.join(__dirname, '..', 'dist', 'server.js');
if (fs.existsSync(bundle)) servers.push(['bundle', bundle]);

for (const [label, script] of servers) {
  const withServer = (name, initOptions, body) => test(`${label}: ${name}`, async () => {
    const server = startServer(script);
    try {
      await server.init(initOptions);
      await body(server);
    } finally {
      await server.stop();
    }
  });

  test(`${label}: advertises "{" as its only on-type trigger`, async () => {
    const server = startServer(script);
    try {
      const { capabilities } = await server.init();
      assert.deepEqual(capabilities.documentOnTypeFormattingProvider, { firstTriggerCharacter: '{' });
      assert.equal(capabilities.textDocumentSync.change, 2);
    } finally {
      await server.stop();
    }
  });

  withServer('a lone "{" is converted through on-type formatting', undefined, async (server) => {
    server.open('const a = "hello $";\n');
    server.change({ range: at(0, 18), text: '{' });
    assert.deepEqual(await server.onType(0, 19), [
      { range: { start: pos(0, 10), end: pos(0, 11) }, newText: '`' },
      { range: { start: pos(0, 19), end: pos(0, 20) }, newText: '`' },
    ]);
    assert.equal(server.applyEdits.length, 0);
  });

  withServer('an auto-closed "{}" is converted through a versioned applyEdit, once', undefined, async (server) => {
    server.open("const a = 'hello $ world';\n");
    const version = server.change({ range: at(0, 18), text: '{}' });
    await server.sync();
    assert.equal(server.applyEdits.length, 1);
    assert.deepEqual(server.applyEdits[0].edit.documentChanges, [{
      textDocument: { uri: URI, version },
      edits: [
        { range: { start: pos(0, 10), end: pos(0, 11) }, newText: '`' },
        { range: { start: pos(0, 26), end: pos(0, 27) }, newText: '`' },
      ],
    }]);
    // A client that asks about the same keystroke anyway gets nothing more.
    assert.equal(await server.onType(0, 19), null);
  });

  withServer('several cursors in one change give one applyEdit', undefined, async (server) => {
    server.open('const a = "x $ y";\nconst b = \'x $ y\';\n');
    server.change({ range: at(0, 14), text: '{}' }, { range: at(1, 14), text: '{}' });
    await server.sync();
    assert.equal(server.applyEdits.length, 1);
    assert.deepEqual(
      server.applyEdits[0].edit.documentChanges[0].edits.map((e) => [e.range.start.line, e.range.start.character]),
      [[0, 10], [0, 18], [1, 10], [1, 18]],
    );
  });

  withServer('JSX attribute values are left alone', undefined, async (server) => {
    server.open('const x = <p title="a $">t</p>;\n', 'typescriptreact');
    server.change({ range: at(0, 22), text: '{' });
    assert.equal(await server.onType(0, 23), null);
  });

  withServer('convertVia "onType" never sends applyEdit', { convertVia: 'onType' }, async (server) => {
    server.open("const a = 'hello $ world';\n");
    server.change({ range: at(0, 18), text: '{}' });
    await server.sync();
    assert.equal(server.applyEdits.length, 0);
  });

  withServer('settings can switch the server off and on again', undefined, async (server) => {
    server.open('const a = "hello $";\n');
    server.change({ range: at(0, 18), text: '{' });
    server.notify('workspace/didChangeConfiguration', { settings: { enabled: false } });
    assert.equal(await server.onType(0, 19), null);
    server.notify('workspace/didChangeConfiguration', { settings: {} });
    assert.equal((await server.onType(0, 19)).length, 2);
  });

  withServer('autoRevert is off by default', undefined, async (server) => {
    server.open('const a = `hello ${} world`;\n');
    server.change({ range: { start: pos(0, 18), end: pos(0, 20) }, text: '' });
    await server.sync();
    assert.equal(server.applyEdits.length, 0);
  });

  withServer('autoRevert restores the quote that was converted', { autoRevert: true }, async (server) => {
    server.open("const a = 'hello $ world';\n");
    server.change({ range: at(0, 18), text: '{}' });
    server.change(
      { range: { start: pos(0, 26), end: pos(0, 27) }, text: '`' },
      { range: { start: pos(0, 10), end: pos(0, 11) }, text: '`' },
    );
    const version = server.change({ range: { start: pos(0, 18), end: pos(0, 20) }, text: '' });
    await server.sync();
    assert.equal(server.applyEdits.length, 2);
    assert.deepEqual(server.applyEdits[1].edit.documentChanges, [{
      textDocument: { uri: URI, version },
      edits: [
        { range: { start: pos(0, 10), end: pos(0, 11) }, newText: "'" },
        { range: { start: pos(0, 24), end: pos(0, 25) }, newText: "'" },
      ],
    }]);
  });
}
