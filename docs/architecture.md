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
Service Bindingで転送します。Consoleは署名済み短期delegation tokenの`sub`へ現在の
Account IDを固定し、DeveloperCAは署名とAccount active状態を再確認します。

通常利用者へDeveloperCA管理APIを転送しません。`developer_ca_reviewers`へ登録された
Accountだけが、固定された審査BFF APIを通してDeveloper確認、追加Developer作成申請、
Certificate発行申請と発行Policyを操作できます。Console Workerは60秒の署名済みadmin
tokenを操作ごとに生成します。DeveloperCAのactorは署名済み`sub`だけから取得され、`jti`
はreplay防止と監査へ使用されます。
任意の管理パスを指定できるproxyは公開しません。

## MPKGからの証明書権限入力

ブラウザーは選択された`.mpkg`をgzip展開し、tar内の`manifest.toml`または
`META/manifest.toml`を端末内で解析します。`[package].id`をPackage ID scopeへ、全
`[[binary]].requires`の和集合を許可Capabilityへ入力します。圧縮済み128 MiB、展開後
512 MiB、10,000 entry、manifest 1 MiBの上限を設けます。

これは入力補助であり信頼判定ではありません。DeveloperCAは発行時にactive member、
Developer Package scope grant、Developer Capability grant、global issuable Capabilityを
再検証します。審査画面では不足Policyを明示的に許可するまで発行できません。

## App Store審査

Console D1の`app_store_reviewers`に登録されたAccountだけが審査画面とBFF APIを利用できます。Console WorkerはAppStore Service Bindingへ`APPSTORE_ADMIN_TOKEN`と審査担当Account IDを付けて、検証済みReleaseの一覧・詳細・承認・却下だけを転送します。

ブラウザへ管理tokenや任意のAppStore管理API proxyは公開しません。`.mpkg`の形式・全ファイルhash・Developer署名の権威ある検証はネイティブRust reviewerが担当し、ブラウザは`validation_status=valid`かつ`review_status=submitted`のReleaseだけを最終審査します。
