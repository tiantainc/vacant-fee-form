#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * 空置房费用在线填报工具 —— 零依赖 Node 后端
 * 启动： node server.js   （可选环境变量 PORT / ADMIN_KEY / DATA_DIR）
 *
 * 接口：
 *   GET  /api/config            公开：返回填报结构（项目/业态/1-9实际/10-12预估）
 *   POST /api/submit            公开：提交一次填报（仅 10-12 月实际值），返回 {ok,id}
 *   GET  /api/submissions       管理：返回全部提交列表（需 ?key=）
 *   GET  /api/summary?from&to   管理：按月份区间聚合（区分 实际 / 预估参考）（需 ?key=）
 *   GET  /api/export?format     管理：导出 CSV / XLS（需 ?key=）
 *   GET  /*                     托管 public/ 静态资源
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const SUB_PATH = path.join(DATA_DIR, 'submissions.json');
const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xls': 'application/vnd.ms-excel; charset=utf-8',
  '.ico': 'image/x-icon',
};

let CONFIG = null;
try { CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
catch (e) { console.error('读取 config.json 失败:', e.message); process.exit(1); }

function loadSubs() {
  try { return JSON.parse(fs.readFileSync(SUB_PATH, 'utf8')); }
  catch (e) { return []; }
}
function saveSubs(arr) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SUB_PATH, JSON.stringify(arr, null, 2), 'utf8');
}
if (!fs.existsSync(SUB_PATH)) saveSubs([]);

// ---------- 计算工具 ----------
const ACTUAL_MONTHS = CONFIG.meta.actualMonths;       // [1..9]
const ESTIMATE_MONTHS = CONFIG.meta.estimateMonths;   // [10,11,12]
const ALL_MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

function isActualMonth(m) { return m <= 9; }

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

/** 取某项目某业态明细行在指定月份的“基础值”（1-9实际 / 10-12预估）。*/
function baseValue(line, month) {
  return line.monthly[month - 1] || 0;
}

/** 把提交集合聚合成 “lineKey#month -> 最近一次实际填写值”。lineKey = fee#lineIdx */
function buildActualMap(subs, projectId) {
  const map = {}; // key -> {value, ts}
  subs.filter(s => String(s.projectId) === String(projectId))
    .sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt))
    .forEach(s => {
      const vals = s.values || {};
      Object.keys(vals).forEach(fee => {
        (vals[fee] || []).forEach((lineObj, li) => {
          if (!lineObj) return;
          Object.keys(lineObj).forEach(mStr => {
            const m = parseInt(mStr, 10);
            const v = lineObj[mStr];
            if (v === null || v === undefined || v === '') return;
            const key = fee + '#' + li + '#' + m;
            map[key] = { value: Number(v), ts: s.submittedAt };
          });
        });
      });
    });
  return map;
}

/**
 * 计算某项目在 [from,to] 区间内、各费种的实际/预估合计。
 * @param actualMap 聚合后的实际值映射
 * @param useActualOnly true=仅计入实际填写值（未填的10-12记0）；false=用预估占位
 */
function computeProjectRange(project, from, to, actualMap, useActualOnly) {
  const fees = {};
  let estimateMonthsIncluded = 0;
  CONFIG.meta.feeTypes.forEach(fee => {
    const lines = project.fees[fee] || [];
    let sum = 0;
    lines.forEach((line, li) => {
      ALL_MONTHS.forEach(m => {
        if (m < from || m > to) return;
        if (isActualMonth(m)) {
          sum += baseValue(line, m);
        } else {
          const key = fee + '#' + li + '#' + m;
          const actual = actualMap[key];
          if (actual) {
            sum += actual.value;
          } else {
            if (!useActualOnly) sum += baseValue(line, m); // 用预估占位
            else estimateMonthsIncluded++; // 实际口径下，未填的预估月不计入
          }
        }
      });
    });
    fees[fee] = round2(sum);
  });
  return { fees, estimateMonthsIncluded };
}

