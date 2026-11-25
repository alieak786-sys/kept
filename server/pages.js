// Small responsive pages for the pairing flow (no frameworks needed).

const STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0f1411; color: #e8f5e9; font-family: system-ui, Arial, sans-serif; padding: 16px; }
  main { width: 100%; max-width: 420px; background: #172019; border: 1px solid #2a3a2e;
         border-radius: 16px; padding: 28px 22px; text-align: center; }
  h1 { margin: 0 0 8px; font-size: 28px; color: #7CFC9A; }
  p { line-height: 1.5; margin: 10px 0; }
  .msg { background: #3a2a1a; border: 1px solid #7a5a2a; border-radius: 8px; padding: 10px; color: #ffd9a0; }
  .small { font-size: 13px; color: #9bb5a0; margin-top: 20px; }
  input { width: 100%; font-size: 28px; letter-spacing: 6px; text-align: center; text-transform: uppercase;
          padding: 12px; border-radius: 10px; border: 1px solid #2a3a2e; background: #0f1411; color: #e8f5e9; margin: 14px 0; }
  button { width: 100%; font-size: 17px; padding: 14px; border: 0; border-radius: 10px;
           background: #7CFC9A; color: #0f1411; font-weight: 600; cursor: pointer; }
`

function layout(body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kept: pair your glasses</title>
  <style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`
}

export function pairPage(message = '') {
  return layout(`
    <h1>Kept</h1>
    <p>Type the code shown on your glasses.</p>
    ${message ? `<p class="msg">${message}</p>` : ''}
    <form action="/pair/connect" method="get">
      <input name="code" maxlength="6" placeholder="ABC123" autocomplete="off" autocapitalize="characters" required autofocus>
      <button type="submit">Connect Google Calendar</button>
    </form>
    <p class="small">Kept only adds calendar events for promises you approve. It never stores your meeting audio.</p>
  `)
}

export function pairedPage() {
  return layout(`
    <h1>Glasses paired</h1>
    <p>Google Calendar is connected. You can close this page and go back to your glasses.</p>
  `)
}