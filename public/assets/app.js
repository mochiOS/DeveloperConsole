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

function certificateContent(item) {
  return item?.certificate_details?.content || {};
}

function certificateScopes(item) {
  const scopes = certificateContent(item).package_id_scopes;
  return Array.isArray(scopes) ? scopes.filter((scope) => typeof scope === "string") : [];
}

function certificateDisplayName(item) {
  const name = String(item?.display_name || "").trim();
  const serial = item?.serial_number || certificateContent(item).serial_number || "—";
  return name || `Certificate ${serial}`;
}

function certificateTableRow(item, developerId, canManage) {
  const certificateId = item.certificate_id || item.id;
  const name = certificateDisplayName(item);
  const nameCell = canManage
    ? `<form class="certificate-name-form" data-developer-id="${escapeHtml(developerId)}" data-certificate-id="${escapeHtml(certificateId)}"><input class="input input--compact" name="display_name" value="${escapeHtml(name)}" maxlength="80" aria-label="証明書名" required><button class="button button--secondary button--compact" type="submit">保存</button><span class="field-error" data-error hidden></span></form>`
    : `<strong>${escapeHtml(name)}</strong>`;
  return `<tr><td>${nameCell}<small class="certificate-id"><code>${escapeHtml(certificateId)}</code></small></td><td>${statusBadge(item.status)}</td><td>${formatDate(certificateContent(item).not_after || item.not_after)}</td></tr>`;
}

function scopeAllowsBundleId(scope, bundleId) {
  return scope === bundleId || (scope.endsWith(".*") && bundleId.startsWith(scope.slice(0, -1)));
}

function activeCertificateOptions(certificates) {
  const now = Math.floor(Date.now() / 1000);
  return certificates
    .filter((item) => item.status === "active" && Number(item.not_after || certificateContent(item).not_after) > now)
    .map((item) => {
      const id = item.certificate_id || item.id;
      const scopes = certificateScopes(item);
      const serial = item.serial_number || certificateContent(item).serial_number || "—";
      return `<option value="${escapeHtml(id)}" data-scopes="${escapeHtml(scopes.join(" "))}">${escapeHtml(certificateDisplayName(item))} · serial ${escapeHtml(serial)} · ${escapeHtml(scopes.join(", ") || "scopeなし")}</option>`;
    })
    .join("");
}

