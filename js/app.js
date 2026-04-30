/* app.js — Application init + page navigation + user management */
const App = (() => {
  const USER_STORAGE_KEY = 'sleep_tracker_user_id';

  async function init() {
    // Check for stored user
    const storedUserId = localStorage.getItem(USER_STORAGE_KEY);
    const users = await Data.loadUsers();

    if (storedUserId && users.find(u => u.id === storedUserId)) {
      // User found in localStorage matches a known user
      selectUser(storedUserId, users);
    } else {
      // No valid stored user — show user selection modal
      showUserModal(users);
    }
  }

  async function selectUser(userId, users) {
    const user = (users || await Data.loadUsers()).find(u => u.id === userId);
    if (!user) return;

    Data.setUser(userId);
    localStorage.setItem(USER_STORAGE_KEY, userId);

    // Update nav user indicator
    updateUserIndicator(user.name);

    // Init data + UI modules
    await Data.init();
    await Record.init();
    await Dashboard.init();
    await Analysis.init();

    // Close user modal if open
    closeUserModal();
  }

  async function switchUser() {
    const users = await Data.loadUsers();
    showUserModal(users);
  }

  // ---- User modal ----
  function showUserModal(users) {
    const modal = document.getElementById('user-modal');
    const list = document.getElementById('user-list');
    const input = document.getElementById('new-user-name');

    renderUserList(list, users);
    input.value = '';
    modal.classList.add('open');
  }

  function closeUserModal() {
    document.getElementById('user-modal').classList.remove('open');
  }

  function renderUserList(container, users) {
    if (users.length === 0) {
      container.innerHTML = '<p class="user-empty">还没有用户，请在下方创建一个</p>';
      return;
    }
    container.innerHTML = users.map(u => `
      <div class="user-card" data-id="${u.id}" onclick="App.pickUser('${u.id}')">
        <span class="user-avatar">${getAvatar(u.name)}</span>
        <span class="user-name">${u.name}</span>
        <span class="user-date">${u.createdAt ? u.createdAt.slice(0, 10) : ''}</span>
      </div>
    `).join('');
  }

  function getAvatar(name) {
    const colors = ['🌙', '⭐', '🌊', '🍀', '🔮', '🎯', '🦊', '🐱', '🐻', '🌸'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i);
    return colors[Math.abs(hash) % colors.length];
  }

  async function pickUser(userId) {
    const users = await Data.loadUsers();
    await selectUser(userId, users);
  }

  async function createNewUser() {
    const input = document.getElementById('new-user-name');
    const name = input.value.trim();
    if (!name) {
      showToast('请输入用户名');
      return;
    }
    const user = await Data.createUser(name);
    if (user) {
      showToast(`用户 "${user.name}" 创建成功`);
      await selectUser(user.id, [user]);
    } else {
      showToast('创建用户失败');
    }
  }

  function handleUserModalOverlay(e) {
    // Only close if a user is already selected (don't let them dismiss without choosing)
    if (Data.getUserId() && e.target === document.getElementById('user-modal')) {
      closeUserModal();
    }
  }

  function handleNewUserKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      createNewUser();
    }
  }

  function updateUserIndicator(name) {
    const el = document.getElementById('current-user-name');
    if (el) el.textContent = name;
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

  return { showPage, switchUser, pickUser, createNewUser, handleUserModalOverlay, handleNewUserKeydown };
})();
