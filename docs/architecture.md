# アーキテクチャ

## 認証

1. Consoleが256-bit stateを`__Host-` Cookieへ保存
2. AccountsがGitHub OAuthとAccount状態を確認
3. Accountsが120秒・一回限りのConsole認可コードを発行
4. ConsoleがAccounts Service Bindingで交換
5. Consoleがopaque sessionを発行し、D1へSHA-256だけを保存

各リクエストでAccountsへactive状態を再照会し、停止、削除、障害、応答不正はfail closedです。

## Certificate発行

```text
ブラウザ
  ├─ application.pubを厳密に32-byte公開鍵として読む
  ├─ unsigned .mpkgをローカルで読む
  ├─ MPKG v1 header／ustar／path／manifestを検証
  ├─ Package ID、Capability、Subject Key IDをreadonly表示
  └─ 公開鍵＋Package ID＋CapabilityだけをJSON送信
          ↓ same-origin BFF
Console Worker
  └─ 60秒delegation token + X-Idempotency-Key
          ↓ Service Binding
Developer CA
  └─ raw MCER Base64を返す
          ↓
ブラウザがdeveloper.certとして保存
```

legacy `.pkg`、gzip、圧縮MPKG、未知ustar type、path traversal、重複path、未知signature entry、署名済みMPKG、過大manifest、不正TOMLを拒否します。MPKG ArrayBufferは`certificateIssuePayload`へ渡さず、Worker request bodyにも含めません。

ブラウザ操作ごとに新しい冪等キーを生成し、通信再送中は同じキーを維持します。画面を開き直せば意図的な再発行が可能です。Developer CAは同一内容を5分間集約します。

## 管理画面

`developer_ca_reviewers`はDeveloper確認、追加Developer作成申請、Certificate失効だけを操作できます。`app_store_reviewers`はReviewer通過済みReleaseの最終承認・却下だけを操作できます。任意の上流管理pathを指定できるproxyはありません。
