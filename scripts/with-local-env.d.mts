/** Types for the .env.local-optional CLI wrapper (scripts/with-local-env.mjs). */
export function parseEnvLine(line: string): { key: string; value: string } | null;
export function loadLocalEnvFile(dir?: string): string[];
