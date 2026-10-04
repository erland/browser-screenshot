import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const baseUrl = process.env.BASE_URL;
const token = process.env.MCP_ACCESS_TOKEN;
const publicUrl = process.env.PUBLIC_URL ?? 'https://example.com';
if (!baseUrl || !token) {
  console.error('BASE_URL and MCP_ACCESS_TOKEN are required');
  process.exit(2);
}

const endpoint = new URL('/mcp', baseUrl);
const transport = new StreamableHTTPClientTransport(endpoint, {
  fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${token}`);
    return fetch(new Request(request, { headers }));
  },
});
const client = new Client({ name: 'browser-screenshot-acceptance', version: '1.0.0' });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  if (!listed.tools.some((tool) => tool.name === 'screenshot_create')) {
    throw new Error('screenshot_create is not advertised');
  }
  if (listed.tools.some((tool) => /click|type|script|navigate/i.test(tool.name))) {
    throw new Error('unexpected general browser-control tool advertised');
  }

  const result = await client.callTool({
    name: 'screenshot_create',
    arguments: { url: publicUrl, preset: 'mobile', fullPage: false },
  });
  if (result.isError) throw new Error(`screenshot_create returned an error: ${JSON.stringify(result.content)}`);
  const image = result.content?.find((item) => item.type === 'image');
  if (!image || image.mimeType !== 'image/png' || !image.data?.startsWith('iVBORw0KGgo')) {
    throw new Error('MCP result did not contain a valid PNG image');
  }
  const structured = result.structuredContent ?? {};
  if (structured.viewportWidth !== 390 || structured.viewportHeight !== 844 || structured.deviceScaleFactor !== 2) {
    throw new Error(`unexpected MCP mobile metadata: ${JSON.stringify(structured)}`);
  }
  console.log('mcp-acceptance: PASS');
} finally {
  await client.close().catch(() => undefined);
}
