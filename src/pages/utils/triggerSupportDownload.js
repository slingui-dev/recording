import { buildDiagnosticZip } from "./buildDiagnosticZip";

// Download the diagnostic ZIP locally so the user can attach it to a
// Slingui support request if needed.
export const triggerSupportDownload = async (opts = {}) => {
  try {

    const { blob, filename } = await buildDiagnosticZip(opts);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return filename;
  } catch (err) {
    console.error("[Slingui] Support zip download failed:", err);
    return null;
  }
};
