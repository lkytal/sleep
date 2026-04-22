/* dashboard.js — Dashboard: mixed bar/line chart + recent records list */
const Dashboard = (() => {
  let chart = null;
  let windowDays = 7;
  let allTags = [];
  let allMeds = [];

  async function init() {
    allTags = await Data.loadTags();
    allMeds = await Data.loadMedications();
    refresh();
  }

  function setWindow(days, btn) {
    windowDays = days;
    document.querySelectorAll('.window-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    refresh();
  }

  function refresh() {
    const records = Data.getRecordsSorted();
    let filtered = records;
    if (windowDays > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - windowDays);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      filtered = records.filter(r => r.date >= cutoffStr);
    }
    renderChart(filtered);
    renderLegend();
    renderRecent(records.slice(-10).reverse());
  }

  /* ---- Chart ---- */
  function renderChart(records) {
    const ctx = document.getElementById('sleep-chart').getContext('2d');
    if (chart) chart.destroy();
    if (records.length === 0) {
      chart = null;
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.fillStyle = '#5a6480';
      ctx.font = '16px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无数据 — 点击「记录」添加第一条', ctx.canvas.width / 2, ctx.canvas.height / 2);
      return;
    }

    const labels = records.map(r => r.date.slice(5)); // MM-DD
    const scores = records.map(r => r.score);
    const durations = records.map(r => -(r.effectiveSleep / 60)); // negative for below axis

    // Medication lines: offset relative to bedtime in hours
    const medDatasets = [];
    const medColors = ['#fd79a8', '#fdcb6e', '#55efc4', '#74b9ff', '#a29bfe', '#ffeaa7'];
    const uniqueMedIds = [...new Set(records.flatMap(r => (r.medications || []).map(m => m.id)))];

    uniqueMedIds.forEach((medId, i) => {
      const medInfo = allMeds.find(m => m.id === medId);
      const data = records.map(r => {
        const med = (r.medications || []).find(m => m.id === medId);
        if (!med) return null;
        // Calculate offset: med time - bedtime (in hours)
        const bedMin = r.bedtime.hour * 60 + r.bedtime.minute;
        const medMin = med.time.hour * 60 + med.time.minute;
        let diff = medMin - bedMin;
        // Handle cross-midnight: if diff > 12*60, medication was before midnight and bed after
        if (diff > 720) diff -= 1440;
        if (diff < -720) diff += 1440;
        return diff / 60; // hours
      });

      medDatasets.push({
        type: 'line',
        label: medInfo ? medInfo.name : medId,
        data: data,
        borderColor: medColors[i % medColors.length],
        backgroundColor: medColors[i % medColors.length] + '33',
        borderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6,
        tension: 0.3,
        spanGaps: true,
        yAxisID: 'yMed',
        order: 0
      });
    });

    chart = new Chart(ctx, {
      data: {
        labels,
        datasets: [
          {
            type: 'bar',
            label: '睡眠评分',
            data: scores,
            backgroundColor: scores.map(s => scoreColor(s)),
            borderRadius: { topLeft: 4, topRight: 4 },
            yAxisID: 'y',
            order: 1
          },
          {
            type: 'bar',
            label: '睡眠时长 (h)',
            data: durations,
            backgroundColor: 'rgba(108,92,231,0.55)',
            borderRadius: { bottomLeft: 4, bottomRight: 4 },
            yAxisID: 'y',
            order: 1
          },
          ...medDatasets
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(17,24,39,0.95)',
            borderColor: '#6c5ce7',
            borderWidth: 1,
            titleFont: { family: 'Inter' },
            bodyFont: { family: 'Inter' },
            callbacks: {
              label: (ctx) => {
                if (ctx.dataset.label === '睡眠时长 (h)') {
                  return `睡眠时长: ${(-ctx.parsed.y).toFixed(1)}h`;
                }
                if (ctx.dataset.yAxisID === 'yMed') {
                  const v = ctx.parsed.y;
                  if (v === null) return '';
                  const sign = v >= 0 ? '+' : '';
                  return `${ctx.dataset.label}: 入睡${sign}${v.toFixed(1)}h`;
                }
                return `${ctx.dataset.label}: ${ctx.parsed.y}`;
              }
            }
          }
        },
        scales: {
          x: {
            stacked: true,
            grid: { color: 'rgba(42,48,80,0.5)' },
            ticks: { color: '#8892a8', font: { family: 'Inter', size: 11 } }
          },
          y: {
            stacked: true,
            position: 'left',
            min: -11,
            max: 11,
            grid: {
              color: (ctx) => ctx.tick.value === 0 ? 'rgba(136,146,168,0.6)' : 'rgba(42,48,80,0.3)'
            },
            ticks: {
              color: '#8892a8',
              font: { family: 'Inter', size: 11 },
              stepSize: 1,
              callback: v => {
                if (v === 0) return '─';
                if (v > 0 && v <= 10) return v + '分';
                if (v < 0 && v >= -10) return (-v) + 'h';
                return '';
              }
            }
          },
          yMed: {
            position: 'right',
            grid: { display: false },
            ticks: {
              color: '#8892a8',
              font: { family: 'Inter', size: 11 },
              callback: v => {
                const sign = v >= 0 ? '+' : '';
                return `${sign}${v}h`;
              }
            },
            title: { display: true, text: '药物偏移', color: '#8892a8', font: { family: 'Inter' } }
          }
        }
      }
    });
  }

  function scoreColor(s) {
    if (s <= 3) return 'rgba(225,112,85,0.8)';
    if (s <= 5) return 'rgba(253,203,110,0.8)';
    if (s <= 7) return 'rgba(0,206,201,0.7)';
    return 'rgba(85,239,196,0.8)';
  }

  /* ---- Legend ---- */
  function renderLegend() {
    const el = document.getElementById('chart-legend');
    const records = Data.getRecordsSorted();
    const uniqueMedIds = [...new Set(records.flatMap(r => (r.medications || []).map(m => m.id)))];
    const medColors = ['#fd79a8', '#fdcb6e', '#55efc4', '#74b9ff', '#a29bfe', '#ffeaa7'];

    let html = `
      <div class="legend-item"><span class="legend-dot" style="background:rgba(0,206,201,0.7)"></span>睡眠评分</div>
      <div class="legend-item"><span class="legend-dot" style="background:rgba(108,92,231,0.55)"></span>睡眠时长</div>`;

    uniqueMedIds.forEach((id, i) => {
      const med = allMeds.find(m => m.id === id);
      html += `<div class="legend-item"><span class="legend-dot" style="background:${medColors[i % medColors.length]}"></span>${med ? med.name : id}</div>`;
    });
    el.innerHTML = html;
  }

  /* ---- Recent Records ---- */
  function renderRecent(records) {
    const container = document.getElementById('recent-records');
    if (records.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:2rem;">暂无记录</p>';
      return;
    }

    const tagMap = {};
    allTags.forEach(t => { tagMap[t.id] = t.name; });

    let html = '<h2>最近记录</h2>';
    records.forEach(r => {
      const h = Math.floor(r.effectiveSleep / 60);
      const m = r.effectiveSleep % 60;
      const dur = `${h}h${m > 0 ? ' ' + m + 'm' : ''}`;
      const bed = `${String(r.bedtime.hour).padStart(2,'0')}:${String(r.bedtime.minute).padStart(2,'0')}`;
      const wake = `${String(r.wakeTime.hour).padStart(2,'0')}:${String(r.wakeTime.minute).padStart(2,'0')}`;
      const tagHtml = (r.tags || []).map(t => `<span class="rc-tag">${tagMap[t] || t}</span>`).join('');

      html += `<div class="record-card" onclick="Dashboard.editRecord('${r.date}')">
        <span class="rc-date">${r.date}</span>
        <span class="rc-score" style="color:${scoreColor(r.score).replace('0.8','1').replace('0.7','1')}">${r.score}</span>
        <span class="rc-duration">${bed} → ${wake}<br>${dur}</span>
        <span class="rc-tags">${tagHtml}</span>
        <span class="rc-actions"><button class="rc-delete" onclick="event.stopPropagation();Dashboard.deleteRecord('${r.date}')">删除</button></span>
      </div>`;
    });
    container.innerHTML = html;
  }

  function editRecord(date) {
    const all = Data.getAll();
    const record = all[date];
    if (record) Record.open(record);
  }

  function deleteRecord(date) {
    if (!confirm(`确定删除 ${date} 的记录吗？`)) return;
    Data.deleteRecord(date);
    showToast('记录已删除');
    refresh();
  }

  return { init, setWindow, refresh, editRecord, deleteRecord };
})();
