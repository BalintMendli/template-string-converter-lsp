'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { convertToTemplate, revertToQuotes, createParseCache, applyEdits } = require('../src/convert');

// "|" marks the cursor: the position just after the typed "{".
function convert(marked, languageId = 'typescript') {
  const offset = marked.indexOf('|');
  const text = marked.replace('|', '');
  const result = convertToTemplate(text, offset, languageId);
  return { out: applyEdits(text, result.edits), reason: result.reason };
}

test('double-quoted string becomes a template literal', () => {
  assert.equal(convert('const a = "hello ${|}";').out, 'const a = `hello ${}`;');
});

test('single-quoted string becomes a template literal', () => {
  assert.equal(convert("const a = 'hello ${|}';").out, 'const a = `hello ${}`;');
});

test('works without the auto-closed brace', () => {
  assert.equal(convert('const a = "hello ${|";').out, 'const a = `hello ${`;');
});

test('existing backticks are escaped', () => {
  assert.equal(convert('const a = "run `ls` ${|}";').out, 'const a = `run \\`ls\\` ${}`;');
});

test('already escaped backticks are left alone', () => {
  assert.equal(convert('const a = "run \\`ls ${|}";').out, 'const a = `run \\`ls ${}`;');
});

test('escaped quotes inside the string do not end it', () => {
  assert.equal(convert("const a = 'it\\'s ${|}';").out, "const a = `it\\'s ${}`;");
});

test('nothing happens inside a template literal', () => {
  assert.equal(convert('const a = `hello ${|}`;').reason, 'already a template literal');
  assert.equal(convert('const a = `hello ${|`;').reason, 'already a template literal');
  assert.equal(convert('const a = `${x} and ${|}`;').reason, 'already a template literal');
});

test('a string inside a template expression is converted on its own', () => {
  assert.equal(convert('const a = `x ${f("y ${|}")}`;').out, 'const a = `x ${f(`y ${}`)}`;');
});

test('multi-line template before the string does not confuse detection', () => {
  assert.equal(convert('const t = `a\n"b\n`;\nconst a = "c ${|}";').out, 'const t = `a\n"b\n`;\nconst a = `c ${}`;');
});

test('nothing happens in code, comments or regexes', () => {
  assert.equal(convert('const a = ${|}').reason, 'not inside a string literal');
  assert.equal(convert('// "hello ${|}"').reason, 'not inside a string literal');
  assert.equal(convert('/* "hello ${|}" */ const a = 1;').reason, 'not inside a string literal');
  assert.equal(convert('const r = /"${|}"/;').reason, 'not inside a string literal');
});

test('a quote inside a comment does not open a string', () => {
  assert.equal(convert('// don\'t\nconst a = "x ${|}";').out, '// don\'t\nconst a = `x ${}`;');
});

test('division is not mistaken for a regex', () => {
  assert.equal(convert('const a = b / 2; const c = "x ${|}"; const d = e / 2;').out, 'const a = b / 2; const c = `x ${}`; const d = e / 2;');
});

test('"{" without "$" and escaped "$" are ignored', () => {
  assert.equal(convert('const a = "hello {|}";').reason, 'no "$" before "{"');
  assert.equal(convert('const a = "hello \\${|}";').reason, '"$" is escaped');
});

test('unterminated strings are left alone', () => {
  assert.equal(convert('const a = "hello ${|\nconst b = 1;').reason, 'string literal is not closed');
});

test('only the string under the cursor is touched', () => {
  assert.equal(convert('f("a", "b ${|}", \'c\');').out, 'f("a", `b ${}`, \'c\');');
});

test('works while the rest of the file does not parse', () => {
  assert.equal(convert('function ( {\nconst a = "x ${|}";\nif (').out, 'function ( {\nconst a = `x ${}`;\nif (');
});

test('JSX: text is not a string, expressions are, attributes are blocked', () => {
  const tsx = (s) => convert(s, 'typescriptreact');
  assert.equal(tsx("const x = <p>don't ${|} it's</p>;").reason, 'not inside a string literal');
  assert.equal(tsx('const x = <p>{"a ${|}"}</p>;').out, 'const x = <p>{`a ${}`}</p>;');
  assert.equal(tsx('const x = <a>{"y"}</a>; const s = "z ${|}";').out, 'const x = <a>{"y"}</a>; const s = `z ${}`;');
  assert.equal(tsx('const x = <p title="a ${|}">t</p>;').reason, 'template literal not allowed here (JSX attribute value)');
  assert.equal(tsx('const x = <p title={"a ${|}"}>t</p>;').out, 'const x = <p title={`a ${}`}>t</p>;');
});

