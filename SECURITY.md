# Security

claude-bot-bridge forwards text between an MCP client and HTTP bots you configure. It is not a sandbox. The process runs as the user who launched it.

## Threat model

What we try to hold:

- The webhook secret, inbox token, HMAC secret, and HTTP token do not show up in logs, tool errors, or the dashboard.
- The model cannot choose an arbitrary URL. It can only name a bot id from the config.
- Redirects are not followed, so a secret header is not sent to a second host.
- A webhook or reply body over 1 MiB is rejected.
- The inbox binds to loopback unless you change the host. A public bind without a token is called out in the log.
- Streamable HTTP binds to loopback unless `MCP_HTTP_TOKEN` is set, and it rejects browser `Origin` values that are not localhost or on `MCP_ALLOWED_ORIGINS`.
- The dashboard binds to loopback only. Other accounts on the same machine can still open it.
- Do not pass `--key` on the command line if you can avoid it. It shows up in the process list. Use `BOT_WEBHOOK_KEY`.
- A blank optional field in the Desktop Extension is ignored, including a leftover `${user_config....}` value. An empty webhook key means the bot is called with no auth header.
- `list_bots` and webhook errors omit URL query strings, so a token in a query is not copied into the chat.
- `stop_relay` only interrupts a relay that is already running. It does not cancel a later `wait_for_reply`.
- Optional `BOT_ALLOWED_HOSTS` refuses webhook, poll, and SSE URLs whose host is not on the list.
- Optional HMAC (`BOT_SIGNING_SECRET`, `BOT_INBOX_SIGNING_SECRET`) covers the raw body plus a timestamp. The inbox rejects a timestamp more than five minutes off.
- Saved reply files are mode `0600`.

What this does not do:

- It does not stop a user who can prompt the MCP client from sending messages and spending the bot's quota.
- It does not stop the bot from treating `message` as instructions. The bot must do that itself. Incoming text is untrusted.
- It does not hide the webhook URL from the model. The host is visible in `list_bots` and resources. Query strings are not printed on the dashboard.
- It does not encrypt traffic. Use `https` for anything that leaves the machine.
- A tunnel (`claude-bot-bridge tunnel`) publishes the inbox. Set `BOT_INBOX_TOKEN` and a signing secret before you do that.
- SSE and long polls are outbound connections to a URL you configured. A hostile URL can hold the connection open until the process stops. A 401, 403, or redirect stops the reconnect loop.

## HMAC

```
X-Bridge-Timestamp: <unix milliseconds>
X-Bridge-Signature: sha256=<hex HMAC-SHA256 of `${timestamp}.${rawBody}`>
```

The bot should compute the same MAC over the raw body and reject skew or a mismatch. Compare with a constant-time function.

## Reporting

Open a GitHub issue for a bug that does not include a live secret. If the report itself would reveal a secret or an unfixed remote exploit, contact the maintainer through the repository instead of pasting the secret into the issue.
