# Apolla Work 运维入口。`make help` 看全部目标；详细说明见 docs/ops.md。
# 这里只做「把 CI 与运维脚本收敛到一处」，不引入任何新的构建逻辑 ——
# 每个目标都只是转调 pnpm / bash 脚本，本地跑什么、CI 跑什么保持一致。

SHELL := /usr/bin/env bash

# ——— 可覆盖变量 ———
COMPOSE     ?= infra/compose/compose.prod.yml
ENV_FILE    ?= infra/compose/.env
PROJECT     ?= apolla
BACKUP_OUT  ?= ./backups
BACKUP      ?=
KEEP        ?= 7
PY          ?= python3

.DEFAULT_GOAL := help
.PHONY: help install build test eval redteam perf ci licenses audit lint-workflows lint-scripts lint \
        backup backup-dry verify-backup restore restore-yes

help: ## 显示本帮助
	@echo "Apolla Work 运维命令（详见 docs/ops.md）"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "可覆盖变量：COMPOSE / ENV_FILE / PROJECT / BACKUP_OUT / BACKUP / KEEP"
	@echo "例：make backup BACKUP_OUT=/srv/apolla-backup KEEP=7"

# ————————————————————————————————— 构建与测试 —————————————————————————————————

install: ## 安装依赖（跳过 electron 二进制下载）
	ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile

build: ## 构建全部包（串行，保证拓扑顺序与 prisma generate 不打架）
	ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm -r --workspace-concurrency=1 run build

test: ## 单元 / 集成测试
	ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm -r run test

eval: ## 黄金场景评测（硬闸门）→ eval/report.md
	pnpm --filter @apolla/eval exec tsx run.ts

redteam: ## 红队安全测试（严格模式，零缺口硬闸门）→ eval/redteam/report.md
	REDTEAM_STRICT=1 pnpm --filter @apolla/eval exec tsx redteam/run.ts

perf: ## 性能基准（软闸门，只出报告）→ eval/perf/report.md
	pnpm --filter @apolla/eval exec tsx perf/run.ts

ci: build test eval redteam ## 本地跑一遍 CI 的全部硬闸门（不含性能软闸门）
	@echo ""
	@echo "✅ 全部硬闸门通过（build / test / 黄金场景 / 红队严格模式）"

# ————————————————————————————————— 安全与合规 —————————————————————————————————

# 本地只打终端，不落文件 —— 免得在仓库里留下未跟踪的报告目录。
# 需要报告文件时自己加：node .github/scripts/check-licenses.mjs --md-out <路径>
licenses: ## 开源许可合规检查（硬闸门）
	node .github/scripts/check-licenses.mjs

audit: ## 依赖漏洞审计（软闸门，仅报告）
	-pnpm audit --audit-level=high

lint-workflows: ## 静态校验 workflow YAML 语法与结构（需 python + pyyaml）
	@$(PY) -c "import yaml" 2>/dev/null || { \
	  echo "❌ 需要 PyYAML：pip install pyyaml（或 PY=/path/to/venv/bin/python make lint-workflows）"; exit 1; }
	@for f in .github/workflows/*.yml; do \
	  printf '%-34s' "$$f"; \
	  $(PY) -c "import yaml,sys; yaml.safe_load(open(sys.argv[1])); print('YAML OK')" "$$f" || exit 1; \
	done

lint-scripts: ## 校验全部 shell 脚本语法（bash -n）
	@for f in infra/*.sh infra/backup/*.sh scripts/*.sh; do \
	  [ -f "$$f" ] || continue; \
	  printf '%-34s' "$$f"; \
	  bash -n "$$f" && echo "bash -n OK" || exit 1; \
	done

lint: lint-workflows lint-scripts ## 全部静态校验

# ————————————————————————————————— 备份与恢复 —————————————————————————————————

backup: ## 全量备份（BACKUP_OUT=目录 KEEP=保留份数）
	bash infra/backup/backup.sh --out "$(BACKUP_OUT)" --keep "$(KEEP)" \
	  --compose "$(COMPOSE)" --env-file "$(ENV_FILE)" --project "$(PROJECT)"

backup-dry: ## 备份 dry-run（只打印计划，不动数据）
	bash infra/backup/backup.sh --out "$(BACKUP_OUT)" --keep "$(KEEP)" \
	  --compose "$(COMPOSE)" --env-file "$(ENV_FILE)" --project "$(PROJECT)" --dry-run

verify-backup: ## 校验备份完整性（BACKUP=备份目录）
	@[ -n "$(BACKUP)" ] || { echo "❌ 用法：make verify-backup BACKUP=./backups/apolla-backup-<时间戳>"; exit 2; }
	bash infra/backup/verify-backup.sh "$(BACKUP)"

restore: ## 恢复演练：只打印计划，不做任何改动（BACKUP=备份目录）
	@[ -n "$(BACKUP)" ] || { echo "❌ 用法：make restore BACKUP=./backups/apolla-backup-<时间戳>"; exit 2; }
	bash infra/backup/restore.sh "$(BACKUP)" \
	  --compose "$(COMPOSE)" --env-file "$(ENV_FILE)" --project "$(PROJECT)"

restore-yes: ## 【破坏性】真正恢复（BACKUP=备份目录）—— 会 DROP 数据库并覆盖对象存储
	@[ -n "$(BACKUP)" ] || { echo "❌ 用法：make restore-yes BACKUP=./backups/apolla-backup-<时间戳>"; exit 2; }
	bash infra/backup/restore.sh "$(BACKUP)" \
	  --compose "$(COMPOSE)" --env-file "$(ENV_FILE)" --project "$(PROJECT)" --yes
