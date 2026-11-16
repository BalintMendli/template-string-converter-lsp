# Template String Converter for Zed

Turns the quotes of a JavaScript or TypeScript string into backticks when you
type `${` inside it.

```ts
const greeting = "hello |";        // type ${
const greeting = `hello ${|`;      // quotes became backticks
```

It works in JavaScript, TypeScript and TSX files, with `'single'` and
`"double"` quotes. Backticks already inside the string are escaped.

This is an independent implementation for Zed of the idea behind the VS Code
extension [Template String Converter](https://github.com/meganrogge/template-string-converter)
by Megan Rogge. No code is shared with it.

## Installing

Until the extension is in Zed's registry, install it as a dev extension: clone
this repository, run `zed: install dev extension` and pick the folder. See
[Development](#development) for running the server from the checkout.

## What to expect

- **No closing brace when the cursor is right before the closing quote.** Zed
  does not auto-close `{` in front of a quote, so `"hello |"` becomes
  `` `hello ${|` `` and you type the `}` yourself. Anywhere else in the string
  you get `${|}` as usual.
- **Undo takes two steps.** The first undo turns the backticks back into
  quotes and keeps the `${`; the second removes the `${`.
- **Multiple cursors** all convert when every `{` was auto-closed. When none
  was (every cursor right before a closing quote), only the string at the
  newest cursor converts.
- **Typing very fast in a very large file** can, in principle, land a keystroke
  between Zed's request and the server's answer. The server answers within a
  few milliseconds to keep that window small.

Strings are left alone where a template literal would be a syntax error or
change meaning:

- JSX attribute values (`<a title="...">`)
- `import` / `export` paths, `declare module "..."` names and import attributes
- property names (`{ "key": 1 }`, class members, destructuring)
- enum member values
- directives such as `"use strict"`

## Settings

In Zed's `settings.json`:

```json
{
  "lsp": {
    "template-string-converter": {
      "settings": {
        "enabled": true,
        "convertVia": "hybrid",
        "autoRevert": false
      }
    }
  }
}
```

| Setting        | Default    | Meaning                                                                                                                                                                              |
| -------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`      | `true`     | Switch the conversion off without uninstalling.                                                                                                                                      |
| `convertVia`   | `"hybrid"` | How the edit reaches Zed, see [How it works](#how-it-works). `"onType"` and `"applyEdit"` each use one route only.                                                                   |
| `autoRevert`   | `false`    | Turn backticks back into quotes when the last `${` of a single-line template literal is deleted. Does nothing when the cursor touches the closing backtick.                           |
| `debugLogFile` | unset      | Path of a file to append every message the server handles to, including document text. For debugging only.                                                                            |

Changes apply without restarting the server. Zed's own `use_on_type_format`
setting (on by default) must stay on for the conversion right before a closing
quote.

## How it works

Zed extensions cannot listen to edits or change buffers, so the extension ships
a small language server and attaches it to the JavaScript and TypeScript
languages. The server reaches the buffer in two ways:

- **On-type formatting.** The server registers `{` as a trigger character. Zed
  asks it for edits after a `{` is typed, and pins the cursor while applying
  them. Zed only asks when it did not auto-close the brace.
- **`workspace/applyEdit`.** When Zed did auto-close the brace it does not ask,
  so the server sends the edit itself after seeing `{}` arrive in the document.

`"hybrid"` uses whichever of the two fits the keystroke. The server finds the
string with the TypeScript parser, so comments, regular expressions and JSX
text are never mistaken for strings.

## Development

```sh
cd server
npm install
npm test          # unit tests, plus protocol tests against src/ and dist/
npm run build     # bundles the server into dist/server.js
```

The extension normally installs the server from npm. To run the server from
this checkout instead, open the `playground/` folder in Zed: its
`.zed/settings.json` overrides the server command and writes a debug log to
`server/server.log`.

After changing the Rust code, use **Rebuild** on Zed's Extensions page. Zed
stops the server on a rebuild; run `editor: restart language server` to start
it again. After changing the server's JavaScript, restarting the language
server is enough.

The extension crate builds with:

```sh
cargo build --release --target wasm32-wasip2
```

## Releasing

1. Bump `version` in `server/package.json`, and in `extension.toml` and
   `Cargo.toml` when the extension itself changed.
2. Publish the server from `server/` with `npm publish` (remove
   `"private": true` first; it is there to prevent an accidental publish).
   The extension installs the newest published server version, so a
   server-only fix needs nothing more.
3. For an extension change, open a pull request against
   [zed-industries/extensions](https://github.com/zed-industries/extensions)
   that moves the submodule to the new commit and updates the version in
   `extensions.toml`. See Zed's
   [publishing guide](https://zed.dev/docs/extensions/publishing/overview).

## Licence

[MIT](LICENSE)
