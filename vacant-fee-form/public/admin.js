/* admin.js —— 管理端：区间汇总、提交查看、导出 */
(function () {
  'use strict';
  const C = window.AppCalc;
  const $ = s => document.querySelector(s);
  let CONFIG = null;

  function toast(msg, type) {
    const t = $('#toast'); t.textContent = msg;
    t.className = 'toast show' + (type ? ' ' + type : '');
    setTimeout(() => { t.className = 'toast' + (type ? ' ' + type : ''); }, 2200);
  }
  function getKey() { return $('#key').value.trim(); }
  function urlParams(extra) {
    const p = 'key=' + encodeURIComponent(getKey());
    return p + (extra ? '&' + extra : '');
  }
  function rememberKey() { try { localStorage.setItem('admin_key', getKey()); } catch (e) {} }
  function restoreKey() { try { const k = localStorage.getItem('admin_key'); if (k) $('#key').value = k; } catch (e) {} }

  function init() {
    // 月份下拉 1-12
    const opts = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}月</option>`).join('');
    $('#fromM').innerHTML = opts; $('#toM').innerHTML = opts;
    $('#fromM').value = '10'; $('#toM').value = '12';

    restoreKey();
    $('#key').addEventListener('input', rememberKey);

    // 从 URL 预填密钥
    const q = new URLSearchParams(location.search);
    if (q.get('key')) { $('#key').value = q.get('key'); rememberKey(); }

    $('#btnSummary').onclick = loadSummary;
    $('#btnCsv').onclick = () => exportFile('csv');
    $('#btnXls').onclick = () => exportFile('xls');
    $('#btnClear').onclick = clearData;

    // 自动加载（若已有密钥）
    if (getKey()) { loadSummary(); loadSubs(); }
  }

  async function clearData() {
    if (!confirm('确认清空全部提交记录？此操作不可恢复。')) return;
    try {
      const r = await fetch('api/clear?' + urlParams(), { method: 'POST' });
      const d = await r.json();
      if (!d.ok) { toast(d.error || '清空失败', 'err'); return; }
      toast('已全部清空', 'ok');
      loadSubs(); renderProgress([]);
    } catch (e) { toast('网络错误', 'err'); }
  }

  async function loadSummary() {
    const from = $('#fromM').value, to = $('#toM').value;
    try {
      const r = await fetch('api/summary?' + urlParams('from=' + from + '&to=' + to));
      const d = await r.json();
      if (!d.ok) { toast(d.error || '汇总失败', 'err'); return; }
      renderSummary(d.summary);
    } catch (e) { toast('网络错误', 'err'); }
  }

  function renderSummary(s) {
    const head = `<tr><th>项目</th><th>投资公司</th><th>总户数</th><th>未售</th><th>空置率%</th>
      <th>物业费(实际)</th><th>公维金(实际)</th><th>水电公摊(实际)</th><th>${s.from}–${s.to}月合计(实际)</th><th>区间合计(预估参考)</th></tr>`;
    const body = s.projects.map(p => `<tr><td class="name">${p.name}</td><td style="text-align:left">${p.company}</td>
      <td>${p.totalHouseholds}</td><td>${p.unsoldHouseholds}</td><td>${p.vacancyRate}</td>
      <td>${C.fmtMoney(p.feesActual['物业费'])}</td><td>${C.fmtMoney(p.feesActual['公维金'])}</td><td>${C.fmtMoney(p.feesActual['公摊水电'])}</td>
      <td>${C.fmtMoney(p.totalActual)}</td><td>${C.fmtMoney(p.totalRef)}</td></tr>`).join('') +
      `<tr class="tod"><td class="name">TOD小计</td><td></td><td>${C.round2(s.tod.totalHouseholds)}</td><td>${C.round2(s.tod.unsoldHouseholds)}</td><td>${s.tod.vacancyRate}</td>
      <td>${C.fmtMoney(s.tod.feesActual['物业费'])}</td><td>${C.fmtMoney(s.tod.feesActual['公维金'])}</td><td>${C.fmtMoney(s.tod.feesActual['公摊水电'])}</td>
      <td>${C.fmtMoney(s.tod.totalActual)}</td><td>${C.fmtMoney(s.tod.totalRef)}</td></tr>`;
    $('#adminSummary').innerHTML = head + body;
  }

  async function loadSubs() {
    try {
      const r = await fetch('api/submissions?' + urlParams());
      const d = await r.json();
      if (!d.ok) { toast(d.error || '获取失败', 'err'); return; }
      renderSubs(d.submissions);
      renderProgress(d.submissions);
    } catch (e) { toast('网络错误', 'err'); }
  }

  function renderProgress(list) {
    if (!CONFIG) { $('#progTable').innerHTML = '<tr><td>加载配置中…</td></tr>'; return; }
    const head = `<tr><th>项目</th><th>10–12月应填单元格</th><th>已实际填报</th><th>覆盖率</th></tr>`;
    const body = CONFIG.projects.map(p => {
      let total = 0;
      C.FEE_TYPES.forEach(f => { total += (p.fees[f] || []).length * 3; });
      const filledSet = new Set();
      (list || []).filter(s => String(s.projectId) === String(p.id)).forEach(s => {
        C.FEE_TYPES.forEach(f => {
          const arr = (s.values && s.values[f]) || [];
          arr.forEach((obj, li) => {
            if (!obj) return;
            [10, 11, 12].forEach(m => {
              const v = obj[m];
              if (v !== null && v !== undefined && v !== '') filledSet.add(f + '#' + li + '#' + m);
            });
          });
        });
      });
      const filled = filledSet.size;
      const pct = total ? Math.round(filled / total * 100) : 0;
      const color = pct === 100 ? '#2f9e44' : (pct > 0 ? '#e8590c' : '#e03131');
      return `<tr><td class="name" style="text-align:left">${p.name}</td><td>${total}</td><td>${filled}</td>
        <td style="color:${color};font-weight:700">${pct}%</td></tr>`;
    }).join('');
    $('#progTable').innerHTML = head + body;
  }

  function renderSubs(list) {
    $('#subCount').textContent = '共 ' + list.length + ' 条';
    if (!list.length) { $('#subTable').innerHTML = '<tr><td>暂无提交</td></tr>'; return; }
    const head = `<tr><th>提交ID</th><th>项目</th><th>填写人</th><th>提交时间</th><th>备注</th></tr>`;
    const body = list.map(s => {
      const p = CONFIG ? CONFIG.projects.find(x => String(x.id) === String(s.projectId)) : null;
      const pname = p ? p.name : s.projectId;
      const t = (s.submittedAt || '').replace('T', ' ').slice(0, 19);
      return `<tr><td>${s.id}</td><td class="name" style="text-align:left">${pname}</td><td style="text-align:left">${s.filler || ''}</td>
        <td>${t}</td><td style="text-align:left">${s.note || ''}</td></tr>`;
    }).join('');
    $('#subTable').innerHTML = head + body;
  }

  function exportFile(format) {
    const from = $('#fromM').value, to = $('#toM').value;
    const url = 'api/export?' + urlParams('format=' + format + '&from=' + from + '&to=' + to);
    window.location.href = url;
    toast('已开始导出 ' + format.toUpperCase(), 'ok');
  }

  // 拉取 config 仅用于项目名映射（非必需）
  (async () => {
    try { const r = await fetch('api/config'); CONFIG = await r.json(); } catch (e) {}
    init();
  })();
})();
