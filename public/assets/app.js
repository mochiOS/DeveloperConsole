const app = document.querySelector("#app");
const toastRegion = document.querySelector("#toast-region");

let account = null;
let appStoreReviewer = false;
let developerCaReviewer = false;
let developers = [];
let creationRequests = [];
let detailRequestId = 0;

const icon = (name) => `<span class="material-symbols-outlined" aria-hidden="true">${name}</span>`;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initials(value) {
  return [...String(value || "m").trim()].slice(0, 1).join("").toUpperCase() || "m";
}

function formatDate(seconds) {
  if (!Number.isFinite(Number(seconds))) return "—";
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeZone: "Asia/Tokyo" })
    .format(new Date(Number(seconds) * 1000));
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let size = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

function githubDownloadUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.hash && url.pathname.includes("/releases/download/")) return url.href;
  } catch {}
  return null;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "リクエストを完了できませんでした。");
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

function showToast(title, message = "", type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `${icon(type === "error" ? "error" : "check_circle")}<div><strong>${escapeHtml(title)}</strong>${message ? `<p>${escapeHtml(message)}</p>` : ""}</div>`;
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 4500);
}

function header() {
  return `<header class="site-header"><div class="site-header__inner">
    <a class="brand" href="#overview" aria-label="mochiOS ID Developer">
      <span>mochiOS <span class="brand__product">ID</span></span><span class="brand__context">Developer</span>
    </a>
    ${account ? `<button class="header-user" type="button" data-action="logout" title="ログアウト"><span>${escapeHtml(account.name)}</span><span class="header-user__avatar">${escapeHtml(initials(account.name))}</span></button>` : ""}
  </div></header>`;
}

function footer() {
  return `<footer class="site-footer"><div class="site-footer__inner">
    <span>Copyright © 2026 mochiOS team</span>
    <nav class="footer-links" aria-label="フッター">
      <a href="https://policy.mochios.org/terms/" target="_blank" rel="noopener noreferrer">利用規約</a>
      <a href="https://policy.mochios.org/privacy/" target="_blank" rel="noopener noreferrer">プライバシー</a>
      <a href="https://status.mochios.org" target="_blank" rel="noopener noreferrer">サービス状態</a>
    </nav>
  </div></footer>`;
}

function renderLogin() {
  document.title = "Developer | mochiOS ID";
  app.innerHTML = `<div class="login-page">${header()}<main class="login-main">
    <section class="login-copy">
      <p class="login-kicker">mochiOS Developer</p>
      <h1 class="login-title">つくる人のための<br>ワークスペース</h1>
      <p class="login-lead">Developerアカウント、メンバー、署名証明書を、mochiOS IDと同じ場所から安全に管理できます。</p>
      <div class="login-features" aria-label="主な機能"><article><strong>Developer</strong><span>公開者と署名主体を管理します。</span></article><article><strong>メンバー</strong><span>役割ごとにアクセスを管理します。</span></article><article><strong>Certificate</strong><span>秘密鍵を端末から出さずに発行します。</span></article></div>
    </section>
    <section class="login-panel" aria-labelledby="login-title">
      <h2 id="login-title">mochiOS IDでログイン</h2>
      <p>Developer機能はmochiOS IDに接続されています。ログイン後、参加中のDeveloperだけが表示されます。</p>
      <a class="button button--primary button--wide" href="/v1/auth/start">${icon("person")}mochiOS IDで続ける</a>
      <p class="login-note">GitHubのパスワードやDeveloper秘密鍵がConsoleへ共有されることはありません。</p>
    </section>
  </main>${footer()}</div>`;
}

function activeRoute() {
  const hash = window.location.hash || "#overview";
  if (hash.startsWith("#developers")) return "developers";
  if (hash === "#requests") return "requests";
  if (hash === "#developer-reviews") return "developer-reviews";
  if (hash.startsWith("#reviews")) return "reviews";
  return "overview";
}

function navigation() {
  const active = activeRoute();
  return `<aside class="sidebar"><p>DEVELOPER</p><nav aria-label="Developerナビゲーション">
    <a href="#overview" ${active === "overview" ? 'aria-current="page"' : ""}>${icon("dashboard")}概要</a>
    <a href="#developers" ${active === "developers" ? 'aria-current="page"' : ""}>${icon("badge")}Developers</a>
    <a href="#requests" ${active === "requests" ? 'aria-current="page"' : ""}>${icon("description")}追加申請</a>
    ${developerCaReviewer ? `<a href="#developer-reviews" ${active === "developer-reviews" ? 'aria-current="page"' : ""}>${icon("security")}Developer管理</a>` : ""}
    ${appStoreReviewer ? `<a href="#reviews" ${active === "reviews" ? 'aria-current="page"' : ""}>${icon("fact_check")}App審査</a>` : ""}
  </nav><div class="sidebar__account"><p>MOCHIOS ID</p><nav>
    <a href="https://accounts.mochios.org/#account" target="_blank" rel="noopener noreferrer">${icon("settings")}Account設定</a>
  </nav></div></aside>`;
}

