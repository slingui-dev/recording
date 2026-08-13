// src/utils/slingui-auth.js

const config = {
  apiBaseUrl: 'https://api.slingui.com',
  authority: 'https://api.slingui.com/auth/oidc',
  client_id: 'screenity-extension',
  scope: 'openid profile email',
};

// --- PKCE and State Utility Functions ---

function generateRandomString() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64urlEncode(array);
}

function base64urlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64urlEncode(digest);
}

function getRedirectUrl() {
  if (typeof chrome !== 'undefined' && chrome.identity) {
    return chrome.identity.getRedirectURL('callback.html');
  }
  // Fallback for development
  return 'http://localhost:3000/callback.html';
}

function parseJwt(token) {
    if (!token) {
        return null;
    }

    try {
        const base64Url = token.split('.')[1];
        if (!base64Url) {
            return null;
        }

        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));

        return JSON.parse(jsonPayload);
    } catch (e) {
        console.error("Error parsing JWT", e);
        return null;
    }
}

function getTokenProfile(tokens) {
  return parseJwt(tokens.id_token) || parseJwt(tokens.access_token) || null;
}

function maskToken(token) {
  if (!token || typeof token !== 'string') {
    return token;
  }

  return `${token.slice(0, 12)}...${token.slice(-8)}`;
}

function getSafeAuthLogData(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  return Object.entries(data).reduce((safeData, [key, value]) => {
    const lowerKey = key.toLowerCase();
    const isSensitive = lowerKey.includes('token') || lowerKey.includes('secret');

    safeData[key] = isSensitive && typeof value === 'string'
      ? maskToken(value)
      : value;

    return safeData;
  }, {});
}

function hasProfileDisplayName(profile) {
  return Boolean(
    profile?.name ||
    profile?.given_name ||
    profile?.family_name ||
    profile?.preferred_username ||
    profile?.email
  );
}

