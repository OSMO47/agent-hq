/** Model ids: Claude aliases (opus|sonnet|haiku) or "<cli>:<model>" for other vendors' CLIs: codex:gpt-5, gemini:gemini-2.5-pro. */
export const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'];
export type ExternalCli = 'codex' | 'gemini';

export function parseExternalModel(model: string): { cli: ExternalCli; id: string } | null {
  const m = /^(codex|gemini):([A-Za-z0-9._\-]{1,80})$/.exec(model);
  return m ? { cli: m[1] as ExternalCli, id: m[2] } : null;
}

export const isKnownModel = (model: unknown): model is string =>
  typeof model === 'string' && (CLAUDE_ALIASES.includes(model) || parseExternalModel(model) !== null);
