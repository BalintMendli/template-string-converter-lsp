'use strict';

// Pure text logic: offsets in, offset edits out. No LSP types in here.
//
// String detection uses the TypeScript parser rather than a hand-written
// scanner, so comments, regexes, JSX text and nested templates are handled by
// the same code that compiles the file, and the syntactic position of a string
// (import path, property name, JSX attribute...) is known.
//
// A document is either a script (JavaScript, TypeScript) or markup that embeds
// scripts in <script> blocks (HTML, Svelte, Vue). In markup, only the contents
// of those blocks are parsed and converted.

const ts = require('typescript');

// Keyed by LSP language id. Zed sends "tsx" for .tsx files; "typescriptreact"
// is what the LSP specification lists.
const SCRIPT_KINDS = {
  typescript: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  jsx: ts.ScriptKind.JSX,
  typescriptreact: ts.ScriptKind.TSX,
  javascript: ts.ScriptKind.JSX, // .js files may hold JSX
  javascriptreact: ts.ScriptKind.JSX,
};

const TEMPLATE_KINDS = new Set([
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

// Parent pointers are not set: filling them in doubles the parse time, and the
// two ancestors needed here fall out of the descent in `nodeAt`.
function parse(text, languageId) {
  const kind = SCRIPT_KINDS[languageId];
  return ts.createSourceFile('document', text, ts.ScriptTarget.Latest, /* setParentNodes */ false, kind);
}

/**
 * Parsed files, kept per document so that a later lookup re-parses only what
 * changed. A full parse of a 5,000-line file takes tens of milliseconds, an
 * incremental one a few; the answer to a keystroke has to be fast (see the
 * on-type formatting handler in server.js).
 */
function createParseCache(limit = 8) {
  const entries = new Map(); // key -> { text, languageId, sourceFile }, oldest first

  function parseCached(key, text, languageId) {
    const hit = entries.get(key);
    entries.delete(key);
    let sourceFile;
    if (hit && hit.languageId === languageId) {
      sourceFile = hit.text === text ? hit.sourceFile : update(hit, text);
    }
    sourceFile ??= parse(text, languageId);
    entries.set(key, { text, languageId, sourceFile });
    if (entries.size > limit) entries.delete(entries.keys().next().value);
    return sourceFile;
  }

  // Describe old -> new as one replaced span (everything between the common
  // prefix and the common suffix) and let TypeScript reuse the rest.
  function update(hit, text) {
    const old = hit.text;
    const max = Math.min(old.length, text.length);
    let prefix = 0;
    while (prefix < max && old.charCodeAt(prefix) === text.charCodeAt(prefix)) prefix++;
    let suffix = 0;
    while (suffix < max - prefix && old.charCodeAt(old.length - 1 - suffix) === text.charCodeAt(text.length - 1 - suffix)) suffix++;
    const range = { span: { start: prefix, length: old.length - prefix - suffix }, newLength: text.length - prefix - suffix };
    try {
      return ts.updateSourceFile(hit.sourceFile, text, range);
    } catch {
      return undefined; // fall back to a full parse
    }
  }

  // Drops `key` and every "key#..." entry (a document's script blocks).
  function drop(key) {
    for (const existing of [...entries.keys()]) {
      if (existing === key || existing.startsWith(key + '#')) entries.delete(existing);
    }
  }

  return { parse: parseCached, delete: drop, has: (key) => entries.has(key) };
}

// <script type="..."> values that hold JavaScript or TypeScript. Anything else
// (JSON, templates, import maps...) is data, not code.
const SCRIPT_TYPES = {
  module: 'javascript',
  'text/javascript': 'javascript',
  'application/javascript': 'javascript',
  'text/ecmascript': 'javascript',
  'application/ecmascript': 'javascript',
  'text/babel': 'jsx',
  'text/jsx': 'jsx',
  'text/typescript': 'typescript',
  'application/typescript': 'typescript',
  'text/tsx': 'tsx',
};
const SCRIPT_LANGS = { js: 'javascript', javascript: 'javascript', jsx: 'jsx', ts: 'typescript', typescript: 'typescript', tsx: 'tsx' };

function attribute(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]).trim().toLowerCase() : null;
}

/** The language of a <script ...> opening tag's contents, or null when it is not code we handle. */
function scriptTagLanguage(tag) {
  const lang = attribute(tag, 'lang');
  if (lang !== null) return SCRIPT_LANGS[lang] ?? null;
  const type = attribute(tag, 'type');
  if (type !== null && type !== '') return SCRIPT_TYPES[type] ?? null;
  return 'javascript';
}

/**
 * The <script> blocks of a markup document, as the ranges of their contents.
 * Follows HTML's rule for script elements: the contents run to the next
 * "</script", whatever is in between. `slot` numbers the blocks, for caching.
 *
 * @returns {Array<{start: number, end: number, languageId: string, slot: number}>}
 */
