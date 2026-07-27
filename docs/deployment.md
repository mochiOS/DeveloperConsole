# デプロイ

## 前提

- Accounts Worker名: `mochios-accounts`
- DeveloperCA Worker名: `mochios-developer-ca`
- AppStore Worker名: `mochios-app-store-api`
- Console Worker名: `mochios-console`
- Worker Route: `console.mochios.org/*`（既存のproxied DNS recordを使用）

## Secret

同じランダム値を3サービスの`CONSOLE_SERVICE_TOKEN`へ設定します。通常の
`SERVICE_TOKEN`や`ADMIN_TOKEN`とは別の値を使用してください。

```powershell
npx wrangler secret put CONSOLE_SERVICE_TOKEN
npx wrangler secret put APPSTORE_ADMIN_TOKEN
```

Secret値をコマンド引数、ログ、Git管理ファイルへ書かないでください。

## マイグレーション

AccountsへConsole認可コード用migrationを、Consoleへsession・App Store reviewer用migrationを適用します。

```powershell
cd ../Account
npx wrangler d1 migrations apply mochios-accounts-staging --remote

cd ../Console
npx wrangler d1 migrations apply mochios-console --remote
```

審査担当Accountは必要最小限だけallowlistへ登録します。

```powershell
npx wrangler d1 execute mochios-console --remote --command "INSERT INTO app_store_reviewers(account_id, created_at, created_by) VALUES('<Account UUID>', unixepoch(), '<登録者Account UUID>')"
```

削除は`DELETE FROM app_store_reviewers WHERE account_id='<Account UUID>'`で行います。ブラウザーから審査担当者を追加・削除するAPIはありません。

## 反映順序

1. Accounts
2. DeveloperCA
3. AppStore
4. Console

各サービスで`cargo test`、Clippy、`npx wrangler deploy --dry-run`を通してから
`npx wrangler deploy`を実行します。
