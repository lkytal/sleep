/* seed.js — Generate sample data for demonstration. Load via console or include temporarily. */
(function seedData() {
  const records = {};
  const tagPool = ['restless', 'dream', 'deep', 'light', 'wake_up', 'refreshed', 'groggy', 'anxiety'];
  const medPool = [
    { id: 'melatonin', defH: 22, defM: 30 },
    { id: 'magnesium', defH: 22, defM: 0 },
    { id: 'valerian', defH: 22, defM: 0 }
  ];

  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    const bedH = 22 + Math.floor(Math.random() * 2);
    const bedM = Math.floor(Math.random() * 6) * 10;
    const wakeH = 6 + Math.floor(Math.random() * 2);
    const wakeM = Math.floor(Math.random() * 6) * 10;
    const eff = 300 + Math.floor(Math.random() * 20) * 15; // 5h-10h in 15m steps
    const score = Math.round((3 + Math.random() * 7) * 2) / 2; // 3-10, 0.5 step
    const numTags = 1 + Math.floor(Math.random() * 3);
    const tags = [];
    for (let t = 0; t < numTags; t++) {
      const pick = tagPool[Math.floor(Math.random() * tagPool.length)];
      if (!tags.includes(pick)) tags.push(pick);
    }
    const meds = [];
    medPool.forEach(m => {
      if (Math.random() > 0.5) {
        meds.push({
          id: m.id,
          time: { hour: m.defH + (Math.random() > 0.7 ? -1 : 0), minute: m.defM }
        });
      }
    });

    records[date] = {
      date,
      bedtime: { hour: bedH, minute: bedM },
      wakeTime: { hour: wakeH, minute: wakeM },
      effectiveSleep: eff,
      score,
      tags,
      medications: meds
    };
  }
  localStorage.setItem('sleep_tracker_records', JSON.stringify(records));
  console.log('Seeded', Object.keys(records).length, 'records');
  location.reload();
})();