function scriptBlocks(text) {
  const blocks = [];
  const opener = /<!--|<script(?=[\s>/])/gi;
  const closer = /<\/script/gi;
  let slot = 0;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    if (match[0] === '<!--') {
      const close = text.indexOf('-->', match.index + 4);
      if (close === -1) break;
      opener.lastIndex = close + 3;
      continue;
    }
    // Find the ">" that ends the opening tag, skipping quoted attribute values.
    let i = match.index + match[0].length;
    for (let quote = null; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (i >= text.length) break;
    const start = i + 1;
    if (text[i - 1] === '/') { // <script src="..." />
      opener.lastIndex = start;
      continue;
    }
    closer.lastIndex = start;
    const close = closer.exec(text);
    const end = close ? close.index : text.length;
    const languageId = scriptTagLanguage(text.slice(match.index, start));
    if (languageId) blocks.push({ start, end, languageId, slot });
    slot++;
    if (!close) break;
    opener.lastIndex = end;
  }
  return blocks;
}

/**
 * The stretch of `text` that holds the script around `index`: the whole text
 * for a script document, the enclosing <script> block for markup, or null.
 */
function scriptAt(text, languageId, index) {
  if (languageId in SCRIPT_KINDS) return { start: 0, end: text.length, languageId, slot: 0 };
  return scriptBlocks(text).find((block) => block.start <= index && index < block.end) ?? null;
}

/**
 * Parse the script around `offset` now, so that a lookup that follows shortly
 * only needs an incremental re-parse.
 */
function warmParse(text, offset, languageId, parseFile) {
  const script = scriptAt(text, languageId, offset);
  if (script) parseFile(text.slice(script.start, script.end), script.languageId, script.slot);
}

/**
 * The innermost node whose own text (not its leading comments or whitespace)
 * covers `index`, with its parent and grandparent; or null.
 */
function nodeAt(sourceFile, index) {
  let grandparent;
  let parent;
  let node = sourceFile;
  for (;;) {
    const child = ts.forEachChild(node, (c) => (c.pos <= index && index < c.end ? c : undefined));
    if (!child) break;
    grandparent = parent;
    parent = node;
    node = child;
  }
  return index >= node.getStart(sourceFile) ? { node, parent, grandparent } : null;
}

/**
 * Why a string literal in this position must stay a string literal, or null.
 * A template literal is a syntax error (or changes meaning) in these places.
 */
function blockedContext(node, parent, grandparent) {
  if (ts.isJsxAttribute(parent)) return 'JSX attribute value';
  if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) return 'module specifier';
  if (ts.isExternalModuleReference(parent)) return 'module specifier';
  if (ts.isModuleDeclaration(parent)) return 'module name';
  if (ts.isLiteralTypeNode(parent) && grandparent && ts.isImportTypeNode(grandparent)) return 'module specifier';
  if (ts.isImportAttribute?.(parent) || ts.isAssertEntry?.(parent)) return 'import attribute';
  if (parent.name === node || parent.propertyName === node) return 'property name';
  if (ts.isEnumMember(parent)) return 'enum member value';
  if (ts.isExpressionStatement(parent)) return 'directive';
  return null;
}

/** Offsets of unescaped occurrences of `ch` in text[from, to). */
function unescapedIndexes(text, from, to, ch) {
  const out = [];
  for (let i = from; i < to; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === ch) out.push(i);
  }
  return out;
}

/**
 * Quote -> backtick conversion.
 *
 * `offset` is the position just after a "{" that follows a "$".
 *
 * `languageId` is the document's LSP language id. `parseFile` is
 * `(text, languageId, slot) => ts.SourceFile`; pass a cache's to reuse earlier
 * parses.
 *
 * @returns {{edits: Array<{start: number, end: number, newText: string}>, reason: string, quote?: string, start?: number}}
 */
function convertToTemplate(text, offset, languageId, parseFile = parse) {
  // Cheap checks first: most "{" keystrokes are not preceded by "$", and those
  // never reach the parser.
  if (text[offset - 1] !== '{') return { edits: [], reason: 'no "{" before the position' };
  if (text[offset - 2] !== '$') return { edits: [], reason: 'no "$" before "{"' };
  let backslashes = 0;
  for (let k = offset - 3; k >= 0 && text[k] === '\\'; k--) backslashes++;
  if (backslashes % 2 === 1) return { edits: [], reason: '"$" is escaped' };

  const script = scriptAt(text, languageId, offset - 2);
  if (!script || offset > script.end) return { edits: [], reason: 'not inside a script block' };
  const result = convertInScript(
    text.slice(script.start, script.end),
    offset - script.start,
    parseFile(text.slice(script.start, script.end), script.languageId, script.slot),
  );
  return shifted(result, script.start);
}

