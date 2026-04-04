const userList = document.getElementById('userList');
const webhookList = document.getElementById('webhookList');
const createUserForm = document.getElementById('createUserForm');
const createUserStatus = document.getElementById('createUserStatus');
const addWebhookForm = document.getElementById('addWebhookForm');
const mirrorSyncProgress = document.getElementById('mirrorSyncProgress');
const mirrorSyncText = document.getElementById('mirrorSyncText');
const mirrorPauseBtn = document.getElementById('mirrorPauseBtn');
const mirrorRetryBtn = document.getElementById('mirrorRetryBtn');
const mirrorConcurrencyInput = document.getElementById('mirrorConcurrencyInput');
const mirrorConcurrencyBtn = document.getElementById('mirrorConcurrencyBtn');
const mirrorAutoTuneToggle = document.getElementById('mirrorAutoTuneToggle');
const mirrorControlStatus = document.getElementById('mirrorControlStatus');
const analyticsText = document.getElementById('analyticsText');
const subtitleSyncProgress = document.getElementById('subtitleSyncProgress');
const subtitleSyncText = document.getElementById('subtitleSyncText');
let mirrorSyncTimer = null;
let mirrorSyncState = { paused: false, autoTune: true, concurrency: 1, minConcurrency: 1, maxConcurrency: 6 };

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const num = value / Math.pow(1024, exp);
  const prec = exp >= 3 ? 2 : 1;
  return `${num.toFixed(prec)} ${units[exp]}`;
}

function formatRate(bps) {
  return `${formatBytes(Number(bps || 0))}/s`;
}

function applyMirrorSyncState(data) {
  mirrorSyncState = {
    paused: !!data.paused,
    autoTune: !!data.autoTune,
    concurrency: Number(data.concurrency || 1),
    minConcurrency: Number(data.minConcurrency || 1),
    maxConcurrency: Number(data.maxConcurrency || 6)
  };
  mirrorPauseBtn.textContent = mirrorSyncState.paused ? 'Resume sync' : 'Pause sync';
  mirrorAutoTuneToggle.checked = mirrorSyncState.autoTune;
  mirrorConcurrencyInput.min = String(mirrorSyncState.minConcurrency);
  mirrorConcurrencyInput.max = String(mirrorSyncState.maxConcurrency);
  mirrorConcurrencyInput.value = String(mirrorSyncState.concurrency);
}

async function loadMirrorSync() {
  try {
    const res = await fetch('/api/admin/mirror-sync');
    if (!res.ok) {
      throw new Error('sync_stats_failed');
    }
    const data = await res.json();
    const totalFiles = Number(data.filesTotal || 0);
    const doneFiles = Number(data.filesDone || 0);
    const remainingFiles = Number(data.filesRemaining || 0);
    const filesPercent = Number(data.filesPercent || 0);
    const total = Number(data.totalParts || 0);
    const done = Number(data.doneParts || 0);
    const pending = Number(data.pendingParts || 0);
    const errors = Number(data.errorParts || 0);
    const totalBytes = Number(data.totalBytes || 0);
    const doneBytes = Number(data.doneBytes || 0);
    const remainingBytes = Number(data.remainingBytes || 0);
    const bytesPercent = Number(data.bytesPercent || 0);
    const archivesTotal = Number(data.archivesTotal || 0);
    const archivesDone = Number(data.archivesDone || 0);
    applyMirrorSyncState(data);

    if (totalBytes > 0) {
      mirrorSyncProgress.max = totalBytes;
      mirrorSyncProgress.value = Math.min(doneBytes, totalBytes);
    } else {
      mirrorSyncProgress.max = 100;
      mirrorSyncProgress.value = 100;
    }

    if (totalBytes === 0 && totalFiles === 0 && total === 0) {
      mirrorSyncText.textContent = 'No sync tasks';
      return;
    }

    mirrorSyncText.textContent = `${bytesPercent}% | data ${formatBytes(doneBytes)} / ${formatBytes(totalBytes)} | remaining ${formatBytes(remainingBytes)} | files ${doneFiles}/${totalFiles} | archives ${archivesDone}/${archivesTotal} | parts ${done}/${total} | pending ${pending} | part-errors ${errors}`;
  } catch (err) {
    mirrorSyncText.textContent = 'Failed to load sync stats';
  }
}

async function loadAnalytics() {
  try {
    const res = await fetch('/api/admin/analytics');
    if (!res.ok) {
      throw new Error('analytics_failed');
    }
    const data = await res.json();
    const upload = data.upload || {};
    const mirror = data.mirror || {};
    const download = data.download || {};
    const discord = mirror.providers?.discord || {};
    const telegram = mirror.providers?.telegram || {};
    analyticsText.textContent =
      `Upload ${upload.archivesDone || 0}/${upload.archivesStarted || 0} done, errors ${upload.archivesError || 0}, rate ${formatRate(upload.rateBps60s || 0)}, avg ${upload.avgArchiveMs || 0} ms | ` +
      `Mirror parts ${mirror.partsDone || 0}, errors ${mirror.partsError || 0}, 429 ${mirror.rateLimited || 0}, rate ${formatRate(mirror.rateBps60s || 0)}, avg ${mirror.avgPartMs || 0} ms, discord ${discord.done || 0}/${(discord.done || 0) + (discord.error || 0)}, telegram ${telegram.done || 0}/${(telegram.done || 0) + (telegram.error || 0)} | ` +
      `Download ${download.done || 0}/${download.started || 0} done, errors ${download.error || 0}, rate ${formatRate(download.rateBps60s || 0)}`;
  } catch (err) {
    analyticsText.textContent = 'Failed to load analytics';
  }
}

