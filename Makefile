.PHONY: help bootstrap install build dev start test test-unit test-integration test-all check-types clean

help: ## Show this help message
	@echo "hydradb-mcp — MCP server for Hydra DB"
	@echo ""
	@echo "Usage: make <target>"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

bootstrap: ## Bootstrap project (install deps, build, create .env)
	bash scripts/bootstrap.sh

install: ## Install dependencies
	npm ci

build: ## Compile TypeScript to dist/
	npm run build

dev: ## Start MCP server in dev mode (tsx)
	npm run dev

start: ## Start MCP server from compiled output
	npm start

test: ## Run unit tests
	npm test

test-unit: ## Run unit tests
	npm run test:unit

test-integration: ## Run live integration tests (requires credentials)
	npm run test:integration

test-all: ## Run all tests (unit + integration)
	npm run test:all

check-types: ## Type-check without emitting
	npm run check-types

clean: ## Remove build artifacts and dependencies
	rm -rf node_modules/ dist/
