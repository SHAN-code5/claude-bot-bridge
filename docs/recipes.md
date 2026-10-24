# Recipes

Every recipe ends at the same bridge. The bot receives:

```json
{
  "from": "Claude Desktop",
  "message": "the text",
  "context": "",
  "sentAt": "2026-10-24T05:30:00.000Z",
  "threadId": "thr_ab12",
  "messageId": "msg_cd34",
  "bot": "assistant",
  "replyChannels": []
}
```

`doctor: true` means the call came from `claude-bot-bridge doctor`. Ignore those if you do not want health checks in the transcript.

Treat `message` and `context` as untrusted. Check the `Authorization` header, or the HMAC headers when `BOT_SIGNING_SECRET` is set, before you do anything with the body.

## Webhook that answers immediately

```javascript
const http = require('node:http');

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if ((req.headers.authorization || '') !== `Bearer ${process.env.WEBHOOK_KEY}`) {
      res.writeHead(401).end();
      return;
    }
    const body = JSON.parse(raw || '{}');
    if (body.doctor) {
      res.writeHead(204).end();
      return;
    }
    const reply = JSON.stringify({ reply: `You said: ${body.message}`, threadId: body.threadId });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(reply);
  });
}).listen(8788);
```

Point the bridge at `http://127.0.0.1:8788/` with the same key. `node examples/echo-bot.js` is the same idea with sync, poll, and inbox modes.

## Reply URL

Have the bot append to a JSON file or object your server can GET:

```json
{ "replies": [{ "id": "1", "threadId": "thr_ab12", "message": "done", "at": "2026-10-24T05:40:00.000Z" }] }
```

Set `BOT_REPLY_URL` to that GET. Send `ETag` if you can. A `304` means "nothing new". A plain text body is one shared reply with no thread id.

## SSE, no public callback

The bot hosts the stream. The bridge connects to it.

```
event: reply
data: {"id":"1","threadId":"thr_ab12","message":"done"}

```

```bash
BOT_REPLY_SSE_URL=https://bot.example/events node bin/claude-bot-bridge.js
```

Claude gets a logging notification when an event arrives. It still will not speak until the user prompts it. Call `get_replies` or read `bridge://thread/thr_ab12`.

## n8n or Zapier

1. Create a webhook trigger.
2. Map the JSON field `message` into the workflow.
3. Respond with `{ "reply": "<result>", "threadId": "<threadId from the body>" }`.
4. Put the webhook URL in `BOT_WEBHOOK_URL` and a long random value in `BOT_WEBHOOK_KEY`. Check that header in the workflow before the rest of the nodes run.

If the workflow is slow, respond `202` with `{ "ok": true }` and write the result to a reply URL the bridge polls.

## Discord or Telegram style

Your bot code already receives platform events. Add one HTTP route that accepts the bridge payload and calls the same function you use for a chat message. Post the answer back as `{ "reply": "..." }` or to the inbox URL in `replyChannels` when you have set `BOT_INBOX_PUBLIC_URL`.

For a platform that only knows how to POST outward, the inbox plus `claude-bot-bridge tunnel` is the return path. Set `BOT_INBOX_TOKEN` first.

## Two bots talking

Configure both webhooks, then ask Claude to call `relay_conversation` with `fromBot`, `toBot`, `message`, and `maxTurns`. Call `stop_relay` to end it after the current turn. The transcript is on `bridge://thread/<id>`.

## Grok-style routine

A bot that only has a webhook and writes answers to a shared document is the original case. Put the document's raw URL in `BOT_REPLY_URL`. `get_replies` reads what is there now. `wait_for_reply` ignores text that was already on the URL when the wait started, so an old note is not treated as a fresh answer.
