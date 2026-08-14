import React, { useEffect, useState } from "react";
import { login, waitForAccessToken } from "../../../../utils/slingui-auth";

const AuthRequiredDialog = ({ contentState, onSkipSync }) => {
  const [visible, setVisible] = useState(false);
  const [loginState, setLoginState] = useState("idle");

  const status = contentState.meetingAudioChunksStatus;
  // ContentState already validated that a meeting context exists. Do not
  // require one particular identifier here: the chunks API also accepts
  // callId, roomId, classroomId, and other legacy context shapes.
  const hasMeeting = Boolean(contentState.recordingMeta?.meetingContext);
  const needsAuth =
    status === "waiting-auth" ||
    status === "auth-timeout" ||
    status === "auth-required";

  useEffect(() => {
    if (!hasMeeting || !needsAuth) {
      setVisible(false);
      if (status === "auth-ready" || status === "loaded") {
        setLoginState("idle");
      }
      return undefined;
    }

    if (status === "auth-timeout" || status === "auth-required") {
      setVisible(true);
      return undefined;
    }

    // Give an OIDC callback that is already in progress a short, quiet grace
    // period, but do not leave the user waiting for the full auth timeout.
    const timer = setTimeout(() => setVisible(true), 1800);
    return () => clearTimeout(timer);
  }, [hasMeeting, needsAuth, status]);

  if (!visible) return null;

  const handleLogin = async () => {
    setLoginState("loading");
    try {
      await login();
      // The OIDC callback resolves after exchanging the code, but wait for the
      // storage write as well. Chunk requests must never start without this token.
      await waitForAccessToken({ timeoutMs: 15_000 });
      // Hide the dialog before retrying. The retry will put the editor back in
      // its loading state and will show the dialog again only if auth fails.
      setVisible(false);
      setLoginState("idle");
      contentState.retryMeetingAudioChunks?.();
    } catch (error) {
      console.warn("[MeetingAudioChunks] Login requested by editor failed", error);
      setLoginState("error");
    }
  };

  return (
    <div style={styles.backdrop} role="dialog" aria-modal="true" aria-labelledby="slingui-auth-title">
      {loginState === "loading" && (
        <div style={styles.fullscreenLoading} role="status" aria-live="polite">
          <img
            src={chrome.runtime.getURL("assets/logo-text.svg")}
            alt="Slingui"
            style={styles.loadingLogo}
          />
          <img
            src={chrome.runtime.getURL("assets/record-tab-active.svg")}
            alt=""
            style={styles.loadingIcon}
          />
          <div style={styles.loadingTitle}>Preparando a sincronização…</div>
          <div style={styles.loadingDescription}>
            Aguarde enquanto concluímos seu login para sincronizar a aula com a gravação.
          </div>
        </div>
      )}
      {loginState !== "loading" && <div style={styles.dialog}>
        <div style={styles.icon} aria-hidden="true">🔐</div>
        <h2 id="slingui-auth-title" style={styles.title}>
          Faça login para sincronizar sua aula
        </h2>
        <p style={styles.description}>
          Entre na Slingui para sincronizar sua aula com esta gravação e compartilhá-la com seus alunos.
        </p>
        {loginState === "error" && (
          <p style={styles.error} role="alert">
            Não foi possível concluir o login. Tente novamente para sincronizar a reunião.
          </p>
        )}
        <div style={styles.actions}>
          <button
            type="button"
            style={styles.primary}
            onClick={handleLogin}
            disabled={loginState === "loading"}
          >
            {loginState === "loading" ? "Abrindo login…" : "Entrar na Slingui"}
          </button>
          <button
            type="button"
            style={styles.secondary}
            onClick={() => {
              setVisible(false);
              onSkipSync?.();
            }}
            disabled={loginState === "loading"}
          >
            Continuar sem sincronizar
          </button>
        </div>
      </div>}
    </div>
  );
};

const styles = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 2147483647,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background: "rgba(15, 23, 42, 0.42)",
    pointerEvents: "auto",
  },
  fullscreenLoading: {
    position: "fixed",
    inset: 0,
    zIndex: 2147483647,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    boxSizing: "border-box",
    background: "#f6f7fb",
    color: "#172033",
    textAlign: "center",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  loadingLogo: { position: "absolute", bottom: 30, width: 120 },
  loadingIcon: { width: 40, marginBottom: 20 },
  loadingTitle: { fontSize: 24, fontWeight: 700, marginBottom: 14 },
  loadingDescription: { maxWidth: 380, color: "#526074", fontSize: 14, lineHeight: 1.5 },
  dialog: {
    width: "min(440px, 100%)",
    boxSizing: "border-box",
    padding: "30px 32px 26px",
    borderRadius: 18,
    background: "#fff",
    color: "#172033",
    boxShadow: "0 24px 70px rgba(15, 23, 42, 0.28)",
    textAlign: "center",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  icon: { fontSize: 28, marginBottom: 10 },
  title: { margin: "0 0 12px", fontSize: 22, lineHeight: 1.25, fontWeight: 700 },
  description: { margin: "0 auto 22px", maxWidth: 360, color: "#526074", fontSize: 15, lineHeight: 1.5 },
  error: { margin: "-6px 0 16px", color: "#b42318", fontSize: 13, lineHeight: 1.4 },
  actions: { display: "flex", flexDirection: "column", gap: 10 },
  primary: { border: 0, borderRadius: 10, padding: "12px 16px", background: "#16834b", color: "#fff", fontSize: 15, fontWeight: 650, cursor: "pointer" },
  secondary: { border: "1px solid #d4dbe5", borderRadius: 10, padding: "11px 16px", background: "#fff", color: "#526074", fontSize: 14, cursor: "pointer" },
};

export default AuthRequiredDialog;
