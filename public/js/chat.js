const chatPanel = document.getElementById("chat");

if (chatPanel) {
  const listingId = chatPanel.dataset.listingId;
  const userId = chatPanel.dataset.userId;
  let guestId = chatPanel.dataset.guestId || null; // set for guests on load; owners pick one below

  const messagesEl = chatPanel.querySelector(".chat-messages");
  const errorEl = chatPanel.querySelector(".chat-error");
  const formEl = chatPanel.querySelector(".chat-form");
  const inputEl = formEl.querySelector("input[name='text']");
  const guestButtons = document.querySelectorAll(".chat-guest-btn");

  // WebSocket-only: with several app instances behind a load balancer, this
  // keeps one connection pinned to one instance, so plain round robin works
  // with no sticky-session config on the server. See Phase 4 plan D3.
  const socket = io({ transports: ["websocket"] });

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = false;
  };
  const clearError = () => {
    errorEl.hidden = true;
  };

  const render = (msg) => {
    const li = document.createElement("li");
    li.className = "chat-message" + (msg.senderId === userId ? " mine" : "");

    const meta = document.createElement("div");
    meta.className = "chat-message-meta";
    const time = new Date(msg.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    meta.textContent = `${msg.senderName} · ${time}`; // "·" separator

    const body = document.createElement("div");
    body.className = "chat-message-text";
    body.textContent = msg.text; // textContent only — never innerHTML — so a message can never inject markup/scripts

    li.appendChild(meta);
    li.appendChild(body);
    messagesEl.appendChild(li);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  const join = (targetGuestId) => {
    guestId = targetGuestId;
    clearError();
    socket.emit("chat:join", { listingId, guestId }, (res) => {
      if (!res.ok) {
        showError(res.error);
        return;
      }
      messagesEl.innerHTML = "";
      res.messages.forEach(render);
      chatPanel.hidden = false;
    });
  };

  // Re-join on every connect, including reconnects after an instance goes
  // down: Socket.IO auto-reconnects to another instance, but room membership
  // lived only on the old one, so we must re-join and reload history.
  socket.on("connect", () => {
    if (guestId) join(guestId);
  });

  socket.on("connect_error", () => {
    showError("Couldn't connect to chat. Try reloading the page.");
  });

  // The server only delivers this event to sockets currently in that
  // conversation's room, and joining a new one leaves the old room first
  // (socket/chat.js), so every message here belongs to the open conversation.
  socket.on("chat:message", render);

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text || !guestId) return;
    clearError();
    socket.emit("chat:send", { listingId, guestId, text }, (res) => {
      if (!res.ok) {
        showError(res.error);
        return;
      }
      inputEl.value = "";
    });
  });

  guestButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      guestButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      join(btn.dataset.guestId);
    });
  });
}
