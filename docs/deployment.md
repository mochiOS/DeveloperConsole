# デプロイ

## 前提

- Accounts Worker名: `mochios-accounts`
- DeveloperCA Worker名: `mochios-developer-ca`
- AppStore Worker名: `mochios-app-store-api`
- Console Worker名: `mochios-console`
- Worker Route: `console.mochios.org/*`（既存のproxied DNS recordを使用）

## Secret

Accounts内部API用token、DeveloperCA短期token署名鍵、AppStore管理tokenを別々に
設定します。DeveloperCAへは署名鍵の公開鍵だけを設定します。

```powershell
npx wrangler secret put CONSOLE_SERVICE_TOKEN
npx wrangler secret put DEVELOPER_CA_TOKEN_SIGNING_KEY
npx wrangler secret put APPSTORE_ADMIN_TOKEN
```

Secret値をコマンド引数、ログ、Git管理ファイルへ書かないでください。

## マイグレーション

AccountsへConsole認可コード用migrationを、Consoleへsession・DeveloperCA管理担当・
App Store reviewer用migrationを適用します。DeveloperCAには自動発行migrationも適用します。

```powershell
cd ../Account
npx wrangler d1 migrations apply mochios-accounts-staging --remote

cd ../Console
npx wrangler d1 migrations apply mochios-console --remote

cd ../DeveloperCA
npx wrangler d1 migrations apply mochios-developer-ca --remote
```

管理・審査担当Accountは必要最小限だけallowlistへ登録します。DeveloperCA担当者は
Developer確認、追加作成申請、Certificate失効を行いますが、Certificate発行審査はしません。

```powershell
npx wrangler d1 execute mochios-console --remote --command "INSERT INTO app_store_reviewers(account_id, created_at, created_by) VALUES('<Account UUID>', unixepoch(), '<登録者Account UUID>')"
npx wrangler d1 execute mochios-console --remote --command "INSERT INTO developer_ca_reviewers(account_id, created_at, created_by) VALUES('<Account UUID>', unixepoch(), '<登録者Account UUID>')"
```

削除は対象のallowlistテーブルからAccount UUIDを削除します。ブラウザーから審査担当者を
追加・削除するAPIはありません。

## 反映順序

1. Accounts
2. DeveloperCA
3. AppStore
4. Console

各サービスで`cargo test`、Clippy、`npx wrangler deploy --dry-run`を通してから
`npx wrangler deploy`を実行します。

DeveloperCAとConsoleを同時に切り替えます。DeveloperCAへ対応する
`CONSOLE_TOKEN_PUBLIC_KEY`を設定してからConsoleを公開してください。旧
`DEVELOPER_CA_ADMIN_TOKEN`とDeveloperCA向け`CONSOLE_SERVICE_TOKEN`は削除できます。
