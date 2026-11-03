/* app.js —— 移动端填报页逻辑 */
(function () {
  'use strict';
  const C = window.AppCalc;
  const $ = sel => document.querySelector(sel);
  const LS_KEY = 'kongzhifang_draft_v1';

  let CONFIG = null;
  let draft = loadDraft();
  let currentProjectId = null;

  // ---------- 工具 ----------
  function loadDraft() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveDraft() { localStorage.setItem(LS_KEY, JSON.stringify(draft)); }
  function toast(msg, type) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast show' + (type ? ' ' + type : '');
    setTimeout(() => { t.className = 'toast' + (type ? ' ' + type : ''); }, 2200);
  }
  function showModal(html) {
    $('#modal').innerHTML = html;
    $('#mask').classList.add('show');
  }
  function hideModal() { $('#mask').classList.remove('show'); }

  function getProject(id) { return CONFIG.projects.find(p => String(p.id) === String(id)); }
  function getDraftValues(pid) {
    if (!draft.values) draft.values = {};
    if (!draft.values[pid]) {
      draft.values[pid] = {};
      C.FEE_TYPES.forEach(f => {
        const lines = getProject(pid).fees[f] || [];
        draft.values[pid][f] = lines.map(() => ({ 10: null, 11: null, 12: null }));
      });
    }
    return draft.values[pid];
  }

  // ---------- 初始化 ----------
  async function init() {
    try {
      const res = await fetch('api/config');
      CONFIG = await res.json();
    } catch (e) { toast('加载配置失败', 'err'); return; }

    // 身份回填
    $('#filler').value = draft.filler || '';
    $('#note').value = draft.note || '';
    buildStrictToggle();

    // 项目下拉
    const sel = $('#projectSel');
    sel.innerHTML = CONFIG.projects.map(p => `<option value="${p.id}">${p.name}（${p.company}）</option>`).join('');
    sel.addEventListener('change', () => selectProject(sel.value));

    // 严格模式
    $('#strictMode').checked = !!draft.strictMode;
    $('#strictMode').addEventListener('change', e => { draft.strictMode = e.target.checked; saveDraft(); });

    // 预估参考开关（默认开启：汇总表先展示含预估的完整口径，与原表一致）
    $('#showEst').checked = true;
    $('#showEst').addEventListener('change', () => renderSummary());

    // 月份区间选择（X月–Y月）：默认全年 1–12
    const ropts = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}月</option>`).join('');
    $('#rangeFrom').innerHTML = ropts; $('#rangeTo').innerHTML = ropts;
    $('#rangeFrom').value = '1'; $('#rangeTo').value = '12';
    $('#rangeFrom').addEventListener('change', () => {
      if (+$('#rangeFrom').value > +$('#rangeTo').value) $('#rangeTo').value = $('#rangeFrom').value;
      renderSummary();
    });
    $('#rangeTo').addEventListener('change', () => {
      if (+$('#rangeTo').value < +$('#rangeFrom').value) $('#rangeFrom').value = $('#rangeTo').value;
      renderSummary();
    });

    // 按钮
    $('#btnDraft').addEventListener('click', onSaveDraft);
    $('#btnSubmit').addEventListener('click', onSubmit);
    $('#btnHelp').addEventListener('click', showHelp);
    $('#btnMy').addEventListener('click', showMy);

    selectProject(CONFIG.projects[0].id);
  }

  function buildStrictToggle() {
    const card = document.querySelector('.card'); // 身份卡
    const div = document.createElement('div');
    div.className = 'toggle-row';
    div.innerHTML = `
      <input type="checkbox" id="strictMode" />
      <label for="strictMode">严格校验模式：若“下月费用高于上月”则<b>直接阻止提交</b>（不勾选则提醒后可继续）</label>`;
    card.appendChild(div);
  }

  function selectProject(pid) {
    currentProjectId = pid;
    const p = getProject(pid);
    $('#projHint').innerHTML = `总户数 <b>${p.totalHouseholds}</b> · 未售(9月基准) <b>${p.unsoldHouseholds}</b> · 投资公司 ${p.company}<br><span style="color:#6b7280">${p.note || ''}</span>`;
    renderFeeTables(p);
    renderSummary();
  }

  // ---------- 明细表 ----------
  function renderFeeTables(p) {
    const vals = getDraftValues(p.id);
    const months = Array.from({ length: 12 }, (_, i) => i + 1);
    let html = '';
    C.FEE_TYPES.forEach(fee => {
      const lines = p.fees[fee] || [];
      html += `<div class="fee-block" style="margin-top:12px">
        <h3 style="font-size:14px;margin:6px 0">${fee}</h3>
        <div class="tablewrap"><table class="grid">
          <thead><tr><th class="rowhead">业态 / 单价</th>` +
        months.map(m => {
          const estBadge = (m >= 10) ? ' <span class="estbadge">估</span>'
            : ((fee === '公摊水电' && m === 9) ? ' <span class="estbadge">估</span>' : '');
          return `<th>${m}月${estBadge}</th>`;
        }).join('') +
        (fee === '公摊水电' ? '<th>25年</th>' : '') +
        `</tr></thead><tbody>`;
      lines.forEach((line, li) => {
        html += `<tr><td class="rowhead">${line.sub}<br><span style="color:#6b7280;font-size:11px">${line.price || line.type || ''}</span></td>`;
        months.forEach(m => {
          if (m <= 9) {
            html += `<td class="actual">${C.fmtMoney(line.monthly[m - 1] || 0)}</td>`;
          } else {
            const actual = vals[fee][li][m];
            const shown = (actual !== null && actual !== undefined && actual !== '') ? actual : line.estimate[m - 10];
            const filled = (actual !== null && actual !== undefined && actual !== '');
            html += `<td class="cell-est"><input type="number" inputmode="decimal" min="0" step="0.01"
              data-fee="${fee}" data-li="${li}" data-m="${m}" value="${shown}"
              class="${filled ? 'filled' : ''}" /></td>`;
          }
        });
        if (fee === '公摊水电') html += `<td class="ref25">${C.fmtMoney(line.price25)}</td>`;
        html += `</tr>`;
      });
      html += `</tbody></table></div></div>`;
    });
    $('#feeTables').innerHTML = html;

    // 绑定输入
    document.querySelectorAll('#feeTables input[type=number]').forEach(inp => {
      inp.addEventListener('input', onCellInput);
    });
  }

  function onCellInput(e) {
    const inp = e.target;
    const fee = inp.dataset.fee, li = +inp.dataset.li, m = +inp.dataset.m;
    const line = getProject(currentProjectId).fees[fee][li];
    const est = line.estimate[m - 10];
    const raw = inp.value.trim();
    const vals = getDraftValues(currentProjectId)[fee][li];
    if (raw === '') {
      vals[m] = null;
      inp.value = est;            // 清空则回退为预估占位
      inp.classList.remove('filled');
    } else {
      const num = Number(raw);
      if (isNaN(num) || num < 0) {
        inp.classList.add('filled');
        toast('请输入非负数值', 'warn');
        return;
      }
      vals[m] = num;
      inp.classList.add('filled');
    }
    saveDraft();
    renderSummary();
  }

  // ---------- 汇总表（锁定） ----------
  function getRange() {
    let f = parseInt($('#rangeFrom').value, 10) || 1;
    let t = parseInt($('#rangeTo').value, 10) || 12;
    if (f > t) { const x = f; f = t; t = x; }
    return { from: f, to: t };
  }

  function renderSummary() {
    const p = getProject(currentProjectId);
    const useEst = $('#showEst').checked;
    const range = getRange();
    const vals = getDraftValues(p.id);
    const row = summaryRow(p, vals, useEst, range);

    // 计算 TOD 小计（跨项目，按当前区间与口径汇总所有项目）
    const tod = { totalHouseholds: 0, unsoldHouseholds: 0, wy: 0, gw: 0, sd: 0, total: 0 };
    CONFIG.projects.forEach(pr => {
      const r = summaryRow(pr, getDraftValues(pr.id), useEst, range);
      tod.totalHouseholds += r.totalHouseholds;
      tod.unsoldHouseholds += r.unsoldHouseholds;
      tod.wy += r.wy; tod.gw += r.gw; tod.sd += r.sd; tod.total += r.total;
    });
    tod.vacancyRate = tod.totalHouseholds ? C.round2(tod.unsoldHouseholds / tod.totalHouseholds * 100) : 0;

    // 仅保留“合计”一列；区间为全年时显示“全年合计”，否则显示“X–Y月合计”
    const totalLabel = (range.from === 1 && range.to === 12) ? '全年合计' : (range.from + '–' + range.to + '月合计');
    const head = `<tr><th>项目</th><th>总户数</th><th>未售</th><th>空置率%</th><th>物业费</th><th>公维金</th><th>水电公摊</th><th>${totalLabel}</th></tr>`;
    const body = CONFIG.projects.map(pr => {
      const r = summaryRow(pr, getDraftValues(pr.id), useEst, range);
      const hl = (pr.id === p.id) ? ' style="outline:2px solid #2b6cb0"' : '';
      return `<tr${hl}><td class="name">${pr.name}</td><td>${r.totalHouseholds}</td><td>${r.unsoldHouseholds}</td><td>${r.vacancyRate}</td>
        <td>${C.fmtMoney(r.wy)}</td><td>${C.fmtMoney(r.gw)}</td><td>${C.fmtMoney(r.sd)}</td>
        <td>${C.fmtMoney(r.total)}</td></tr>`;
    }).join('') +
      `<tr class="tod"><td class="name">TOD小计</td><td>${C.round2(tod.totalHouseholds)}</td><td>${C.round2(tod.unsoldHouseholds)}</td><td>${tod.vacancyRate}</td>
        <td>${C.fmtMoney(tod.wy)}</td><td>${C.fmtMoney(tod.gw)}</td><td>${C.fmtMoney(tod.sd)}</td>
        <td>${C.fmtMoney(tod.total)}</td></tr>
       <tr class="locked-note"><td colspan="8">说明：以上由系统按公式自动计算并锁定；1–9月为已填实际（灰色锁定），10–12月按“实际填报值”或“预估参考”口径在所选区间内汇总。空置率=未售户数/总户数（依据9月基准）。可在上方切换汇总月份区间。</td></tr>`;
    $('#summaryTable').innerHTML = head + body;

    const inc = row.estimateMonthsIncluded;
    $('#summaryHint').textContent = useEst
      ? `当前为“预估参考”口径：所选区间内未实际填报的 ${inc} 个10–12月单元格按预估值占位。`
      : `当前为“纯实际”口径：所选区间内未填报的10–12月不计入统计（共 ${inc} 个单元格待填报）。`;
  }

  function summaryRow(p, vals, useEst, range) {
    // 各费种在所选区间内的合计（含/不含预估）
    const comp = C.computeProject(p, vals, useEst, range);
    const wy = comp.fees['物业费'], gw = comp.fees['公维金'], sd = comp.fees['公摊水电'];
    return {
      totalHouseholds: Number(p.totalHouseholds || 0),
      unsoldHouseholds: Number(p.unsoldHouseholds || 0),
      vacancyRate: p.totalHouseholds ? C.round2(p.unsoldHouseholds / p.totalHouseholds * 100) : 0,
      wy, gw, sd, total: comp.total,
      estimateMonthsIncluded: comp.estimateMonthsIncluded,
    };
  }

  // ---------- 草稿 / 提交 ----------
  function onSaveDraft() {
    draft.filler = $('#filler').value.trim();
    draft.note = $('#note').value.trim();
    saveDraft();
    toast('草稿已保存到本机', 'ok');
  }

  function collectPayload() {
    const p = getProject(currentProjectId);
    const vals = getDraftValues(p.id);
    // 仅提交 10-12 实际/空值（空=使用预估）
    const out = {};
    C.FEE_TYPES.forEach(fee => {
      const lines = p.fees[fee] || [];
      out[fee] = lines.map((line, li) => ({
        10: norm(vals[fee][li][10]),
        11: norm(vals[fee][li][11]),
        12: norm(vals[fee][li][12]),
      }));
    });
    return {
      projectId: p.id,
      filler: $('#filler').value.trim(),
      note: $('#note').value.trim(),
      values: out,
    };
  }
  function norm(v) { return (v === null || v === undefined || v === '') ? null : Number(v); }

  async function onSubmit() {
    const payload = collectPayload();
    if (!payload.filler) { toast('请填写填写人姓名', 'warn'); $('#filler').focus(); return; }

    // 基础数值校验
    const p = getProject(currentProjectId);
    for (const fee of C.FEE_TYPES) {
      const lines = p.fees[fee] || [];
      for (let li = 0; li < lines.length; li++) {
        for (const m of C.ESTIMATE_MONTHS) {
          const v = payload.values[fee][li][m];
          if (v !== null && (isNaN(v) || v < 0)) { toast(`${fee}/${lines[li].sub}/${m}月须为非负数`, 'warn'); return; }
        }
      }
    }

    // 下月不得高于上月校验
    const violations = C.checkMonthOrder(p, getDraftValues(p.id));
    if (violations.length) {
      const strict = !!draft.strictMode;
      showViolationModal(violations, strict);
      return;
    }
    doSubmit(payload);
  }

  function showViolationModal(violations, strict) {
    const items = violations.map(v =>
      `<li>${v.fee} · ${v.sub}：${v.fromMonth}月 ${C.fmtMoney(v.fromVal)} → ${v.toMonth}月 ${C.fmtMoney(v.toVal)}（上升）</li>`).join('');
    const allowContinue = strict ? '' : `<button class="btn btn-ghost" id="mViolContinue">我确认无误，仍要提交</button>`;
    showModal(`<h3>⚠️ 校验提醒：下月费用高于上月</h3>
      <p style="font-size:13px;color:#374151">以下单元格“下月费用”高于“上月”（物业费/公维金规则）：</p>
      <ul>${items}</ul>
      ${strict ? '<p style="color:#e03131;font-size:13px">当前为<strong>严格模式</strong>，须先修改后方可提交。</p>' : '<p style="font-size:13px;color:#6b7280">可返回修改，或确认无误后继续提交。</p>'}
      <div class="row">
        <button class="btn btn-ghost" id="mViolBack">返回修改</button>
        ${allowContinue}
      </div>`);
    $('#mViolBack').onclick = hideModal;
    if (!strict) $('#mViolContinue').onclick = () => { hideModal(); doSubmit(collectPayload()); };
  }

  async function doSubmit(payload) {
    try {
      const res = await fetch('api/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) { toast('提交失败：' + (data.error || ''), 'err'); return; }
      toast('✅ 提交成功！可继续修改并再次提交', 'ok');
      // 清空本项目已填值（保留身份），便于下次重新填报
      delete draft.values[payload.projectId];
      saveDraft();
      renderFeeTables(getProject(payload.projectId));
      renderSummary();
    } catch (e) { toast('网络错误，提交失败', 'err'); }
  }

  // ---------- 填报说明 / 口径决策 ----------
  function showHelp() {
    showModal(`<h3>填报说明与默认决策</h3>
      <p style="font-size:13px;color:#374151"><b>一、怎么填</b><br>
      1–9月为已填实际，系统锁定只读；10–12月的空置物业费、公维金、水电公摊为在线填写字段。
      原预估值以<b>浅灰虚线</b>占位显示，输入实际值后自动变白底覆盖；未修改的预估值<b>不计入“实际统计”</b>。</p>
      <p style="font-size:13px;color:#374151"><b>二、已定的默认决策（待你复核）</b><br>
      ① <b>空置率口径</b>：维持与源表一致——未售户数/空置率仅含住宅未售（9月基准）。如南部新城未售=0（车位未售未计入），如需含车位请告知调整。<br>
      ② <b>填写范围/频次</b>：每个项目可由指定填报人填报，10–12月一次性填报，支持多次提交（取最新），无需每月分开。<br>
      ③ <b>字段结构</b>：10–12月仅空置物业费/公维金/水电公摊三类；公维金南部新城为0（无行）；“25年”历史列仅展示不参与填报。<br>
      ④ <b>校验强度</b>：“下月费用不得高于上月”（物业费/公维金）默认<b>提醒后可继续</b>，可在本页切换为<b>严格阻止</b>。<br>
      ⑤ <b>部署方式</b>：已发布/可发布为公网 HTTPS 链接，微信群内直接打开填写；管理端用管理员密钥保护。</p>
      <p style="font-size:13px;color:#6b7280">如有异议，明天上午告诉我要改哪条即可。</p>
      <div class="row"><button class="btn btn-primary" id="mHelpClose">知道了</button></div>`);
    $('#mHelpClose').onclick = hideModal;
  }

  // ---------- 我的提交记录 ----------
  async function showMy() {
    const filler = $('#filler').value.trim();
    const pid = currentProjectId;
    if (!filler) { toast('请先填写填写人姓名', 'warn'); $('#filler').focus(); return; }
    try {
      const r = await fetch('api/my?projectId=' + encodeURIComponent(pid) + '&filler=' + encodeURIComponent(filler));
      const d = await r.json();
      if (!d.ok) { toast('查询失败', 'err'); return; }
      const rows = d.submissions.length
        ? d.submissions.map(s => `<li><b>${s.id}</b> · ${(s.submittedAt || '').replace('T', ' ').slice(0, 19)}${s.note ? ' · 备注:' + s.note : ''}</li>`).join('')
        : '<li>暂无提交记录</li>';
      showModal(`<h3>我的提交记录（${filler}）</h3>
        <p style="font-size:13px;color:#6b7280">共 ${d.count} 条。多次提交时，管理端汇总取各单元格最新值。</p>
        <ul>${rows}</ul>
        <div class="row"><button class="btn btn-primary" id="mMyClose">关闭</button></div>`);
      $('#mMyClose').onclick = hideModal;
    } catch (e) { toast('网络错误', 'err'); }
  }

  init();
})();
