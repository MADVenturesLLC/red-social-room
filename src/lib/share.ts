// C1: hand a finished image to the phone's share sheet (Instagram, Messages, AirDrop …).
// Where the browser has no Web Share API with files (most desktops), it downloads the image instead,
// which is exactly what the app did before. Callers are client components; nothing here touches the server.
export type ShareResult = "shared" | "downloaded" | "cancelled" | "failed";

export async function shareImage(url: string, filename: string, title: string, text?: string): Promise<ShareResult> {
  let file: File;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return "failed";
    const blob = await res.blob();
    const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
    file = new File([blob], filename.replace(/\.(jpg|jpeg|png|webp)$/i, `.${ext}`), { type: blob.type || "image/jpeg" });
  } catch {
    return "failed";
  }

  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  if (typeof nav.share === "function" && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title, text });
      return "shared";
    } catch (e) {
      return (e as Error).name === "AbortError" ? "cancelled" : "failed";
    }
  }

  try {
    const u = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = u;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(u);
    return "downloaded";
  } catch {
    return "failed";
  }
}

/** True when this browser can open a file share sheet; used to label the button honestly. */
export function canShareFiles(): boolean {
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  try {
    const probe = new File([new Uint8Array([0])], "probe.jpg", { type: "image/jpeg" });
    return typeof nav.share === "function" && nav.canShare?.({ files: [probe] }) === true;
  } catch {
    return false;
  }
}
