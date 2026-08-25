import { createInterface } from 'node:readline';

export async function runNativeMcpStdio({
  input = process.stdin,
  output = process.stdout,
  server,
} = {}) {
  if (!server || typeof server.handle !== 'function') {
    throw new TypeError('runNativeMcpStdio requires a server');
  }
  const pending = new Set();
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); }
    catch {
      output.write(`${JSON.stringify({
        jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' },
      })}\n`);
      continue;
    }
    const operation = Promise.resolve(server.handle(message))
      .then((response) => {
        if (response) output.write(`${JSON.stringify(response)}\n`);
      })
      .catch(() => {
        if (message.id !== undefined) {
          output.write(`${JSON.stringify({
            jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Internal error' },
          })}\n`);
        }
      })
      .finally(() => pending.delete(operation));
    pending.add(operation);
  }
  await Promise.all(pending);
}
