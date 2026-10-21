import { html, useData, Loading, Link, atLeast } from '../ui.js';

function People({ list, empty = '—' }) {
  if (!list.length) return html`<span class="muted small">${empty}</span>`;
  return html`<div class="people">${list.map((p) => html`<span class="person-chip">${p.name}${p.zalo_linked ? '' : html`<small class="muted"> ·chưa Zalo</small>`}</span>`)}</div>`;
}

export function OrgView({ me }) {
  const st = useData('/api/org');
  if (!st.data) return html`<${Loading} state=${st} />`;
  const o = st.data;
  return html`<div class="stack">
    <p class="muted small">Sơ đồ tự cập nhật theo vai trò và tổ của từng người trong mục Nhân viên. Việc báo lên cấp trên đi theo chiều mũi tên.</p>
    ${atLeast(me, 'manager') ? html`<div class="row wrap"><${Link} href="/cai-dat?tab=to" class="btn-link">+ Thêm / sửa bộ phận (tổ)<//><${Link} href="/nhan-vien" class="btn-link">Xếp người vào tổ<//></div>` : null}
    <div class="org">
      <div class="org-level"><div class="org-box top"><div class="org-role">Chủ</div><${People} list=${o.owners} /></div></div>
      <div class="org-arrow">↓</div>
      <div class="org-level"><div class="org-box"><div class="org-role">Quản lý</div><${People} list=${o.managers} empty="Chưa có quản lý" /></div></div>
      <div class="org-arrow">↓</div>
      <div class="org-level"><div class="org-box"><div class="org-role">Trưởng ca</div><${People} list=${o.shift_leads} empty="Chưa có trưởng ca" /></div></div>
      <div class="org-arrow">↓</div>
      <div class="org-teams">
        ${o.teams.map((t) => html`<div class="org-box team">
          <div class="org-role">${t.name}</div>
          <div class="org-sub">Tổ trưởng</div><${People} list=${t.leads} empty="Chưa có" />
          <div class="org-sub">Nhân viên (${t.members.length})</div><${People} list=${t.members} empty="Chưa có" />
          ${t.backups.length ? html`<div class="org-sub">Làm thay được</div><${People} list=${t.backups} />` : null}
        </div>`)}
      </div>
      ${o.unassigned.length ? html`<div class="org-box"><div class="org-role">Chưa có tổ</div><${People} list=${o.unassigned} /></div>` : null}
    </div>
    <section class="card">
      <h3>Báo việc theo cấp</h3>
      <ul class="plain">
        <li><b>Xin nghỉ:</b> Nhân viên gửi đơn → Tổ trưởng/Trưởng ca nhờ người thay → người được nhờ bấm nhận → Quản lý duyệt.</li>
        <li><b>Đi trễ, chấm công ngoài lịch, quên chấm ra:</b> báo Tổ trưởng của tổ, Trưởng ca và Quản lý.</li>
        <li><b>Giao việc:</b> Tổ trưởng giao trong tổ mình; Trưởng ca trở lên giao cho mọi tổ.</li>
        <li><b>Thông báo gấp</b> (nhờ làm thay, việc gấp) gửi cả trong giờ yên lặng ban đêm.</li>
      </ul>
    </section>
  </div>`;
}
