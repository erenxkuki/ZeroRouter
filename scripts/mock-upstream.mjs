/**
 * Local mock OpenAI-compatible upstream for smoke/verification tests ONLY.
 * Serves non-streaming chat, SSE streaming chat, and a models listing on
 * http://127.0.0.1:18081/v1/...
 */
import http from 'node:http';

const PORT = 18081;
let requests = 0;

const server = http.createServer((req, res) => {
  requests += 1;
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-small-1', object: 'model', created: 1, owned_by: 'mock' }, { id: 'mock-small-2', object: 'model', created: 1, owned_by: 'mock' }] }));
      return;
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* ignore */
      }
      const prompt = JSON.stringify(parsed.messages ?? []);
      // Upstream 401 path
      if (req.headers.authorization !== 'Bearer mock-secret') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key', type: 'auth' } }));
        return;
      }
      // Mid-stream failure path
      if (prompt.includes('FORCE_UPSTREAM_FAIL')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] })}\n\n`);
        setTimeout(() => {
          res.write(`data: ${JSON.stringify({ error: { message: 'upstream exploded mid-stream', code: 500 } })}\n\n`);
          res.end();
        }, 30);
        return;
      }
      if (parsed.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const parts = ['Hello', ',', ' world', '!'];
        let i = 0;
        const emit = () => {
          if (i < parts.length) {
            res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: parts[i] }, finish_reason: null }] })}\n\n`);
            i += 1;
            setTimeout(emit, 10);
          } else {
            res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] , usage: null})}\n\n`);
            res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
        };
        emit();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      res.write(`"id":"chatcmpl-mock","object":"chat.completion","created":1234,"model":${JSON.stringify(parsed.model ?? 'mock-small-1')},`);
      res.write(`"choices":[{"index":0,"message":{"role":"assistant","content":"MOCK REPLY: ${parsed.messages?.[0]?.content ?? ''}"},"finish_reason":"stop"}],`);
      res.write(`"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}`);
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock upstream on http://127.0.0.1:${PORT}`));
console.log('mock pid', process.pid);
