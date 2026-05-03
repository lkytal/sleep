/* record.js — Record modal: wheel pickers for date/duration/score, tags, events, medications, biometrics */
const Record = (() => {
  let tags = [];
  let medications = [];
  let events = [];
  let selectedTags = new Set();
  let selectedEvents = new Set();
  let checkedMeds = {};
  let isOutlier = false;

  async function init() {
    tags = await Data.loadTags();
    medications = await Data.loadMedications();
    events = await Data.loadEvents();
    renderTags();
    renderEvents();
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
      // Set date wheels to today
      const now = new Date();
      setDateWheels(now.getFullYear(), now.getMonth() + 1, now.getDate());
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

  /* ---- Date wheel helpers ---- */
  function setDateWheels(year, month, day) {
    document.getElementById('date-year').textContent = String(year);
    document.getElementById('date-month').textContent = String(month).padStart(2, '0');
    document.getElementById('date-day').textContent = String(day).padStart(2, '0');
  }

  function getDateFromWheels() {
    const y = parseInt(document.getElementById('date-year').textContent);
    const m = parseInt(document.getElementById('date-month').textContent);
    const d = parseInt(document.getElementById('date-day').textContent);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  /* ---- Load existing record into form ---- */
  function loadRecord(r) {
    // Date
    const parts = r.date.split('-');
    setDateWheels(parseInt(parts[0]), parseInt(parts[1]), parseInt(parts[2]));

    // Bedtime / Wake
    document.getElementById('bedtime-hour').textContent = String(r.bedtime.hour).padStart(2, '0');
    document.getElementById('bedtime-min').textContent = String(r.bedtime.minute).padStart(2, '0');
    document.getElementById('wake-hour').textContent = String(r.wakeTime.hour).padStart(2, '0');
    document.getElementById('wake-min').textContent = String(r.wakeTime.minute).padStart(2, '0');

    // Duration (wheel)
    const durH = Math.floor(r.effectiveSleep / 60);
    const durM = r.effectiveSleep % 60;
    // Round minute to nearest 15
    const roundedM = Math.round(durM / 15) * 15;
    document.getElementById('dur-hour').textContent = String(durH).padStart(2, '0');
    document.getElementById('dur-min').textContent = String(roundedM).padStart(2, '0');

    // Score (wheel)
    document.getElementById('score-val').textContent = parseFloat(r.score).toFixed(1);
    updateScoreEmoji(r.score);

    // Tags
    selectedTags.clear();
    (r.tags || []).forEach(t => selectedTags.add(t));
    document.querySelectorAll('#tags-container .tag-chip').forEach(chip => {
      chip.classList.toggle('selected', selectedTags.has(chip.dataset.id));
    });

    // Events
    selectedEvents.clear();
    (r.events || []).forEach(e => selectedEvents.add(e));
    document.querySelectorAll('#events-container .tag-chip').forEach(chip => {
      chip.classList.toggle('selected', selectedEvents.has(chip.dataset.id));
    });

    // Biometrics
    if (r.biometrics) {
      document.getElementById('bio-hrv').value = r.biometrics.hrv != null ? r.biometrics.hrv : '';
      document.getElementById('bio-rhr').value = r.biometrics.rhr != null ? r.biometrics.rhr : '';
      document.getElementById('bio-deep').value = r.biometrics.deepSleepPct != null ? r.biometrics.deepSleepPct : '';
    }

    // Subjective ratings
    if (r.subjective) {
      document.getElementById('subj-drowsy').textContent = r.subjective.drowsy != null ? String(r.subjective.drowsy) : '5';
      document.getElementById('subj-energy').textContent = r.subjective.energy != null ? String(r.subjective.energy) : '5';
      document.getElementById('subj-comfort').textContent = r.subjective.comfort != null ? String(r.subjective.comfort) : '5';
    } else {
      document.getElementById('subj-drowsy').textContent = '5';
      document.getElementById('subj-energy').textContent = '5';
      document.getElementById('subj-comfort').textContent = '5';
    }

    // Outlier
    isOutlier = !!r.isOutlier;
    const outlierCb = document.getElementById('record-outlier');
    if (outlierCb) outlierCb.checked = isOutlier;

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
    const field = el.dataset.field;
    const valEl = el.querySelector('.time-value');

    // Score uses float
    if (field === 'score-val') {
      const step = 0.5;
      let current = parseFloat(valEl.textContent);
      if (delta < 0) current += step; else current -= step;
      if (current > 10) current = 1;
      if (current < 1) current = 10;
      valEl.textContent = current.toFixed(1);
      updateScoreEmoji(current);
      return;
    }

    // Subjective fields (integer 1-10, no zero-pad)
    if (field === 'subj-drowsy' || field === 'subj-energy' || field === 'subj-comfort') {
      let current = parseInt(valEl.textContent);
      if (delta < 0) current += 1; else current -= 1;
      if (current > 10) current = 1;
      if (current < 1) current = 10;
      valEl.textContent = String(current);
      return;
    }

    const min = parseInt(el.dataset.min);
    const max = parseInt(el.dataset.max);
    const step = parseInt(el.dataset.step);
    let current = parseInt(valEl.textContent);
    if (delta < 0) current += step; else current -= step;
    if (current > max) current = min;
    if (current < min) current = max;

    // For year field, no zero-pad
    if (field === 'date-year') {
      valEl.textContent = String(current);
    } else {
      valEl.textContent = String(current).padStart(2, '0');
    }
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

  /* ---- Score emoji ---- */
  function updateScoreEmoji(val) {
    const v = parseFloat(val);
    const emojis = ['😫','😣','😞','😕','😐','🙂','😊','😄','🤩','🌟'];
    const idx = Math.min(Math.floor(v) - 1, 9);
    document.getElementById('score-emoji').textContent = emojis[Math.max(0, idx)];
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

  /* ---- Events ---- */
  function renderEvents() {
    const container = document.getElementById('events-container');
    container.innerHTML = '';
    events.forEach(ev => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip event-chip';
      chip.textContent = ev.name;
      chip.dataset.id = ev.id;
      chip.addEventListener('click', () => {
        chip.classList.toggle('selected');
        if (selectedEvents.has(ev.id)) selectedEvents.delete(ev.id);
        else selectedEvents.add(ev.id);
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
    const date = getDateFromWheels();
    if (!date) { showToast('请选择日期'); return; }

    const bedHour = parseInt(document.getElementById('bedtime-hour').textContent);
    const bedMin = parseInt(document.getElementById('bedtime-min').textContent);
    const wakeHour = parseInt(document.getElementById('wake-hour').textContent);
    const wakeMin = parseInt(document.getElementById('wake-min').textContent);

    // Duration from wheels
    const durH = parseInt(document.getElementById('dur-hour').textContent);
    const durM = parseInt(document.getElementById('dur-min').textContent);
    const effectiveSleep = durH * 60 + durM;

    // Score from wheel
    const score = parseFloat(document.getElementById('score-val').textContent);

    // Subjective ratings
    const subjective = {
      drowsy:  parseInt(document.getElementById('subj-drowsy').textContent),
      energy:  parseInt(document.getElementById('subj-energy').textContent),
      comfort: parseInt(document.getElementById('subj-comfort').textContent)
    };

    // Biometrics (optional)
    const hrvVal = document.getElementById('bio-hrv').value;
    const rhrVal = document.getElementById('bio-rhr').value;
    const deepVal = document.getElementById('bio-deep').value;
    const biometrics = {};
    if (hrvVal !== '') biometrics.hrv = parseInt(hrvVal);
    if (rhrVal !== '') biometrics.rhr = parseInt(rhrVal);
    if (deepVal !== '') biometrics.deepSleepPct = parseInt(deepVal);

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
      subjective,
      tags: Array.from(selectedTags),
      events: Array.from(selectedEvents),
      medications: meds
    };

    // Only add biometrics if any value was entered
    if (Object.keys(biometrics).length > 0) {
      record.biometrics = biometrics;
    }

    // Outlier
    const outlierCb = document.getElementById('record-outlier');
    if (outlierCb && outlierCb.checked) {
      record.isOutlier = true;
    }

    Data.saveRecord(record);
    showToast('记录已保存 ✓');
    close();
    Dashboard.refresh();
  }

  function resetForm() {
    selectedTags.clear();
    selectedEvents.clear();
    checkedMeds = {};
    document.querySelectorAll('#tags-container .tag-chip').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('#events-container .tag-chip').forEach(c => c.classList.remove('selected'));
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
    document.getElementById('dur-hour').textContent = '07';
    document.getElementById('dur-min').textContent = '00';
    document.getElementById('score-val').textContent = '7.0';
    updateScoreEmoji(7);

    // Reset subjective ratings
    document.getElementById('subj-drowsy').textContent = '5';
    document.getElementById('subj-energy').textContent = '5';
    document.getElementById('subj-comfort').textContent = '5';

    // Reset biometrics
    document.getElementById('bio-hrv').value = '';
    document.getElementById('bio-rhr').value = '';
    document.getElementById('bio-deep').value = '';

    // Reset outlier
    isOutlier = false;
    const outlierCb = document.getElementById('record-outlier');
    if (outlierCb) outlierCb.checked = false;
  }

  return { init, open, close, handleOverlayClick, save };
})();
