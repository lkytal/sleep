/* data.js — Data layer: localStorage CRUD + import/export + config loading */
const Data = (() => {
  const STORAGE_KEY = 'sleep_tracker_records';

  function getAll() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch { return {}; }
  }

  function saveAll(records) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  }

  function saveRecord(record) {
    const all = getAll();
    all[record.date] = record;
    saveAll(all);
  }

  function deleteRecord(date) {
    const all = getAll();
    delete all[date];
    saveAll(all);
  }

  function getRecordsSorted() {
    const all = getAll();
    return Object.values(all).sort((a, b) => a.date.localeCompare(b.date));
  }

  /* CSV parser — simple, handles id,name or id,name,default_time */
  function parseCSV(text) {
    const lines = text.trim().split('\n');
    const header = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).filter(l => l.trim()).map(line => {
      const vals = line.split(',').map(v => v.trim());
      const obj = {};
      header.forEach((h, i) => { obj[h] = vals[i] || ''; });
      return obj;
    });
  }

  async function loadConfig(path) {
    try {
      const res = await fetch(path);
      const text = await res.text();
      return parseCSV(text);
    } catch (e) {
      console.error('Failed to load config:', path, e);
      return [];
    }
  }

  async function loadTags() { return loadConfig('config/tags.csv'); }
  async function loadMedications() { return loadConfig('config/medications.csv'); }

  /* Export */
  function exportData() {
    const data = JSON.stringify(getAll(), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sleep_data_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('数据已导出');
  }

  /* Import */
  function importData() {
    document.getElementById('import-file').click();
  }

  function handleImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        const current = getAll();
        const merged = { ...current, ...imported };
        saveAll(merged);
        showToast(`已导入 ${Object.keys(imported).length} 条记录`);
        if (typeof Dashboard !== 'undefined') Dashboard.refresh();
      } catch (err) {
        showToast('导入失败：文件格式错误');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  }

  return { getAll, saveRecord, deleteRecord, getRecordsSorted, loadTags, loadMedications, exportData, importData, handleImport };
})();

/* Global toast */
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}
