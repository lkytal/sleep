/* data.js — Data layer: file-based persistence + localStorage fallback + config loading */
const Data = (() => {
  const STORAGE_KEY = 'sleep_tracker_records';
  let fileHandle = null;   // File System Access API handle
  let cachedRecords = {};  // In-memory cache

  /* ---- Init: load from file on startup ---- */
  async function init() {
    // Try to load from file first
    const loaded = await promptAndLoadFile();
    if (!loaded) {
      // Fall back to localStorage
      try {
        cachedRecords = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
      } catch { cachedRecords = {}; }
    }
  }

  /* Prompt user to pick an existing file or create a new one */
  async function promptAndLoadFile() {
    if (!window.showOpenFilePicker) {
      console.warn('File System Access API not supported — using localStorage only');
      return false;
    }
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{
          description: 'Sleep Data JSON',
          accept: { 'application/json': ['.json'] }
        }],
        multiple: false
      });
      fileHandle = handle;
      const file = await handle.getFile();
      const text = await file.text();
      cachedRecords = text.trim() ? JSON.parse(text) : {};
      // Sync to localStorage as backup
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedRecords));
      showToast(`已加载 ${Object.keys(cachedRecords).length} 条记录`);
      return true;
    } catch (e) {
      // User cancelled the picker or error
      if (e.name !== 'AbortError') console.error('File load error:', e);
      return false;
    }
  }

  /* Write current data to the file handle */
  async function writeToFile() {
    if (!fileHandle) return;
    try {
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(cachedRecords, null, 2));
      await writable.close();
    } catch (e) {
      console.error('File write error:', e);
      showToast('文件写入失败，数据已保存到浏览器');
    }
  }

  function getAll() {
    return cachedRecords;
  }

  function saveAll(records) {
    cachedRecords = records;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    writeToFile(); // async, fire-and-forget
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
  async function loadEvents() { return loadConfig('config/events.csv'); }

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

  /* Allow user to re-pick a file at any time */
  async function pickFile() {
    const loaded = await promptAndLoadFile();
    if (loaded && typeof Dashboard !== 'undefined') Dashboard.refresh();
  }

  return { init, getAll, saveRecord, deleteRecord, getRecordsSorted, loadTags, loadMedications, loadEvents, exportData, importData, handleImport, pickFile };
})();

/* Global toast */
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}
