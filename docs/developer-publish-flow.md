# 一般開発者のApp公開フロー

## 1. Developerの準備

mochiOS IDでConsoleへログインし、Developerを作成します。最初のDeveloperは作成できますが、Certificate発行には管理者によるDeveloper確認が必要です。Certificate自体の審査はありません。

## 2. 鍵生成

```powershell
msign key generate --private-key application.key --public-key application.pub
```

`.cert`は生成されません。`application.key`は秘密鍵なので送信しません。

## 3. unsigned MPKG作成とCertificate取得

MPKG v1の未署名パッケージを作成し、ConsoleのDeveloper詳細で次を選択します。

```text
application.pub
application.mpkg
```

ブラウザ内でPackage ID、全必須Capability、Subject Key IDを確認し、「developer.certを発行」を押します。Cloudへ届くのは公開情報だけです。

## 4. ローカル署名

```powershell
msign package sign application.mpkg --certificate developer.cert --key application.key --output application-signed.mpkg
```

`kome sign`はlegacy `.pkg`用なので使用しません。

## 5. GitHub ReleasesとAppStore

署名済みMPKGを固定tagのGitHub Release assetへ公開し、AppStoreへrepository、tag、asset名、Certificate IDを登録します。`latest` URLは使用しません。

ReviewerはGitHubから一時取得し、MPKG、payload、MCER署名、Issuer trust、serial、Subject Key ID、Developer ID、Package scope、Capability、manifest署名、SHA-256を確認します。MPKG本体はAppStoreへ保存しません。最終承認後、mochiOSクライアントはGitHub Releasesから直接取得して再検証します。
