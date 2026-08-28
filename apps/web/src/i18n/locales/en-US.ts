import type { zhCN } from './zh-CN';

/**
 * 英文语言包。
 *
 * 显式标注为 `Record<keyof typeof zhCN, string>`：缺 key 或多 key 都会在编译期报错，
 * 保证两个语言包始终对齐（`scripts/check-i18n.mjs` 再做一次运行时校验）。
 */
export const enUS: Record<keyof typeof zhCN, string> = {
  // ── Common ──────────────────────────────────────────────
  'common.loading': 'Loading…',
  'common.save': 'Save',
  'common.delete': 'Delete',
  'common.test': 'Test',
  'common.testing': 'Testing…',
  'common.download': 'Download',
  'common.colon': ': ',

  // ── Product identity ────────────────────────────────────
  'app.name': 'Apolla Work',
  'app.tagline': 'Enterprise AI agent workspace',

  // ── Sidebar ─────────────────────────────────────────────
  'sidebar.newTask': 'New task',
  'sidebar.projects': 'Projects',
  'sidebar.skills': 'Experts · Skills · Connectors',
  'sidebar.automation': 'Automation',
  'sidebar.library': 'Knowledge base',
  'sidebar.more': 'More',
  'sidebar.moreHint': 'Admin · Ideas',
  'sidebar.tasks': 'Tasks',
  'sidebar.tasksWithCount': 'Tasks ({n})',
  'sidebar.untitledTask': 'Untitled task',
  'sidebar.emptyTasks': 'No tasks yet. Create one to get started.',
  'sidebar.language': 'Language',

  // ── Language names (endonyms — identical in every locale) ──
  'lang.zh-CN': '中文',
  'lang.en-US': 'English',

  // ── Home ────────────────────────────────────────────────
  'home.title': 'How can Apolla help?',
  'home.titleWithName': '{name}, how can Apolla help?',
  'home.subtitle':
    'Describe the task in a sentence — Apolla runs it in your enterprise sandbox and delivers the files.',
  'home.footer':
    'Every task runs in an isolated server-side sandbox · Data never leaves your network · Fully auditable',
  'home.category.work': 'Everyday work',
  'home.category.code': 'Development',
  'home.category.design': 'Design',
  'home.chip.doc.label': 'Documents',
  'home.chip.doc.prompt': 'Turn this material into a well-structured Word report',
  'home.chip.finance.label': 'Finance',
  'home.chip.finance.prompt':
    'Analyze this financial report and summarize performance and key metrics',
  'home.chip.data.label': 'Data analysis & charts',
  'home.chip.data.prompt': 'Clean and analyze this dataset, then produce charts',
  'home.chip.workspace.label': 'My workspace',
  'home.chip.workspace.prompt':
    'Consolidate the weekly reports in this folder into a monthly summary',
  'home.chip.slides.label': 'Slides',
  'home.chip.slides.prompt': 'Build a slide deck from these key points',

  // ── Composer ────────────────────────────────────────────
  'composer.placeholder': 'What can Apolla take off your plate today?',
  'composer.model': 'Model',
  'composer.permission': 'Permission',
  'composer.stop': 'Stop',
  'composer.send': 'Send (⌘↵)',

  // ── Permission modes / model tiers ──────────────────────
  'mode.auto': 'Auto-run',
  'mode.plan': 'Plan first',
  'mode.ask': 'Ask first',
  'tier.auto': 'Auto',
  'tier.fast': 'Fast',
  'tier.deep': 'Deep',

  // ── Task status ─────────────────────────────────────────
  'status.queued': 'Queued',
  'status.running': 'Running',
  'status.waiting_approval': 'Awaiting approval',
  'status.waiting_input': 'Awaiting input',
  'status.completed': 'Completed',
  'status.failed': 'Failed',
  'status.cancelled': 'Cancelled',

  // ── Task view ───────────────────────────────────────────
  'task.fallbackTitle': 'Task',
  'task.thinking': 'Apolla is thinking…',
  'task.tokens': '{n} tok',
  'task.approval.deny': 'Deny',
  'task.approval.allowAll': 'Allow all',
  'task.approval.approve': 'Approve',
  'task.composer.busyPlaceholder': 'Add instructions any time…',
  'task.composer.idlePlaceholder': 'Continue the conversation or start a new task…',

  // ── Timeline ────────────────────────────────────────────
  'timeline.plan': 'Execution plan',
  'timeline.awaitingAnswer': 'Waiting for your answer: {question}',
  'timeline.taskFailed': 'Task failed: {message}',
  'timeline.toolOk': 'Done',
  'timeline.toolFailed': 'Failed',
  'timeline.approved': 'Approved',
  'timeline.denied': 'Denied',
  'timeline.approvalNeeded': 'Approval required',

  // ── Tool labels ─────────────────────────────────────────
  'tool.Bash': 'Run command',
  'tool.Write': 'Write file',
  'tool.Edit': 'Edit file',
  'tool.Read': 'Read file',
  'tool.Grep': 'Search contents',
  'tool.Glob': 'Find files',
  'tool.TodoWrite': 'Update plan',
  'tool.Skill': 'Load skill',
  'tool.Artifact': 'Create artifact',
  'tool.WebFetch': 'Fetch web page',
  'tool.WebSearch': 'Web search',
  'tool.AskUserQuestion': 'Ask for confirmation',

  // ── Artifact panel ──────────────────────────────────────
  'artifact.title': 'Artifacts ({n})',
  'artifact.download': 'Download {name}',
  'artifact.noPreview': 'Inline preview is not available for this format — download it to view.',

  // ── Skills ──────────────────────────────────────────────
  'skills.title': 'Experts · Skills · Connectors',
  'skills.subtitle':
    'Skills are reusable capability packs for the agent (following the SKILL.md spec), loaded on demand while a task runs.',
  'skills.connectorsHintPrefix': 'To manage enterprise connectors, go to',
  'skills.connectorsLink': 'Connectors',
  'skills.connectorsHintSuffix': '.',
  'skills.tab.installed': 'Enabled skills ({n})',
  'skills.tab.market': 'Marketplace',
  'skills.scope.builtin': 'Built-in',
  'skills.installed': 'Installed',
  'skills.install': 'Install',
  'skills.marketEmpty': 'No skills available in the marketplace.',

  // ── Files ───────────────────────────────────────────────
  'files.title': 'Workspace files',
  'files.subtitle':
    'Upload source material for the agent to reference with @; task artifacts are archived here too.',
  'files.upload': 'Upload files',
  'files.empty': 'No files in this workspace yet. Upload material, or let the agent produce it.',

  // ── Knowledge base ──────────────────────────────────────
  'knowledge.title': 'Knowledge base',
  'knowledge.subtitle':
    'Once a document is indexed, the agent can search it during a task and cite the source (RAG).',
  'knowledge.searchPlaceholder': 'Search the knowledge base…',
  'knowledge.search': 'Search',
  'knowledge.searching': 'Searching…',
  'knowledge.noHits': 'No matching content',
  'knowledge.source': 'Source: {doc}',
  'knowledge.pageRef': 'page {n}',
  'knowledge.indexedDocs': 'Indexed documents ({n})',
  'knowledge.chunks': '{n} chunks',
  'knowledge.pages': '{n} pages',
  'knowledge.empty': 'The knowledge base is empty',
  'knowledge.ingestable': 'Workspace files ready to index',
  'knowledge.ingest': 'Index',
  'knowledge.ingestEmpty':
    'Nothing left to index. Upload files under Projects, or let the agent create them.',

  // ── Automation ──────────────────────────────────────────
  'automation.title': 'Automation',
  'automation.subtitle':
    'Run task templates on a schedule — a daily data digest, a weekly roll-up, and so on.',
  'automation.namePlaceholder': 'Job name, e.g. "Daily data digest"',
  'automation.cronPlaceholder': 'Cron expression',
  'automation.promptPlaceholder':
    'Instruction to run, e.g. "Summarize yesterday\'s sales by region into a daily report"',
  'automation.create': 'Create schedule',
  'automation.preset.daily9': 'Daily 9:00',
  'automation.preset.weeklyMon9': 'Mondays 9:00',
  'automation.preset.hourly': 'Hourly',
  'automation.next': 'next {time}',
  'automation.last': 'last {time}',
  'automation.runNow': 'Run now',
  'automation.empty': 'No scheduled jobs yet',

  // ── Connectors ──────────────────────────────────────────
  'connectors.title': 'Connectors',
  'connectors.add': 'Add connector',
  'connectors.subtitle':
    'Reach internal systems over MCP (databases, internal APIs, OA…). Credentials are envelope-encrypted and every call is audited.',
  'connectors.namePlaceholder': 'Connector name (e.g. crm)',
  'connectors.commandPlaceholder': 'Launch command (e.g. python3 / npx)',
  'connectors.argsPlaceholder': 'Arguments, space-separated (e.g. /path/to/mcp_server.py)',
  'connectors.envPlaceholder':
    'Environment variables, one KEY=VALUE per line (credentials stored encrypted)',
  'connectors.builtinKb': 'Knowledge base (built-in)',
  'connectors.builtinKbHint':
    'Mounted automatically as the kb_search tool when the workspace has an indexed knowledge base',
  'connectors.testOk': '{n} tools: {tools}',
  'connectors.empty': 'No custom connectors yet',

  // ── Admin ───────────────────────────────────────────────
  'admin.title': 'Admin console',
  'admin.subtitle': 'Model governance, usage dashboard, and audit trail.',
  'admin.stat.tasks': 'Total tasks',
  'admin.stat.inTokens': 'Input tokens',
  'admin.stat.outTokens': 'Output tokens',
  'admin.stat.models': 'Models',
  'admin.section.byStatus': 'By status',
  'admin.section.byModel': 'Usage by model',
  'admin.section.audit': 'Audit log',
  'admin.calls': '{n} calls',
  'admin.inOut': 'in {in} / out {out}',
  'admin.noUsage': 'No usage data yet',
  'admin.noAudit': 'No audit records yet',
  'admin.models.section':
    'Model providers (configure one to use a real model; tiers: deep = complex tasks / fast = simple tasks / auto = fallback)',
  'admin.models.namePlaceholder': 'Name, e.g. vLLM-Qwen',
  'admin.models.baseUrlPlaceholder': 'Base URL (/v1)',
  'admin.models.modelPlaceholder': 'Model name',
  'admin.models.apiKeyPlaceholder': 'API key (stored encrypted)',
  'admin.models.tier.deep': 'deep (complex tasks)',
  'admin.models.tier.fast': 'fast (simple tasks)',
  'admin.models.tier.auto': 'auto (fallback)',
  'admin.models.save': 'Add / update model',
  'admin.models.testOk': 'Reachable: {reply}',
  'admin.models.empty':
    'No model configured — the environment-variable default is in use. Add one to manage models from here.',

  // ── Login ───────────────────────────────────────────────
  'login.intro':
    'Sign in with your corporate identity. Tasks run in an on-premise sandbox, data stays inside your network, and everything is auditable.',
  'login.redirecting': 'Redirecting…',
  'login.sso': 'Sign in with SSO',
  'login.terms': 'Signing in means you accept your organization’s usage policy',

  // ── Errors ──────────────────────────────────────────────
  'error.unauthorized': 'Not authenticated — please sign in again',
  'error.oidcConfigMissing': 'OIDC configuration is missing',
  'error.oidcState': 'OIDC state check failed (possible CSRF)',
  'error.pkceMissing': 'PKCE verifier is missing — please sign in again',
  'error.tokenExchange': 'Token exchange failed: {status} {detail}',
};
