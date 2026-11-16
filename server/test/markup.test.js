'use strict';

// Markup documents (HTML, Svelte, Vue): only <script> blocks are converted.

const test = require('node:test');
const assert = require('node:assert/strict');
const { convertToTemplate, revertToQuotes, scriptBlocks, createParseCache, applyEdits } = require('../src/convert');

// "|" marks the cursor: the position just after the typed "{".
function convert(marked, languageId, parseFile) {
  const offset = marked.indexOf('|');
  const text = marked.replace('|', '');
  const result = convertToTemplate(text, offset, languageId, parseFile);
  return { out: applyEdits(text, result.edits), reason: result.reason, start: result.start };
}

const contents = (text) => scriptBlocks(text).map((block) => [text.slice(block.start, block.end), block.languageId]);

test('script blocks: contents, language and numbering', () => {
  const text = [
    '<script context="module" lang="ts">let a: number;</script>',
    '<script>let b;</script>',
    '<p>markup</p>',
    '<script type="application/json">{"c": 1}</script>',
    '<SCRIPT TYPE="module">let d;</SCRIPT>',
  ].join('\n');
  assert.deepEqual(contents(text), [['let a: number;', 'typescript'], ['let b;', 'javascript'], ['let d;', 'javascript']]);
  // Numbering counts every script tag, so a block keeps its number when a
  // neighbour changes between code and data.
  assert.deepEqual(scriptBlocks(text).map((block) => block.slot), [0, 1, 3]);
});

test('script blocks: lang and type attributes', () => {
  const language = (tag) => scriptBlocks(`${tag}x</script>`)[0]?.languageId ?? null;
  assert.equal(language('<script>'), 'javascript');
  assert.equal(language('<script setup lang="ts">'), 'typescript');
  assert.equal(language("<script lang='tsx'>"), 'tsx');
  assert.equal(language('<script lang=jsx>'), 'jsx');
  assert.equal(language('<script lang="coffee">'), null);
  assert.equal(language('<script type="text/babel">'), 'jsx');
  assert.equal(language('<script type="text/typescript">'), 'typescript');
  assert.equal(language('<script type="importmap">'), null);
  assert.equal(language('<script type="text/x-template">'), null);
  assert.equal(language('<script type="">'), 'javascript');
  assert.equal(language('<script\n  lang="ts"\n  generics="T extends Record<string, unknown>"\n>'), 'typescript');
});

test('script blocks: comments, self-closing tags, unclosed blocks, look-alikes', () => {
  assert.deepEqual(contents('<!-- <script>no</script> --><script>yes</script>'), [['yes', 'javascript']]);
  assert.deepEqual(contents('<script src="a.js" /><script>b</script>'), [['b', 'javascript']]);
  assert.deepEqual(contents('<script>let a = "open'), [['let a = "open', 'javascript']]);
  assert.deepEqual(contents('<scripted>no</scripted><script-x>no</script-x>'), []);
  assert.deepEqual(contents('<script>const s = "</p>";</script>'), [['const s = "</p>";', 'javascript']]);
  assert.deepEqual(contents('<script'), []);
});

test('Svelte: converts inside <script>, in both blocks', () => {
  const file = (body) => `<script module lang="ts">\n  export const a = "x";\n</script>\n\n<script lang="ts">\n${body}\n</script>\n\n<h1 class="big">it's {name}</h1>\n`;
  assert.equal(convert(file('  let greeting: string = "hello ${|}";'), 'svelte').out, file('  let greeting: string = `hello ${}`;'));
  assert.equal(
    convert('<script module lang="ts">\n  export const a = "x ${|}";\n</script>\n<script>let b = "y";</script>', 'svelte').out,
    '<script module lang="ts">\n  export const a = `x ${}`;\n</script>\n<script>let b = "y";</script>',
  );
});

test('Svelte: runes, stores and reactive statements parse', () => {
  assert.equal(
    convert('<script>\n  let n = $state(0);\n  $: doubled = n * 2;\n  const t = $page.url + "x ${|}";\n</script>', 'svelte').out,
    '<script>\n  let n = $state(0);\n  $: doubled = n * 2;\n  const t = $page.url + `x ${}`;\n</script>',
  );
});

test('markup outside <script> is never converted', () => {
  for (const languageId of ['svelte', 'vue', 'html']) {
    assert.equal(convert('<script>let a;</script>\n<p title="a ${|}">x</p>', languageId).reason, 'not inside a script block', languageId);
    assert.equal(convert('<p>{cond ? "a ${|}" : "b"}</p>\n<script>let a;</script>', languageId).reason, 'not inside a script block', languageId);
    assert.equal(convert('<style>a::before { content: "a ${|}"; }</style>', languageId).reason, 'not inside a script block', languageId);
  }
});

