(function () {
  const css = `
  #dw-help-btn {
    position: fixed; right: 16px; bottom: 16px; z-index: 9998;
    width: 32px; height: 32px; border-radius: 50%;
    background: rgba(24,24,27,0.7); color: #a1a1aa;
    border: 1px solid #3f3f46; cursor: pointer;
    font: 600 16px/1 Helvetica, Arial, sans-serif;
    display: flex; align-items: center; justify-content: center;
    transition: opacity 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    opacity: 0.55;
    padding: 0;
  }
  #dw-help-btn:hover { opacity: 1; color: #fbbf24; border-color: #fbbf24; }
  #dw-help-overlay {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.75);
    display: none; align-items: center; justify-content: center;
    padding: 24px;
  }
  #dw-help-overlay.show { display: flex; }
  #dw-help-modal {
    background: #18181b; border: 1px solid #27272a; border-radius: 14px;
    padding: 28px; max-width: 480px; width: 100%;
    color: #f4f4f5; font-family: Helvetica, Arial, sans-serif;
    box-shadow: 0 20px 60px rgba(0,0,0,0.6);
  }
  #dw-help-modal h3 { margin: 0 0 12px; font-size: 18px; letter-spacing: 0.02em; }
  #dw-help-modal p { margin: 0 0 16px; color: #d4d4d8; font-size: 14px; line-height: 1.55; }
  #dw-help-modal p .vibe { color: #ef4444; font-weight: 700; letter-spacing: 0.04em; }
  #dw-help-modal p a:hover { text-decoration: underline !important; }
  #dw-help-modal textarea {
    width: 100%; box-sizing: border-box; min-height: 110px; resize: vertical;
    background: #0f0f10; color: #f4f4f5; border: 1px solid #27272a;
    border-radius: 10px; padding: 12px 14px;
    font: inherit; font-size: 14px; line-height: 1.5;
  }
  #dw-help-modal textarea:focus { outline: 2px solid #fbbf24; }
  #dw-help-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px; }
  #dw-help-modal button {
    font: inherit; font-size: 14px; padding: 10px 16px; border-radius: 8px;
    border: 1px solid #27272a; background: transparent; color: #f4f4f5;
    cursor: pointer;
  }
  #dw-help-modal button.primary { background: #ef4444; border-color: #ef4444; color: white; font-weight: 600; }
  #dw-help-modal button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  #dw-help-modal button:hover:not(:disabled) { filter: brightness(1.1); }
  #dw-help-status { color: #71717a; font-size: 13px; min-height: 1.2em; margin-top: 10px; }
  #dw-help-status.ok { color: #22c55e; }
  #dw-help-status.err { color: #ef4444; }
  `;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'dw-help-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'About this site / send feedback');
  btn.textContent = '?';

  const overlay = document.createElement('div');
  overlay.id = 'dw-help-overlay';
  overlay.innerHTML = `
    <div id="dw-help-modal" role="dialog" aria-modal="true" aria-labelledby="dw-help-title">
      <h3 id="dw-help-title">About this site</h3>
      <p>This site was <span class="vibe">VIBECODED AS HELL</span> by <a href="https://harrywaterman.com" target="_blank" rel="noopener" style="color:#fbbf24;text-decoration:none;font-weight:600;">harry</a>. If you have feedback, drop it below — my agent will autonomously implement the fix or change if it's reasonable.</p>
      <textarea id="dw-help-text" placeholder="What should change? Bugs, ideas, nitpicks, anything." maxlength="2000"></textarea>
      <div id="dw-help-status"></div>
      <div id="dw-help-actions">
        <button type="button" id="dw-help-close">Close</button>
        <button type="button" id="dw-help-send" class="primary">Send</button>
      </div>
    </div>
  `;

  function mount() {
    document.body.appendChild(btn);
    document.body.appendChild(overlay);

    const textarea = overlay.querySelector('#dw-help-text');
    const status = overlay.querySelector('#dw-help-status');
    const sendBtn = overlay.querySelector('#dw-help-send');
    const closeBtn = overlay.querySelector('#dw-help-close');

    function open() {
      overlay.classList.add('show');
      status.textContent = '';
      status.className = '';
      setTimeout(() => textarea.focus(), 30);
    }
    function close() { overlay.classList.remove('show'); }

    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('show')) close();
    });

    sendBtn.addEventListener('click', async () => {
      const text = textarea.value.trim();
      if (!text) { status.textContent = 'Write something first.'; status.className = 'err'; return; }
      sendBtn.disabled = true;
      status.textContent = 'Sending…';
      status.className = '';
      try {
        const r = await fetch('/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, page: location.pathname + location.search }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        status.textContent = 'Sent. Thanks.';
        status.className = 'ok';
        textarea.value = '';
        setTimeout(close, 1200);
      } catch (err) {
        status.textContent = 'Failed to send. Try again later.';
        status.className = 'err';
      } finally {
        sendBtn.disabled = false;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
