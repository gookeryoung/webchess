# Makefile - webchess 项目快捷命令
# 运行 `make help` 查看所有可用命令

.PHONY: help install dev build typecheck lint test e2e e2e-smoke e2e-critical smoke check clean push

help: ## 显示帮助信息
	@node -e "const fs=require('fs');const re=/^([a-zA-Z][A-Za-z0-9 _-]*):.*?##\s*(.*)$$/;for(const f of process.argv.slice(1)){for(const line of fs.readFileSync(f,'utf8').split(/\r?\n/)){const m=re.exec(line);if(m)console.log('  '+m[1].padEnd(14)+' '+m[2])}}" $(MAKEFILE_LIST)

install: ## 安装依赖（pnpm install）
	pnpm install --frozen-lockfile

dev: ## 启动 Web 开发服务器
	pnpm run dev

build: ## 构建全部包
	pnpm run build

typecheck: ## 类型检查
	pnpm run typecheck

lint: ## 代码风格检查（ESLint）
	pnpm run lint

test: ## 运行全部测试
	pnpm run test

e2e: ## 前端 E2E 测试（Playwright，自动构建并起 preview 服务；首次需 pnpm --filter @webchess/web exec playwright install chromium）
	pnpm run e2e

e2e-smoke: ## 前端 E2E 冒烟测试
	pnpm run e2e:smoke

e2e-critical: ## 前端 E2E 关键链路测试
	pnpm run e2e:critical

smoke: ## 运行冒烟测试（内核 + Web）
	pnpm run smoke && pnpm run smoke:web

check: ## 运行全套门禁（typecheck + 纯净度 + lint + 测试 + 构建 + 冒烟）
	pnpm run check

clean: ## 清理构建产物与缓存
	rm -rf packages/*/dist packages/web/dist node_modules/.vite

push: ## 推送代码到所有远程仓库（带 --tags，任一失败立即中断；-u 使新分支首推可用）
	@node -e "const{execSync}=require('child_process');for(const r of execSync('git remote',{encoding:'utf8'}).split(/\s+/).filter(Boolean)){console.log('推送 '+r+'...');execSync('git push -u '+r+' HEAD',{stdio:'inherit'});execSync('git push '+r+' --tags',{stdio:'inherit'})}"
