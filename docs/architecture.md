# アーキテクチャ

## 認証

1. Consoleが256 bitのstateを生成し、`__Host-` Cookieへ保存します。
2. AccountsがGitHub OAuthとAccount状態確認を行います。
3. AccountsはConsole callback専用の一回限り認可コードを発行します。
4. Console WorkerがService Binding経由でコードを交換します。
5. Consoleは独自のopaque sessionを発行し、D1にはSHA-256 hashだけを保存します。

Consoleの各リクエストではAccountsへAccount状態を問い合わせます。停止・削除済み
Account、Accounts障害、応答不正はfail closedで拒否します。

## DeveloperCA連携

ブラウザーはDeveloperCAを直接呼びません。Console Workerが許可した利用者APIだけを
Service Bindingで転送し、`X-Account-ID`とConsole専用サービス認証を付与します。

DeveloperCA管理APIは転送しません。Developer審査、Certificate発行・失効などの管理機能は、将来の内部管理サービスで実装します。

## App Store審査

Console D1の`app_store_reviewers`に登録されたAccountだけが審査画面とBFF APIを利用できます。Console WorkerはAppStore Service Bindingへ`APPSTORE_ADMIN_TOKEN`と審査担当Account IDを付けて、検証済みReleaseの一覧・詳細・承認・却下だけを転送します。

ブラウザへ管理tokenや任意のAppStore管理API proxyは公開しません。`.mpkg`の形式・全ファイルhash・Developer署名の権威ある検証はネイティブRust reviewerが担当し、ブラウザは`validation_status=valid`かつ`review_status=submitted`のReleaseだけを最終審査します。
