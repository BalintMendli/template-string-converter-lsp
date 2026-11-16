# template-string-converter-language-server

Language server that turns the quotes of a JavaScript or TypeScript string into
backticks when `${` is typed inside it.

It is the server behind the
[Template String Converter extension for Zed](https://github.com/BalintMendli/template-string-converter-lsp),
which installs and starts it for you. See that repository for behaviour,
settings and development notes.

## Running it directly

```sh
npx template-string-converter-language-server --stdio
```

The server speaks LSP over stdio. It registers `{` as an on-type formatting
trigger and may send `workspace/applyEdit` requests, so the client needs to
support both.

## Licence

MIT
