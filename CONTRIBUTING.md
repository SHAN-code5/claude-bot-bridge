# Contributing

Thanks for looking at claude-bot-bridge. The useful changes are small and specific: a reply shape that a real bot sends, a clearer error, or a test that would have caught a bug.

## Setup

Install Node.js 18 or newer. There are no runtime dependencies.

```bash
git clone https://github.com/SHAN-code5/claude-bot-bridge.git
cd claude-bot-bridge
npm test
```

`npm test` runs `node --test`. CI runs that on Node 18, 20, and 22.

To try the server against the example bot:

```bash
ECHO_MODE=sync node examples/echo-bot.js
```

In another terminal:

```bash
BOT_WEBHOOK_URL=http://127.0.0.1:8788/webhook \
BOT_WEBHOOK_KEY=dev-secret \
node bin/claude-bot-bridge.js
```

Paste one JSON object per line. A minimal handshake is in the README.

## What to know before editing

- Stdout is the MCP protocol. Logs, errors, and help text that the server prints while it is running go to stderr. A stray `console.log` in the server breaks every client.
- `--help` and `--version` are the exceptions: they print to stdout and exit before the protocol starts.
- Never log a webhook key, an inbox token, or an `Authorization` header. `src/redact.js` is the last line of defense. Add a test if you find a new place a secret could leak.
- Config errors should say what to set and must not repeat the secret. See `test/config.test.js`.
- The model can only reach URLs from the config. Do not add a tool argument that takes an arbitrary URL.
- Reply-URL text that is already present when `wait_for_reply` starts is a snapshot, not a new reply. `get_replies` is how you read what is already there. If you change that, update the tool description and the README together. The model sees the description.

## Tests

Put tests next to the behavior:

- config parsing and validation in `test/config.test.js`
- reply body shapes in `test/parse.test.js`
- the stdio handshake in `test/stdio.test.js`
- webhook, poll, and inbox behavior in `test/tools.test.js`

Prefer a local HTTP server on `127.0.0.1` and port `0` over mocking `fetch`, so redirects, headers, and status codes are real.

## Pull requests

- Keep the diff focused.
- Do not commit real webhook keys, inbox tokens, or a filled-in `claude-bot-bridge.config.json`. The example file uses `${ENV}` placeholders on purpose.
- Say how you ran `npm test` and, if you changed the protocol or the tools, how you checked `initialize`, `tools/list`, and `tools/call`.

## Publishing

The npm package name is `claude-bot-bridge` and the bin is `claude-bot-bridge`. After a maintainer publishes it, `npx -y claude-bot-bridge` works. Until then, `npx -y github:SHAN-code5/claude-bot-bridge` and `node bin/claude-bot-bridge.js` are the install paths.
