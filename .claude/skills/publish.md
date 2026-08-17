# npm publish ワークフロー

npm に変更を publish する手順。

## 手順

1. **変更の確認**: `git diff` で変更内容を把握する
2. **バージョン決定**: semver に従い、変更パッケージのバージョンを決定する
   - patch: バグ修正
   - minor: 機能追加（後方互換）
   - major: 破壊的変更
3. **package.json の version を更新**
4. **src/index.ts 内の `McpServer({ version })` も同じバージョンに更新**（auth 以外の MCP サーバーパッケージ）
5. **ビルド・検証**: `pnpm build && pnpm typecheck && pnpm -r test`
6. **コミット**: `"{パッケージ名} v{バージョン}: {変更内容}"` 形式
7. **push**: main ブランチに push（shivaduke に確認）
8. **npm publish**:
   - auth が変更された場合は auth を先に publish する: `pnpm publish --filter @senchabrew/google-mcp-auth`
   - その後、残りのパッケージを publish する: `pnpm publish --filter @senchabrew/google-calendar-mcp --filter @senchabrew/gmail-mcp --filter @senchabrew/google-sheets-mcp`
   - 変更がないパッケージは publish しない
9. **確認**: `npm view @senchabrew/<パッケージ名> version` でバージョンが更新されていることを確認
