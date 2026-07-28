# セキュリティ

- sessionとOAuth stateはSecure、HttpOnly、SameSite=Laxの`__Host-` Cookie
- Accounts Cookieを親domainへ共有しない
- 変更APIの`Origin`を`CONSOLE_BASE_URL`へ完全一致
- BFF JSON bodyは64 KiB、上流応答は1 MiBへ制限
- Accounts、Developer CA、AppStoreはService Bindingで接続
- delegation tokenは60秒、固定issuer/audience/role/actor、操作ごとに一意jti
- Developer秘密鍵、Offline Root秘密鍵、MPKG bytesを送信・保存・ログ出力しない
- `.key`、4 KiB超の公開鍵file、不正Base64／hex、32-byte以外を拒否
- unsigned MPKGは128 MiB、manifestは1 MiB、entryは10,000件を上限にブラウザ解析
- Package ID、Capability、Subject Key IDはreadonlyで、任意scope入力UIを持たない
- Developer CAの管理BFFは確認、追加申請、失効だけ。Certificate承認APIはない
- AppStoreの`ADMIN_TOKEN`をブラウザへ返さない
- CSPでscript、connect、frameの実行元を制限

ブラウザで算出したSubject Key IDやmanifest情報は利便性表示であり、Developer CAとAppStore Reviewerが共有crateで再検証します。
