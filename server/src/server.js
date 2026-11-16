#!/usr/bin/env node
'use strict';

// Language server behind the Zed "Template String Converter" extension.
//
// When "{" is typed right after "$" inside a '...' or "..." string, the quotes
// become backticks. Zed sends textDocument/onTypeFormatting for that "{" only
// when it did not auto-close the brace, so there are two routes:
//
//   - on-type formatting, when the client asks about a lone "{";
//   - an unsolicited workspace/applyEdit from didChange, when the change was an
//     auto-closed "{}" (the client will not ask about that one).
//
// Settings (initializationOptions, then workspace/didChangeConfiguration):
//
//   enabled       boolean, default true
//   convertVia    "hybrid" (default) | "onType" | "applyEdit"
//   autoRevert    boolean, default false. Turn backticks back into quotes when
//                 the last "${" of a single-line template literal is deleted.
//   debugLogFile  string, default unset. Append every message handled, with
//                 document text, to this file. For debugging only.

const fs = require('fs');
const {
  createConnection,
  ProposedFeatures,
  TextDocumentSyncKind,
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { convertToTemplate, revertToQuotes, warmParse, createParseCache } = require('./convert');

const DEFAULTS = Object.freeze({ enabled: true, convertVia: 'hybrid', autoRevert: false, debugLogFile: null });

/** Keep known keys with valid values; anything else falls back to `base`. */
function readSettings(raw, base) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : base.enabled,
    convertVia: ['hybrid', 'onType', 'applyEdit'].includes(input.convertVia) ? input.convertVia : base.convertVia,
    autoRevert: typeof input.autoRevert === 'boolean' ? input.autoRevert : base.autoRevert,
    debugLogFile: typeof input.debugLogFile === 'string' && input.debugLogFile ? input.debugLogFile : base.debugLogFile,
  };
}

const connection = createConnection(ProposedFeatures.all);

let settings = DEFAULTS;
/** @type {Map<string, TextDocument>} */
const documents = new Map();
/** Quote character each document's last conversion replaced, for the revert. */
const lastQuote = new Map();
/** Document version an applyEdit conversion was sent for, so a client that
 *  also asks about the same keystroke does not get the edits twice. */
const convertedAtVersion = new Map();
/** Parsed scripts, keyed by document URI and script block number. */
const parseCache = createParseCache();
const parserFor = (uri) => (text, languageId, slot = 0) => parseCache.parse(`${uri}#${slot}`, text, languageId);

function debug(event, data) {
  if (!settings.debugLogFile) return;
  try {
    fs.appendFileSync(settings.debugLogFile, JSON.stringify({ t: new Date().toISOString(), event, ...data }) + '\n');
  } catch {
    // Debug logging must never break the server.
  }
}

/** The line at `position` with a "|" marking the position, for the debug log. */
function lineWithCaret(doc, position) {
  const text = doc.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line + 1, character: 0 },
  }).replace(/\r?\n$/, '');
  return text.slice(0, position.character) + '|' + text.slice(position.character);
}

function toTextEdits(doc, edits) {
  return edits.map((e) => ({
    range: { start: doc.positionAt(e.start), end: doc.positionAt(e.end) },
    newText: e.newText,
  }));
}

// Sent in the same tick as the didChange that caused it, and stamped with that
// document version: Zed rebases a versioned edit onto whatever was typed since.
function sendApplyEdit(doc, label, edits) {
  const textEdits = toTextEdits(doc, edits);
  const edit = { documentChanges: [{ textDocument: { uri: doc.uri, version: doc.version }, edits: textEdits }] };
  debug('applyEdit ->', { label, uri: doc.uri, version: doc.version, edits: textEdits });
  // The response is only logged: Zed answers "applied: true" unconditionally.
  connection.workspace.applyEdit({ label, edit }).then(
    (response) => debug('applyEdit <-', { label, response }),
    (error) => debug('applyEdit failed', { label, error: String(error) }),
  );
}

connection.onInitialize((params) => {
  settings = readSettings(params.initializationOptions, DEFAULTS);
  debug('initialize', { client: params.clientInfo, settings });
  return {
    capabilities: {
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental },
      documentOnTypeFormattingProvider: { firstTriggerCharacter: '{' },
    },
    serverInfo: { name: 'template-string-converter-language-server' },
  };
});

connection.onDidChangeConfiguration((params) => {
  // Start from the defaults, not the current values: a key removed from the
  // user's settings goes back to its default.
  settings = readSettings(params.settings, DEFAULTS);
  debug('didChangeConfiguration', { settings });
});

connection.onDidOpenTextDocument(({ textDocument }) => {
  documents.set(
    textDocument.uri,
    TextDocument.create(textDocument.uri, textDocument.languageId, textDocument.version, textDocument.text),
  );
  debug('didOpen', { uri: textDocument.uri, languageId: textDocument.languageId, version: textDocument.version });
});

