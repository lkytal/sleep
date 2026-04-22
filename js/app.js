/* app.js — Application init + page navigation */
const App = (() => {
  async function init() {
    await Data.init();
    await Record.init();
    await Dashboard.init();
    await Analysis.init();
  }

  function showPage(name) {
    // Hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    // Show target
    const target = document.getElementById(`page-${name}`);
    if (target) target.classList.add('active');

    // Update nav tab active state (exclude record button)
    document.querySelectorAll('.nav-tab').forEach(btn => btn.classList.remove('active'));
    const navBtn = document.getElementById(`nav-${name}`);
    if (navBtn) navBtn.classList.add('active');

    // Refresh analysis when switching to it
    if (name === 'analysis' && typeof Analysis !== 'undefined') {
      Analysis.refresh();
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  return { showPage };
})();
