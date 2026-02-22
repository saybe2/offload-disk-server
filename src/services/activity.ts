let activeRestores = 0;

export function startRestore() {
  activeRestores += 1;
}

export function endRestore() {
  activeRestores = Math.max(0, activeRestores - 1);
}