function computeSummary(from, to, subs) {
  from = Math.max(1, Math.min(12, parseInt(from, 10) || 1));
  to = Math.max(from, Math.min(12, parseInt(to, 10) || 12));
  const projects = CONFIG.projects.map(p => {
    const actMap = buildActualMap(subs, p.id);
    const actual = computeProjectRange(p, from, to, actMap, true);
    const ref = computeProjectRange(p, from, to, actMap, false);
    const feeActual = actual.fees, feeRef = ref.fees;
    const totalActual = round2(CONFIG.meta.feeTypes.reduce((s, f) => s + feeActual[f], 0));
    const totalRef = round2(CONFIG.meta.feeTypes.reduce((s, f) => s + feeRef[f], 0));
    return {
      id: p.id, name: p.name, company: p.company,
      totalHouseholds: p.totalHouseholds,
      unsoldHouseholds: p.unsoldHouseholds,
      vacancyRate: p.totalHouseholds ? round2(p.unsoldHouseholds / p.totalHouseholds * 100) : 0,
      feesActual: feeActual, feesRef: feeRef,
      totalActual, totalRef,
      estimateMonthsIncluded: actual.estimateMonthsIncluded,
    };
  });
  // TOD 小计
  const tod = {
    totalHouseholds: round2(projects.reduce((s, p) => s + Number(p.totalHouseholds || 0), 0)),
    unsoldHouseholds: round2(projects.reduce((s, p) => s + Number(p.unsoldHouseholds || 0), 0)),
    feesActual: {}, feesRef: {},
    totalActual: round2(projects.reduce((s, p) => s + p.totalActual, 0)),
    totalRef: round2(projects.reduce((s, p) => s + p.totalRef, 0)),
  };
  CONFIG.meta.feeTypes.forEach(f => {
    tod.feesActual[f] = round2(projects.reduce((s, p) => s + p.feesActual[f], 0));
    tod.feesRef[f] = round2(projects.reduce((s, p) => s + p.feesRef[f], 0));
  });
  tod.vacancyRate = tod.totalHouseholds ? round2(tod.unsoldHouseholds / tod.totalHouseholds * 100) : 0;
  return { from, to, projects, tod, submissionCount: subs.length };
}

// ---------- HTTP ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) reject(new Error('body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function adminOk(reqUrl) {
  const q = url.parse(reqUrl, true).query;
  return q.key === ADMIN_KEY;
}

