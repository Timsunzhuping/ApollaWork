/**
 * 内嵌页面（data URL）。用于 server 就绪前 / 出错 / 缺构建 / 设置。
 * 主窗口就绪后会 loadURL 到真正的本地 server（http://127.0.0.1:port）。
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把一段 HTML 包成 data URL。 */
export function dataUrl(html: string): string {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

const BASE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", "Hiragino Sans GB", sans-serif;
    background: radial-gradient(1200px 800px at 50% -10%, #1b2440 0%, #0d1117 55%, #0a0d13 100%);
    color: #e6e9ef;
    display: flex; align-items: center; justify-content: center;
    -webkit-user-select: none; user-select: none;
  }
  .card { width: min(560px, 88vw); text-align: center; padding: 40px 36px; }
  .logo { font-size: 22px; font-weight: 700; letter-spacing: .5px; color: #cbd5ff; }
  .logo b { color: #7aa2ff; }
  h1 { font-size: 18px; font-weight: 600; margin: 22px 0 8px; }
  p { font-size: 13.5px; line-height: 1.7; color: #9aa4b2; margin: 6px 0; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre {
    text-align: left; background: #0b0f16; border: 1px solid #232a36; border-radius: 10px;
    padding: 14px 16px; font-size: 12px; color: #c8d1de; overflow: auto; max-height: 240px;
    white-space: pre-wrap; word-break: break-word; -webkit-user-select: text; user-select: text;
  }
  .spinner {
    width: 34px; height: 34px; margin: 0 auto 6px; border-radius: 50%;
    border: 3px solid #2a3346; border-top-color: #7aa2ff; animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .err { color: #ff8f8f; }
  .hint { margin-top: 18px; font-size: 12.5px; color: #7d8794; }
`;

function shell(inner: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<title>Apolla Work</title><style>${BASE_CSS}</style></head><body>${inner}</body></html>`;
}

/** 启动加载页。message 可选，用于展示当前阶段。 */
export function loadingPage(message = '正在启动 Apolla 本地服务…'): string {
  return shell(`
    <div class="card">
      <div class="logo">Apolla <b>Work</b></div>
      <div class="spinner" style="margin-top:26px"></div>
      <h1>${esc(message)}</h1>
      <p>本地执行模式：数据与文件仅保存在这台电脑上。</p>
    </div>`);
}

/** 启动失败页。 */
export function errorPage(message: string, detail?: string): string {
  return shell(`
    <div class="card">
      <div class="logo">Apolla <b>Work</b></div>
      <h1 class="err">本地服务启动失败</h1>
      <p>${esc(message)}</p>
      ${detail ? `<pre>${esc(detail)}</pre>` : ''}
      <p class="hint">可在「视图 → 切换开发者工具」查看更多日志；修复后请从「Apolla → 重启本地服务」重试。</p>
    </div>`);
}

/** 缺少构建产物提示页。 */
export function missingBuildPage(missing: string[]): string {
  const items = missing.map((m) => `<li><code>${esc(m)}</code></li>`).join('');
  return shell(`
    <div class="card">
      <div class="logo">Apolla <b>Work</b></div>
      <h1 class="err">尚未构建，无法启动本地服务</h1>
      <p>缺少以下产物：</p>
      <pre><ul style="margin:0;padding-left:18px">${items}</ul></pre>
      <p>请在仓库根目录先执行构建，然后重新启动本应用：</p>
      <pre>pnpm install
pnpm --filter @apolla/server run build
pnpm --filter @apolla/web run build
pnpm --filter @apolla/runtime run build</pre>
      <p class="hint">或直接 <code>pnpm -w run build</code> 一次性构建全部工作区。</p>
    </div>`);
}

/**
 * 设置页。通过 preload 暴露的 window.apollaSettings 桥（IPC）读写。
 * 保存后主进程会重启 server 使之生效。
 */
export function settingsPage(): string {
  const css = `${BASE_CSS}
    body { display:block; }
    .wrap { width:min(560px,92vw); margin:0 auto; padding:28px 26px 36px; }
    .logo { text-align:center; margin-bottom:6px; }
    .sub { text-align:center; color:#8b95a4; font-size:12.5px; margin-bottom:22px; }
    label { display:block; font-size:12.5px; color:#aeb7c4; margin:16px 0 6px; }
    input {
      width:100%; padding:10px 12px; font-size:13.5px; color:#e6e9ef;
      background:#0b0f16; border:1px solid #2a3346; border-radius:9px; outline:none;
      -webkit-user-select:text; user-select:text;
    }
    input:focus { border-color:#7aa2ff; }
    .desc { font-size:11.5px; color:#727c8a; margin-top:5px; }
    .row { display:flex; gap:12px; margin-top:26px; }
    button {
      flex:1; padding:11px 14px; font-size:13.5px; font-weight:600; border-radius:9px;
      border:1px solid #2a3346; background:#151b27; color:#e6e9ef; cursor:pointer;
    }
    button.primary { background:#3355dd; border-color:#3355dd; }
    button:active { transform: translateY(1px); }
    .status { text-align:center; font-size:12.5px; margin-top:16px; min-height:18px; color:#7aa2ff; }
  `;
  const script = `
    const $ = (id) => document.getElementById(id);
    async function boot() {
      try {
        const s = await window.apollaSettings.get();
        $('MODEL_BASE_URL').value = s.MODEL_BASE_URL || '';
        $('MODEL_API_KEY').value = s.MODEL_API_KEY || '';
        $('MODEL_DEFAULT').value = s.MODEL_DEFAULT || '';
      } catch (e) { $('status').textContent = '读取设置失败：' + e; }
    }
    async function save(restart) {
      $('status').textContent = '保存中…';
      try {
        await window.apollaSettings.save({
          MODEL_BASE_URL: $('MODEL_BASE_URL').value.trim(),
          MODEL_API_KEY: $('MODEL_API_KEY').value.trim(),
          MODEL_DEFAULT: $('MODEL_DEFAULT').value.trim(),
        }, !!restart);
        $('status').textContent = restart ? '已保存，正在重启本地服务…' : '已保存';
      } catch (e) { $('status').textContent = '保存失败：' + e; }
    }
    document.addEventListener('DOMContentLoaded', () => {
      boot();
      $('save').addEventListener('click', () => save(false));
      $('saveRestart').addEventListener('click', () => save(true));
    });
  `;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<title>设置 · Apolla Work</title><style>${css}</style></head><body>
  <div class="wrap">
    <div class="logo"><span style="font-size:20px;font-weight:700;color:#cbd5ff">Apolla <b style="color:#7aa2ff">Work</b></span></div>
    <div class="sub">模型设置（保存到 userData/settings.json，重启本地服务后生效）</div>

    <label for="MODEL_DEFAULT">默认模型（MODEL_DEFAULT）</label>
    <input id="MODEL_DEFAULT" placeholder="如 qwen3:8b；填 mock 则用内置确定性模型（无需 LLM）" />
    <div class="desc">决定智能体默认使用的模型名。mock 可在无 LLM 环境下跑通链路。</div>

    <label for="MODEL_BASE_URL">模型端点（MODEL_BASE_URL）</label>
    <input id="MODEL_BASE_URL" placeholder="如 http://localhost:11434/v1（Ollama）" />
    <div class="desc">OpenAI 兼容端点。留空则沿用环境变量或内置默认。</div>

    <label for="MODEL_API_KEY">API Key（MODEL_API_KEY）</label>
    <input id="MODEL_API_KEY" type="password" placeholder="本地 Ollama 可随意填，如 ollama" />
    <div class="desc">仅保存在本机 settings.json，不会上传。</div>

    <div class="row">
      <button id="save">仅保存</button>
      <button id="saveRestart" class="primary">保存并重启服务</button>
    </div>
    <div class="status" id="status"></div>
  </div>
  <script>${script}</script>
</body></html>`;
}
