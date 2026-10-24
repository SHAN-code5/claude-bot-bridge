# Changelog

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0

- Desktop Extension manifest and `pack` command (`.mcpb`).
- `init` writes the Claude Desktop config on macOS, Windows, and Linux.
- `doctor` pings each webhook.
- `http` Streamable HTTP transport, with origin checks and a required token off localhost.
- `dashboard` for threads and messages.
- `tunnel` prints a cloudflared URL for the inbox.
- Reply SSE streams, conditional GET (`ETag` / 304), broadcast, and a bounded bot-to-bot relay with `stop_relay`.
- MCP resources for bots and threads, and logging notifications when a reply arrives.
- HMAC signing, host allowlists, per-bot rate limits, and retries on 429 and 5xx.
- Dockerfile and a tag-triggered release workflow.

## 0.1.0

- First public MCP server: stdio tools, sync replies, reply URL polling, local inbox, and `wait_for_reply`.
