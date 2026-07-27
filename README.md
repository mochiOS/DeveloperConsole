# mochiOS Console

`console.mochios.org`で提供する開発者向けポータルです。Rustと`workers-rs`で
実装したBFF、Cloudflare Workers Static Assets、D1セッションで構成します。

ConsoleはDeveloper、Developer Member、追加Developer申請、Developer
Certificate申請を操作します。allowlistへ登録された審査担当者は、検証済みApp Store Releaseの確認、承認、却下もブラウザから行えます。DeveloperCAの秘密鍵、`ADMIN_TOKEN`、Accountsの
セッショントークンをブラウザーへ渡しません。

## 構成

```text
ブラウザー
  ├─ AccountsでGitHub OAuth
  └─ Console Worker（HttpOnlyセッション）
        ├─ Accounts Service Binding
        ├─ DeveloperCA Service Binding
        ├─ AppStore Service Binding（審査担当者のみ）
        ├─ D1（Consoleセッション）
        └─ Static Assets（日本語UI）
```

AccountsからConsoleへのログイン引き渡しには、120秒で失効し一度だけ交換できる
認可コードを使用します。AccountsのCookieへ親ドメインは設定しません。

## ローカル検証

```powershell
cargo test --offline
cargo clippy --offline --all-targets -- -D warnings
npx wrangler d1 migrations apply mochios-console --local
npx wrangler deploy --dry-run
```

`.dev.vars`へ次のSecretを設定します。

```text
CONSOLE_SERVICE_TOKEN=<Accounts、DeveloperCA、Consoleで共有するConsole専用ランダム値>
APPSTORE_ADMIN_TOKEN=<AppStore APIのADMIN_TOKENと同じ値>
```

`APPSTORE_ADMIN_TOKEN`はConsole Worker内だけで使用します。HTML、JavaScript、APIレスポンスには含めません。審査担当者はConsole D1の`app_store_reviewers`で明示的に許可します。

本番設定と手順は[docs/deployment.md](docs/deployment.md)を参照してください。
