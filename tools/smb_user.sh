#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
USERNAME="${2:-}"
PASSWORD="${3:-}"
SMB_MOUNT="${SMB_MOUNT:-/home/container/offload_mount}"
SMB_CONF_PATH="${SMB_CONF_PATH:-/home/container/runtime/smb.conf}"

export SMB_CONF_PATH

if [[ -z "$ACTION" || -z "$USERNAME" ]]; then
  echo "usage: smb_user.sh ensure|delete <username> [password]" >&2
  exit 2
fi

if [[ ! "$USERNAME" =~ ^[a-zA-Z0-9._-]{1,32}$ ]]; then
  echo "invalid username" >&2
  exit 3
fi

case "$ACTION" in
  ensure)
    if [[ -z "$PASSWORD" ]]; then
      echo "password required" >&2
      exit 4
    fi
    if ! id "$USERNAME" >/dev/null 2>&1; then
      useradd -M -s /usr/sbin/nologin "$USERNAME"
    fi
    printf "%s\n%s\n" "$PASSWORD" "$PASSWORD" | smbpasswd -c "$SMB_CONF_PATH" -a -s "$USERNAME" >/dev/null
    smbpasswd -c "$SMB_CONF_PATH" -e "$USERNAME" >/dev/null 2>&1 || true
    mkdir -p "$SMB_MOUNT/$USERNAME"
    chown "$USERNAME":"$USERNAME" "$SMB_MOUNT/$USERNAME" 2>/dev/null || true
    chmod 750 "$SMB_MOUNT/$USERNAME" 2>/dev/null || true
    ;;
  delete)
    if id "$USERNAME" >/dev/null 2>&1; then
      smbpasswd -c "$SMB_CONF_PATH" -x "$USERNAME" >/dev/null 2>&1 || true
      userdel "$USERNAME" >/dev/null 2>&1 || true
    fi
    ;;
  *)
    echo "unknown action" >&2
    exit 2
    ;;
esac