test('Zed\'s own language ids for TSX and JSX are understood', () => {
  assert.equal(convert('const x = <p title="a ${|}">t</p>;', 'tsx').reason, 'template literal not allowed here (JSX attribute value)');
  assert.equal(convert('const x = <p>{"b ${|}"}</p>;', 'jsx').out, 'const x = <p>{`b ${}`}</p>;');
});

test('JSX in a .js file', () => {
  assert.equal(convert('const x = <p title="a ${|}">{"b"}</p>;', 'javascript').reason, 'template literal not allowed here (JSX attribute value)');
  assert.equal(convert('const x = <p>{"b ${|}"}</p>;', 'javascript').out, 'const x = <p>{`b ${}`}</p>;');
});

test('TypeScript generics and casts in a .ts file are not read as JSX', () => {
  assert.equal(convert('const a = <string>"x ${|}"; const b = f<T>("y");').out, 'const a = <string>`x ${}`; const b = f<T>("y");');
});

test('positions where a template literal is a syntax error are left alone', () => {
  const blocked = (s, why) => assert.equal(convert(s).reason, `template literal not allowed here (${why})`, s);
  blocked('import a from "./m ${|}";', 'module specifier');
  blocked('import "./m ${|}";', 'module specifier');
  blocked('export * from "./m ${|}";', 'module specifier');
  blocked('export { a } from "./m ${|}";', 'module specifier');
  blocked('import a = require("./m ${|}");', 'module specifier');
  blocked('type T = import("./m ${|}").T;', 'module specifier');
  blocked('declare module "m ${|}" {}', 'module name');
  blocked('import d from "./d.json" with { type: "json ${|}" };', 'import attribute');
  blocked('const o = { "a ${|}": 1 };', 'property name');
  blocked('class C { "a ${|}" = 1 }', 'property name');
  blocked('class C { "a ${|}"() {} }', 'property name');
  blocked('interface I { "a ${|}": number }', 'property name');
  blocked('const { "a ${|}": b } = o;', 'property name');
  blocked('enum E { "a ${|}" = 1 }', 'property name');
  blocked('enum E { A = "a ${|}" }', 'enum member value');
  blocked('"use strict ${|}";', 'directive');
  blocked('function f() { "use strict ${|}"; }', 'directive');
});

test('positions that only look similar still convert', () => {
  assert.equal(convert('const o = { a: "b ${|}" };').out, 'const o = { a: `b ${}` };');
  assert.equal(convert('const v = o["k ${|}"];').out, 'const v = o[`k ${}`];');
  assert.equal(convert('const o = { ["k ${|}"]: 1 };').out, 'const o = { [`k ${}`]: 1 };');
  assert.equal(convert('const m = await import("./m ${|}");').out, 'const m = await import(`./m ${}`);');
  assert.equal(convert('const m = require("./m ${|}");').out, 'const m = require(`./m ${}`);');
  assert.equal(convert('type T = "a ${|}";').out, 'type T = `a ${}`;');
  assert.equal(convert('switch (x) { case "a ${|}": break; }').out, 'switch (x) { case `a ${}`: break; }');
  assert.equal(convert('const a = c ? "b ${|}" : d;').out, 'const a = c ? `b ${}` : d;');
});

// For the revert tests "|" marks where the change happened; it is the same
// offset in the old and the new text, and where the cursor ends up.
function revert(oldMarked, newMarked, quote, languageId = 'typescript') {
  const offset = oldMarked.indexOf('|');
  const oldText = oldMarked.replace('|', '');
  const newText = newMarked.replace('|', '');
  const result = revertToQuotes(oldText, newText, offset, newText.length - oldText.length, languageId, quote);
  return { out: applyEdits(newText, result.edits), reason: result.reason };
}

test('deleting "{}" reverts to the remembered quote', () => {
  assert.equal(revert('a = `hi $|{} x`;', 'a = `hi $| x`;', "'").out, "a = 'hi $ x';");
  assert.equal(revert('a = `hi $|{} x`;', 'a = `hi $| x`;', '"').out, 'a = "hi $ x";');
});

