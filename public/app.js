// public/app.js

// --- 1. INITIALIZATION ---
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();
const messaging = firebase.messaging();

// --- STATE & DOM ELEMENTS ---
let currentUser = null;
let currentChatId = null;
let unsubscribeMessages = null;
let replyingTo = null;

const ui = {
    auth: document.getElementById('auth-container'),
    app: document.getElementById('app-container'),
    loginForm: document.getElementById('login-form'),
    chatList: document.getElementById('chat-list'),
    messagesContainer: document.getElementById('messages-container'),
    input: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    fileInput: document.getElementById('file-upload'),
    chatArea: document.getElementById('chat-area'),
    sidebar: document.getElementById('sidebar'),
    emptyState: document.getElementById('empty-state'),
    activeChat: document.getElementById('active-chat'),
    previewModal: document.getElementById('image-modal'),
    replyPreview: document.getElementById('reply-preview')
};

// --- 2. AUTHENTICATION ---
auth.onAuthStateChanged(async (user) => {
    if (user) {
        currentUser = user;
        await updateUserData(user); // Simpan user ke Firestore
        ui.auth.classList.add('hidden');
        ui.app.classList.remove('hidden');
        
        // Request FCM Permission
        requestNotificationPermission();
        
        loadChats();
    } else {
        currentUser = null;
        ui.auth.classList.remove('hidden');
        ui.app.classList.add('hidden');
    }
});

async function updateUserData(user) {
    const userRef = db.collection('users').doc(user.uid);
    const doc = await userRef.get();
    
    // Update presence & token
    const token = await messaging.getToken({ vapidKey: "ISI_VAPID_KEY_ANDA" }).catch(() => null);
    
    if (!doc.exists) {
        await userRef.set({
            uid: user.uid,
            email: user.email,
            name: user.displayName || user.email.split('@')[0],
            avatar: user.photoURL || `https://ui-avatars.com/api/?name=${user.email}`,
            role: 'member', // Default role
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            fcmToken: token
        });
    } else {
        // Update token if changed
        if(token && doc.data().fcmToken !== token) {
            userRef.update({ fcmToken: token });
        }
        // Set Online Status (Simple implementation)
        userRef.update({ status: 'online', lastSeen: firebase.firestore.FieldValue.serverTimestamp() });
    }
}

ui.loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const pass = document.getElementById('password').value;
    auth.signInWithEmailAndPassword(email, pass).catch(alert);
});

document.getElementById('google-login').onclick = () => {
    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(alert);
};

document.getElementById('logout-btn').onclick = () => {
    if(currentUser) db.collection('users').doc(currentUser.uid).update({ status: 'offline' });
    auth.signOut();
};

// --- 3. CHAT LIST LOGIC ---
function loadChats() {
    // Listen to chats where user is a member
    db.collection('chats')
      .where('members', 'array-contains', currentUser.uid)
      .orderBy('updatedAt', 'desc')
      .onSnapshot(snapshot => {
          ui.chatList.innerHTML = '';
          snapshot.forEach(doc => {
              const chat = doc.data();
              const div = document.createElement('div');
              div.className = `chat-item ${currentChatId === doc.id ? 'active' : ''}`;
              
              // Get Name & Avatar
              let name = chat.name;
              let avatar = `https://ui-avatars.com/api/?name=${chat.name}`;
              
              if (chat.type === 'private') {
                  const otherId = chat.members.find(id => id !== currentUser.uid);
                  // Fetch other user details (Optimized: In real app, store name in chat doc or join)
                  db.collection('users').doc(otherId).get().then(u => {
                      if(u.exists) {
                          name = u.data().name;
                          avatar = u.data().avatar;
                          div.querySelector('.chat-name').textContent = name;
                          div.querySelector('img').src = avatar;
                      }
                  });
              }

              div.innerHTML = `
                <img src="${avatar}" class="avatar">
                <div class="chat-meta">
                    <div class="flex justify-between">
                        <span class="chat-name">${name}</span>
                        <span class="time">${formatTime(chat.updatedAt?.toDate())}</span>
                    </div>
                    <div class="last-msg">${chat.lastMessage || ''}</div>
                </div>
              `;
              div.onclick = () => openChat(doc.id, chat);
              ui.chatList.appendChild(div);
          });
      });
}

// --- 4. MESSAGING LOGIC ---
function openChat(chatId, chatData) {
    currentChatId = chatId;
    
    // UI Mobile Transition
    if (window.innerWidth <= 768) {
        ui.chatArea.classList.add('active');
    }
    
    ui.emptyState.classList.add('hidden');
    ui.activeChat.classList.remove('hidden');
    
    // Header Info
    document.getElementById('chat-name').textContent = chatData.name;
    
    // Unsubscribe previous listener
    if (unsubscribeMessages) unsubscribeMessages();
    
    // Load Messages (Realtime)
    unsubscribeMessages = db.collection('chats').doc(chatId)
        .collection('messages')
        .orderBy('timestamp', 'asc')
        .onSnapshot(snapshot => {
            ui.messagesContainer.innerHTML = '';
            snapshot.forEach(doc => {
                renderMessage(doc.data());
            });
            scrollToBottom();
            
            // Mark as read if not me
            const unread = snapshot.docs.filter(d => d.data().senderId !== currentUser.uid && d.data().status !== 'read');
            if (unread.length > 0) {
                const batch = db.batch();
                unread.forEach(d => {
                    batch.update(d.ref, { status: 'read' });
                });
                batch.commit();
            }
        });
}

