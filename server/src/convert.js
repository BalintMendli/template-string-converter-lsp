'use strict';

// Pure text logic: offsets in, offset edits out. No LSP types in here.
//
// String detection uses the TypeScript parser rather than a hand-written
// scanner, so comments, regexes, JSX text and nested templates are handled by
// the same code that compiles the file, and the syntactic position of a string
// (import path, property name, JSX attribute...) is known.

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
  const kind = SCRIPT_KINDS[languageId] ?? ts.ScriptKind.TSX;
  return ts.createSourceFile('document', text, ts.ScriptTarget.Latest, /* setParentNodes */ false, kind);
}

/**
 * Parsed files, kept per document so that a later lookup re-parses only what
 * changed. A full parse of a 5,000-line file takes tens of milliseconds, an
 * incremental one a few; the answer to a keystroke has to be fast (see the
 * on-type formatting handler in server.js).
 */
function createParseCache(limit = 4) {
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

  return { parse: parseCached, delete: (key) => entries.delete(key), has: (key) => entries.has(key) };
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
 * `parseFile` is `(text, languageId) => ts.SourceFile`; pass a cache's to reuse
 * earlier parses.
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

  const sourceFile = parseFile(text, languageId);
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
  const sourceFile = parseFile(newText, languageId);
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

module.exports = { convertToTemplate, revertToQuotes, createParseCache, applyEdits };
