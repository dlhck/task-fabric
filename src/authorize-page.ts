export interface AuthorizePageParams {
  clientName: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope: string;
  resource: string;
}

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderAuthorizePage(params: AuthorizePageParams): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize - Task Fabric</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 2rem; max-width: 420px; width: 100%; }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; color: #fff; }
    .client { color: #8b8b8b; font-size: 0.9rem; margin-bottom: 1.5rem; }
    .client strong { color: #c0c0c0; }
    label { display: block; font-size: 0.85rem; color: #aaa; margin-bottom: 0.35rem; }
    input[type="password"] { width: 100%; padding: 0.6rem 0.75rem; background: #111; border: 1px solid #444; border-radius: 6px; color: #fff; font-size: 1rem; margin-bottom: 1.25rem; }
    input[type="password"]:focus { outline: none; border-color: #666; }
    .actions { display: flex; gap: 0.75rem; }
    button { flex: 1; padding: 0.6rem; border: none; border-radius: 6px; font-size: 0.95rem; cursor: pointer; font-weight: 500; }
    .approve { background: #2563eb; color: #fff; }
    .approve:hover { background: #1d4ed8; }
    .deny { background: #333; color: #ccc; }
    .deny:hover { background: #444; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize Access</h1>
    <p class="client"><strong>${esc(params.clientName)}</strong> wants to connect to Task Fabric.</p>
    <form method="POST" action="/authorize/decide">
      <input type="hidden" name="client_id" value="${esc(params.clientId)}">
      <input type="hidden" name="redirect_uri" value="${esc(params.redirectUri)}">
      <input type="hidden" name="state" value="${esc(params.state ?? "")}">
      <input type="hidden" name="code_challenge" value="${esc(params.codeChallenge)}">
      <input type="hidden" name="scope" value="${esc(params.scope)}">
      <input type="hidden" name="resource" value="${esc(params.resource)}">
      <label for="api_key">API Key</label>
      <input type="password" id="api_key" name="api_key" placeholder="Enter your API key" required autofocus>
      <div class="actions">
        <button type="submit" name="action" value="deny" class="deny">Deny</button>
        <button type="submit" name="action" value="approve" class="approve">Approve</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}
