const API_BASE = import.meta.env.VITE_URL ?? 'https://api.slingui.com';

/**
 * Registers a recording in Classroom after its media has been uploaded.
 * The storage upload and the classroom document are separate API operations.
 */
export async function createRecordingDocument({
  name,
  storageUrl,
  token,
  metadata = {},
}) {
  if (!name || !storageUrl || !token) {
    throw new Error('Dados insuficientes para registrar a recording no Slingui');
  }

  const response = await fetch(`${API_BASE}/classroom/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      name,
      path: 'recording',
      type: 'recording',
      usersCanAccess: [],
      storageUrl,
      metadata,
    }),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.message ? `: ${body.message}` : '';
    } catch {}
    throw new Error(
      `Upload concluído, mas não foi possível registrar a recording (${response.status})${detail}`,
    );
  }

  return response.json();
}
