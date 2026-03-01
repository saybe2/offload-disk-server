const userList = document.getElementById('userList');
const webhookList = document.getElementById('webhookList');
const createUserForm = document.getElementById('createUserForm');
const createUserStatus = document.getElementById('createUserStatus');
const addWebhookForm = document.getElementById('addWebhookForm');
const mirrorSyncProgress = document.getElementById('mirrorSyncProgress');
const mirrorSyncText = document.getElementById('mirrorSyncText');
let mirrorSyncTimer = null;

async function loadMirrorSync() {
  try {
    const res = await fetch('/api/admin/mirror-sync');
    if (!res.ok) {
      throw new Error('sync_stats_failed');
    }
    const data = await res.json();
    const total = Number(data.totalParts || 0);
    const done = Number(data.doneParts || 0);
    const pending = Number(data.pendingParts || 0);
    const remaining = Number(data.remainingParts || 0);
    const errors = Number(data.errorParts || 0);
    const archivesTotal = Number(data.archivesTotal || 0);
    const archivesPending = Number(data.archivesPending || 0);

    if (total > 0) {
      mirrorSyncProgress.max = total;
      mirrorSyncProgress.value = Math.min(done, total);
    } else {
      mirrorSyncProgress.max = 100;
      mirrorSyncProgress.value = 100;
    }

    if (total === 0) {
      mirrorSyncText.textContent = 'No sync tasks';
      return;
    }

    const pct = Math.floor((Math.min(done, total) / total) * 100);
    mirrorSyncText.textContent = `${pct}% | ${done}/${total} parts | remaining ${remaining} | pending ${pending} | errors ${errors} | archives ${archivesTotal - archivesPending}/${archivesTotal}`;
  } catch (err) {
    mirrorSyncText.textContent = 'Failed to load sync stats';
  }
}

async function loadUsers() {
  const res = await fetch('/api/admin/users');
  const data = await res.json();
  userList.innerHTML = '';
  for (const u of data.users) {
    const usedGb = (u.usedBytes / (1024 * 1024 * 1024)).toFixed(2);
    const quotaGb = u.quotaBytes > 0 ? (u.quotaBytes / (1024 * 1024 * 1024)).toFixed(2) : 'unlimited';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${u.username}</td>
      <td>${u.role}</td>
      <td>${usedGb}</td>
      <td>${quotaGb}</td>
      <td>
        <input type="number" min="0" value="${u.quotaBytes > 0 ? (u.quotaBytes / (1024 * 1024 * 1024)).toFixed(2) : 0}" data-user="${u._id}" />
        <button data-action="quota" data-user="${u._id}">Set</button>
      </td>
      <td>
        <input type="password" placeholder="New password" data-user="${u._id}" data-type="password" />
        <button data-action="password" data-user="${u._id}">Update</button>
      </td>
      <td>
        <button data-action="delete" data-user="${u._id}">Delete</button>
      </td>
    `;
    userList.appendChild(tr);
  }

  userList.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-user');
      const action = btn.getAttribute('data-action');
      if (action === 'quota') {
        const input = userList.querySelector(`input[data-user="${id}"]:not([data-type])`);
        const quotaGb = Number(input.value);
        await fetch(`/api/admin/users/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quotaBytes: Math.floor(quotaGb * 1024 * 1024 * 1024) })
        });
        await loadUsers();
        return;
      }
      if (action === 'password') {
        const input = userList.querySelector(`input[data-user="${id}"][data-type="password"]`);
        const password = input.value;
        if (!password) {
          alert('Enter a new password');
          return;
        }
        await fetch(`/api/admin/users/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        input.value = '';
        return;
      }
      if (action === 'delete') {
        const ok = confirm('Delete user and queue their files for deletion?');
        if (!ok) return;
        const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert(data.error || 'Delete failed');
          return;
        }
        await loadUsers();
      }
    });
  });
}

async function loadWebhooks() {
  const res = await fetch('/api/admin/webhooks');
  const data = await res.json();
  webhookList.innerHTML = '';
  for (const w of data.webhooks) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${w.url}</td>
      <td>${w.enabled}</td>
      <td><button data-id="${w._id}">${w.enabled ? 'Disable' : 'Enable'}</button></td>
    `;
    webhookList.appendChild(tr);
  }

  webhookList.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const current = btn.textContent === 'Disable';
      await fetch(`/api/admin/webhooks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !current })
      });
      await loadWebhooks();
    });
  });
}

createUserForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  createUserStatus.textContent = '';
  const data = new FormData(createUserForm);
  const res = await fetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: data.get('username'),
      password: data.get('password'),
      role: data.get('role'),
      quotaBytes: Math.floor(Number(data.get('quotaGb')) * 1024 * 1024 * 1024)
    })
  });
  if (!res.ok) {
    createUserStatus.textContent = 'Error creating user';
    return;
  }
  createUserStatus.textContent = 'User created';
  createUserForm.reset();
  await loadUsers();
});

addWebhookForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(addWebhookForm);
  await fetch('/api/admin/webhooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: data.get('url') })
  });
  addWebhookForm.reset();
  await loadWebhooks();
});

(async () => {
  await loadMirrorSync();
  await loadUsers();
  await loadWebhooks();
  if (mirrorSyncTimer) {
    clearInterval(mirrorSyncTimer);
  }
  mirrorSyncTimer = setInterval(loadMirrorSync, 5000);
})();