test('deleting the "$" reverts too', () => {
  assert.equal(revert('a = `hi |${x} y`;', 'a = `hi |{x} y`;', '"').out, 'a = "hi {x} y";');
});

test('deleting a whole "${x}" reverts', () => {
  assert.equal(revert('a = `|${x} y`;', 'a = `| y`;', '"').out, 'a = " y";');
});

test('revert unescapes backticks and escapes the quote', () => {
  assert.equal(revert('a = `\\`x\\` "y" \'z\' $|{} w`;', 'a = `\\`x\\` "y" \'z\' $| w`;', '"').out, 'a = "`x` \\"y\\" \'z\' $ w";');
});

test('revert picks the other quote when that avoids escaping', () => {
  assert.equal(revert('a = `say "hi" $|{} x`;', 'a = `say "hi" $| x`;', '"').out, "a = 'say \"hi\" $ x';");
});

test('no revert when the cursor touches the closing backtick', () => {
  assert.equal(revert('a = `hi $|{}`;', 'a = `hi $|`;', '"').reason, 'cursor touches the closing backtick');
  assert.equal(revert('a = `hi $|{`;', 'a = `hi $|`;', '"').reason, 'cursor touches the closing backtick');
});

test('no revert while another ${ remains', () => {
  assert.equal(revert('a = `${x} $|{} y`;', 'a = `${x} $| y`;', '"').reason, 'not inside a template literal without "${"');
});

test('no revert for templates that never had ${, multi-line or tagged ones', () => {
  assert.equal(revert('a = `hi|x y`;', 'a = `hi| y`;', '"').reason, 'template had no "${" before the change');
  assert.equal(revert('a = `hi\n$|{} y`;', 'a = `hi\n$| y`;', '"').reason, 'template spans lines');
  assert.equal(revert('a = html`hi $|{} y`;', 'a = html`hi $| y`;', '"').reason, 'tagged template');
});

test('no revert for changes outside any template', () => {
  assert.equal(revert('a = 1|2; b = `x`;', 'a = 1|; b = `x`;', '"').reason, 'not inside a template literal without "${"');
  assert.equal(revert('|${x}', '|', '"').reason, 'not inside a template literal without "${"');
});

test('the parse cache keeps only the most recently used documents', () => {
  const cache = createParseCache(2);
  cache.parse('a', 'let a;', 'typescript');
  cache.parse('b', 'let b;', 'typescript');
  cache.parse('a', 'let a2;', 'typescript');
  cache.parse('c', 'let c;', 'typescript');
  assert.deepEqual(['a', 'b', 'c'].map((key) => cache.has(key)), [true, false, true]);
  cache.delete('a');
  assert.equal(cache.has('a'), false);
});

// Random edits to a file that mixes every construct the converter cares about.
// After each edit, every "${" in the text must get the same answer from an
// incrementally updated parse as from a fresh one.
test('incremental parses give the same answers as fresh parses', () => {
  const pieces = ['${', '${}', '{', '}', '"', "'", '`', '\n', 'x', ' ', '/', '//', '/*', '*/', '<p>', '</p>', '(', ')', '\\'];
  let seed = 12345;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >>> 12) % n; // the low bits of this generator repeat quickly
  };
  let text = [
    'import a from "./mod";',
    'const s = "one ", t = \'two \', u = `three ${s} four`;',
    'const o = { "key": "value ", plain: \'x\' };',
    '// a "comment" with ${',
    'const r = /"re${/.test(s) ? "yes " : `no ${t}`;',
    'export const V = () => <p title="attr ">{"child "} text\'s</p>;',
    'function f() { "use strict"; return s + t; }',
    '',
  ].join('\n');

  const cache = createParseCache();
  const cached = (source, languageId) => cache.parse('doc', source, languageId);
  let compared = 0;
  for (let step = 0; step < 400; step++) {
    const at = random(text.length + 1);
    text = random(4) === 0
      ? text.slice(0, at) + text.slice(at + 1 + random(3))
      : text.slice(0, at) + pieces[random(pieces.length)] + text.slice(at);

    for (let i = text.indexOf('${'); i !== -1; i = text.indexOf('${', i + 1)) {
      const fresh = convertToTemplate(text, i + 2, 'typescriptreact');
      assert.deepEqual(convertToTemplate(text, i + 2, 'typescriptreact', cached), fresh, `step ${step}, offset ${i + 2}`);
      compared++;
    }
  }
  assert.ok(compared > 1000, `only ${compared} comparisons ran`);
});