function shell(content) {
  return `${header()}<main class="page"><div class="account-layout">${navigation()}<section class="content">${content}</section></div></main>${footer()}`;
}

function heading(kicker, title, description, action = "") {
  return `<header class="page-heading"><div class="page-heading__copy"><p>${escapeHtml(kicker)}</p><h1>${escapeHtml(title)}</h1><span>${escapeHtml(description)}</span></div>${action}</header>`;
}

function statusBadge(value, kind = "status") {
  const labels = {
    active: "有効", suspended: "停止中", deleted: "削除済み",
    pending: "検証待ち", submitted: "審査待ち", valid: "検証済み", invalid: "検証失敗", verified: "確認済み", rejected: "却下", approved: "承認済み", consumed: "使用済み",
    draft: "下書き", published: "公開中",
    individual: "個人", organization: "組織", owner: "Owner", admin: "Admin", developer: "Developer", viewer: "Viewer",
    invited: "招待中", removed: "削除済み", issued: "発行済み", revoked: "失効済み",
  };
  const style = ["active", "valid", "verified", "approved", "issued", "published"].includes(value)
    ? "success" : ["pending", "submitted", "invited", "draft"].includes(value) ? "warning" : ["invalid", "suspended", "deleted", "rejected", "revoked", "removed"].includes(value) ? "danger" : "neutral";
  return `<span class="badge badge--${style}" data-kind="${escapeHtml(kind)}">${escapeHtml(labels[value] || value)}</span>`;
}

function developerLink(developer) {
  return `<a class="card developer-card" href="#developers/${encodeURIComponent(developer.id)}">
    <span class="developer-icon">${icon(developer.developer_type === "organization" ? "group" : "person")}</span>
    <span class="developer-card__copy"><strong>${escapeHtml(developer.display_name)}</strong><small>${escapeHtml(developer.id)}</small><span class="badges">${statusBadge(developer.developer_type, "type")}${statusBadge(developer.verification_status, "verification")}</span></span>
    ${icon("chevron_right")}
  </a>`;
}

function renderOverview() {
  const pending = creationRequests.filter((request) => request.status === "pending").length;
  const verified = developers.filter((developer) => developer.verification_status === "verified").length;
  const recent = developers.slice(0, 4);
  document.title = "概要 | mochiOS ID Developer";
  app.innerHTML = shell(`${heading("mochiOS Developer", `こんにちは、${account.name}`, "Developerアカウントと証明書の状態を確認できます。")}
    <section class="metrics" aria-label="概要">
      <article class="metric"><span>参加中のDeveloperアカウント</span><strong>${developers.length}</strong></article>
      <article class="metric"><span>確認済みDeveloperアカウント</span><strong>${verified}</strong></article>
      <article class="metric"><span>審査中の追加申請</span><strong>${pending}</strong></article>
    </section>
    <section class="section"><div class="section-title"><h2>Developers</h2><a class="button button--secondary" href="#developers">すべて表示</a></div>
      ${recent.length ? `<div class="grid">${recent.map(developerLink).join("")}</div>` : `<div class="card empty">${icon("badge")}<h3>Developerアカウントを作成しましょう</h3><p>最初のDeveloperアカウントはすぐに作成できます。Developerアカウントはアプリの公開者と署名主体を表します。</p><p><a class="button button--primary" href="#developers">作成を開始</a></p></div>`}
    </section>`);
}

function approvedRequestOptions() {
  return creationRequests
    .filter((request) => request.status === "approved")
    .map((request) => `<option value="${escapeHtml(request.id)}">${escapeHtml(request.requested_display_name)}</option>`)
    .join("");
}

