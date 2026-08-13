export const UploadStrategyPathEnum = {
  AVATAR: 'avatar',
  RECORDING: 'recording',
  AUDIO_ANSWER: 'audioAnswer',
  CHAT: 'chat',
};

export async function getSignedUrl(data, token) {
  const API_BASE = 'https://api.slingui.com';
  const res = await fetch(`${API_BASE}/storage/upload`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error('Falha ao obter URL assinado para upload');
  }
  return await res.json();
}

function getUploadContentType(blob, signedContentType) {
  // For a presigned S3 URL, this must match the Content-Type used to sign it.
  // Prefer the value returned by Slingui; browser Blob types may include codec
  // parameters that are not part of the signed value.
  const contentType = signedContentType || blob?.type;
  if (contentType) return contentType;

  const name = blob?.name?.toLowerCase() || '';
  if (name.endsWith('.mp3')) return 'audio/mpeg';
  if (name.endsWith('.webm')) return 'video/webm';
  return 'application/octet-stream';
}

export async function sendFile(uploadUrl, blob, contentType) {
  const uploadContentType = getUploadContentType(blob, contentType);
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      // Do not strip parameters: signed headers must be sent verbatim.
      'Content-Type': uploadContentType,
      // Access-Control-Allow-Origin is a response header and must be set by
      // S3/API CORS configuration, not sent in the upload request. Avoiding
      // extra custom headers also keeps this PUT from requiring a needless
      // preflight on the signed S3 URL.
    },
    body: blob,
  });
  if (!res.ok) {
    throw new Error('Falha ao enviar arquivo para a URL assinada');
  }
}

export async function upload(data, blob, token) {
  const result = await getSignedUrl(data, token);
  console.log('result', result);
  await sendFile(result.uploadURL, blob, result.contentType);
  return result;
}

export async function getDownloadUrlByName(fileName, token) {
  try {
    const API_BASE = import.meta.env.VITE_URL ?? 'https://api.slingui.com';
    const url = new URL(`${API_BASE}/storage/download`);
    url.searchParams.set('url', fileName);
    url.searchParams.set('strategy', 'chat');
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        accept: '*/*',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      return data.uploadUrl || data.url || null;
    }
    const text = await res.text();
    return text && /^https?:\/\//.test(text) ? text : null;
  } catch {
    return null;
  }
}
