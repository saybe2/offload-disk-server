#!/usr/bin/env bash
set -euo pipefail

SMB_PORT="${SMB_PORT:-445}"
SMB_SHARE_NAME="${SMB_SHARE_NAME:-offload}"
SMB_ENABLED="${SMB_ENABLED:-false}"
APP_UID="${APP_UID:-101}"
APP_GID="${APP_GID:-103}"
export SMB_CONF_PATH="/home/container/runtime/smb.conf"

export HOME="/home/container"

mkdir -p /home/container/data/samba /home/container/logs /home/container/offload_mount /home/container/runtime /home/container/.npm
rm -f /home/container/runtime/fuse_ready /home/container/runtime/fuse_failed
chmod 777 /home/container/offload_mount
chown -R "${APP_UID}:${APP_GID}" /home/container
chown -R root:root /home/container/data/samba /home/container/logs /home/container/runtime
chmod 755 /home/container/data/samba /home/container/logs /home/container/runtime
touch /home/container/logs/samba.log
chmod +x /home/container/tools/smb_user.sh || true

# Keep mountpoint empty for FUSE; move any leftovers aside.
shopt -s dotglob nullglob
entries=(/home/container/offload_mount/*)
if [[ ${#entries[@]} -gt 0 ]]; then
  orphan_dir="/home/container/data/smb_orphans/$(date +%Y%m%d_%H%M%S)"
  mkdir -p "$orphan_dir"
  mv "${entries[@]}" "$orphan_dir"/ 2>/dev/null || true
fi
shopt -u dotglob nullglob

CONF_PATH="/home/container/runtime/smb.conf"
cat > "$CONF_PATH" <<EOF
[global]
  workgroup = WORKGROUP
  server string = Offload Disk
  server role = standalone server
  map to guest = never
  smb ports = ${SMB_PORT}
  min protocol = SMB2
  max protocol = SMB3
  log level = 1
  log file = /home/container/logs/samba.log
  max log size = 1000
  load printers = no
  disable spoolss = yes
  printing = bsd
  printcap name = /dev/null
  passdb backend = tdbsam
  obey pam restrictions = no
  unix password sync = no
  state directory = /home/container/data/samba
  cache directory = /home/container/data/samba
  lock directory = /home/container/data/samba
  private dir = /home/container/data/samba
  pid directory = /home/container/data/samba

[${SMB_SHARE_NAME}]
  path = /home/container/offload_mount/%U
  browseable = yes
  read only = no
  guest ok = no
  valid users = %U
  create mask = 0664
  directory mask = 0775
EOF

start_app() {
  if command -v gosu >/dev/null 2>&1; then
    gosu "${APP_UID}:${APP_GID}" bash -lc "npm_config_cache=/home/container/.npm npm install && npm run dev" &
  else
    bash -lc "npm_config_cache=/home/container/.npm npm install && npm run dev" &
  fi
  APP_PID=$!
}

start_smb() {
  if [[ "$SMB_ENABLED" != "true" ]]; then
    return 0
  fi
  if [[ ! -f /home/container/runtime/fuse_ready ]]; then
    echo "FUSE not ready, skipping SMB start" >> /home/container/logs/samba.log
    return 1
  fi
  if command -v smbd >/dev/null 2>&1; then
    if command -v pdbedit >/dev/null 2>&1; then
      while IFS= read -r smb_user; do
        if [[ -z "$smb_user" ]]; then
          continue
        fi
        if ! id "$smb_user" >/dev/null 2>&1; then
          useradd -M -s /usr/sbin/nologin "$smb_user" >/dev/null 2>&1 || true
        fi
      done < <(pdbedit -L -s "$CONF_PATH" 2>/dev/null | awk -F: '{print $1}')
    fi
    /usr/sbin/smbd -F --no-process-group -s "$CONF_PATH" &
  else
    echo "smbd not found in PATH"
  fi
}

start_app

if [[ "$SMB_ENABLED" == "true" ]]; then
  for _ in {1..20}; do
    if [[ -f /home/container/runtime/fuse_ready ]]; then
      break
    fi
    sleep 1
  done
fi

start_smb

wait "$APP_PID"
