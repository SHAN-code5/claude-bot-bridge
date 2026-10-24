# Changelog

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

Security:

- The inbox refuses requests that carry an `Origin` header and bodies that are not JSON, so a web page cannot inject a fake bot reply into a tokenless loopback inbox.
- The dashboard and the loopback HTTP transport reject a non-loopback `Host` header (DNS rebinding).
- Webhook POSTs are no longer retried after a timeout, a dropped connection, a `502`, or a `504`. Only `429`, `503`, and connection failures before sending are retried, so a slow bot does not get the same message three times.
- Per-bot signing secrets and `http --token` are redacted like the other secrets.

Fixes:

- The SSE client waits before every reconnect. A stream that closed at once was reconnected in a tight loop (over 1,500 requests a second). A response that is not `text/event-stream` now stops the client.
- `wait_for_reply` watches SSE replies. A bot with only an SSE URL used to return "nothing to watch" at once.
- `wait_for_reply` counts a threaded reply-URL answer that showed up after the send but before the wait started.
- `relay_conversation` no longer counts the other bot's late reply as the current speaker's turn.
- On stdio, `ping`, `tools/list`, and resource reads are answered while a tool call is running. A cancelled request that was still queued is dropped without leaking memory.
- The HTTP transport cancels a call on `notifications/cancelled`, on client disconnect, and on `DELETE`. Each session tracks its own delivered replies.
- The state file is written in batches instead of on every change, and the reply cap applies when it loads.
- `BOT_ALLOWED_HOSTS` ignores case.
- `init` reports a flag with no value instead of writing `true`, keeps `claude_desktop_config.json.bak`, and writes atomically. The other commands report missing flag values too, and `http --port` is validated.
- `doctor` opens each SSE stream instead of always reporting it as ok.
- The release workflow can publish to npm (the token check moved where the step's `if` can see it), and workflow actions are pinned to commit SHAs.

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
