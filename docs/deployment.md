# デプロイ

## Secret

```powershell
npx wrangler secret put CONSOLE_SERVICE_TOKEN
npx wrangler secret put DEVELOPER_CA_TOKEN_SIGNING_KEY
npx wrangler secret put APPSTORE_ADMIN_TOKEN
```

対応関係:

- `CONSOLE_SERVICE_TOKEN` = AccountsのConsole内部API token
- `DEVELOPER_CA_TOKEN_SIGNING_KEY`に対応する公開鍵 = Developer CAの`CONSOLE_TOKEN_PUBLIC_KEY`
- `APPSTORE_ADMIN_TOKEN` = AppStore APIの`ADMIN_TOKEN`

Secretを引数、Git管理ファイル、HTML、JavaScriptへ書きません。

## D1と反映

```powershell
npx wrangler d1 migrations apply mochios-console --remote
npx wrangler deploy
```

反映順はAccounts、Developer CA、AppStore API、Consoleです。Developer CA発行endpointとAppStore identity migrationを先に公開してからConsole UIを切り替えます。

審査担当者は必要最小限だけD1へ登録します。Developer CA担当者はCertificateを承認せず、失効だけを行います。

```powershell
npx wrangler d1 execute mochios-console --remote --command "INSERT INTO developer_ca_reviewers(account_id,created_at,created_by) VALUES('<Account UUID>',unixepoch(),'<登録者>')"
npx wrangler d1 execute mochios-console --remote --command "INSERT INTO app_store_reviewers(account_id,created_at,created_by) VALUES('<Account UUID>',unixepoch(),'<登録者>')"
```

deploy後はログイン、`.pub`＋unsigned MPKG解析、`developer.cert`保存、同一操作再送、viewer発行拒否、管理者失効、App審査を確認します。