function renderDevelopers() {
  document.title = "Developers | mochiOS ID Developer";
  const action = `<button class="button button--primary" type="button" data-action="toggle-create">${icon("add")}Developerを作成</button>`;
  app.innerHTML = shell(`${heading("WORKSPACE", "Developers", "所属するDeveloperと審査状態を管理します。", action)}
    <section class="card" id="create-developer-card" ${developers.length ? "hidden" : ""}>
      <div class="card__header"><div><h2>新しいDeveloper</h2><p>最初のDeveloperは審査枠なしで作成できます。</p></div></div>
      <form id="create-developer-form"><div class="card__body form">
        <div class="form-row"><label class="field"><span>表示名</span><input class="input" name="display_name" maxlength="120" required><small>ストアや証明書で表示する名称です。</small></label>
        <label class="field"><span>種類</span><select class="select" name="developer_type"><option value="individual">個人</option><option value="organization">組織</option></select></label></div>
        ${approvedRequestOptions() ? `<label class="field"><span>承認済み追加申請</span><select class="select" name="creation_request_id"><option value="">使用しない</option>${approvedRequestOptions()}</select><small>2つ目以降のDeveloper作成時に選択します。</small></label>` : ""}
        <span class="field-error" data-error hidden></span>
      </div><div class="card__footer"><button class="button button--primary" type="submit">Developerを作成</button></div></form>
    </section>
    <section class="section"><div class="section-title"><h2>所属中</h2></div>
      ${developers.length ? `<div class="grid">${developers.map(developerLink).join("")}</div>` : `<div class="card empty">${icon("badge")}<h3>Developerはまだありません</h3><p>上のフォームから最初のDeveloperを作成してください。</p></div>`}
    </section>`);
}