test('data script blocks are never converted', () => {
  assert.equal(convert('<script type="application/ld+json">{ "a": "b ${|}" }</script>', 'html').reason, 'not inside a script block');
  assert.equal(convert('<script type="text/x-template"><p title="a ${|}"></p></script>', 'html').reason, 'not inside a script block');
});

test('Vue: <script setup lang="ts"> and plain <script>', () => {
  assert.equal(
    convert('<template>\n  <p :title="\'a\'">{{ msg }}</p>\n</template>\n\n<script setup lang="ts">\nconst msg: string = \'hi ${|}\';\n</script>\n', 'vue').out,
    '<template>\n  <p :title="\'a\'">{{ msg }}</p>\n</template>\n\n<script setup lang="ts">\nconst msg: string = `hi ${}`;\n</script>\n',
  );
  assert.equal(
    convert('<script>\nexport default { data: () => ({ msg: "hi ${|}" }) };\n</script>', 'vue').out,
    '<script>\nexport default { data: () => ({ msg: `hi ${}` }) };\n</script>',
  );
});

test('HTML: inline script, with markup before and after', () => {
  assert.equal(
    convert('<!doctype html>\n<body onload="go(\'x\')">\n<script>\n  const url = "/api/${|}";\n</script>\n<p>don\'t</p>\n</body>', 'html').out,
    '<!doctype html>\n<body onload="go(\'x\')">\n<script>\n  const url = `/api/${}`;\n</script>\n<p>don\'t</p>\n</body>',
  );
});

test('the same guards apply inside a script block', () => {
  const svelte = (body) => convert(`<script lang="ts">\n${body}\n</script>`, 'svelte');
  assert.equal(svelte('import a from "./a ${|}";').reason, 'template literal not allowed here (module specifier)');
  assert.equal(svelte('const o = { "k ${|}": 1 };').reason, 'template literal not allowed here (property name)');
  assert.equal(svelte('const t = `a ${|}`;').reason, 'already a template literal');
  assert.equal(svelte('// "a ${|}"').reason, 'not inside a string literal');
});

test('TypeScript-only syntax needs lang="ts"; a JavaScript block still finds its strings', () => {
  assert.equal(convert('<script lang="ts">const a = <string>"x ${|}";</script>', 'svelte').out, '<script lang="ts">const a = <string>`x ${}`;</script>');
  assert.equal(convert('<script>const a = "x ${|}";</script>', 'svelte').out, '<script>const a = `x ${}`;</script>');
});

test('a string cut off by </script> is not converted', () => {
  assert.equal(convert('<script>const a = "x ${|</script>', 'html').reason, 'string literal is not closed');
});

test('reported start is a document offset', () => {
  const marked = '<p>x</p>\n<script>const a = "x ${|}";</script>';
  assert.equal(convert(marked, 'svelte').start, marked.indexOf('"'));
});

test('unknown language ids are treated as markup', () => {
  assert.equal(convert('const a = "x ${|}";', 'astro').reason, 'not inside a script block');
  assert.equal(convert('<script>const a = "x ${|}";</script>', 'astro').out, '<script>const a = `x ${}`;</script>');
});

test('revert works inside a script block and nowhere else', () => {
  const revert = (oldMarked, newMarked) => {
    const offset = oldMarked.indexOf('|');
    const oldText = oldMarked.replace('|', '');
    const newText = newMarked.replace('|', '');
    const result = revertToQuotes(oldText, newText, offset, newText.length - oldText.length, 'svelte', "'");
    return { out: applyEdits(newText, result.edits), reason: result.reason };
  };
  assert.equal(
    revert('<p>a</p>\n<script>\n  let a = `hi $|{} x`;\n</script>', '<p>a</p>\n<script>\n  let a = `hi $| x`;\n</script>').out,
    "<p>a</p>\n<script>\n  let a = 'hi $ x';\n</script>",
  );
  assert.equal(revert('<p>`hi $|{} x`</p>', '<p>`hi $| x`</p>').reason, 'not inside a script block');
});

test('each script block has its own cached parse', () => {
  const cache = createParseCache();
  const parseFile = (text, languageId, slot = 0) => cache.parse(`doc#${slot}`, text, languageId);
  const file = '<script module>const a = "x ${|}";</script>\n<script lang="ts">const b: string = "y";</script>';
  assert.equal(convert(file, 'svelte', parseFile).out, '<script module>const a = `x ${}`;</script>\n<script lang="ts">const b: string = "y";</script>');
  const second = '<script module>const a = "x";</script>\n<script lang="ts">const b: string = "y ${|}";</script>';
  assert.equal(convert(second, 'svelte', parseFile).out, '<script module>const a = "x";</script>\n<script lang="ts">const b: string = `y ${}`;</script>');
  assert.deepEqual([cache.has('doc#0'), cache.has('doc#1')], [true, true]);
  cache.delete('doc');
  assert.deepEqual([cache.has('doc#0'), cache.has('doc#1')], [false, false]);
});