function initializePublishingForms() {
  const appSelect = document.querySelector("#app-store-create-form select[name='bundle_id']");
  const displayName = document.querySelector("#app-store-create-form input[name='display_name']");
  const releaseSelect = document.querySelector("#app-store-release-form select[name='bundle_id']");
  const certificateSelect = document.querySelector("#app-store-release-form select[name='certificate_id']");
  const certificateHelp = document.querySelector("[data-certificate-help]");
  const versionInput = document.querySelector("#app-store-release-form input[name='version']");
  const tagInput = document.querySelector("#app-store-release-form input[name='release_tag']");

  const fillDisplayName = () => {
    const option = appSelect?.selectedOptions[0];
    if (option?.dataset.appName && displayName && !displayName.value) displayName.value = option.dataset.appName;
  };
  appSelect?.addEventListener("change", fillDisplayName);
  fillDisplayName();

  const filterCertificates = () => {
    if (!releaseSelect || !certificateSelect) return;
    const bundleId = releaseSelect.value;
    let available = 0;
    for (const option of [...certificateSelect.options].slice(1)) {
      const allowed = Boolean(bundleId) && option.dataset.scopes.split(" ").some((scope) => scopeAllowsBundleId(scope, bundleId));
      option.hidden = !allowed;
      option.disabled = !allowed;
      if (allowed) available += 1;
    }
    if (certificateSelect.selectedOptions[0]?.disabled) certificateSelect.value = "";
    if (available === 1 && !certificateSelect.value) {
      const option = [...certificateSelect.options].find((item) => item.value && !item.disabled);
      if (option) certificateSelect.value = option.value;
    }
    if (certificateHelp) {
      certificateHelp.textContent = !bundleId
        ? "先にBundle IDを選択してください。"
        : available
          ? `${available}件の有効な証明書を利用できます。`
          : "このBundle IDを署名できる有効な証明書がありません。先にkome signを実行してください。";
    }
  };
  releaseSelect?.addEventListener("change", filterCertificates);
  filterCertificates();

  let generatedTag = "";
  versionInput?.addEventListener("input", () => {
    if (!tagInput || (tagInput.value && tagInput.value !== generatedTag)) return;
    generatedTag = versionInput.value ? `v${versionInput.value}` : "";
    tagInput.value = generatedTag;
  });
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
  document.title = "Developer console | mochiOS ID";
  app.innerHTML = `<div class="login-page">${header()}<main class="login-main">
    <section class="login-copy">
      <h1 class="login-title">Easy to<br>Develop</h1>
      <p class="login-lead">Developerアカウント、メンバー、署名証明書を簡単に管理できます。</p>
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
  const developerLinks = developers.map((developer) => {
    const href = `#developers/${encodeURIComponent(developer.id)}`;
    return `<a href="${href}" ${window.location.hash.startsWith(href) ? 'aria-current="page"' : ""}>${icon("account_circle")}<span>${escapeHtml(developer.display_name)}</span></a>`;
  }).join("");
  return `<aside class="sidebar"><p>DEVELOPER</p><nav aria-label="Developerナビゲーション">
    <a href="#overview" ${active === "overview" ? 'aria-current="page"' : ""}>${icon("dashboard")}概要</a>
    <a href="#developers" ${window.location.hash === "#developers" ? 'aria-current="page"' : ""}>${icon("badge")}Developers</a>
    ${developerLinks}
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
    active: "有効", suspended: "停止中", blocked: "停止中", deleted: "削除済み",
    pending: "検証待ち", submitted: "審査待ち", valid: "検証済み", invalid: "検証失敗", verified: "確認済み", rejected: "却下", approved: "承認済み", consumed: "使用済み",
    draft: "下書き", published: "公開中", app: "アプリ", game: "ゲーム",
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

function selected(value, expected) {
  return value === expected ? "selected" : "";
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
    const [developerResult, memberResult, certificateResult, bundleResult, appStoreResult] = await Promise.all([
      api(`/v1/developers/${encodeURIComponent(developerId)}`),
      api(`/v1/developers/${encodeURIComponent(developerId)}/members`),
      api(`/v1/developers/${encodeURIComponent(developerId)}/certificates`),
      api(`/v1/app-store/developers/${encodeURIComponent(developerId)}/bundle-ids`),
      api(`/v1/app-store/developers/${encodeURIComponent(developerId)}/apps`).catch(() => ({ apps: [] })),
    ]);
    if (requestId !== detailRequestId) return;
    const developer = developerResult.developer;
    const members = memberResult.members || [];
    const certificates = certificateResult.certificates || [];
    const bundleIds = bundleResult.bundle_ids || [];
    const reservedBundleIds = bundleIds.filter((item) => item.status === "reserved");
    const developerApps = appStoreResult.apps || [];
    const releaseResults = await Promise.all(developerApps.map((item) => api(`/v1/app-store/developers/${encodeURIComponent(developerId)}/apps/${encodeURIComponent(item.bundle_id)}/releases`).catch(() => ({ releases: [] }))));
    const developerReleases = releaseResults.flatMap((result) => result.releases || []);
    if (requestId !== detailRequestId) return;
    const canPublish = members.some((member) => member.account_id === account.id && member.status === "active" && ["owner", "admin", "developer"].includes(member.role));
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
        <section class="card"><div class="card__header"><div><h3>登録済み証明書</h3><p>Developer IDに結び付いた署名証明書です。</p></div></div>
          ${certificates.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>名前と証明書ID</th><th>状態</th><th>有効期限</th></tr></thead><tbody>${certificates.map((item) => certificateTableRow(item, developer.id, canPublish)).join("")}</tbody></table></div>` : `<div class="empty">${icon("key")}<h3>証明書はありません</h3><p>Kome CLIで署名すると必要なDeveloper Certificateが自動発行されます。</p></div>`}
        </section>
        <section class="card"><div class="card__header"><div><h3>Kome CLIで署名</h3><p>公開鍵、秘密鍵、MPKGはブラウザへアップロードしません。</p></div></div><div class="card__body"><p>初回は次を実行してください。</p><pre><code>kome login
