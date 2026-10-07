import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const version = valueAfter('--version') || process.env.PLUGIN_VERSION;
const target = valueAfter('--target') || 'marketplace';
const mcpUrl = process.env.BROWSER_SCREENSHOT_MCP_URL || 'https://browser-screenshot.apphome.one/mcp';
const allowedTargets = new Set(['marketplace', 'desktop']);

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`PLUGIN_VERSION must be a strict semantic version, got: ${version ?? '<missing>'}`);
}
if (!allowedTargets.has(target)) throw new Error('Specify --target marketplace or --target desktop');

const parsedUrl = new URL(mcpUrl);
if (parsedUrl.protocol !== 'https:' || parsedUrl.pathname !== '/mcp') {
  throw new Error('BROWSER_SCREENSHOT_MCP_URL must be an HTTPS /mcp endpoint');
}

const outputRoot = resolve(process.env.PLUGIN_OUTPUT_DIR || `build/plugin-${target}`);
const outputDir = resolve(outputRoot, 'browser-screenshot');
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const pluginTemplate = await readFile('plugin/plugin.template.json', 'utf8');
const manifest = JSON.parse(pluginTemplate.replaceAll('__PLUGIN_VERSION__', version));
if (manifest.name !== 'browser-screenshot' || manifest.version !== version) throw new Error('Plugin manifest identity/version validation failed');
if ((manifest.extensions?.['com.openai']?.interface?.shortDescription?.length ?? 0) > 30) throw new Error('OpenAI shortDescription must be at most 30 characters');
if (manifest.apps != null || manifest.extensions?.['com.openai']?.apps != null) throw new Error('Public plugin package must not declare an app binding');

for (const field of ['displayName','shortDescription','longDescription','developerName','category','defaultPrompt','websiteURL','supportURL','privacyPolicyURL','termsOfServiceURL','logo','composerIcon']) {
  if (manifest.extensions?.['com.openai']?.interface?.[field] == null) throw new Error(`Marketplace listing field is missing: ${field}`);
}

const mcpTemplate = await readFile('plugin/mcp.template.json', 'utf8');
const mcpJson = mcpTemplate.replaceAll('__BROWSER_SCREENSHOT_MCP_URL__', mcpUrl);
const mcp = JSON.parse(mcpJson);
if (mcp.mcpServers?.['browser-screenshot']?.type !== 'streamable-http' || mcp.mcpServers?.['browser-screenshot']?.url !== mcpUrl) throw new Error('Generated MCP URL validation failed');

await writeFile(resolve(outputDir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(resolve(outputDir, 'mcp.json'), mcpJson);
await cp('plugin/skills', resolve(outputDir, 'skills'), { recursive: true });
await cp('plugin/assets', resolve(outputDir, 'assets'), { recursive: true });

console.log(`Generated ${target} plugin package directory: ${outputDir}`);
console.log(`Plugin version: ${version}`);
console.log(`MCP endpoint: ${mcpUrl}`);
