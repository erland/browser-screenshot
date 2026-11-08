import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

interface SkillEntry {
  uri: string;
  frontmatter: { name: string; description: string };
  resources: Array<{ uri: string; digest: string; size: number }>;
}
interface LoadedSkill { entry: SkillEntry; content: string }

/**
 * One canonical source for plugin packaging and MCP publication. The directory
 * lives in the repository at development time and is explicitly copied into
 * the container at runtime. A bad/missing catalog fails startup rather than
 * silently publishing a partial, unverifiable skills index.
 */
const SKILLS_ROOT = fileURLToPath(new URL('../../../plugin/skills/', import.meta.url));

async function loadSkills(): Promise<readonly LoadedSkill[]> {
  const directories = (await readdir(SKILLS_ROOT, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const loaded: LoadedSkill[] = [];
  for (const folder of directories) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(folder)) {
      throw new Error('Invalid packaged skill directory name: ' + folder);
    }
    const names = await readdir(join(SKILLS_ROOT, folder));
    // No implicit supporting resources: every published skill currently consists
    // of exactly one SKILL.md. Fail closed if references are added later without
    // extending the manifest and resource coverage.
    if (names.length !== 1 || names[0] !== 'SKILL.md') {
      throw new Error('Skill requires an explicit resource manifest: ' + folder);
    }
    const raw = await readFile(join(SKILLS_ROOT, folder, 'SKILL.md'));
    if (raw.byteLength > 1024 * 1024) throw new Error('Skill file too large: ' + folder);
    const content = raw.toString('utf8');
    const frontmatter = content.match(/^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n/);
    if (!frontmatter || frontmatter[1] !== folder || !frontmatter[2]?.trim()) {
      throw new Error('Skill frontmatter does not match directory: ' + folder);
    }
    const uri = 'skill://' + folder + '/SKILL.md';
    loaded.push({
      content,
      entry: {
        uri,
        frontmatter: { name: frontmatter[1], description: frontmatter[2] },
        resources: [{
          uri,
          digest: 'sha256:' + createHash('sha256').update(raw).digest('hex'),
          size: raw.byteLength,
        }],
      },
    });
  }
  if (loaded.length !== 4) throw new Error('Browser Screenshot requires exactly four packaged skills.');
  return loaded;
}

const catalog = await loadSkills();

/**
 * SEP-2640 MCP Skills extension on the existing pinned MCP SDK 2.3.x.
 * Implements the two required skill methods through the low-level protocol
 * handler plus ordinary resources/read, without an experimental SDK upgrade.
 * No directoryRead capability is advertised because files are singletons.
 */
export function registerBrowserSkills(server: McpServer): void {
  const byUri = new Map(catalog.map(skill => [skill.entry.uri, skill]));
  for (const skill of catalog) {
    server.registerResource(
      skill.entry.frontmatter.name,
      skill.entry.uri,
      { mimeType: 'text/markdown', description: skill.entry.frontmatter.description },
      async () => ({
        contents: [{
          uri: skill.entry.uri,
          mimeType: 'text/markdown',
          text: skill.content,
        }],
      }),
    );
  }

  server.server.setRequestHandler(
    'skills/list',
    { params: z.object({ cursor: z.string().optional() }).passthrough() },
    async ({ cursor }) => {
      if (cursor) throw new Error('Invalid skills/list cursor');
      return {
        resultType: 'complete' as const,
        skills: catalog.map(item => item.entry),
        ttlMs: 300_000,
        cacheScope: 'public' as const,
      };
    },
  );
  server.server.setRequestHandler(
    'skills/get',
    { params: z.object({ uri: z.string().max(256) }).passthrough() },
    async ({ uri }) => {
      const skill = byUri.get(uri);
      if (!skill) throw new Error('Unknown skill: ' + uri);
      return {
        resultType: 'complete' as const,
        skill: skill.entry,
        ttlMs: 300_000,
        cacheScope: 'public' as const,
      };
    },
  );

  server.server.registerCapabilities({
    extensions: { 'io.modelcontextprotocol/skills': {} },
  } as Parameters<typeof server.server.registerCapabilities>[0]);
}
