#!/usr/bin/env node
// 测试用的极简 MCP stdio 服务器（JSON-RPC 2.0，行分隔）。
// 提供一个工具 echo：把 text 参数原样返回。
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '1.0' } } });
  } else if (msg.method === 'notifications/initialized') {
    // no reply
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: '回显输入的文本',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
        ],
      },
    });
  } else if (msg.method === 'tools/call') {
    const text = msg.params?.arguments?.text ?? '';
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo:${text}` }] } });
  } else if (typeof msg.id === 'number') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
