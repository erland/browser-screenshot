#!/usr/bin/env node
/**
 * BS-SKILL-003: verify the authenticated *deployed* MCP Skills extension.
 *
 * Usage:
 *   BROWSER_SCREENSHOT_MCP_TOKEN=<OAuth access token> \
 *     node scripts/verify-remote-skills.mjs
 *
 * Never prints or persists access tokens. It requires a valid, already-issued
 * OAuth token; it does not bypass the existing MCP authentication boundary.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const endpoint = process.env.BROWSER_SCREENSHOT_MCP_URL ??
  'https://browser-screenshot.apphome.one/mcp';
const token = process.env.BROWSER_SCREENSHOT_MCP_TOKEN;
if (!token || !token.trim()) {
  throw new Error('BROWSER_SCREENSHOT_MCP_TOKEN is required (valid OAuth bearer access token)');
}
const url = new URL(endpoint);
if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.username || url.password) {
  throw new Error('MCP endpoint must be an HTTPS URL ending in /mcp without credentials');
}

let nextId = 0;
async function rpc(method, params = {}) {
  const id = ++nextId;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + token,
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error('MCP ' + method + ' HTTP ' + response.status +
        (response.status === 401 ? ' (OAuth authentication required)' : ''));
    }
    const raw = await response.text();
    const items = response.headers.get('content-type')?.includes('text/event-stream')
      ? raw.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim()).filter(line => line.startsWith('{'))
      : [raw];
    const message = items.map(value => {
      try { return JSON.parse(value); } catch { return null; }
    }).find(value => value && value.id === id);
    if (!message) throw new Error('MCP ' + method + ' returned no matching JSON-RPC result');
    if (message.error) {
      throw new Error('MCP ' + method + ' error ' + message.error.code +
        ': ' + message.error.message);
    }
    return message.result;
  } finally {
    clearTimeout(timeout);
  }
}

const initial = await rpc('initialize', {
  protocolVersion: '2026-07-28',
  capabilities: {},
  clientInfo: { name: 'browser-screenshot-skills-acceptance', version: '1.0.0' },
});
if (!initial?.serverInfo) throw new Error('MCP initialize returned no serverInfo');

const discovered = await rpc('server/discover');
const capabilities = discovered?.capabilities;
if (!capabilities?.extensions ||
    !Object.hasOwn(capabilities.extensions, 'io.modelcontextprotocol/skills')) {
  throw new Error('Deployed server did not advertise io.modelcontextprotocol/skills');
}
if (!capabilities.resources) {
  throw new Error('Skills extension requires resources capability');
}
const list = await rpc('skills/list');
if (list?.resultType !== 'complete' || !Array.isArray(list.skills)) {
  throw new Error('Deployed skills/list did not return a complete list');
}
const expectedNames = (await readdir('plugin/skills', { withFileTypes: true }))
  .filter(item => item.isDirectory()).map(item => item.name).sort();
const expected = [
  'browser-interactive-test', 'browser-pwa-offline-test',
  'browser-release-verification', 'browser-screenshot',
];
if (JSON.stringify(expectedNames) !== JSON.stringify(expected.sort())) {
  throw new Error('Unexpected local skill catalog; inspect plugin/skills before running acceptance');
}
const names = list.skills.map(item => item.frontmatter?.name).sort();
if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
  throw new Error('Remote catalog differs from plugin/skills: ' + JSON.stringify(names));
}
for (const name of expectedNames) {
  const uri = 'skill://' + name + '/SKILL.md';
  const item = list.skills.find(skill => skill.uri === uri);
  if (!item || item.frontmatter?.name !== name || !item.frontmatter?.description) {
    throw new Error('Missing skill entry or frontmatter: ' + name);
  }
  const lookup = await rpc('skills/get', { uri });
  if (JSON.stringify(lookup?.skill) !== JSON.stringify(item)) {
    throw new Error('skills/get did not match skills/list for ' + name);
  }
  if (item.resources?.length !== 1 || item.resources[0].uri !== uri) {
    throw new Error('Incomplete skill resource manifest: ' + name);
  }
  const resource = await rpc('resources/read', { uri });
  const text = resource?.contents?.find(entry => entry.uri === uri)?.text;
  if (typeof text !== 'string') throw new Error('Unreadable skill resource: ' + name);
  const remoteBytes = Buffer.from(text, 'utf8');
  const remoteDigest = 'sha256:' + createHash('sha256').update(remoteBytes).digest('hex');
  const manifest = item.resources[0];
  if (manifest.size !== remoteBytes.byteLength || manifest.digest !== remoteDigest) {
    throw new Error('Remote skill resource does not match its published digest: ' + name);
  }
  const localBytes = await readFile(join('plugin/skills', name, 'SKILL.md'));
  if (!localBytes.equals(remoteBytes)) {
    throw new Error('Deployed skill differs from local repository contents: ' + name);
  }
  process.stdout.write('PASS ' + name + ' (' + remoteBytes.byteLength + ' bytes)\n');
}
process.stdout.write('BS_SKILL_003: PASS (remote authenticated discovery, manifest, resources, source parity)\n');
