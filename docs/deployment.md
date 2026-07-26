# デプロイ

## 前提

- Accounts Worker名: `mochios-accounts`
- DeveloperCA Worker名: `mochios-developer-ca`
- Console Worker名: `mochios-console`
- Custom Domain: `console.mochios.org`

## Secret

同じランダム値を3サービスの`CONSOLE_SERVICE_TOKEN`へ設定します。通常の
`SERVICE_TOKEN`や`ADMIN_TOKEN`とは別の値を使用してください。

```powershell
npx wrangler secret put CONSOLE_SERVICE_TOKEN
```

Secret値をコマンド引数、ログ、Git管理ファイルへ書かないでください。

## マイグレーション

AccountsへConsole認可コード用migrationを、Consoleへsession用migrationを適用します。

```powershell
cd ../Account
npx wrangler d1 migrations apply mochios-accounts-staging --remote

cd ../Console
npx wrangler d1 migrations apply mochios-console --remote
```

## 反映順序

1. Accounts
2. DeveloperCA
3. Console

各サービスで`cargo test`、Clippy、`npx wrangler deploy --dry-run`を通してから
`npx wrangler deploy`を実行します。
