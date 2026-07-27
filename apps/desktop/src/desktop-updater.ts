import type { Update } from "@tauri-apps/plugin-updater";

export type DesktopUpdate = Update;

export async function checkForDesktopUpdate(): Promise<DesktopUpdate | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  return check();
}

export async function installDesktopUpdate(update: DesktopUpdate, onProgress: (label: string) => void): Promise<void> {
  onProgress("Downloading verified update…");
  await update.downloadAndInstall((event) => {
    if (event.event === "Finished") onProgress("Installing update…");
  });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
