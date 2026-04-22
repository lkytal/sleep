/* record.js — Record modal: time pickers, score, tags, medications */
const Record = (() => {
  let tags = [];
  let medications = [];
  let selectedTags = new Set();
  let checkedMeds = {};

  async function init() {
    tags = await Data.loadTags();
    medications = await Data.loadMedications();
    renderTags();
    renderMedications();
    initWheels();
  }

  /* ---- Modal open / close ---- */
  function open(existingRecord) {
    resetForm();
    if (existingRecord) {
      loadRecord(existingRecord);
      document.getElementById('modal-title').textContent = '编辑记录 — ' + existingRecord.date;
    } else {
      document.getElementById('record-date').value = new Date().toISOString().slice(0, 10);
      document.getElementById('modal-title').textContent = '记录睡眠';
    }
    document.getElementById('record-modal').classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    document.getElementById('record-modal').classList.remove('open');
    document.body.style.overflow = '';
  }

  function handleOverlayClick(e) {
    if (e.target === document.getElementById('record-modal')) close();
  }

  /* ---- Load existing record into form ---- */
  function loadRecord(r) {
    document.getElementById('record-date').value = r.date;
    document.getElementById('bedtime-hour').textContent = String(r.bedtime.hour).padStart(2, '0');
    document.getElementById('bedtime-min').textContent = String(r.bedtime.minute).padStart(2, '0');
    document.getElementById('wake-hour').textContent = String(r.wakeTime.hour).padStart(2, '0');
    document.getElementById('wake-min').textContent = String(r.wakeTime.minute).padStart(2, '0');

    document.getElementById('duration-slider').value = r.effectiveSleep;
    updateDurationDisplay(r.effectiveSleep);

    document.getElementById('score-slider').value = r.score;
    updateScoreDisplay(r.score);

    // Tags
    selectedTags.clear();
    (r.tags || []).forEach(t => selectedTags.add(t));
    document.querySelectorAll('.tag-chip').forEach(chip => {
      chip.classList.toggle('selected', selectedTags.has(chip.dataset.id));
    });

    // Medications
    checkedMeds = {};
    const medMap = {};
    (r.medications || []).forEach(m => { medMap[m.id] = m; });
    document.querySelectorAll('.med-item').forEach(item => {
      const id = item.dataset.id;
      const cb = item.querySelector('.med-checkbox');
      const savedMed = medMap[id];
      if (savedMed) {
        cb.checked = true;
        item.classList.add('checked');
        checkedMeds[id] = true;
        // Set time
        const timeVals = item.querySelectorAll('.med-time-val');
        timeVals[0].textContent = String(savedMed.time.hour).padStart(2, '0');
        timeVals[1].textContent = String(savedMed.time.minute).padStart(2, '0');
        // Set dose if available
        if (savedMed.dose) {
          const doseVal = item.querySelector('.med-dose-val');
          if (doseVal) doseVal.textContent = savedMed.dose;
        }
      } else {
        cb.checked = false;
        item.classList.remove('checked');
      }
    });
  }

  /* ---- Time Wheels ---- */
  function initWheels() {
    document.querySelectorAll('.time-wheel').forEach(wheel => {
      wheel.addEventListener('wheel', (e) => {
        e.preventDefault();
        handleWheel(wheel, e.deltaY);
      }, { passive: false });
    });
  }

  function handleWheel(el, delta) {
    const min = parseInt(el.dataset.min);
    const max = parseInt(el.dataset.max);
    const step = parseInt(el.dataset.step);
    const valEl = el.querySelector('.time-value');
    let current = parseInt(valEl.textContent);
    if (delta < 0) current += step; else current -= step;
    if (current > max) current = min;
    if (current < min) current = max;
    valEl.textContent = String(current).padStart(2, '0');
  }

  /* ---- Medication time wheels ---- */
  function initMedWheel(el) {
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const min = parseInt(el.dataset.min);
      const max = parseInt(el.dataset.max);
      const step = parseInt(el.dataset.step);
      const valEl = el.querySelector('.med-time-val');
      let current = parseInt(valEl.textContent);
      if (e.deltaY < 0) current += step; else current -= step;
      if (current > max) current = min;
      if (current < min) current = max;
      valEl.textContent = String(current).padStart(2, '0');
    }, { passive: false });
  }

  /* ---- Duration display ---- */
  function updateDurationDisplay(val) {
    const mins = parseInt(val);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    document.getElementById('duration-display').textContent = `${h}h ${String(m).padStart(2, '0')}m`;
  }

  /* ---- Score display ---- */
  function updateScoreDisplay(val) {
    const v = parseFloat(val);
    document.getElementById('score-display').textContent = v.toFixed(1);
    const emojis = ['😫','😣','😞','😕','😐','🙂','😊','😄','🤩','🌟'];
    const idx = Math.min(Math.floor(v) - 1, 9);
    document.getElementById('score-emoji').textContent = emojis[idx];
  }

  /* ---- Tags ---- */
  function renderTags() {
    const container = document.getElementById('tags-container');
    container.innerHTML = '';
    tags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = tag.name;
      chip.dataset.id = tag.id;
      chip.addEventListener('click', () => {
        chip.classList.toggle('selected');
        if (selectedTags.has(tag.id)) selectedTags.delete(tag.id);
        else selectedTags.add(tag.id);
      });
      container.appendChild(chip);
    });
  }

  /* ---- Dose parsing helper ---- */
  function parseDose(doseStr) {
    if (!doseStr) return null;
    const s = doseStr.trim();
    const match = s.match(/^([\d.]+)\s*(.*)$/);
    if (!match) return null;
    return { value: parseFloat(match[1]), unit: match[2] || '' };
  }

  function formatDose(value, unit) {
    const str = value === Math.floor(value) ? String(value) : value.toFixed(value < 1 ? 2 : 1).replace(/0+$/, '').replace(/\.$/, '');
    return str + unit;
  }

  /* ---- Medications ---- */
  function renderMedications() {
    const container = document.getElementById('meds-container');
    container.innerHTML = '';
    medications.forEach(med => {
      const defaultH = med.default_time ? parseInt(med.default_time.split(':')[0]) : 22;
      const defaultM = med.default_time ? parseInt(med.default_time.split(':')[1]) : 0;
      const roundedM = Math.round(defaultM / 10) * 10;
      const doseInfo = parseDose(med.dose);
      const doseStep = doseInfo ? +(doseInfo.value * 0.1).toFixed(4) : 0;

      const item = document.createElement('div');
      item.className = 'med-item';
      item.dataset.id = med.id;
      item.innerHTML = `
        <input type="checkbox" class="med-checkbox" id="med-${med.id}">
        <span class="med-name">${med.name}</span>
        ${doseInfo ? `<div class="med-dose-wheel" data-default="${doseInfo.value}" data-unit="${doseInfo.unit}" data-step="${doseStep}">
          <span class="med-dose-val">${formatDose(doseInfo.value, doseInfo.unit)}</span>
        </div>` : ''}
        <div class="med-time-picker">
          <div class="med-time-wheel" data-min="0" data-max="23" data-step="1">
            <span class="med-time-val">${String(defaultH).padStart(2,'0')}</span>
            <span class="med-time-lbl">时</span>
          </div>
          <span class="med-time-sep">:</span>
          <div class="med-time-wheel" data-min="0" data-max="50" data-step="10">
            <span class="med-time-val">${String(roundedM).padStart(2,'0')}</span>
            <span class="med-time-lbl">分</span>
          </div>
        </div>`;
      container.appendChild(item);

      const cb = item.querySelector('.med-checkbox');
      cb.addEventListener('change', () => {
        item.classList.toggle('checked', cb.checked);
        if (cb.checked) checkedMeds[med.id] = true;
        else delete checkedMeds[med.id];
      });

      item.querySelectorAll('.med-time-wheel').forEach(w => initMedWheel(w));

      // Dose scroll wheel
      const doseWheel = item.querySelector('.med-dose-wheel');
      if (doseWheel) {
        doseWheel.addEventListener('wheel', (e) => {
          e.preventDefault();
          const step = parseFloat(doseWheel.dataset.step);
          const unit = doseWheel.dataset.unit;
          const valEl = doseWheel.querySelector('.med-dose-val');
          let current = parseFloat(valEl.textContent);
          if (e.deltaY < 0) current += step; else current -= step;
          if (current < step) current = step;
          current = +current.toFixed(4);
          valEl.textContent = formatDose(current, unit);
        }, { passive: false });
      }
    });
  }

  /* ---- Save ---- */
  function save() {
    const date = document.getElementById('record-date').value;
    if (!date) { showToast('请选择日期'); return; }

    const bedHour = parseInt(document.getElementById('bedtime-hour').textContent);
    const bedMin = parseInt(document.getElementById('bedtime-min').textContent);
    const wakeHour = parseInt(document.getElementById('wake-hour').textContent);
    const wakeMin = parseInt(document.getElementById('wake-min').textContent);
    const effectiveSleep = parseInt(document.getElementById('duration-slider').value);
    const score = parseFloat(document.getElementById('score-slider').value);

    const meds = [];
    document.querySelectorAll('.med-item').forEach(item => {
      const cb = item.querySelector('.med-checkbox');
      if (cb.checked) {
        const vals = item.querySelectorAll('.med-time-val');
        const doseEl = item.querySelector('.med-dose-val');
        const medEntry = {
          id: item.dataset.id,
          time: { hour: parseInt(vals[0].textContent), minute: parseInt(vals[1].textContent) }
        };
        if (doseEl) medEntry.dose = doseEl.textContent;
        meds.push(medEntry);
      }
    });

    const record = {
      date,
      bedtime: { hour: bedHour, minute: bedMin },
      wakeTime: { hour: wakeHour, minute: wakeMin },
      effectiveSleep,
      score,
      tags: Array.from(selectedTags),
      medications: meds
    };

    Data.saveRecord(record);
    showToast('记录已保存 ✓');
    close();
    Dashboard.refresh();
  }

  function resetForm() {
    selectedTags.clear();
    checkedMeds = {};
    document.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.med-item').forEach(item => {
      item.classList.remove('checked');
      item.querySelector('.med-checkbox').checked = false;
      // Reset dose to default
      const doseWheel = item.querySelector('.med-dose-wheel');
      if (doseWheel) {
        const defVal = parseFloat(doseWheel.dataset.default);
        const unit = doseWheel.dataset.unit;
        doseWheel.querySelector('.med-dose-val').textContent = formatDose(defVal, unit);
      }
      // Reset time to default from config
      const medId = item.dataset.id;
      const medConfig = medications.find(m => m.id === medId);
      if (medConfig && medConfig.default_time) {
        const dH = parseInt(medConfig.default_time.split(':')[0]);
        const dM = Math.round(parseInt(medConfig.default_time.split(':')[1]) / 10) * 10;
        const timeVals = item.querySelectorAll('.med-time-val');
        timeVals[0].textContent = String(dH).padStart(2, '0');
        timeVals[1].textContent = String(dM).padStart(2, '0');
      }
    });
    document.getElementById('bedtime-hour').textContent = '23';
    document.getElementById('bedtime-min').textContent = '00';
    document.getElementById('wake-hour').textContent = '07';
    document.getElementById('wake-min').textContent = '00';
    document.getElementById('score-slider').value = 7;
    updateScoreDisplay(7);
    document.getElementById('duration-slider').value = 420;
    updateDurationDisplay(420);
  }

  return { init, open, close, handleOverlayClick, updateDurationDisplay, updateScoreDisplay, save };
})();
