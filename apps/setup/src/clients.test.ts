import { describe, expect, it } from 'vitest';
import { connectionInstructions } from './clients.js';

const SERVER = '/opt/hq-mcp/apps/stdio/dist/index.js';

describe('connectionInstructions', () => {
  it('fills the real absolute path into all three clients', () => {
    const text = connectionInstructions({ serverPath: SERVER, built: true }).join('\n');

    expect(text).toContain(`claude mcp add hq -s user -- node ${SERVER}`);
    expect(text).toContain('[mcp_servers.hq]');
    expect(text).toContain(`args = ["${SERVER}"]`);
    expect(text).toContain(`"command": ["node", "${SERVER}"]`);
    expect(text).toContain('~/.codex/config.toml');
    expect(text).toContain('~/.config/opencode/opencode.jsonc');
    // Ни один путь не остался шаблоном.
    expect(text).not.toContain('/absolute/path');
  });

  it('says it applies nothing itself', () => {
    const text = connectionInstructions({ serverPath: SERVER, built: true }).join('\n');
    expect(text).toContain('paste it yourself');
  });

  it('warns when the server has not been built, since every command would fail silently', () => {
    const text = connectionInstructions({ serverPath: SERVER, built: false }).join('\n');

    expect(text).toContain('does not exist yet');
    expect(text).toContain('pnpm build');
    // И почему это важно: клиент показывает «connection closed» без причины.
    expect(text).toContain('connection closed');
  });

  it('says nothing about a missing build when it is there', () => {
    const text = connectionInstructions({ serverPath: SERVER, built: true }).join('\n');
    expect(text).not.toContain('does not exist yet');
  });
});
