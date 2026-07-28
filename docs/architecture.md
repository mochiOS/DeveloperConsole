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
Certificate失効を操作できます。Console Workerは60秒の署名済みadmin
tokenを操作ごとに生成します。DeveloperCAのactorは署名済み`sub`だけから取得され、`jti`
はreplay防止と監査へ使用されます。
任意の管理パスを指定できるproxyは公開しません。

## Developer Certificate登録

CertificateはmochiOSリポジトリの`tools/devkit/crates/msign`でオフライン発行します。
ブラウザーは選択されたMCER v1ファイルをBase64へ変換して固定BFF APIへ送信します。
DeveloperCAはRoot直署名、有効期限、Developer ID、Package ID scope、Capabilityを検証し、
raw MCERとmetadataを登録します。Root秘密鍵やsubject秘密鍵をConsoleへ送信しません。

CapabilityはMPKGの`manifest.toml`にある全`[[binary]].requires`を基に、オフライン発行時に
`msign`へ指定します。Consoleによる自動発行や管理者によるCertificate審査はありません。

## App Store審査

Console D1の`app_store_reviewers`に登録されたAccountだけが審査画面とBFF APIを利用できます。Console WorkerはAppStore Service Bindingへ`APPSTORE_ADMIN_TOKEN`と審査担当Account IDを付けて、検証済みReleaseの一覧・詳細・承認・却下だけを転送します。

ブラウザへ管理tokenや任意のAppStore管理API proxyは公開しません。`.mpkg`の32-byte header、非圧縮ustar、manifest、MCER v1、Developer署名、全payload hashの権威ある検証はネイティブRust reviewerが担当し、ブラウザは`validation_status=valid`かつ`review_status=submitted`のReleaseだけを最終審査します。