function renderMessage(msg) {
    const isMe = msg.senderId === currentUser.uid;
    const div = document.createElement('div');
    div.className = `msg-bubble ${isMe ? 'msg-out' : 'msg-in'}`;
    
    let content = '';
    if (msg.type === 'text') content = msg.text;
    else if (msg.type === 'image') content = `<img src="${msg.mediaUrl}" style="max-width:100%; border-radius:8px;"><br>${msg.text}`;
    else if (msg.type === 'file') content = `<a href="${msg.mediaUrl}" target="_blank">📎 ${msg.fileName}</a>`;
    
    // Reply Context
    let replyHtml = '';
    if (msg.replyTo) {
        replyHtml = `<div style="border-left:3px solid #ccc; padding-left:5px; margin-bottom:5px; opacity:0.8; font-size:0.8rem;">↩ ${msg.replyTo.text || 'Media'}</div>`;
    }

    div.innerHTML = `
        ${replyHtml}
        ${content}
        <span class="msg-time">
            ${formatTime(msg.timestamp?.toDate())}
            ${isMe ? `<span class="checkmark">${msg.status === 'read' ? '✔✔' : '✔'}</span>` : ''}
        </span>
    `;
    
    // Click to reply
    div.oncontextmenu = (e) => {
        e.preventDefault();
        setReply(msg);
    };

    ui.messagesContainer.appendChild(div);
}

async function sendMessage(mediaUrl = null, mediaType = null, fileName = null) {
    const text = ui.input.value.trim();
    if (!text && !mediaUrl) return;
    
    const msgData = {
        senderId: currentUser.uid,
        senderName: currentUser.displayName || currentUser.email,
        text: text,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        status: 'sent',
        type: mediaType || 'text'
    };
    
    if (mediaUrl) {
        msgData.mediaUrl = mediaUrl;
        if(fileName) msgData.fileName = fileName;
    }
    
    if (replyingTo) {
        msgData.replyTo = replyingTo;
        cancelReply();
    }

    // 1. Add Message
    await db.collection('chats').doc(currentChatId).collection('messages').add(msgData);
    
    // 2. Update Chat Header (Last Message & Time)
    await db.collection('chats').doc(currentChatId).update({
        lastMessage: text || (mediaType === 'image' ? '📷 Foto' : '📎 File'),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    
    ui.input.value = '';
}

// --- 5. FILE UPLOAD & PREVIEW ---
ui.fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if(!file) return;
    
    // Preview
    const reader = new FileReader();
    reader.onload = (ev) => {
        document.getElementById('preview-img').src = ev.target.result;
        document.getElementById('caption-input').value = '';
        ui.previewModal.classList.remove('hidden');
        
        // Store file temporarily
        window.tempFile = file;
    };
    if (file.type.startsWith('image/')) reader.readAsDataURL(file);
    else alert("Hanya gambar yang dipreview untuk demo ini.");
});

document.getElementById('confirm-upload').onclick = async () => {
    const file = window.tempFile;
    const caption = document.getElementById('caption-input').value;
    
    // Show loading UI (simple)
    ui.sendBtn.textContent = '...';
    
    try {
        const storageRef = storage.ref(`chats/${currentChatId}/${Date.now()}_${file.name}`);
        await storageRef.put(file);
        const url = await storageRef.getDownloadURL();
        
        await sendMessage(url, 'image');
        ui.previewModal.classList.add('hidden');
    } catch (err) {
        console.error(err);
        alert("Gagal upload: " + err.message);
    } finally {
        ui.sendBtn.textContent = '➤';
    }
};

document.getElementById('cancel-upload').onclick = () => {
    ui.previewModal.classList.add('hidden');
};

// --- 6. UTILS ---
ui.sendBtn.onclick = () => sendMessage();
ui.input.addEventListener('keypress', (e) => { if(e.key === 'Enter') sendMessage(); });

document.querySelector('.mobile-back-btn').onclick = () => {
    ui.chatArea.classList.remove('active');
};

function formatTime(date) {
    if(!date) return '';
    return date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
}

function scrollToBottom() {
    ui.messagesContainer.scrollTop = ui.messagesContainer.scrollHeight;
}

function setReply(msg) {
    replyingTo = { text: msg.text, id: msg.id, senderName: msg.senderName };
    ui.replyPreview.classList.remove('hidden');
    document.getElementById('reply-to-name').textContent = "Membalas " + msg.senderName;
    document.getElementById('reply-text').textContent = msg.text || "Media";
    ui.input.focus();
}

function cancelReply() {
    replyingTo = null;
    ui.replyPreview.classList.add('hidden');
}

document.getElementById('cancel-reply').onclick = cancelReply;

// --- 7. FCM NOTIFICATIONS ---
async function requestNotificationPermission() {
    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            console.log('Notification permission granted.');
            const token = await messaging.getToken();
            console.log('FCM Token:', token);
            // Save token to Firestore already handled in updateUserData
        }
    } catch (err) {
        console.error('Unable to get permission', err);
    }
}

// Foreground notification
messaging.onMessage((payload) => {
    console.log('Message received. ', payload);
    const notificationTitle = payload.notification.title;
    const notificationOptions = { body: payload.notification.body };
    new Notification(notificationTitle, notificationOptions);
});

// Dark Mode Toggle
document.getElementById('theme-toggle').onclick = () => {
    const current = document.body.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.body.setAttribute('data-theme', next);
};
