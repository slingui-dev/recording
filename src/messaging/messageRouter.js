const handlers = {};

export const registerMessage = (type, handler) => {
  if (handlers[type]) {
    console.warn(
      `⚠️ Handler for ${type} already exists in this context. Skipping.`
    );
    return;
  }
  handlers[type] = handler;
};

export const messageDispatcher = (message, sender, sendResponse) => {
  const handler = handlers[message.type];

  if (handler) {
    let responseSent = false;
    const reply = (response) => {
      if (responseSent) return;
      responseSent = true;
      try {
        sendResponse(response);
      } catch (error) {
        // The sender can disappear while an async handler is running (for
        // example when editor.html is reloaded). There is nothing left to
        // reply to in that case.
        console.debug("[Slingui][Messaging] response channel closed", {
          type: message?.type || null,
          error: String(error?.message || error),
        });
      }
    };

    try {
      const result = handler(message, sender, reply);

      if (result instanceof Promise) {
        result
          .then((response) => {
            if (!responseSent) reply(response);
          })
          .catch((err) => {
            if (!responseSent) {
              reply({ error: err?.message || String(err) });
            }
          });

        return true;
      } else if (!responseSent) {
        reply(result);
      }
    } catch (err) {
      if (!responseSent) reply({ error: err?.message || String(err) });
    }
  }
};

export const messageRouter = () => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const result = messageDispatcher(message, sender, sendResponse);

    if (result === true || result instanceof Promise) {
      return true;
    }
  });
};
