/* app.js — Application init */
const App = (() => {
  async function init() {
    await Record.init();
    await Dashboard.init();
  }

  document.addEventListener('DOMContentLoaded', init);

  return {};
})();
