/* common.js —— 前后端共享的计算与格式化逻辑（纯前端版） */
(function (global) {
  'use strict';

  const FEE_TYPES = ['物业费', '公维金', '公摊水电'];
  const ACTUAL_MONTHS = Array.from({ length: 9 }, (_, i) => i + 1);   // 1-9 实际
  const ESTIMATE_MONTHS = [10, 11, 12];                              // 10-12 预估/可填

  function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

  function fmtMoney(n) {
    if (n === null || n === undefined || n === '') return '';
    const v = Math.round(Number(n));
    return v.toLocaleString('zh-CN'); // 整数 + 千分位，不保留小数，提升可读性
  }

  /**
   * 计算某项目在填报草稿下的各费种金额。
   * @param project  config 中的项目对象
   * @param draft    {fee:[ {10:val|null,11,12} per line ]}
   * @param useEstimate  true=10-12 未填时用预估占位；false=未填记 0（实际口径）
   * @param range    {from,to} 月份区间（默认 1–12）；填写页可按需选 X月–Y月
   * @returns { fees:{物业费,公维金,公摊水电}, total, estimateMonthsIncluded }
   */
  function computeProject(project, draft, useEstimate, range) {
    const from = (range && range.from != null) ? Math.max(1, range.from) : 1;
    const to = (range && range.to != null) ? Math.min(12, range.to) : 12;
    const fees = {};
    let estimateMonthsIncluded = 0;
    FEE_TYPES.forEach(fee => {
      const lines = project.fees[fee] || [];
      let sum = 0;
      lines.forEach((line, li) => {
        for (let m = from; m <= to; m++) {
          if (m <= 9) {
            sum += line.monthly[m - 1] || 0;          // 1-9 固定实际
          } else {
            const dv = draft && draft[fee] && draft[fee][li] ? draft[fee][li][m] : null;
            if (dv !== null && dv !== undefined && dv !== '') {
              sum += Number(dv);
            } else if (useEstimate) {
              sum += line.estimate[m - 10] || 0;
              estimateMonthsIncluded++;
            }
          }
        }
      });
      fees[fee] = round2(sum);
    });
    return {
      fees,
      total: round2(FEE_TYPES.reduce((s, f) => s + fees[f], 0)),
      estimateMonthsIncluded,
    };
  }

  /**
   * 下月不得高于上月校验（仅 物业费、公维金）。
   * 比较序列：9月(实际) -> 10 -> 11 -> 12（草稿值优先，否则用预估）。
   * @returns 违规数组 [{fee, sub, fromMonth, toMonth, fromVal, toVal}]
   */
  function checkMonthOrder(project, draft) {
    const violations = [];
    ['物业费', '公维金'].forEach(fee => {
      const lines = project.fees[fee] || [];
      lines.forEach((line, li) => {
        const seq = [];
        for (let m = 9; m <= 12; m++) {
          let v;
          if (m <= 9) v = line.monthly[m - 1] || 0;
          else {
            const dv = draft && draft[fee] && draft[fee][li] ? draft[fee][li][m] : null;
            v = (dv !== null && dv !== undefined && dv !== '') ? Number(dv) : (line.estimate[m - 10] || 0);
          }
          seq.push({ m, v });
        }
        for (let i = 1; i < seq.length; i++) {
          if (seq[i].v > seq[i - 1].v + 1e-6) {
            violations.push({
              fee, sub: line.sub,
              fromMonth: seq[i - 1].m, toMonth: seq[i].m,
              fromVal: seq[i - 1].v, toVal: seq[i].v,
            });
          }
        }
      });
    });
    return violations;
  }

  global.AppCalc = {
    FEE_TYPES, ACTUAL_MONTHS, ESTIMATE_MONTHS,
    round2, fmtMoney, computeProject, checkMonthOrder,
  };
})(window);