async function loadSubtitleSync() {
  try {
    const res = await fetch('/api/admin/subtitle-sync');
    if (!res.ok) {
      throw new Error('subtitle_sync_failed');
    }
    const data = await res.json();
    const filesTotal = Number(data.filesTotal || 0);
    const filesDone = Number(data.filesDone || 0);
    const filesPending = Number(data.filesPending || 0);
    const filesFailed = Number(data.filesFailed || 0);
    const mirrorPending = Number(data.mirrorPending || 0);
    const totalBytes = Number(data.totalBytes || 0);
    const doneBytes = Number(data.doneBytes || 0);
    const remainingBytes = Number(data.remainingBytes || 0);
    const bytesPercent = Number(data.bytesPercent || 0);
    if (totalBytes > 0) {
      subtitleSyncProgress.max = totalBytes;
      subtitleSyncProgress.value = Math.min(doneBytes, totalBytes);
    } else {
      subtitleSyncProgress.max = 100;
      subtitleSyncProgress.value = 100;
    }
    if (filesTotal === 0) {
      subtitleSyncText.textContent = 'No subtitle tasks';
      return;
    }
    subtitleSyncText.textContent = `${bytesPercent}% | data ${formatBytes(doneBytes)} / ${formatBytes(totalBytes)} | remaining ${formatBytes(remainingBytes)} | files ${filesDone}/${filesTotal} | pending ${filesPending} | failed ${filesFailed} | mirror-pending ${mirrorPending}`;
  } catch (err) {
    subtitleSyncText.textContent = 'Failed to load subtitle sync stats';
  }
}

mirrorPauseBtn.addEventListener('click', async () => {
  mirrorControlStatus.textContent = 'Updating...';
  const res = await fetch('/api/admin/mirror-sync/pause', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: !mirrorSyncState.paused })
  });
  if (!res.ok) {
    mirrorControlStatus.textContent = 'Failed to update pause state';
    return;
  }
  const data = await res.json();
  applyMirrorSyncState(data);
  mirrorControlStatus.textContent = mirrorSyncState.paused ? 'Mirror sync paused' : 'Mirror sync resumed';
  await loadMirrorSync();
});

mirrorRetryBtn.addEventListener('click', async () => {
  mirrorControlStatus.textContent = 'Retrying failed parts...';
  const res = await fetch('/api/admin/mirror-sync/retry-failed', { method: 'POST' });
  if (!res.ok) {
    mirrorControlStatus.textContent = 'Retry request failed';
    return;
  }
  const data = await res.json();
  mirrorControlStatus.textContent = `Requeued archives: ${data.modified || 0}`;
  await loadMirrorSync();
});

mirrorConcurrencyBtn.addEventListener('click', async () => {
  const value = Number(mirrorConcurrencyInput.value);
  if (!Number.isFinite(value) || value < 1) {
    mirrorControlStatus.textContent = 'Bad concurrency value';
    return;
  }
  mirrorControlStatus.textContent = 'Applying concurrency...';
  const res = await fetch('/api/admin/mirror-sync/concurrency', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ concurrency: value })
  });
  if (!res.ok) {
    mirrorControlStatus.textContent = 'Failed to set concurrency';
    return;
  }
  const data = await res.json();
  applyMirrorSyncState(data);
  mirrorControlStatus.textContent = `Concurrency set to ${mirrorSyncState.concurrency}`;
  await loadMirrorSync();
});

mirrorAutoTuneToggle.addEventListener('change', async () => {
  mirrorControlStatus.textContent = 'Updating auto tune...';
  const res = await fetch('/api/admin/mirror-sync/auto-tune', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: mirrorAutoTuneToggle.checked })
  });
  if (!res.ok) {
    mirrorControlStatus.textContent = 'Failed to update auto tune';
    mirrorAutoTuneToggle.checked = !mirrorAutoTuneToggle.checked;
    return;
  }
  const data = await res.json();
  applyMirrorSyncState(data);
  mirrorControlStatus.textContent = mirrorSyncState.autoTune ? 'Auto tune enabled' : 'Auto tune disabled';
});

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
        <button data-action="view" data-user="${u._id}" data-username="${encodeURIComponent(u.username)}">Files</button>
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
        return;
      }
      if (action === 'view') {
        const usernameEncoded = btn.getAttribute('data-username') || '';
        const target = `/?view=files&owner=${encodeURIComponent(id)}${usernameEncoded ? `&ownerName=${usernameEncoded}` : ''}`;
        window.open(target, '_blank');
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
  await loadAnalytics();
  await loadSubtitleSync();
  await loadUsers();
  await loadWebhooks();
  if (mirrorSyncTimer) {
    clearInterval(mirrorSyncTimer);
  }
  mirrorSyncTimer = setInterval(async () => {
    await loadMirrorSync();
    await loadAnalytics();
    await loadSubtitleSync();
  }, 5000);
})();