/** Moves a result computed on a slice of the document back to document offsets. */
function shifted(result, by) {
  if (by === 0 || result.edits.length === 0) return result;
  return {
    ...result,
    start: result.start === undefined ? undefined : result.start + by,
    edits: result.edits.map((e) => ({ start: e.start + by, end: e.end + by, newText: e.newText })),
  };
}

/** `convertToTemplate` for one parsed script; offsets are relative to `text`. */
function convertInScript(text, offset, sourceFile) {
  const found = nodeAt(sourceFile, offset - 2);
  if (!found) return { edits: [], reason: 'not inside a string literal' };
  const { node, parent, grandparent } = found;
  if (TEMPLATE_KINDS.has(node.kind)) return { edits: [], reason: 'already a template literal' };
  if (!ts.isStringLiteral(node)) return { edits: [], reason: 'not inside a string literal' };

  const start = node.getStart(sourceFile);
  const end = node.end - 1; // index of the closing quote
  const quote = text[start];
  if (node.isUnterminated || end <= start || text[end] !== quote) return { edits: [], reason: 'string literal is not closed' };
  const blocked = blockedContext(node, parent, grandparent);
  if (blocked) return { edits: [], reason: `template literal not allowed here (${blocked})` };

  const edits = [{ start, end: start + 1, newText: '`' }];
  for (const at of unescapedIndexes(text, start + 1, end, '`')) {
    edits.push({ start: at, end: at, newText: '\\' });
  }
  edits.push({ start: end, end: end + 1, newText: '`' });
  return { edits, reason: 'converted', quote, start };
}

/**
 * Backtick -> quote reversion, for when the last "${" of a template literal is
 * deleted.
 *
 * `offset` is where the change happened (the same offset in both texts, and
 * where the cursor is afterwards); `delta` is newText.length - oldText.length.
 */
function revertToQuotes(oldText, newText, offset, delta, languageId, preferredQuote, parseFile = parse) {
  // The change sits after the script's start, so that start is the same
  // offset in the old text.
  const script = scriptAt(newText, languageId, Math.max(offset - 1, 0));
  if (!script) return { edits: [], reason: 'not inside a script block' };
  const result = revertInScript(
    oldText.slice(script.start, script.end - delta),
    newText.slice(script.start, script.end),
    offset - script.start,
    delta,
    preferredQuote,
    parseFile(newText.slice(script.start, script.end), script.languageId, script.slot),
  );
  return shifted(result, script.start);
}

/** `revertToQuotes` for one parsed script; offsets are relative to the texts. */
function revertInScript(oldText, newText, offset, delta, preferredQuote, sourceFile) {
  const { node, parent } = (offset > 0 && nodeAt(sourceFile, offset - 1)) || {};
  if (!node || node.kind !== ts.SyntaxKind.NoSubstitutionTemplateLiteral) return { edits: [], reason: 'not inside a template literal without "${"' };

  const start = node.getStart(sourceFile);
  const end = node.end - 1; // index of the closing backtick
  if (node.isUnterminated || end <= start || newText[end] !== '`') return { edits: [], reason: 'template literal is not closed' };
  if (offset > end) return { edits: [], reason: 'change was not inside the literal' };
  // An edit that replaces a character the cursor touches moves the cursor past
  // it in Zed, which here would throw the cursor out of the string.
  if (offset === end) return { edits: [], reason: 'cursor touches the closing backtick' };
  if (ts.isTaggedTemplateExpression(parent)) return { edits: [], reason: 'tagged template' };

  const content = newText.slice(start + 1, end);
  if (/[\r\n]/.test(content)) return { edits: [], reason: 'template spans lines' };
  // The same literal in the old text ends `delta` characters earlier or later.
  if (!oldText.slice(start, end + 1 - delta).includes('${')) return { edits: [], reason: 'template had no "${" before the change' };

  let quote = preferredQuote === "'" || preferredQuote === '"' ? preferredQuote : '"';
  const other = quote === '"' ? "'" : '"';
  if (content.includes(quote) && !content.includes(other)) quote = other;

  const edits = [{ start, end: start + 1, newText: quote }];
  for (let i = start + 1; i < end; i++) {
    if (newText[i] === '\\') {
      if (newText[i + 1] === '`') edits.push({ start: i, end: i + 1, newText: '' });
      i++;
      continue;
    }
    if (newText[i] === quote) edits.push({ start: i, end: i, newText: '\\' });
  }
  edits.push({ start: end, end: end + 1, newText: quote });
  return { edits, reason: 'reverted', quote };
}

/** Apply offset edits to a string (used by the tests). */
function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}

module.exports = { convertToTemplate, revertToQuotes, warmParse, scriptBlocks, createParseCache, applyEdits };
