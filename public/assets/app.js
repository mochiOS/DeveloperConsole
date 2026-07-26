const app = document.querySelector("#app");
const toastRegion = document.querySelector("#toast-region");

let account = null;
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

function topbar() {
  return `<header class="topbar"><div class="topbar__inner">
    <a class="brand" href="#overview" aria-label="mochiOS Console">
      <span>mochiOS <span class="brand__product">Console</span></span>
    </a>
    ${account ? `<button class="account-menu" type="button" data-action="logout" title="ログアウト"><span>${escapeHtml(account.name)}</span><span class="account-avatar">${escapeHtml(initials(account.name))}</span></button>` : ""}
  </div></header>`;
}

function footer() {
  return `<footer class="footer">Copyright © 2026 mochiOS team · Developer Console</footer>`;
}

function renderLogin() {
  document.title = "mochiOS Console";
  app.innerHTML = `<div class="login">${topbar()}<main class="login-main">
    <section>
      <h1>Easy to develop</h1>
      <p class="login-lead">Developerアカウント、チーム、署名証明書を安全に管理します。認証はmochiOS IDで行い、秘密鍵はお使いの端末から送信されません。</p>
      <div class="login-features"><span>Developerアカウントの管理</span><span>メンバーと権限管理</span><span>Certificate申請</span></div>
    </section>
    <section class="login-card" aria-labelledby="login-title">
      <h2 id="login-title">ログイン</h2>
      <p>mochiOS IDを使用します。ConsoleへGitHubのパスワードやアクセストークンが共有されることはありません。</p>
      <a class="button button--primary button--wide" href="/v1/auth/start">${icon("person")}mochiOS IDで続ける</a>
    </section>
  </main>${footer()}</div>`;
}

function activeRoute() {
  const hash = window.location.hash || "#overview";
  if (hash.startsWith("#developers")) return "developers";
  if (hash === "#requests") return "requests";
  return "overview";
}

function sidebar() {
  const active = activeRoute();
  return `<aside class="sidebar"><p class="sidebar__label">WORKSPACE</p><nav aria-label="Consoleナビゲーション">
    <a href="#overview" ${active === "overview" ? 'aria-current="page"' : ""}>${icon("dashboard")}概要</a>
    <a href="#developers" ${active === "developers" ? 'aria-current="page"' : ""}>${icon("badge")}Developers</a>
    <a href="#requests" ${active === "requests" ? 'aria-current="page"' : ""}>${icon("description")}追加申請</a>
  </nav><div class="sidebar__account"><p class="sidebar__label">ACCOUNT</p><nav>
    <a href="https://accounts.mochios.org/#account" target="_blank" rel="noopener noreferrer">${icon("settings")}Account設定</a>
  </nav></div></aside>`;
}

function shell(content) {
  return `${topbar()}<div class="workspace">${sidebar()}<main class="main">${content}</main></div>${footer()}`;
}

function heading(kicker, title, description, action = "") {
  return `<header class="page-heading"><div class="page-heading__copy"><p>${escapeHtml(kicker)}</p><h1>${escapeHtml(title)}</h1><span>${escapeHtml(description)}</span></div>${action}</header>`;
}

function statusBadge(value, kind = "status") {
  const labels = {
    active: "有効", suspended: "停止中", deleted: "削除済み",
    pending: "審査中", verified: "確認済み", rejected: "却下", approved: "承認済み", consumed: "使用済み",
    individual: "個人", organization: "組織", owner: "Owner", admin: "Admin", developer: "Developer", viewer: "Viewer",
    invited: "招待中", removed: "削除済み", issued: "発行済み", revoked: "失効済み",
  };
  const style = ["active", "verified", "approved", "issued"].includes(value)
    ? "success" : ["pending", "invited"].includes(value) ? "warning" : ["suspended", "deleted", "rejected", "revoked", "removed"].includes(value) ? "danger" : "neutral";
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
  document.title = "概要 | mochiOS Console";
  app.innerHTML = shell(`${heading("mochiOS Console", `こんにちは、${account.name}`, "Developerアカウントと証明書の状態を確認できます。")}
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
  document.title = "Developers | mochiOS Console";
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
  document.title = "追加申請 | mochiOS Console";
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
    document.title = `${developer.display_name} | mochiOS Console`;
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
          ${certificates.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>証明書</th><th>状態</th><th>有効期限</th></tr></thead><tbody>${certificates.map((item) => `<tr><td><code>${escapeHtml(item.id)}</code></td><td>${statusBadge(item.status)}</td><td>${formatDate(item.certificate?.not_after)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">${icon("key")}<h3>証明書はありません</h3><p>審査完了後、公開鍵を使って発行申請できます。</p></div>`}
        </section>
        <form class="card" id="certificate-request-form" data-developer-id="${escapeHtml(developer.id)}"><div class="card__header"><div><h3>証明書を申請</h3><p>秘密鍵ではなくEd25519公開鍵だけを入力します。</p></div></div><div class="card__body form">
          <label class="field"><span>公開鍵（Base64）</span><textarea class="textarea" name="subject_public_key" required></textarea><small>32 byteのEd25519公開鍵をBase64で入力してください。</small></label>
          <label class="field"><span>Package IDスコープ</span><input class="input" name="package_id_scopes" placeholder="org.mochios.example.*" required><small>複数の場合はカンマで区切ります。</small></label>
          <label class="field"><span>許可Capability</span><input class="input" name="allowed_capabilities" placeholder="network, notifications"><small>複数の場合はカンマで区切ります。</small></label>
          <span class="field-error" data-error hidden></span>
        </div><div class="card__footer"><button class="button button--primary" type="submit" ${developer.verification_status !== "verified" ? "disabled title=\"Developerの確認完了後に申請できます\"" : ""}>発行を申請</button></div></form>
      </div></section>`);
  } catch (error) {
    if (requestId !== detailRequestId) return;
    app.innerHTML = shell(`${heading("DEVELOPER", "読み込めませんでした", error.message)}<div class="card empty">${icon("error")}<h3>Developer情報を取得できません</h3><p><a class="button button--secondary" href="#developers">一覧へ戻る</a></p></div>`);
  }
}

async function renderRoute() {
  if (!account) return renderLogin();
  const hash = window.location.hash || "#overview";
  if (hash.startsWith("#developers/")) {
    const id = decodeURIComponent(hash.slice("#developers/".length));
    if (id) return renderDeveloperDetail(id);
  }
  detailRequestId += 1;
  if (hash === "#developers") return renderDevelopers();
  if (hash === "#requests") return renderRequests();
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
  if (button.dataset.action === "logout") {
    button.disabled = true;
    try {
      await api("/v1/session/logout", { method: "POST" });
      account = null;
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
  if (form.id === "certificate-request-form") {
    await submitForm(form, async () => {
      const values = formValues(form);
      const developerId = form.dataset.developerId;
      const payload = { signature_algorithm: "ed25519", subject_public_key: values.subject_public_key.trim(), package_id_scopes: commaList(values.package_id_scopes), allowed_capabilities: commaList(values.allowed_capabilities) };
      await api(`/v1/developers/${encodeURIComponent(developerId)}/certificate-requests`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      showToast("Certificate発行を申請しました");
      await renderDeveloperDetail(developerId);
    });
  }
});

window.addEventListener("hashchange", () => void renderRoute());

async function initialize() {
  try {
    const result = await api("/v1/session/me");
    account = result.account;
    await refreshWorkspace();
  } catch (error) {
    if (error.status !== 401) showToast("Consoleを読み込めませんでした", error.message, "error");
  }
  await renderRoute();
}

void initialize();
