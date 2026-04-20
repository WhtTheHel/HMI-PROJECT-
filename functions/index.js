// functions/index.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

exports.sendNotification = functions.firestore
    .document('chats/{chatId}/messages/{messageId}')
    .onCreate(async (snap, context) => {
        const message = snap.data();
        const chatId = context.params.chatId;
        
        // Jangan kirim notifikasi jika pengirimnya sendiri (opsional, tergantung kebutuhan)
        // Di sini kita kirim ke semua anggota KECUALI pengirim
        
        // 1. Ambil data Chat untuk dapat daftar member
        const chatDoc = await admin.firestore().collection('chats').doc(chatId).get();
        const chatData = chatDoc.data();
        
        if (!chatData || !chatData.members) return;

        // 2. Ambil FCM Token semua anggota
        const tokens = [];
        const members = chatData.members;
        
        const userDocs = await admin.firestore().collection('users')
            .where(admin.firestore.FieldPath.documentId(), 'in', members)
            .get();
            
        userDocs.forEach(doc => {
            const data = doc.data();
            // Hanya ambil token user lain (bukan sender)
            if (doc.id !== message.senderId && data.fcmToken) {
                tokens.push(data.fcmToken);
            }
        });

        // 3. Kirim Payload
        if (tokens.length > 0) {
            const payload = {
                notification: {
                    title: chatData.name, // Nama Grup atau User (perlu logic tambahan untuk private chat)
                    body: message.type === 'text' ? message.text : 'Mengirim gambar...',
                    icon: 'https://ui-avatars.com/api/?name=OrgConnect',
                    click_action: 'https://YOUR_PROJECT_ID.web.app' // Link ke web app
                },
                data: {
                    chatId: chatId
                }
            };

            const response = await admin.messaging().sendToDevice(tokens, payload);
            console.log('Notifications sent:', response);
        }
    });