function buildCSV(subs, summary) {
  // 行级明细：每条提交展开为 项目/填写人/提交时间/费种/业态/10/11/12/是否实际
  const rows = [['提交ID', '项目', '填写人', '提交时间', '费种', '业态', '10月', '11月', '12月', '数据性质']];
  subs.forEach(s => {
    const p = CONFIG.projects.find(x => String(x.id) === String(s.projectId));
    const pname = p ? p.name : s.projectId;
    CONFIG.meta.feeTypes.forEach(fee => {
      const lines = (p ? p.fees[fee] : []) || [];
      const arr = (s.values && s.values[fee]) || [];
      lines.forEach((line, li) => {
        const obj = arr[li] || {};
        [10, 11, 12].forEach(m => {
          const v = obj[m];
          const nature = (v === null || v === undefined || v === '') ? '预估(未填)' : '实际';
          rows.push([s.id, pname, s.filler || '', s.submittedAt || '', fee, line.sub,
            (v === null || v === undefined || v === '') ? (line.estimate[m - 10] || 0) : v, '', '', nature].map(x => x));
        });
      });
    });
  });
  // 汇总表附加
  rows.push([]);
  rows.push(['汇总表（区间 ' + summary.from + '月-' + summary.to + '月，实际口径）']);
  rows.push(['项目', '投资公司', '总户数', '未售户数', '空置率%', '物业费', '公维金', '水电公摊', '合计']);
  summary.projects.forEach(p => {
    rows.push([p.name, p.company, p.totalHouseholds, p.unsoldHouseholds, p.vacancyRate,
      p.feesActual['物业费'], p.feesActual['公维金'], p.feesActual['公摊水电'], p.totalActual]);
  });
  rows.push(['TOD小计', '', p_total(summary, 'totalHouseholds'), p_total(summary, 'unsoldHouseholds'),
    summary.tod.vacancyRate, summary.tod.feesActual['物业费'], summary.tod.feesActual['公维金'],
    summary.tod.feesActual['公摊水电'], summary.tod.totalActual]);
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}
function csvCell(v) {
  const s = String(v == null ? '' : v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function p_total(summary, key) {
  return round2(summary.projects.reduce((s, p) => s + Number(p[key] || 0), 0));
}

function buildXLS(subs, summary) {
  // 生成 Excel 可直接打开的 SpreadsheetML 2003（.xls）
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let rows = '';
  const add = (cells, bold) => {
    rows += '<Row>';
    cells.forEach(c => {
      rows += '<Cell><Data ss:Type="' + (isNaN(c) ? 'String' : 'Number') + '">' + esc(c) + '</Data></Cell>';
    });
    rows += '</Row>';
  };
  add(['提交ID', '项目', '填写人', '提交时间', '费种', '业态', '10月', '11月', '12月', '数据性质']);
  subs.forEach(s => {
    const p = CONFIG.projects.find(x => String(x.id) === String(s.projectId));
    const pname = p ? p.name : s.projectId;
    CONFIG.meta.feeTypes.forEach(fee => {
      const lines = (p ? p.fees[fee] : []) || [];
      const arr = (s.values && s.values[fee]) || [];
      lines.forEach((line, li) => {
        const obj = arr[li] || {};
        [10, 11, 12].forEach(m => {
          const v = obj[m];
          const nature = (v === null || v === undefined || v === '') ? '预估(未填)' : '实际';
          const val = (v === null || v === undefined || v === '') ? (line.estimate[m - 10] || 0) : v;
          add([s.id, pname, s.filler || '', s.submittedAt || '', fee, line.sub, val === '' ? '' : val, '', '', nature]);
        });
      });
    });
  });
  rows += '<Row/>';
  add(['汇总表（区间 ' + summary.from + '月-' + summary.to + '月，实际口径）']);
  add(['项目', '投资公司', '总户数', '未售户数', '空置率%', '物业费', '公维金', '水电公摊', '合计']);
  summary.projects.forEach(p => {
    add([p.name, p.company, p.totalHouseholds, p.unsoldHouseholds, p.vacancyRate,
      p.feesActual['物业费'], p.feesActual['公维金'], p.feesActual['公摊水电'], p.totalActual]);
  });
  add(['TOD小计', '', p_total(summary, 'totalHouseholds'), p_total(summary, 'unsoldHouseholds'),
    summary.tod.vacancyRate, summary.tod.feesActual['物业费'], summary.tod.feesActual['公维金'],
    summary.tod.feesActual['公摊水电'], summary.tod.totalActual]);
  return '<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    '<Worksheet ss:Name="空置房费用导出"><Table>' + rows + '</Table></Worksheet></Workbook>';
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);
  try {
    if (pathname === '/api/config' && req.method === 'GET') {
      return sendJSON(res, 200, CONFIG);
    }
    if (pathname === '/api/submit' && req.method === 'POST') {
      const raw = await readBody(req);
      let body; try { body = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const err = validateSubmit(body);
      if (err) return sendJSON(res, 400, { ok: false, error: err });
      const subs = loadSubs();
      const rec = {
        id: 'S' + Date.now() + Math.floor(Math.random() * 1000),
        projectId: body.projectId,
        filler: String(body.filler || '').slice(0, 30),
        note: String(body.note || '').slice(0, 200),
        monthsCovered: ESTIMATE_MONTHS,
        values: body.values,
        submittedAt: new Date().toISOString(),
        clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      };
      subs.push(rec);
      saveSubs(subs);
      return sendJSON(res, 200, { ok: true, id: rec.id, submittedAt: rec.submittedAt });
    }
    if (pathname === '/api/submissions' && req.method === 'GET') {
      if (!adminOk(req.url)) return sendJSON(res, 401, { ok: false, error: '需要管理员密钥 ?key=' });
      const subs = loadSubs().slice().reverse();
      return sendJSON(res, 200, { ok: true, count: subs.length, submissions: subs });
    }
    if (pathname === '/api/summary' && req.method === 'GET') {
      if (!adminOk(req.url)) return sendJSON(res, 401, { ok: false, error: '需要管理员密钥 ?key=' });
      const subs = loadSubs();
      const summary = computeSummary(parsed.query.from, parsed.query.to, subs);
      return sendJSON(res, 200, { ok: true, summary });
    }
    if (pathname === '/api/export' && req.method === 'GET') {
      if (!adminOk(req.url)) return sendJSON(res, 401, { ok: false, error: '需要管理员密钥 ?key=' });
      const subs = loadSubs();
      const summary = computeSummary(parsed.query.from, parsed.query.to, subs);
      const format = (parsed.query.format || 'csv').toLowerCase();
      if (format === 'xls') {
        const xls = buildXLS(subs, summary);
        res.writeHead(200, { 'Content-Type': MIME['.xls'], 'Content-Disposition': "attachment; filename=\"kongzhifang_export.xls\"; filename*=UTF-8''kongzhifang_export.xls" });
        return res.end(xls);
      }
      const csv = '﻿' + buildCSV(subs, summary); // BOM 保证 Excel 正确识别 UTF-8
      res.writeHead(200, { 'Content-Type': MIME['.csv'], 'Content-Disposition': "attachment; filename=\"kongzhifang_export.csv\"; filename*=UTF-8''kongzhifang_export.csv" });
      return res.end(csv);
    }
    if (pathname === '/api/my' && req.method === 'GET') {
      // 公开：填报人查看自己的提交（仅返回元信息，不含全部明细）
      const pid = parsed.query.projectId;
      const filler = (parsed.query.filler || '').trim();
      const subs = loadSubs().filter(s =>
        String(s.projectId) === String(pid) && (!filler || (s.filler || '') === filler));
      return sendJSON(res, 200, {
        ok: true, count: subs.length,
        submissions: subs.slice().reverse().map(s => ({
          id: s.id, filler: s.filler, submittedAt: s.submittedAt, note: s.note,
        })),
      });
    }
    if (pathname === '/api/clear' && req.method === 'POST') {
      if (!adminOk(req.url)) return sendJSON(res, 401, { ok: false, error: '需要管理员密钥' });
      saveSubs([]);
      return sendJSON(res, 200, { ok: true });
    }
    // 静态资源
    let filePath = path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname);
    filePath = path.normalize(filePath);
    if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(filePath, (e, data) => {
      if (e) {
        // SPA 回退到 index.html
        fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); return res.end('not found'); }
          res.writeHead(404, { 'Content-Type': MIME['.html'] }); res.end(d2);
        });
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: e.message });
  }
});

