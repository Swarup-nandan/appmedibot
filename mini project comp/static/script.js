console.log("🚀 Medibot loaded");

// DOM Elements
const chatContainer = document.getElementById("chat-container");
const chatMessages = document.getElementById("chat-messages");
const welcomeScreen = document.getElementById("welcome-screen");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const newChatBtn = document.getElementById("new-chat-btn");
const clearHistoryBtn = document.getElementById("clear-history-btn");
const sidebar = document.getElementById("sidebar");
const sidebarOverlay = document.getElementById("sidebar-overlay");
const menuToggle = document.getElementById("menu-toggle");
const mobileMenuBtn = document.getElementById("mobile-menu-btn");
const recentChats = document.getElementById("recent-chats");

// Convert URLs to clickable links
function linkify(text) {
    const urlPattern = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
    return text.replace(urlPattern, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

// Format message: escape HTML, convert URLs to links, convert newlines
function formatMessage(text) {
    let escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    escaped = linkify(escaped);
    escaped = escaped.replace(/\n/g, '<br>');
    return escaped;
}

// Hide welcome screen
function hideWelcome() {
    if (welcomeScreen) {
        welcomeScreen.classList.add("hidden");
    }
}

// Show welcome screen
function showWelcome() {
    if (welcomeScreen) {
        welcomeScreen.classList.remove("hidden");
    }
    chatMessages.innerHTML = "";
}

// Add message to chat
function addMessage(content, sender = "bot", type = "chat") {
    hideWelcome();
    
    const messageDiv = document.createElement("div");
    messageDiv.classList.add("message", sender);
    if (type === "emergency") messageDiv.classList.add("emergency");
    if (type === "location") messageDiv.classList.add("location");
    
    const avatarIcon = sender === "user" ? "You" : "🩺";
    
    messageDiv.innerHTML = `
        <div class="message-avatar">${sender === "user" ? "Y" : "🩺"}</div>
        <div class="message-content">
            <div class="message-bubble">${formatMessage(content)}</div>
        </div>
    `;
    
    chatMessages.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    
    // Add to recent chats (first 30 chars)
    if (sender === "user") {
        addToRecent(content);
    }
}

// Typing indicator with optional message
function showTyping(message = "") {
    hideWelcome();
    const typing = document.createElement("div");
    typing.id = "typing";
    typing.classList.add("typing-indicator");
    
    if (message) {
        typing.innerHTML = `
            <div class="message-avatar">🩺</div>
            <div class="typing-dots">
                <span></span>
                <span></span>
                <span></span>
            </div>
            <div style="margin-left: 45px; margin-top: 5px; font-size: 12px; color: #666;">${message}</div>
        `;
    } else {
        typing.innerHTML = `
            <div class="message-avatar">🩺</div>
            <div class="typing-dots">
                <span></span>
                <span></span>
                <span></span>
            </div>
        `;
    }
    
    chatMessages.appendChild(typing);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function removeTyping() {
    const typing = document.getElementById("typing");
    if (typing) typing.remove();
}

// Update typing indicator message
function updateTypingMessage(message) {
    const typing = document.getElementById("typing");
    if (typing) {
        const existingMsg = typing.querySelector('div[style*="margin-left"]');
        if (existingMsg) {
            existingMsg.textContent = message;
        } else {
            const msgDiv = document.createElement("div");
            msgDiv.style.marginLeft = "45px";
            msgDiv.style.marginTop = "5px";
            msgDiv.style.fontSize = "12px";
            msgDiv.style.color = "#666";
            msgDiv.textContent = message;
            typing.appendChild(msgDiv);
        }
    }
}

// Add to recent chats sidebar
function addToRecent(message) {
    const truncated = message.length > 30 ? message.substring(0, 30) + "..." : message;
    
    // Check if already exists
    const existing = recentChats.querySelector(`[data-message="${CSS.escape(message)}"]`);
    if (existing) return;
    
    const item = document.createElement("div");
    item.classList.add("recent-item");
    item.textContent = truncated;
    item.dataset.message = message;
    item.onclick = () => {
        userInput.value = message;
        closeSidebar();
    };
    
    // Add to top
    recentChats.insertBefore(item, recentChats.firstChild);
    
    // Keep only 10 recent
    while (recentChats.children.length > 10) {
        recentChats.removeChild(recentChats.lastChild);
    }
}

// Retry fetch with exponential backoff
async function fetchWithRetry(url, options, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await fetch(url, options);
            const data = await response.json();
            
            // Check if response indicates rate limit error
            if (response.status === 429 || (data.error && data.error.includes("429"))) {
                if (attempt < maxRetries - 1) {
                    const delay = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
                    const seconds = Math.ceil(delay / 1000);
                    console.log(`⏳ Rate limited. Retrying in ${seconds}s... (Attempt ${attempt + 1}/${maxRetries})`);
                    updateTypingMessage(`Rate limit reached. Retrying in ${seconds} seconds...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
            }
            
            return { response, data };
            
        } catch (error) {
            if (attempt < maxRetries - 1) {
                const delay = Math.pow(2, attempt) * 1000;
                console.log(`⚠ Network error. Retrying in ${delay/1000}s...`);
                updateTypingMessage(`Connection error. Retrying...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
    
    throw new Error("Max retries exceeded");
}

// Send message with retry logic
async function sendMessage() {
    const message = userInput.value.trim();
    if (!message) return;

    addMessage(message, "user");
    userInput.value = "";
    userInput.style.height = "auto";
    showTyping();
    sendBtn.disabled = true;

    try {
        const { response, data } = await fetchWithRetry(
            "/api/chat",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message }),
            },
            3 // max retries
        );

        removeTyping();
        
        if (data.error) {
            addMessage(`⚠ Error: ${data.error}`, "bot", "error");
        } else {
            const msgType = data.type || "chat";
            const sender = msgType === "emergency" ? "emergency" : "bot";
            addMessage(data.reply, sender, msgType);
        }
        
    } catch (error) {
        removeTyping();
        addMessage(
            "⚠ Unable to connect after multiple attempts. The service may be experiencing high traffic. Please try again in a minute.",
            "bot",
            "error"
        );
        console.error("❌ Chat error:", error);
    } finally {
        sendBtn.disabled = false;
        userInput.focus();
    }
}

// Quick message from buttons
function sendQuickMessage(message) {
    userInput.value = message;
    sendMessage();
    closeSidebar();
}

// Sidebar toggle
function toggleSidebar() {
    sidebar.classList.toggle("open");
    sidebarOverlay.classList.toggle("active");
}

function closeSidebar() {
    sidebar.classList.remove("open");
    sidebarOverlay.classList.remove("active");
}

// Clear chat
async function clearChat() {
    try {
        await fetch("/api/history/clear", { method: "POST" });
        showWelcome();
        recentChats.innerHTML = "";
    } catch (error) {
        console.error("Failed to clear history:", error);
    }
}

// New chat
function newChat() {
    showWelcome();
    closeSidebar();
}

// Event Listeners
sendBtn.addEventListener("click", sendMessage);

userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Auto-resize textarea
userInput.addEventListener("input", () => {
    userInput.style.height = "auto";
    userInput.style.height = Math.min(userInput.scrollHeight, 200) + "px";
});

newChatBtn.addEventListener("click", newChat);
clearHistoryBtn.addEventListener("click", clearChat);
menuToggle.addEventListener("click", toggleSidebar);
mobileMenuBtn.addEventListener("click", toggleSidebar);
sidebarOverlay.addEventListener("click", closeSidebar);

// Load chat history on page load
window.onload = async () => {
    try {
        const response = await fetch("/api/history");
        const data = await response.json();

        if (data.history && data.history.length > 0) {
            hideWelcome();
            data.history.forEach((msg) => {
                const sender = msg.role === "user" ? "user" : "bot";
                const type = msg.message_type || msg.type || "chat";
                addMessage(msg.content, sender, type);
            });
            console.log(`💬 Loaded ${data.history.length} messages`);
        }
    } catch (error) {
        console.error("⚠ Could not load history:", error);
    }
};

// Expose for HTML onclick
window.sendQuickMessage = sendQuickMessage;