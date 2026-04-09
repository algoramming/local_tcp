// Local TCP - content.js
// Bridges standard web page `window.postMessage` directly to the Chrome native background socket API.

window.addEventListener('message', (event) => {
  // 1. Validate the origin of the message
  if (event.source !== window || !event.data || event.data.source !== 'localtcp_req') {
    return;
  }

  // 2. Prepare payload for the background script
  const payload = { ...event.data };
  const messageId = payload.messageId;
  delete payload.source;
  delete payload.messageId;

  // 3. Send securely to the internal background script
  chrome.runtime.sendMessage(payload, (response) => {
    // 4. Return the result back to the same webpage utilizing a matching messageId
    window.postMessage({
      source: 'localtcp_res',
      messageId: messageId,
      response: response || { success: false, error: chrome.runtime.lastError?.message || 'Unknown error' }
    }, '*');
  });
});