kome keygen
kome sign</code></pre><p>2回目以降は<code>kome sign</code>だけで、manifestからPackage IDとCapabilityを読み取り、必要なCertificateを取得します。</p><a class="button button--secondary" href="https://accounts.mochios.org/#sessions">CLIセッションを管理</a></div></section>
      </div></section>
      ${canPublish ? `<section class="section"><div class="section-title"><h2>App Store</h2></div>
        <section class="card"><div class="card__header"><div><h3>登録済みアプリ</h3><p>MPKG本体は保存せず、GitHub Releases上の固定assetを登録します。</p></div></div>
          ${developerApps.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>アプリ</th><th>Bundle ID</th><th>公開状態</th><th></th></tr></thead><tbody>${developerApps.map((item) => `<tr><td><a class="table-link" href="#developers/${encodeURIComponent(developer.id)}/apps/${encodeURIComponent(item.bundle_id)}">${escapeHtml(item.display_name)}</a></td><td><code>${escapeHtml(item.bundle_id)}</code></td><td>${statusBadge(item.visibility)}</td><td><a class="row-action" href="#developers/${encodeURIComponent(developer.id)}/apps/${encodeURIComponent(item.bundle_id)}">管理${icon("chevron_right")}</a></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">${icon("apps")}<h3>アプリは未登録です</h3></div>`}
          ${developerReleases.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Release ID</th><th>Version</th><th>検証</th><th>審査</th><th>公開</th></tr></thead><tbody>${developerReleases.map((item) => `<tr><td><code>${escapeHtml(item.release_id)}</code><br><small>${escapeHtml(item.bundle_id)}</small></td><td>${escapeHtml(item.version)}</td><td>${statusBadge(item.validation_status)}</td><td>${statusBadge(item.review_status)}</td><td>${statusBadge(item.publish_status)}</td></tr>`).join("")}</tbody></table></div>` : ""}
        </section>
        <div class="publishing-flow">
          <form class="card publishing-step" id="app-store-reserve-form" data-developer-id="${escapeHtml(developer.id)}"><div class="card__header"><span class="step-number">1</span><div><h3>Bundle IDを予約</h3><p>アプリを一意に識別する逆ドメイン形式のIDです。</p></div></div><div class="card__body form"><div class="form-row"><label class="field"><span>Bundle ID</span><input class="input" name="bundle_id" placeholder="com.example.testapp" autocomplete="off" required></label><label class="field"><span>アプリ名</span><input class="input" name="app_name" required></label></div><span class="field-error" data-error hidden></span></div><div class="card__footer"><button class="button button--secondary" type="submit">Bundle IDを予約</button></div></form>
          <form class="card publishing-step" id="app-store-create-form" data-developer-id="${escapeHtml(developer.id)}"><div class="card__header"><span class="step-number">2</span><div><h3>アプリ情報を作成</h3><p>予約済みBundle IDを選択します。IDを再入力する必要はありません。</p></div></div><div class="card__body form"><label class="field"><span>予約済みBundle ID</span><select class="select" name="bundle_id" required ${reservedBundleIds.length ? "" : "disabled"}><option value="">${reservedBundleIds.length ? "選択してください" : "予約済みBundle IDがありません"}</option>${reservedBundleIds.map((item) => `<option value="${escapeHtml(item.bundle_id)}" data-app-name="${escapeHtml(item.app_name)}">${escapeHtml(item.bundle_id)} · ${escapeHtml(item.app_name)}</option>`).join("")}</select></label><div class="form-row"><label class="field"><span>表示名</span><input class="input" name="display_name" required ${reservedBundleIds.length ? "" : "disabled"}></label><label class="field"><span>種類</span><select class="select" name="kind" ${reservedBundleIds.length ? "" : "disabled"}><option value="app">アプリ</option><option value="game">ゲーム</option></select></label></div><label class="field"><span>説明</span><textarea class="textarea" name="description" maxlength="4000" ${reservedBundleIds.length ? "" : "disabled"}></textarea></label><span class="field-error" data-error hidden></span></div><div class="card__footer"><button class="button button--secondary" type="submit" ${reservedBundleIds.length ? "" : "disabled"}>アプリ情報を作成</button></div></form>
          <form class="card publishing-step" id="app-store-release-form" data-developer-id="${escapeHtml(developer.id)}"><div class="card__header"><span class="step-number">3</span><div><h3>App Storeへリリースを提出</h3><p>GitHub Releases上の署名済み<code>.mpkg</code>を指定し、App Storeの審査へ提出します。</p></div></div><div class="card__body form"><div class="form-row"><label class="field"><span>Bundle ID</span><select class="select" name="bundle_id" required ${developerApps.length ? "" : "disabled"}><option value="">${developerApps.length ? "選択してください" : "先にアプリ情報を作成してください"}</option>${developerApps.map((item) => `<option value="${escapeHtml(item.bundle_id)}">${escapeHtml(item.display_name)} · ${escapeHtml(item.bundle_id)}</option>`).join("")}</select></label><label class="field"><span>Version</span><input class="input" name="version" placeholder="0.1.0" required ${developerApps.length ? "" : "disabled"}></label></div><div class="form-row"><label class="field"><span>Repository</span><input class="input" name="repository" placeholder="owner/repository" required ${developerApps.length ? "" : "disabled"}></label><label class="field"><span>Release tag</span><input class="input" name="release_tag" placeholder="v0.1.0" required ${developerApps.length ? "" : "disabled"}></label></div><div class="form-row"><label class="field"><span>MPKG asset名</span><input class="input" name="asset" placeholder="TestApp.mpkg" required ${developerApps.length ? "" : "disabled"}></label><label class="field"><span>Developer Certificate</span><select class="select" name="certificate_id" required ${developerApps.length ? "" : "disabled"}><option value="">選択してください</option>${activeCertificateOptions(certificates)}</select><small data-certificate-help>Bundle IDに対応する有効な証明書だけを表示します。</small></label></div><label class="field"><span>変更内容（任意）</span><textarea class="textarea" name="changelog" maxlength="4000" ${developerApps.length ? "" : "disabled"}></textarea></label><span class="field-error" data-error hidden></span></div><div class="card__footer"><button class="button button--primary" type="submit" ${developerApps.length ? "" : "disabled"}>審査に提出</button></div></form>
        </div>
      </section>` : ""}`);
    initializePublishingForms();
  } catch (error) {
    if (requestId !== detailRequestId) return;
    app.innerHTML = shell(`${heading("DEVELOPER", "読み込めませんでした", error.message)}<div class="card empty">${icon("error")}<h3>Developer情報を取得できません</h3><p><a class="button button--secondary" href="#developers">一覧へ戻る</a></p></div>`);
  }
}

async function renderAppDetail(developerId, bundleId) {
  const requestId = ++detailRequestId;
  detailSkeleton();
  try {
    const [developerResult, memberResult, appResult, releaseResult] = await Promise.all([
      api(`/v1/developers/${encodeURIComponent(developerId)}`),
      api(`/v1/developers/${encodeURIComponent(developerId)}/members`),
      api(`/v1/app-store/developers/${encodeURIComponent(developerId)}/apps/${encodeURIComponent(bundleId)}`),
      api(`/v1/app-store/developers/${encodeURIComponent(developerId)}/apps/${encodeURIComponent(bundleId)}/releases`).catch(() => ({ releases: [] })),
    ]);
    if (requestId !== detailRequestId) return;
    const developer = developerResult.developer;
    const application = appResult.app;
    const releases = releaseResult.releases || [];
    const canEdit = (memberResult.members || []).some((member) => member.account_id === account.id && member.status === "active" && ["owner", "admin", "developer"].includes(member.role));
    document.title = `${application.display_name} | mochiOS ID Developer`;
    app.innerHTML = shell(`${heading("APP STORE", application.display_name, application.bundle_id, `<a class="button button--secondary" href="#developers/${encodeURIComponent(developerId)}">Developerへ戻る</a>`)}
      <section class="card"><div class="card__header"><div><h2>アプリ情報</h2><p>Bundle IDは変更できません。ストアへ表示する情報はいつでも更新できます。</p></div><span class="badges">${statusBadge(application.visibility)}${statusBadge(application.kind)}</span></div>
        <div class="card__body"><dl class="detail-list"><div><dt>Developer</dt><dd>${escapeHtml(developer.display_name)}</dd></div><div><dt>Bundle ID</dt><dd><code>${escapeHtml(application.bundle_id)}</code></dd></div><div><dt>最終更新</dt><dd>${formatDate(application.updated_at)}</dd></div></dl></div>
      </section>
      <section class="section"><div class="section-title"><div><h2>ストア情報を編集</h2><p>保存後、Consoleと公開中のストア情報へ反映されます。</p></div></div>
        <form class="card" id="app-store-edit-form" data-developer-id="${escapeHtml(developerId)}" data-bundle-id="${escapeHtml(bundleId)}"><div class="card__body form">
          <div class="form-row"><label class="field"><span>表示名</span><input class="input" name="display_name" value="${escapeHtml(application.display_name)}" maxlength="120" required ${canEdit ? "" : "disabled"}></label><label class="field"><span>種類</span><select class="select" name="kind" ${canEdit ? "" : "disabled"}><option value="app" ${selected(application.kind, "app")}>アプリ</option><option value="game" ${selected(application.kind, "game")}>ゲーム</option></select></label></div>
          <label class="field"><span>サブタイトル</span><input class="input" name="subtitle" value="${escapeHtml(application.subtitle || "")}" maxlength="160" ${canEdit ? "" : "disabled"}></label>
          <label class="field"><span>説明</span><textarea class="textarea" name="description" maxlength="4000" ${canEdit ? "" : "disabled"}>${escapeHtml(application.description || "")}</textarea></label>
          <div class="form-row"><label class="field"><span>アイコンURL</span><input class="input" name="icon_url" type="url" inputmode="url" placeholder="https://example.com/icon.png" value="${escapeHtml(application.icon_url || "")}" ${canEdit ? "" : "disabled"}><small>HTTPSの画像URLを指定してください。</small></label><label class="field"><span>カテゴリ</span><input class="input" name="category" value="${escapeHtml(application.category || "")}" maxlength="80" ${canEdit ? "" : "disabled"}></label></div>
          <label class="field"><span>年齢区分</span><input class="input" name="age_rating" value="${escapeHtml(application.age_rating || "")}" maxlength="40" ${canEdit ? "" : "disabled"}></label>
          <span class="field-error" data-error hidden></span>
        </div><div class="card__footer"><button class="button button--primary" type="submit" ${canEdit ? "" : "disabled"}>変更を保存</button></div></form>
      </section>
      <section class="section"><div class="section-title"><div><h2>App Store Releases</h2><p>このアプリから審査へ提出したバージョンです。</p></div></div><section class="card">
        ${releases.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Version</th><th>検証</th><th>審査</th><th>公開</th><th>提出日</th></tr></thead><tbody>${releases.map((item) => `<tr><td>${escapeHtml(item.version)}</td><td>${statusBadge(item.validation_status)}</td><td>${statusBadge(item.review_status)}</td><td>${statusBadge(item.publish_status)}</td><td>${formatDate(item.created_at)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">${icon("description")}<h3>提出済みのReleaseはありません</h3><p>DeveloperページからApp Storeの審査へ提出できます。</p></div>`}
      </section></section>`);
  } catch (error) {
    if (requestId !== detailRequestId) return;
    app.innerHTML = shell(`${heading("APP STORE", "アプリを読み込めませんでした", error.message, `<a class="button button--secondary" href="#developers/${encodeURIComponent(developerId)}">Developerへ戻る</a>`)}<div class="card empty">${icon("error")}<h3>アプリ情報を取得できません</h3></div>`);
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
    const [result, activePackagesResult, blockedPackagesResult] = await Promise.all([
      api("/v1/app-store/reviews"),
      api("/v1/app-store/packages?status=active"),
      api("/v1/app-store/packages?status=blocked"),
    ]);
    const releases = result.releases || [];
    const packages = [...(blockedPackagesResult.packages || []), ...(activePackagesResult.packages || [])];
    document.title = "App審査 | mochiOS ID Developer";
    app.innerHTML = shell(`${heading("APP STORE", "App審査", "Rust審査ツールによる形式・hash・署名検証を通過したReleaseだけを表示します。")}
      <section class="metrics" aria-label="App審査概要">
        <article class="metric"><span>審査待ち</span><strong>${releases.length}</strong></article>
        <article class="metric"><span>表示条件</span><strong class="metric__text">検証済み</strong></article>
        <article class="metric"><span>配布元</span><strong class="metric__text">GitHub Releases</strong></article>
      </section>
      <section class="card"><div class="card__header"><div><h2>提出済みRelease</h2><p>アプリ情報と検証値を確認して承認または却下します。</p></div></div>
        ${releases.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>アプリ</th><th>バージョン</th><th>検証</th><th>提出日</th><th></th></tr></thead><tbody>${releases.map((release) => `<tr><td><strong>${escapeHtml(release.display_name || release.bundle_id)}</strong><br><code>${escapeHtml(release.bundle_id)}</code></td><td>${escapeHtml(release.version)}</td><td>${statusBadge(release.validation_status)}</td><td>${formatDate(release.submitted_at)}</td><td><a class="button button--secondary" href="#reviews/${encodeURIComponent(release.release_id)}">確認</a></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">${icon("fact_check")}<h3>審査待ちのReleaseはありません</h3><p>MPKG reviewerで検証を通過したReleaseがここに表示されます。</p></div>`}
      </section>
      ${reviewQueueSection("パッケージの公開制御", "問題のあるパッケージは全Releaseを即時停止し、調査後に再開できます。", packages, packageManagementCard)}`);
  } catch (error) {
    app.innerHTML = shell(`${heading("APP STORE", "審査一覧を取得できません", error.message)}<div class="card empty">${icon("error")}<h3>読み込みに失敗しました</h3><p><button class="button button--secondary" type="button" data-action="reload-reviews">再試行</button></p></div>`);
  }
}

function packageManagementCard(item) {
  const blocked = item.package_status === "blocked";
  const action = blocked ? "restore" : "suspend";
  return `<article class="card review-item"><div class="card__header"><div><h3>${escapeHtml(item.display_name || item.bundle_id)}</h3><p><code>${escapeHtml(item.bundle_id)}</code></p></div>${statusBadge(item.package_status)}</div>
    ${blocked && item.suspension_reason ? `<div class="card__body"><p class="pre-wrap">${escapeHtml(item.suspension_reason)}</p></div>` : ""}
    <form class="reject-row package-management-form" data-bundle-id="${escapeHtml(item.bundle_id)}" data-action-name="${action}">
      ${blocked ? "" : `<label class="field"><span>停止理由</span><input class="input" name="reason" minlength="1" maxlength="2000" required></label>`}
      <button class="button ${blocked ? "button--secondary" : "button--danger"}" type="submit">${blocked ? "パッケージを再開" : "パッケージを停止"}</button><span class="field-error" data-error hidden></span>
    </form></article>`;
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
          <div><dt>Bundle ID</dt><dd><code>${escapeHtml(release.bundle_id)}</code></dd></div>
          <div><dt>Version</dt><dd>${escapeHtml(release.version)}</dd></div>
          <div><dt>Repository</dt><dd>${escapeHtml(release.github_repository)}</dd></div>
          <div><dt>Release tag</dt><dd><code>${escapeHtml(release.github_release_tag)}</code></dd></div>
          <div><dt>Asset</dt><dd>${escapeHtml(release.asset_name)} · ${formatBytes(release.file_size)}</dd></div>
          <div><dt>Developer</dt><dd>${escapeHtml(release.developer_display_name || "—")}<br><code>${escapeHtml(release.registered_by)}</code></dd></div>
          <div><dt>Certificate serial</dt><dd><code>${escapeHtml(release.developer_certificate_serial)}</code></dd></div>
          <div><dt>Subject Key ID</dt><dd><code class="hash-value">${escapeHtml(release.developer_certificate_subject_key_id)}</code></dd></div>
          <div><dt>Asset SHA-256</dt><dd><code class="hash-value">${escapeHtml(release.sha256)}</code></dd></div>
          <div><dt>Package digest</dt><dd><code class="hash-value">${escapeHtml(release.package_digest)}</code></dd></div>
          <div><dt>Manifest SHA-256</dt><dd><code class="hash-value">${escapeHtml(release.manifest_hash)}</code></dd></div>
          <div><dt>Capabilities</dt><dd class="pre-wrap">${escapeHtml((JSON.parse(release.capabilities_json || "[]")).join("\n") || "なし")}</dd></div>
          <div><dt>Payload</dt><dd class="pre-wrap">${escapeHtml((JSON.parse(release.payloads_json || "[]")).map((item) => `${item.install_path} · ${formatBytes(item.size)} · ${item.mode}`).join("\n") || "—")}</dd></div>
          <div><dt>検証</dt><dd>${escapeHtml(release.reviewer_version)} · ${formatDate(release.validated_at)}</dd></div>
          <div><dt>変更内容</dt><dd class="pre-wrap">${escapeHtml(release.changelog || "—")}</dd></div>
        </dl></div>
      </section>
      ${actionable ? `<section class="section grid review-actions">
        <form class="card" id="review-approve-form" data-release-id="${escapeHtml(release.release_id)}"><div class="card__header"><div><h3>承認して公開</h3><p>承認するとストアへ即時公開されます。</p></div></div><div class="card__body form"><label class="confirm-field"><input type="checkbox" name="confirmed" required><span>検証値とアプリ内容を確認しました</span></label><span class="field-error" data-error hidden></span></div><div class="card__footer"><button class="button button--primary" type="submit">承認して公開</button></div></form>
        <form class="card" id="review-reject-form" data-release-id="${escapeHtml(release.release_id)}"><div class="card__header"><div><h3>却下</h3><p>固定理由を選び、必要なら補足します。</p></div></div><div class="card__body form"><label class="field"><span>却下理由</span><select class="input" name="reason_code" required><option value="">選択してください</option><option value="metadata_incorrect">Metadataが不正確</option><option value="misleading_description">説明が誤解を招く</option><option value="malicious_behavior">悪意ある動作</option><option value="policy_violation">ポリシー違反</option><option value="duplicate_application">重複アプリ</option><option value="broken_application">動作不能</option><option value="other">その他</option></select></label><label class="field"><span>補足（任意）</span><textarea class="textarea" name="note" maxlength="2000"></textarea></label><span class="field-error" data-error hidden></span></div><div class="card__footer"><button class="button button--danger" type="submit">Releaseを却下</button></div></form>
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
  const content = (item.certificate_details || item.certificate)?.content || {};
  const scopes = (content.package_id_scopes || []).map((scope) => `<code>${escapeHtml(scope)}</code>`).join(" ") || "—";
  const capabilities = (content.allowed_capabilities || []).map((capability) => `<code>${escapeHtml(capability)}</code>`).join(" ") || "なし";
  const suspended = item.status === "suspended";
  return `<article class="card review-item"><div class="card__header"><div><h3><code>${escapeHtml(item.id)}</code></h3><p>Developer <code>${escapeHtml(content.developer_id || "")}</code></p></div>${statusBadge(item.status)}</div><div class="card__body"><dl class="detail-list"><div><dt>Package ID scope</dt><dd class="policy-list">${scopes}</dd></div><div><dt>Capability</dt><dd class="policy-list">${capabilities}</dd></div><div><dt>Subject key</dt><dd><code>${escapeHtml(content.subject_key_id || "")}</code></dd></div><div><dt>有効期限</dt><dd>${formatDate(content.not_after)}</dd></div></dl></div>
    <form class="reject-row developer-review-form" data-kind="certificates" data-resource-id="${escapeHtml(item.id)}" data-review-action="${suspended ? "restore" : "suspend"}">${suspended ? "" : `<label class="field"><span>停止理由</span><input class="input" name="reason" minlength="1" maxlength="2000" required></label>`}<button class="button button--secondary" type="submit">${suspended ? "証明書を再開" : "証明書を一時停止"}</button><span class="field-error" data-error hidden></span></form>
    <form class="reject-row developer-review-form" data-kind="certificates" data-resource-id="${escapeHtml(item.id)}" data-review-action="revoke"><label class="field"><span>失効理由コード</span><select class="select" name="reason_code" required><option value="key_compromise">鍵の侵害</option><option value="developer_suspended">Developer停止</option><option value="certificate_replaced">証明書の置換</option><option value="scope_violation">Scope違反</option><option value="administrative">管理上の理由</option><option value="unspecified">その他</option></select></label><label class="field"><span>失効理由</span><input class="input" name="reason" minlength="1" maxlength="2000" required></label><button class="button button--danger" type="submit">証明書を失効</button><span class="field-error" data-error hidden></span></form></article>`;
}

function developerManagementCard(developer) {
  const suspended = developer.status === "suspended";
  return `<article class="card review-item"><div class="card__header"><div><h3>${escapeHtml(developer.display_name)}</h3><p><code>${escapeHtml(developer.id)}</code></p></div><span class="badges">${statusBadge(developer.developer_type)}${statusBadge(developer.status)}</span></div>
    <form class="reject-row developer-review-form" data-kind="developers" data-resource-id="${escapeHtml(developer.id)}" data-review-action="${suspended ? "restore" : "suspend"}">${suspended ? "" : `<label class="field"><span>停止理由</span><input class="input" name="reason" minlength="1" maxlength="2000" required></label>`}<button class="button ${suspended ? "button--secondary" : "button--danger"}" type="submit">${suspended ? "Developerを再開" : "Developerを停止"}</button><span class="field-error" data-error hidden></span></form></article>`;
}

function reviewQueueSection(title, description, items, renderItem) {
  return `<section class="section"><div class="section-title"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div><span class="queue-count">${items.length}</span></div>
    ${items.length ? `<div class="review-queue">${items.map(renderItem).join("")}</div>` : `<div class="card empty">${icon("check_circle")}<h3>対象はありません</h3></div>`}
  </section>`;
}

async function renderDeveloperReviews() {
  if (!developerCaReviewer) return renderOverview();
  app.innerHTML = shell(`${heading("DEVELOPER CA", "Developer管理", "追加作成申請とセキュリティ停止を管理します。")}<div class="card empty"><span class="spinner"></span></div>`);
  try {
    const queue = await api("/v1/developer-reviews");
    const developerItems = queue.developers || [];
    const creationItems = queue.developer_creation_requests || [];
    const certificateItems = queue.certificates || [];
    document.title = "Developer管理 | mochiOS ID Developer";
    app.innerHTML = shell(`${heading("DEVELOPER CA", "Developer管理", "Developerは自動で利用可能になります。管理者は問題発生時だけ停止または失効します。")}
      <section class="metrics" aria-label="Developer審査概要">
        <article class="metric"><span>Developer</span><strong>${developerItems.length}</strong></article>
        <article class="metric"><span>追加作成申請</span><strong>${creationItems.length}</strong></article>
        <article class="metric"><span>有効な証明書</span><strong>${certificateItems.length}</strong></article>
      </section>
      ${reviewQueueSection("Developerの利用状態", "問題のあるDeveloperは署名発行と既存証明書の利用を即時停止できます。", developerItems, developerManagementCard)}
      ${reviewQueueSection("追加Developer作成申請", "標準上限を超えるDeveloper作成理由を確認します。", creationItems, (request) => `<article class="card review-item"><div class="card__header"><div><h3>${escapeHtml(request.requested_display_name)}</h3><p>${escapeHtml(request.reason)}</p></div><span class="badges">${statusBadge(request.requested_developer_type)}${statusBadge(request.status)}</span></div><div class="card__body"><dl class="detail-list"><div><dt>申請Account</dt><dd><code>${escapeHtml(request.account_id)}</code></dd></div><div><dt>申請日</dt><dd>${formatDate(request.created_at)}</dd></div></dl></div>${decisionForms("creation-requests", request.id, "approve", "作成枠を承認")}</article>`)}
      ${reviewQueueSection("Developer Certificates", "調査中は一時停止し、鍵侵害などが確定した場合だけ不可逆に失効します。", certificateItems, certificateManagementCard)}
    `);
  } catch (error) {
    app.innerHTML = shell(`${heading("DEVELOPER CA", "審査一覧を取得できません", error.message)}<div class="card empty">${icon("error")}<h3>読み込みに失敗しました</h3><p><button class="button button--secondary" type="button" data-action="reload-developer-reviews">再試行</button></p></div>`);
  }
}

async function renderRoute() {
  if (!account) return renderLogin();
  const hash = window.location.hash || "#overview";
  const appMatch = hash.match(/^#developers\/([^/]+)\/apps\/([^/]+)$/);
  if (appMatch) {
    const developerId = decodeURIComponent(appMatch[1]);
    const bundleId = decodeURIComponent(appMatch[2]);
    if (developerId && bundleId) return renderAppDetail(developerId, bundleId);
  }
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
  const developerResult = await api("/v1/developers");
  const requestResult = await api("/v1/developer-creation-requests").catch(() => ({ developer_creation_requests: [] }));
  developers = developerResult.developers || [];
  creationRequests = requestResult.developer_creation_requests || [];
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
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
  if (form.classList.contains("certificate-name-form")) {
    await submitForm(form, async () => {
      const values = formValues(form);
      const developerId = form.dataset.developerId;
      const certificateId = form.dataset.certificateId;
      await api(`/v1/developers/${encodeURIComponent(developerId)}/certificates/${encodeURIComponent(certificateId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ display_name: values.display_name.trim() }) });
      showToast("証明書名を更新しました");
      await renderDeveloperDetail(developerId);
    });
  }
  if (form.id === "app-store-reserve-form") {
    await submitForm(form, async () => {
      const values = formValues(form);
      const developerId = form.dataset.developerId;
      await api(`/v1/app-store/developers/${encodeURIComponent(developerId)}/bundle-ids`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      showToast("Bundle IDを予約しました");
      await renderDeveloperDetail(developerId);
    });
  }
  if (form.id === "app-store-create-form") {
    await submitForm(form, async () => {
      const values = formValues(form);
      const developerId = form.dataset.developerId;
      const result = await api(`/v1/app-store/developers/${encodeURIComponent(developerId)}/apps`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      showToast("アプリ情報を作成しました");
      window.location.hash = `#developers/${encodeURIComponent(developerId)}/apps/${encodeURIComponent(result.app.bundle_id)}`;
    });
  }
  if (form.id === "app-store-edit-form") {
    await submitForm(form, async () => {
      const values = formValues(form);
      const developerId = form.dataset.developerId;
      const bundleId = form.dataset.bundleId;
      for (const name of ["subtitle", "icon_url", "category", "age_rating"]) values[name] = values[name].trim() || null;
      values.display_name = values.display_name.trim();
      values.description = values.description.trim();
      await api(`/v1/app-store/developers/${encodeURIComponent(developerId)}/apps/${encodeURIComponent(bundleId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      showToast("アプリ情報を更新しました");
      await renderAppDetail(developerId, bundleId);
    });
  }
  if (form.id === "app-store-release-form") {
    await submitForm(form, async () => {
      const values = formValues(form);
      const developerId = form.dataset.developerId;
      const bundleId = values.bundle_id;
      delete values.bundle_id;
      await api(`/v1/app-store/developers/${encodeURIComponent(developerId)}/apps/${encodeURIComponent(bundleId)}/releases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      showToast("App Storeの審査に提出しました。");
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
      await api(`/v1/app-store/reviews/${encodeURIComponent(releaseId)}/reject`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason_code: values.reason_code, note: values.note.trim() }) });
      showToast("Releaseを却下しました");
      window.location.hash = "#reviews";
    });
  }
  if (form.classList.contains("developer-review-form")) {
    await submitForm(form, async () => {
      const action = form.dataset.reviewAction;
      const values = formValues(form);
      const options = { method: "POST" };
      if (action === "reject" || action === "revoke" || action === "suspend") {
        options.headers = { "Content-Type": "application/json" };
        options.body = JSON.stringify({ reason: values.reason.trim(), reason_code: values.reason_code || null });
      }
      await api(`/v1/developer-reviews/${encodeURIComponent(form.dataset.kind)}/${encodeURIComponent(form.dataset.resourceId)}/${encodeURIComponent(action)}`, options);
      showToast(action === "reject" ? "申請を却下しました" : action === "revoke" ? "Certificateを失効しました" : action === "suspend" ? "利用を停止しました" : "利用を再開しました");
      await renderDeveloperReviews();
    });
  }
  if (form.classList.contains("package-management-form")) {
    await submitForm(form, async () => {
      const action = form.dataset.actionName;
      const values = formValues(form);
      const options = { method: "POST" };
      if (action === "suspend") {
        options.headers = { "Content-Type": "application/json" };
        options.body = JSON.stringify({ reason: values.reason.trim() });
      }
      await api(`/v1/app-store/packages/${encodeURIComponent(form.dataset.bundleId)}/${action}`, options);
      showToast(action === "suspend" ? "パッケージを停止しました" : "パッケージを再開しました");
      await renderReviews();
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