function renderRequests() {
  document.title = "追加申請 | mochiOS ID Developer";
  app.innerHTML = shell(`${heading("WORKSPACE", "追加Developerアカウント申請", "2つ目以降のDeveloperアカウントを作成するための承認を申請します。")}
    <section class="grid">
      <form class="card" id="creation-request-form"><div class="card__header"><div><h2>新しい申請</h2><p>用途と必要性を記載してください。</p></div></div><div class="card__body form">
        <label class="field"><span>Developerアカウント表示名</span><input class="input" name="requested_display_name" maxlength="120" required></label>
        <label class="field"><span>種類</span><select class="select" name="requested_developer_type"><option value="individual">個人</option><option value="organization">組織</option></select></label>
        <label class="field"><span>申請理由</span><textarea class="textarea" name="reason" maxlength="1000" required></textarea></label>
        <span class="field-error" data-error hidden></span>
      </div><div class="card__footer"><button class="button button--primary" type="submit">申請を送信</button></div></form>
      <section class="card"><div class="card__header"><div><h2>申請履歴</h2><p>審査結果と使用状況を確認できます。</p></div></div>
        ${creationRequests.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>表示名</th><th>状態</th><th>申請日</th></tr></thead><tbody>${creationRequests.map((request) => `<tr><td>${escapeHtml(request.requested_display_name)}<br><small>${escapeHtml(request.requested_developer_type)}</small></td><td>${statusBadge(request.status)}</td><td>${formatDate(request.created_at)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">${icon("description")}<h3>申請履歴はありません</h3><p>追加Developerアカウントが必要になったときに申請してください。</p></div>`}
      </section>
    </section>`);
}

function detailSkeleton() {
  app.innerHTML = shell(`${heading("DEVELOPER", "読み込み中", "Developer情報を取得しています。")}
    <div class="card empty"><span class="spinner"></span></div>`);
}

async function renderDeveloperDetail(developerId) {
  const requestId = ++detailRequestId;
  detailSkeleton();
  try {
    const [developerResult, memberResult, certificateResult] = await Promise.all([
      api(`/v1/developers/${encodeURIComponent(developerId)}`),
      api(`/v1/developers/${encodeURIComponent(developerId)}/members`),
      api(`/v1/developers/${encodeURIComponent(developerId)}/certificates`),
    ]);
    if (requestId !== detailRequestId) return;
    const developer = developerResult.developer;
    const members = memberResult.members || [];
    const certificates = certificateResult.certificates || [];
    document.title = `${developer.display_name} | mochiOS ID Developer`;
    app.innerHTML = shell(`${heading("DEVELOPER", developer.display_name, "Developerアカウントの情報、メンバー、署名証明書を管理します。", `<a class="button button--secondary" href="#developers">一覧へ戻る</a>`)}
      <section class="card"><div class="card__header"><div><h2>基本情報</h2><p>署名主体として使用されるDeveloper情報です。</p></div><span class="badges">${statusBadge(developer.status)}${statusBadge(developer.verification_status)}</span></div>
        <div class="card__body"><dl class="detail-list"><div><dt>Developer ID</dt><dd><code>${escapeHtml(developer.id)}</code></dd></div><div><dt>種類</dt><dd>${statusBadge(developer.developer_type)}</dd></div><div><dt>作成日</dt><dd>${formatDate(developer.created_at)}</dd></div></dl></div>
      </section>
      <section class="section"><div class="section-title"><h2>メンバー</h2></div><div class="card">
        ${members.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Account ID</th><th>ロール</th><th>状態</th></tr></thead><tbody>${members.map((member) => `<tr><td><code>${escapeHtml(member.account_id)}</code></td><td>${statusBadge(member.role)}</td><td>${statusBadge(member.status)}</td></tr>`).join("")}</tbody></table></div>` : ""}
        <form id="add-member-form" data-developer-id="${escapeHtml(developer.id)}"><div class="card__body form"><div class="form-row"><label class="field"><span>Account ID</span><input class="input" name="account_id" required></label><label class="field"><span>ロール</span><select class="select" name="role"><option value="viewer">Viewer</option><option value="developer">Developer</option><option value="admin">Admin</option></select></label></div><span class="field-error" data-error hidden></span></div><div class="card__footer"><button class="button button--secondary" type="submit">メンバーを追加</button></div></form>
      </div></section>
      <section class="section"><div class="section-title"><h2>Developer Certificates</h2></div><div class="grid">
        <section class="card"><div class="card__header"><div><h3>発行済み証明書</h3><p>Developer IDに結び付いた署名証明書です。</p></div></div>
          ${certificates.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>証明書</th><th>状態</th><th>有効期限</th></tr></thead><tbody>${certificates.map((item) => `<tr><td><code>${escapeHtml(item.id)}</code></td><td>${statusBadge(item.status)}</td><td>${formatDate(item.certificate?.content?.not_after)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">${icon("key")}<h3>証明書はありません</h3><p>公開鍵とMPKGからすぐに発行できます。</p></div>`}
        </section>
        <form class="card" id="certificate-request-form" data-developer-id="${escapeHtml(developer.id)}"><div class="card__header"><div><h3>証明書を発行</h3><p>公開鍵とMPKG manifestを検証して即時発行します。管理者審査はありません。</p></div></div><div class="card__body form">
          <label class="field"><span>公開鍵（Base64）</span><textarea class="textarea" name="subject_public_key" required></textarea><small>32 byteのEd25519公開鍵をBase64で入力してください。</small></label>
          <label class="field mpkg-picker"><span>MPKG</span><input class="input input--file" type="file" accept=".mpkg,application/gzip" data-mpkg-input required><small>端末内だけでmanifest.tomlを読みます。.mpkg本体はサーバーへ送信しません。</small></label>
          <div class="manifest-result" data-mpkg-result hidden></div>
          <label class="field"><span>Package IDスコープ</span><input class="input" name="package_id_scopes" placeholder="MPKGから自動入力" required readonly><small>manifest.tomlのpackage.idを使用します。</small></label>
          <label class="field"><span>Capability</span><textarea class="textarea textarea--compact" name="allowed_capabilities" placeholder="MPKGから自動入力" readonly></textarea><small>すべてのbinary.requiresを重複なしで使用します。</small></label>
          <span class="field-error" data-error hidden></span>
        </div><div class="card__footer"><button class="button button--primary" type="submit" ${developer.verification_status !== "verified" ? "disabled title=\"Developerの確認完了後に発行できます\"" : ""}>証明書を発行</button></div></form>
      </div></section>`);
  } catch (error) {
    if (requestId !== detailRequestId) return;
    app.innerHTML = shell(`${heading("DEVELOPER", "読み込めませんでした", error.message)}<div class="card empty">${icon("error")}<h3>Developer情報を取得できません</h3><p><a class="button button--secondary" href="#developers">一覧へ戻る</a></p></div>`);
  }
}

function reviewSkeleton(title = "審査を読み込み中") {
  app.innerHTML = shell(`${heading("APP STORE", title, "検証済みReleaseの審査情報を取得しています。")}
    <div class="card empty"><span class="spinner"></span></div>`);
}

async function renderReviews() {
  if (!appStoreReviewer) return renderOverview();
  reviewSkeleton();
  try {
    const result = await api("/v1/app-store/reviews");
    const releases = result.releases || [];
    document.title = "App審査 | mochiOS ID Developer";
    app.innerHTML = shell(`${heading("APP STORE", "App審査", "Rust審査ツールによる形式・hash・署名検証を通過したReleaseだけを表示します。")}
      <section class="metrics" aria-label="App審査概要">
        <article class="metric"><span>審査待ち</span><strong>${releases.length}</strong></article>
        <article class="metric"><span>表示条件</span><strong class="metric__text">検証済み</strong></article>
        <article class="metric"><span>配布元</span><strong class="metric__text">GitHub Releases</strong></article>
      </section>
      <section class="card"><div class="card__header"><div><h2>提出済みRelease</h2><p>アプリ情報と検証値を確認して承認または却下します。</p></div></div>
        ${releases.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>アプリ</th><th>バージョン</th><th>検証</th><th>提出日</th><th></th></tr></thead><tbody>${releases.map((release) => `<tr><td><strong>${escapeHtml(release.display_name || release.bundle_id)}</strong><br><code>${escapeHtml(release.bundle_id)}</code></td><td>${escapeHtml(release.version)}</td><td>${statusBadge(release.validation_status)}</td><td>${formatDate(release.submitted_at)}</td><td><a class="button button--secondary" href="#reviews/${encodeURIComponent(release.release_id)}">確認</a></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">${icon("fact_check")}<h3>審査待ちのReleaseはありません</h3><p>MPKG reviewerで検証を通過したReleaseがここに表示されます。</p></div>`}
      </section>`);
  } catch (error) {
    app.innerHTML = shell(`${heading("APP STORE", "審査一覧を取得できません", error.message)}<div class="card empty">${icon("error")}<h3>読み込みに失敗しました</h3><p><button class="button button--secondary" type="button" data-action="reload-reviews">再試行</button></p></div>`);
  }
}

async function renderReviewDetail(releaseId) {
  if (!appStoreReviewer) return renderOverview();
  reviewSkeleton("Releaseを読み込み中");
  try {
    const result = await api(`/v1/app-store/reviews/${encodeURIComponent(releaseId)}`);
    const release = result.release;
    const downloadUrl = githubDownloadUrl(release.download_url);
    const actionable = release.validation_status === "valid" && release.review_status === "submitted" && release.publish_status === "draft";
    document.title = `${release.bundle_id} ${release.version} | App審査`;
    app.innerHTML = shell(`${heading("APP STORE REVIEW", release.display_name || release.bundle_id, `${release.bundle_id} · ${release.version}`, `<a class="button button--secondary" href="#reviews">審査一覧へ戻る</a>`)}
      <section class="review-summary">
        <div class="badges">${statusBadge(release.validation_status)}${statusBadge(release.review_status)}${statusBadge(release.publish_status)}</div>
        ${downloadUrl ? `<a class="button button--secondary" href="${escapeHtml(downloadUrl)}" target="_blank" rel="noopener noreferrer">${icon("open_in_new")}GitHubから取得</a>` : ""}
      </section>
      <section class="card"><div class="card__header"><div><h2>Release情報</h2><p>登録時に固定されたGitHub assetとパッケージmetadataです。</p></div></div>
        <div class="card__body"><dl class="detail-list">
          <div><dt>Package ID</dt><dd><code>${escapeHtml(release.bundle_id)}</code></dd></div>
          <div><dt>Version</dt><dd>${escapeHtml(release.version)}</dd></div>
          <div><dt>Repository</dt><dd>${escapeHtml(release.github_repository)}</dd></div>
          <div><dt>Release tag</dt><dd><code>${escapeHtml(release.github_release_tag)}</code></dd></div>
          <div><dt>Asset</dt><dd>${escapeHtml(release.asset_name)} · ${formatBytes(release.file_size)}</dd></div>
          <div><dt>最低mochiOS</dt><dd>${escapeHtml(release.minimum_mochios_version)}</dd></div>
          <div><dt>Certificate</dt><dd><code>${escapeHtml(release.developer_certificate_id)}</code></dd></div>
          <div><dt>Package SHA-256</dt><dd><code class="hash-value">${escapeHtml(release.sha256)}</code></dd></div>
          <div><dt>Manifest SHA-256</dt><dd><code class="hash-value">${escapeHtml(release.manifest_hash)}</code></dd></div>
          <div><dt>変更内容</dt><dd class="pre-wrap">${escapeHtml(release.changelog || "—")}</dd></div>
        </dl></div>
      </section>
      ${actionable ? `<section class="section grid review-actions">
        <form class="card" id="review-approve-form" data-release-id="${escapeHtml(release.release_id)}"><div class="card__header"><div><h3>承認して公開</h3><p>承認するとストアへ即時公開されます。</p></div></div><div class="card__body form"><label class="confirm-field"><input type="checkbox" name="confirmed" required><span>検証値とアプリ内容を確認しました</span></label><span class="field-error" data-error hidden></span></div><div class="card__footer"><button class="button button--primary" type="submit">承認して公開</button></div></form>
        <form class="card" id="review-reject-form" data-release-id="${escapeHtml(release.release_id)}"><div class="card__header"><div><h3>却下</h3><p>開発者が判断できる具体的な理由を記載します。</p></div></div><div class="card__body form"><label class="field"><span>却下理由</span><textarea class="textarea" name="message" minlength="1" maxlength="2000" required></textarea></label><span class="field-error" data-error hidden></span></div><div class="card__footer"><button class="button button--danger" type="submit">Releaseを却下</button></div></form>
      </section>` : `<section class="section card empty">${icon("fact_check")}<h3>このReleaseは操作できません</h3><p>検証済み・審査待ち・下書きのReleaseだけを承認または却下できます。</p></section>`}`);
  } catch (error) {
    app.innerHTML = shell(`${heading("APP STORE", "Releaseを取得できません", error.message)}<div class="card empty">${icon("error")}<h3>読み込みに失敗しました</h3><p><a class="button button--secondary" href="#reviews">審査一覧へ戻る</a></p></div>`);
  }
}

function decisionForms(kind, resourceId, positiveAction, positiveLabel) {
  return `<div class="decision-actions">
    <form class="inline-actions developer-review-form" data-kind="${escapeHtml(kind)}" data-resource-id="${escapeHtml(resourceId)}" data-review-action="${escapeHtml(positiveAction)}">
      <button class="button button--primary" type="submit">${escapeHtml(positiveLabel)}</button><span class="field-error" data-error hidden></span>
    </form>
    <form class="reject-row developer-review-form" data-kind="${escapeHtml(kind)}" data-resource-id="${escapeHtml(resourceId)}" data-review-action="reject">
      <label class="field"><span>却下理由</span><input class="input" name="reason" minlength="1" maxlength="2000" required></label>
      <button class="button button--danger" type="submit">却下</button><span class="field-error" data-error hidden></span>
    </form>
  </div>`;
}

function certificateManagementCard(item) {
  const content = item.certificate?.content || {};
  const scopes = (content.package_id_scopes || []).map((scope) => `<code>${escapeHtml(scope)}</code>`).join(" ") || "—";
  const capabilities = (content.allowed_capabilities || []).map((capability) => `<code>${escapeHtml(capability)}</code>`).join(" ") || "なし";
  return `<article class="card review-item"><div class="card__header"><div><h3><code>${escapeHtml(item.id)}</code></h3><p>Developer <code>${escapeHtml(content.developer_id || "")}</code></p></div>${statusBadge(item.status)}</div><div class="card__body"><dl class="detail-list"><div><dt>Package ID scope</dt><dd class="policy-list">${scopes}</dd></div><div><dt>Capability</dt><dd class="policy-list">${capabilities}</dd></div><div><dt>Subject key</dt><dd><code>${escapeHtml(content.subject_key_id || "")}</code></dd></div><div><dt>有効期限</dt><dd>${formatDate(content.not_after)}</dd></div></dl></div><form class="reject-row developer-review-form" data-kind="certificates" data-resource-id="${escapeHtml(item.id)}" data-review-action="revoke"><label class="field"><span>失効理由コード</span><select class="select" name="reason_code" required><option value="key_compromise">鍵の侵害</option><option value="developer_suspended">Developer停止</option><option value="certificate_replaced">証明書の置換</option><option value="scope_violation">Scope違反</option><option value="administrative">管理上の理由</option><option value="unspecified">その他</option></select></label><label class="field"><span>失効理由</span><input class="input" name="reason" minlength="1" maxlength="2000" required></label><button class="button button--danger" type="submit">証明書を失効</button><span class="field-error" data-error hidden></span></form></article>`;
}

function reviewQueueSection(title, description, items, renderItem) {
  return `<section class="section"><div class="section-title"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div><span class="queue-count">${items.length}</span></div>
    ${items.length ? `<div class="review-queue">${items.map(renderItem).join("")}</div>` : `<div class="card empty">${icon("check_circle")}<h3>対象はありません</h3></div>`}
  </section>`;
}

async function renderDeveloperReviews() {
  if (!developerCaReviewer) return renderOverview();
  app.innerHTML = shell(`${heading("DEVELOPER CA", "Developer管理", "Developer確認、追加作成申請、Certificate失効を管理します。")}<div class="card empty"><span class="spinner"></span></div>`);
  try {
    const queue = await api("/v1/developer-reviews");
    const developerItems = queue.developers || [];
    const creationItems = queue.developer_creation_requests || [];
    const certificateItems = queue.certificates || [];
    document.title = "Developer管理 | mochiOS ID Developer";
    app.innerHTML = shell(`${heading("DEVELOPER CA", "Developer管理", "CertificateはDeveloperへ自動発行されます。管理者は必要な場合だけ失効します。")}
      <section class="metrics" aria-label="Developer審査概要">
        <article class="metric"><span>Developer確認</span><strong>${developerItems.length}</strong></article>
        <article class="metric"><span>追加作成申請</span><strong>${creationItems.length}</strong></article>
        <article class="metric"><span>有効な証明書</span><strong>${certificateItems.length}</strong></article>
      </section>
      ${reviewQueueSection("Developer確認", "公開者・署名主体として使用できるDeveloperか確認します。", developerItems, (developer) => `<article class="card review-item"><div class="card__header"><div><h3>${escapeHtml(developer.display_name)}</h3><p><code>${escapeHtml(developer.id)}</code></p></div><span class="badges">${statusBadge(developer.developer_type)}${statusBadge(developer.verification_status)}</span></div>${decisionForms("developers", developer.id, "verify", "確認済みにする")}</article>`)}
      ${reviewQueueSection("追加Developer作成申請", "標準上限を超えるDeveloper作成理由を確認します。", creationItems, (request) => `<article class="card review-item"><div class="card__header"><div><h3>${escapeHtml(request.requested_display_name)}</h3><p>${escapeHtml(request.reason)}</p></div><span class="badges">${statusBadge(request.requested_developer_type)}${statusBadge(request.status)}</span></div><div class="card__body"><dl class="detail-list"><div><dt>申請Account</dt><dd><code>${escapeHtml(request.account_id)}</code></dd></div><div><dt>申請日</dt><dd>${formatDate(request.created_at)}</dd></div></dl></div>${decisionForms("creation-requests", request.id, "approve", "作成枠を承認")}</article>`)}
      ${reviewQueueSection("Developer Certificates", "発行審査はありません。不正利用、鍵侵害、置換などが必要な証明書だけを失効します。", certificateItems, certificateManagementCard)}
    `);
  } catch (error) {
    app.innerHTML = shell(`${heading("DEVELOPER CA", "審査一覧を取得できません", error.message)}<div class="card empty">${icon("error")}<h3>読み込みに失敗しました</h3><p><button class="button button--secondary" type="button" data-action="reload-developer-reviews">再試行</button></p></div>`);
  }
}

async function renderRoute() {
  if (!account) return renderLogin();
  const hash = window.location.hash || "#overview";
  if (hash.startsWith("#developers/")) {
    const id = decodeURIComponent(hash.slice("#developers/".length));
    if (id) return renderDeveloperDetail(id);
  }
  if (hash.startsWith("#reviews/")) {
    const id = decodeURIComponent(hash.slice("#reviews/".length));
    if (id) return renderReviewDetail(id);
  }
  detailRequestId += 1;
  if (hash === "#developers") return renderDevelopers();
  if (hash === "#requests") return renderRequests();
  if (hash === "#developer-reviews") return renderDeveloperReviews();
  if (hash === "#reviews") return renderReviews();
  renderOverview();
}

async function refreshWorkspace() {
  const [developerResult, requestResult] = await Promise.all([
    api("/v1/developers"),
    api("/v1/developer-creation-requests"),
  ]);
  developers = developerResult.developers || [];
  creationRequests = requestResult.developer_creation_requests || [];
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function commaList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

async function submitForm(form, work) {
  const button = form.querySelector('button[type="submit"]');
  const errorElement = form.querySelector("[data-error]");
  if (errorElement) errorElement.hidden = true;
  try {
    button.disabled = true;
    await work();
  } catch (error) {
    if (errorElement) {
      errorElement.textContent = error.message;
      errorElement.hidden = false;
    } else {
      showToast("処理を完了できませんでした", error.message, "error");
    }
  } finally {
    button.disabled = false;
  }
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  if (button.dataset.action === "toggle-create") {
    const card = document.querySelector("#create-developer-card");
    card.hidden = !card.hidden;
    if (!card.hidden) card.querySelector("input")?.focus();
  }
  if (button.dataset.action === "reload-reviews") await renderReviews();
  if (button.dataset.action === "reload-developer-reviews") await renderDeveloperReviews();
  if (button.dataset.action === "logout") {
    button.disabled = true;
    try {
      await api("/v1/session/logout", { method: "POST" });
      account = null;
      appStoreReviewer = false;
      developerCaReviewer = false;
      developers = [];
      creationRequests = [];
      window.location.hash = "";
      renderLogin();
    } catch (error) {
      showToast("ログアウトできませんでした", error.message, "error");
      button.disabled = false;
    }
  }
});

document.addEventListener("change", async (event) => {
  const input = event.target.closest("[data-mpkg-input]");
  if (!input) return;
  const form = input.closest("form");
  const resultElement = form.querySelector("[data-mpkg-result]");
  const file = input.files?.[0];
  if (!file) return;
  resultElement.hidden = false;
  resultElement.className = "manifest-result manifest-result--loading";
  resultElement.textContent = "manifest.tomlを端末内で解析しています…";
  try {
    const manifest = await globalThis.MochiMpkgManifest.inspectMpkg(file);
    form.elements.package_id_scopes.value = manifest.packageId;
    form.elements.allowed_capabilities.value = manifest.capabilities.join(", ");
    resultElement.className = "manifest-result manifest-result--success";
    resultElement.innerHTML = `<strong>${escapeHtml(manifest.packageId)}</strong><span>${manifest.binaryCount} binary · ${manifest.capabilities.length} capabilities</span>`;
  } catch (error) {
    resultElement.className = "manifest-result manifest-result--error";
    resultElement.textContent = error.message || ".mpkgを解析できませんでした。";
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (form.id === "create-developer-form") {
    await submitForm(form, async () => {
      const values = formValues(form);
      const payload = { developer_type: values.developer_type, display_name: values.display_name.trim(), creation_request_id: values.creation_request_id || null };
      const result = await api("/v1/developers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      await refreshWorkspace();
      showToast("Developerを作成しました");
      window.location.hash = `#developers/${result.developer.id}`;
    });
  }
  if (form.id === "creation-request-form") {
    await submitForm(form, async () => {
      const values = formValues(form);
      await api("/v1/developer-creation-requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      await refreshWorkspace();
      showToast("追加Developer申請を送信しました");
      renderRequests();
    });
  }
  if (form.id === "add-member-form") {
    await submitForm(form, async () => {
      const values = formValues(form);
      const developerId = form.dataset.developerId;
      await api(`/v1/developers/${encodeURIComponent(developerId)}/members`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      showToast("メンバーを追加しました");
      await renderDeveloperDetail(developerId);
    });
  }
  if (form.id === "certificate-request-form") {
    await submitForm(form, async () => {
      const values = formValues(form);
      const developerId = form.dataset.developerId;
      const payload = { signature_algorithm: "ed25519", subject_public_key: values.subject_public_key.trim(), package_id_scopes: commaList(values.package_id_scopes), allowed_capabilities: commaList(values.allowed_capabilities) };
      await api(`/v1/developers/${encodeURIComponent(developerId)}/certificates/issue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      showToast("Certificateを発行しました");
      await renderDeveloperDetail(developerId);
    });
  }
  if (form.id === "review-approve-form") {
    await submitForm(form, async () => {
      const releaseId = form.dataset.releaseId;
      await api(`/v1/app-store/reviews/${encodeURIComponent(releaseId)}/approve`, { method: "POST" });
      showToast("Releaseを公開しました");
      window.location.hash = "#reviews";
    });
  }
  if (form.id === "review-reject-form") {
    await submitForm(form, async () => {
      const releaseId = form.dataset.releaseId;
      const values = formValues(form);
      await api(`/v1/app-store/reviews/${encodeURIComponent(releaseId)}/reject`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: values.message.trim() }) });
      showToast("Releaseを却下しました");
      window.location.hash = "#reviews";
    });
  }
  if (form.classList.contains("developer-review-form")) {
    await submitForm(form, async () => {
      const action = form.dataset.reviewAction;
      const values = formValues(form);
      const options = { method: "POST" };
      if (action === "reject" || action === "revoke") {
        options.headers = { "Content-Type": "application/json" };
        options.body = JSON.stringify({ reason: values.reason.trim(), reason_code: values.reason_code || null });
      }
      await api(`/v1/developer-reviews/${encodeURIComponent(form.dataset.kind)}/${encodeURIComponent(form.dataset.resourceId)}/${encodeURIComponent(action)}`, options);
      showToast(action === "reject" ? "申請を却下しました" : action === "revoke" ? "Certificateを失効しました" : "審査操作を完了しました");
      await renderDeveloperReviews();
    });
  }
});

window.addEventListener("hashchange", () => void renderRoute());

async function initialize() {
  try {
    const result = await api("/v1/session/me");
    account = result.account;
    appStoreReviewer = result.app_store_reviewer === true;
    developerCaReviewer = result.developer_ca_reviewer === true;
    await refreshWorkspace();
  } catch (error) {
    if (error.status !== 401) showToast("Consoleを読み込めませんでした", error.message, "error");
  }
  await renderRoute();
}

void initialize();