async function fetchUserInfo(accessToken) {
  if (!accessToken) {
    console.log('[Slingui Auth] /auth/me skipped: missing access token');
    return null;
  }

  try {
    console.log('[Slingui Auth] Fetching /auth/me with access token:', maskToken(accessToken));

    const response = await fetch(`${config.apiBaseUrl}/auth/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      console.warn('Could not fetch Slingui /auth/me:', response.status);
      return null;
    }

    const userInfo = await response.json();
    console.log('[Slingui Auth] /auth/me response:', userInfo);
    return userInfo;
  } catch (error) {
    console.warn('Could not fetch Slingui /auth/me:', error);
    return null;
  }
}

async function enrichUserProfile(user) {
  if (!user || hasProfileDisplayName(user.profile)) {
    console.log('[Slingui Auth] Profile enrichment skipped:', {
      hasUser: Boolean(user),
      hasDisplayName: hasProfileDisplayName(user?.profile),
      profile: user?.profile || null,
    });
    return user;
  }

  console.log('[Slingui Auth] Profile missing display data, trying /auth/me:', {
    profileFromToken: user.profile || null,
  });

  const userInfo = await fetchUserInfo(user.access_token);
  if (!userInfo) {
    console.log('[Slingui Auth] Profile enrichment did not receive /auth/me data');
    return user;
  }

  const enrichedUser = {
    ...user,
    profile: {
      ...(user.profile || {}),
      ...userInfo,
    },
  };

  console.log('[Slingui Auth] Enriched profile:', enrichedUser.profile);
  return enrichedUser;
}

// --- Main Authentication Logic ---

let loginPromise = null;

export async function login() {
  if (typeof chrome === 'undefined' || !chrome.identity || !chrome.storage) {
    throw new Error('Chrome identity API is not available.');
  }

  if (loginPromise) {
    return loginPromise;
  }

  loginPromise = loginInternal();

  try {
    return await loginPromise;
  } finally {
    loginPromise = null;
  }
}

async function loginInternal() {

  const redirectURL = getRedirectUrl();
  const tokenEndpoint = `${config.authority}/token`;

  const codeVerifier = generateRandomString();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateRandomString();

  // Store verifier and state to use them after the redirect
  await new Promise((resolve, reject) => {
    chrome.storage.local.set({
      auth_code_verifier: codeVerifier,
      auth_state: state
    }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });

  const authParams = new URLSearchParams({
    client_id: config.client_id,
    response_type: 'code',
    redirect_uri: redirectURL,
    scope: config.scope,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: state,
  });

  const authURL = `${config.authority}/auth?${authParams.toString()}`;
  console.log('Launching auth flow:', authURL);

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authURL, interactive: true }, async (responseUrl) => {
      if (chrome.runtime.lastError || !responseUrl) {
        return reject(new Error(chrome.runtime.lastError?.message || "Authentication flow failed."));
      }

      try {
        const url = new URL(responseUrl);
        const authCode = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');

        const { auth_state, auth_code_verifier } = await new Promise(resolve => {
          chrome.storage.local.get(['auth_state', 'auth_code_verifier'], result => resolve(result));
        });

        if (returnedState !== auth_state) {
          throw new Error('State mismatch: possible CSRF attack');
        }

        if (!authCode) {
          const error = url.searchParams.get('error');
          throw new Error(`Authorization failed: ${error}`);
        }

        const tokenParams = new URLSearchParams({
          client_id: config.client_id,
          grant_type: 'authorization_code',
          code: authCode,
          redirect_uri: redirectURL,
          code_verifier: auth_code_verifier,
        });

        const tokenResponse = await fetch(tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenParams.toString(),
        });

        if (!tokenResponse.ok) {
          const errorData = await tokenResponse.json();
          throw new Error(`Token exchange failed: ${errorData.error}`);
        }

        const tokens = await tokenResponse.json();
        console.log('[Slingui Auth] Token response:', getSafeAuthLogData(tokens));

        const profile = getTokenProfile(tokens);
        console.log('[Slingui Auth] Profile parsed from token:', profile);

        const user = await enrichUserProfile({ ...tokens, profile });
        console.log('[Slingui Auth] Final user before storage:', getSafeAuthLogData(user));

        chrome.storage.local.set({ user: user }, () => {
          chrome.storage.local.remove(['auth_code_verifier', 'auth_state']);
          console.log('[Slingui Auth] User profile stored:', getSafeAuthLogData(user));
          resolve(user);
        });

      } catch (error) {
        console.error('Auth error:', error.message);
        chrome.storage.local.remove(['auth_code_verifier', 'auth_state']);
        reject(error);
      }
    });
  });
}

export function isTokenExpired(user) {
  if (!user || !user.expires_at) {
    if (user && user.profile && user.profile.exp) {
      return Date.now() >= user.profile.exp * 1000;
    }
    return true;
  }
  return Date.now() >= user.expires_at * 1000;
}

const readStoredAuth = async () => {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { user: null, screenityToken: null };
  }

  return new Promise((resolve) => {
    chrome.storage.local.get(['user', 'screenityToken'], (result) => {
      resolve({
        user: result?.user || null,
        screenityToken: result?.screenityToken || null,
      });
    });
  });
};

const resolveStoredAccessToken = async () => {
  const { user, screenityToken } = await readStoredAuth();
  if (user?.access_token && !isTokenExpired(user)) {
    return user.access_token;
  }

  // Keep the legacy token as a compatibility fallback for existing sessions.
  // New OIDC sessions should use user.access_token above.
  return screenityToken || null;
};

/**
 * Wait until the OIDC callback has persisted a usable token.
 * The editor can open before the auth flow finishes, so a one-shot storage
 * read is not sufficient for requests started during editor recovery.
 */
export async function waitForAccessToken({
  timeoutMs = 30_000,
  pollMs = 250,
  onStatus,
} = {}) {
  const startedAt = Date.now();
  let removeStorageListener = () => {};
  let timer = null;
  let pollTimer = null;

  const notify = (status, details = {}) => {
    onStatus?.({ status, elapsedMs: Date.now() - startedAt, ...details });
  };

  notify('waiting-auth');

  const token = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (pollTimer) clearTimeout(pollTimer);
      removeStorageListener();
      resolve(value || null);
    };

    const check = async () => {
      try {
        const nextToken = await resolveStoredAccessToken();
        if (nextToken) {
          notify('auth-ready');
          finish(nextToken);
          return;
        }
      } catch (error) {
        console.warn('[Slingui Auth] Could not read auth state:', error);
      }

      if (!settled) pollTimer = setTimeout(check, pollMs);
    };

    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      const listener = (changes, area) => {
        if (area !== 'local') return;
        if (!changes.user && !changes.screenityToken) return;
        check();
      };
      chrome.storage.onChanged.addListener(listener);
      removeStorageListener = () => chrome.storage.onChanged.removeListener(listener);
    }

    timer = setTimeout(() => {
      notify('auth-timeout');
      finish(null);
    }, timeoutMs);

    check();
  });

  if (!token) {
    throw new Error(`Authentication not ready after ${timeoutMs}ms`);
  }

  return token;
}

export async function getUser() {
  if (typeof chrome === 'undefined' || !chrome.storage) {
    return null;
  }

  const result = await new Promise((resolve) => {
    chrome.storage.local.get('user', resolve);
  });

  const user = result.user || null;
  if (!user) {
    console.log('[Slingui Auth] Stored user not found');
    return null;
  }

  console.log('[Slingui Auth] Stored user found:', getSafeAuthLogData(user));

  const userWithExpiration = {
    ...user,
    expired: isTokenExpired(user),
  };

  console.log('[Slingui Auth] Stored user expiration status:', {
    expired: userWithExpiration.expired,
    expires_at: userWithExpiration.expires_at || null,
    profileExp: userWithExpiration.profile?.exp || null,
  });

  if (userWithExpiration.expired) {
    return userWithExpiration;
  }

  const enrichedUser = await enrichUserProfile(userWithExpiration);
  if (enrichedUser !== userWithExpiration) {
    chrome.storage.local.set({ user: enrichedUser });
    console.log('[Slingui Auth] Stored user updated after profile enrichment:', getSafeAuthLogData(enrichedUser));
  }

  console.log('[Slingui Auth] Returning stored user:', getSafeAuthLogData(enrichedUser));
  return enrichedUser;
}

export function logout() {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.remove('user', () => {
        console.log('User logged out and data removed.');
        resolve();
      });
    } else {
      resolve();
    }
  });
}