connection.onDidCloseTextDocument(({ textDocument }) => {
  documents.delete(textDocument.uri);
  lastQuote.delete(textDocument.uri);
  convertedAtVersion.delete(textDocument.uri);
  parseCache.delete(textDocument.uri);
  debug('didClose', { uri: textDocument.uri });
});

connection.onDidChangeTextDocument(({ textDocument, contentChanges }) => {
  const doc = documents.get(textDocument.uri);
  if (!doc) return;

  // Apply the changes one at a time, noting where each one starts, how much it
  // shifts the text after it, and what it removed. TextDocument.update edits
  // `doc` in place.
  const steps = [];
  for (const change of contentChanges) {
    const ranged = 'range' in change;
    const offset = ranged ? doc.offsetAt(change.range.start) : 0;
    const removedText = ranged ? doc.getText(change.range) : doc.getText();
    // Only a single-change revert looks at the old text, so keep it just then.
    const oldText = contentChanges.length === 1 ? doc.getText() : null;
    TextDocument.update(doc, [change], textDocument.version);
    steps.push({ text: change.text, ranged, offset, removedText, oldText, delta: change.text.length - removedText.length });
  }
  const newText = doc.getText();

  debug('didChange', {
    uri: textDocument.uri,
    version: textDocument.version,
    changes: contentChanges.map((c) => ('range' in c ? { range: c.range, text: c.text } : { full: true, length: c.text.length })),
    text: newText,
  });

  if (!settings.enabled) return;

  // A "$" was typed: a "{" may be next. Parse now, while nothing is waiting,
  // so that the answer to that "{" only needs an incremental re-parse.
  const dollar = steps.find((step) => step.text === '$');
  if (dollar) warmParse(newText, dollar.offset, doc.languageId, parserFor(textDocument.uri));

  if (settings.convertVia !== 'onType') {
    // One conversion per auto-closed "{}" that was just inserted. In pure
    // applyEdit mode a lone "{" counts too; in hybrid mode the client asks
    // about that one through on-type formatting.
    const wanted = settings.convertVia === 'hybrid' ? ['{}'] : ['{', '{}'];
    const edits = [];
    const seen = new Set();
    steps.forEach((step, i) => {
      if (!step.ranged || !wanted.includes(step.text)) return;
      // Position just after the "{", moved to where it sits in the final text.
      let offset = step.offset + 1;
      for (const later of steps.slice(i + 1)) {
        if (later.offset + later.removedText.length <= offset) offset += later.delta;
      }
      const result = convertToTemplate(newText, offset, doc.languageId, parserFor(textDocument.uri));
      if (result.edits.length === 0 || seen.has(result.start)) return;
      seen.add(result.start);
      lastQuote.set(textDocument.uri, result.quote);
      edits.push(...result.edits);
    });
    if (edits.length > 0) {
      convertedAtVersion.set(textDocument.uri, doc.version);
      sendApplyEdit(doc, 'Convert to template string', edits);
      return;
    }
  }

  // Revert: only for a single change that removed a "$" or "{" (anything else
  // cannot have removed a "${"), so ordinary typing never reaches the parser.
  if (settings.autoRevert && steps.length === 1 && steps[0].ranged && /[${]/.test(steps[0].removedText)) {
    const { oldText, offset, delta } = steps[0];
    const result = revertToQuotes(oldText, newText, offset, delta, doc.languageId, lastQuote.get(textDocument.uri), parserFor(textDocument.uri));
    debug('revert check', { uri: textDocument.uri, outcome: result.reason });
    if (result.edits.length > 0) sendApplyEdit(doc, 'Revert template string', result.edits);
  }
});

// Answered without awaiting anything: on-type formatting edits carry no
// document version, so Zed applies them at face value to whatever the buffer
// holds when they arrive. The sooner the answer, the smaller that window.
connection.onDocumentOnTypeFormatting((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || !settings.enabled || params.ch !== '{') return null;

  let result;
  if (settings.convertVia === 'applyEdit') {
    result = { edits: [], reason: 'on-type conversion is switched off' };
  } else if (convertedAtVersion.get(params.textDocument.uri) === doc.version) {
    result = { edits: [], reason: 'already converted through applyEdit' };
  } else {
    result = convertToTemplate(doc.getText(), doc.offsetAt(params.position), doc.languageId, parserFor(params.textDocument.uri));
  }

  debug('onTypeFormatting', {
    uri: params.textDocument.uri,
    ch: params.ch,
    position: params.position,
    docVersion: doc.version,
    line: lineWithCaret(doc, params.position),
    outcome: result.reason,
    edits: result.edits.length,
  });
  if (result.edits.length === 0) return null;
  lastQuote.set(params.textDocument.uri, result.quote);
  return toTextEdits(doc, result.edits);
});

connection.listen();
