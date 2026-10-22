export function inlineScriptHashes(html: string): string[];
export function buildCsp(input: { html: string; supabaseUrl: string | undefined; sentryDsn?: string | undefined }): string;
export function nginxSnippet(csp: string): string;
export function sentrySecurityEndpoint(dsn: string | undefined): string | null;