function validateSubmit(body) {
  if (!body || typeof body !== 'object') return '提交内容为空';
  const p = CONFIG.projects.find(x => String(x.id) === String(body.projectId));
  if (!p) return '项目不存在';
  if (!body.filler || !String(body.filler).trim()) return '请填写填写人姓名';
  if (!body.values || typeof body.values !== 'object') return '缺少填报数据';
  for (const fee of CONFIG.meta.feeTypes) {
    const lines = p.fees[fee] || [];
    const arr = body.values[fee];
    if (!Array.isArray(arr) || arr.length !== lines.length) return ('费种「' + fee + '」行数不匹配');
    for (let li = 0; li < lines.length; li++) {
      const obj = arr[li] || {};
      for (const m of ESTIMATE_MONTHS) {
        const v = obj[m];
        if (v === null || v === undefined || v === '') continue; // 空=使用预估
        const num = Number(v);
        if (isNaN(num) || num < 0) return ('「' + p.name + ' / ' + fee + ' / ' + lines[li].sub + ' / ' + m + '月」须为非负数值');
      }
    }
  }
  return null;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('空置房费用在线填报工具已启动');
  console.log('  填报页:  http://localhost:' + PORT + '/');
  console.log('  管理页:  http://localhost:' + PORT + '/admin.html?key=' + ADMIN_KEY);
  console.log('  管理员密钥(请在生产环境通过 ADMIN_KEY 环境变量修改): ' + ADMIN_KEY);
});
