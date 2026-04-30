/* data.js — Data layer: all persistence via backend API */
const API = 'http://localhost:3001/api';

const Data = (() => {
  let cachedRecords = {};

  async function init() {
    try {
      const res = await fetch(`${API}/records`);
      cachedRecords = await res.json();
      showToast(`已加载 ${Object.keys(cachedRecords).length} 条记录`);
    } catch (e) {
      console.error('Failed to load records from backend:', e);
      showToast('⚠ 无法连接后端，请确认服务已启动');
    }
  }

  function getAll() { return cachedRecords; }

  async function saveRecord(record) {
    cachedRecords[record.date] = record;
    try {
      await fetch(`${API}/records/${record.date}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });
    } catch (e) { showToast('⚠ 保存失败，请检查后端连接'); }
  }

  async function deleteRecord(date) {
    delete cachedRecords[date];
    try {
      await fetch(`${API}/records/${date}`, { method: 'DELETE' });
    } catch (e) { showToast('⚠ 删除失败，请检查后端连接'); }
  }

  function getRecordsSorted() {
    return Object.values(cachedRecords).sort((a, b) => a.date.localeCompare(b.date));
  }

  async function loadConfig(endpoint) {
    try {
      const res = await fetch(`${API}/config/${endpoint}`);
      return await res.json();
    } catch (e) {
      console.error('Failed to load config:', endpoint, e);
      return [];
    }
  }

  async function loadTags() { return loadConfig('tags'); }
  async function loadMedications() { return loadConfig('medications'); }
  async function loadEvents() { return loadConfig('events'); }

  function exportData() {
    const blob = new Blob([JSON.stringify(cachedRecords, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sleep_data_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('数据已导出');
  }

  function importData() { document.getElementById('import-file').click(); }

  async function handleImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        const res = await fetch(`${API}/records/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(imported),
        });
        const json = await res.json();
        // Refresh local cache
        cachedRecords = { ...cachedRecords, ...imported };
        showToast(`已导入 ${json.count} 条记录`);
        if (typeof Dashboard !== 'undefined') Dashboard.refresh();
      } catch { showToast('导入失败：文件格式错误或后端连接失败'); }
    };
    reader.readAsText(file);
    event.target.value = '';
  }

  return { init, getAll, saveRecord, deleteRecord, getRecordsSorted, loadTags, loadMedications, loadEvents, exportData, importData, handleImport };
})();

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}
