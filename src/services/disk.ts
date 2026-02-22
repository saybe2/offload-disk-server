import checkDiskSpaceModule from "check-disk-space";

type CheckDiskSpaceFn = (directoryPath: string) => Promise<{ diskPath: string; free: number; size: number }>;

const checkDiskSpace = ((checkDiskSpaceModule as unknown as { default?: CheckDiskSpaceFn }).default ??
  (checkDiskSpaceModule as unknown as CheckDiskSpaceFn));

export { checkDiskSpace };
