/**
 * Готовые команды подключения — ПЕЧАТАЮТСЯ, а не применяются.
 *
 * Конфиги клиентов (`~/.codex/config.toml`, `~/.config/opencode/opencode.jsonc`)
 * — это рабочие файлы человека, в которых уже живут другие серверы, свои
 * комментарии и своё форматирование. Установщик, который правит их сам, в
 * лучшем случае переставит запятые, в худшем — сломает JSONC, и человек
 * останется без всех своих инструментов из-за нашего мастера. Разница в
 * стоимости ошибки несимметрична: вставить строку самому — тридцать секунд,
 * чинить снесённый конфиг — вечер.
 */

export interface ConnectionOptions {
  /** Абсолютный путь до собранного бинарника stdio-сервера. */
  readonly serverPath: string;
  /** Существует ли он уже. Нет — значит, `pnpm build` ещё не запускали. */
  readonly built: boolean;
}

export function connectionInstructions(opts: ConnectionOptions): string[] {
  const lines: string[] = [];
  const push = (...items: string[]): void => {
    lines.push(...items);
  };

  push('Connect a client to it. Nothing below is applied for you — paste it yourself.');
  if (!opts.built) {
    push(
      '',
      `NOTE: ${opts.serverPath} does not exist yet. Run \`pnpm build\` first, or every`,
      '      client below will fail with "connection closed" and no explanation.',
    );
  }

  push(
    '',
    'Claude Code — one command, no file to edit:',
    '',
    `  claude mcp add hq -s user -- node ${opts.serverPath}`,
    '',
    'Codex — add this section to ~/.codex/config.toml:',
    '',
    '  [mcp_servers.hq]',
    '  command = "node"',
    `  args = ["${opts.serverPath}"]`,
    '',
    'opencode — add this entry to the "mcp" object in ~/.config/opencode/opencode.jsonc:',
    '',
    '  "hq": {',
    '    "type": "local",',
    `    "command": ["node", "${opts.serverPath}"],`,
    '    "enabled": true,',
    '    "timeout": 60000',
    '  }',
    '',
    'The server reads its credentials from the .env written above, so no client',
    'config needs to carry them — one file with mode 0600 instead of three copies',
    'in files nobody treats as secret.',
    '',
    'Then ask the agent to call `platform_probe` first: it reports what the two',
    'backends actually are right now, which is the only thing that proves the',
    'whole chain works end to end.',
  );
  return lines;
}
