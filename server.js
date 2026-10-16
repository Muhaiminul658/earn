const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Storage } = require('megajs');
const admin = require('firebase-admin');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// ১. Firebase Admin SDK ইনিশিয়ালাইজেশন
try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is not set!");
  }

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    // আপনার ফায়ারবেজ রিয়েলটাইম ডাটাবেজ ইউআরএল
    databaseURL: "https://earn-mony-e284a-default-rtdb.firebaseio.com" 
  });
  console.log('✅ Firebase Admin SDK initialized with Realtime Database!');
} catch (error) {
  console.error('❌ Firebase initialization error:', error.message);
}

const db = admin.database(); // Realtime Database Instance
const upload = multer({ dest: 'uploads/' });

// Mega Storage Connect
const megaStorage = new Storage({
  key: 'FvaGMKqrmJ7LmBDnWFJqMw'
}, () => {
  console.log('✅ Connected to Mega.nz Storage successfully!');
});

app.get('/', (req, res) => {
  res.send('🚀 Video Hosting API (Realtime DB) is Running!');
});

// ২. গুগল সাইন-ইন এবং ১০ কয়েন দেওয়া (Realtime DB Version)
app.post('/api/v1/auth/google-login', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ success: false, message: 'ID Token missing!' });

    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const { uid, email, name, picture } = decodedToken;

    const teacherRef = db.ref(`teachers/${uid}`);
    const snapshot = await teacherRef.once('value');

    if (!snapshot.exists()) {
      // নতুন শিক্ষক হলে API Key ও ১০ কয়েন দেওয়া
      const generatedApiKey = 'mhin_live_' + crypto.randomBytes(12).toString('hex');
      const newTeacherData = {
        uid,
        name: name || 'Teacher',
        email,
        photoURL: picture || '',
        apiKey: generatedApiKey,
        coins: 10, // 🎁 সাইন-আপ বোনাস ১০ কয়েন
        totalStorageMB: 0,
        createdAt: Date.now()
      };

      await teacherRef.set(newTeacherData);

      // দ্রুত অনুসন্ধানের জন্য API Key দিয়ে আলাদা ইনডেক্সিং ম্যাপ রাখা
      await db.ref(`api_keys/${generatedApiKey}`).set(uid);

      return res.json({ success: true, isNewUser: true, data: newTeacherData });
    } else {
      return res.json({ success: true, isNewUser: false, data: snapshot.val() });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ৩. ভিডিও আপলোড এবং Mega-তে পাঠানো (Realtime DB Version)
app.post('/api/v1/upload-video', upload.single('video'), async (req, res) => {
  try {
    const teacherApiKey = req.headers['x-api-key'];
    if (!teacherApiKey) return res.status(401).json({ success: false, message: 'API Key missing!' });

    // API Key দিয়ে টিচারের UID বের করা
    const apiKeySnap = await db.ref(`api_keys/${teacherApiKey}`).once('value');
    if (!apiKeySnap.exists()) return res.status(403).json({ success: false, message: 'Invalid API Key!' });

    const teacherUid = apiKeySnap.val();
    const teacherRef = db.ref(`teachers/${teacherUid}`);
    const teacherSnap = await teacherRef.once('value');
    const teacherData = teacherSnap.val();

    // কয়েন চেক
    if (!teacherData || teacherData.coins < 1) {
      return res.status(402).json({ success: false, message: 'পর্যাপ্ত কয়েন নেই! দয়া করে রিচার্জ করুন।' });
    }

    if (!req.file) return res.status(400).json({ success: false, message: 'No video file uploaded.' });

    const localFilePath = req.file.path;
    const fileName = req.file.originalname;
    const fileSizeMB = req.file.size / (1024 * 1024);

    megaStorage.upload({ name: fileName, size: req.file.size }, fs.createReadStream(localFilePath), async (err, file) => {
      if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);

      if (err) return res.status(500).json({ success: false, message: 'Failed to upload to Mega storage.' });

      file.link(async (linkErr, megaUrl) => {
        if (linkErr) return res.status(500).json({ success: false, message: 'Failed to generate video link.' });

        const updatedCoins = teacherData.coins - 1;
        const updatedStorage = (teacherData.totalStorageMB || 0) + fileSizeMB;

        // টিচারের ডাটা আপডেট করা
        await teacherRef.update({
          coins: updatedCoins,
          totalStorageMB: updatedStorage
        });

        // ভিডিওর ডাটা সেভ করা
        const newVideoRef = db.ref('videos').push();
        await newVideoRef.set({
          teacherApiKey,
          fileName,
          fileSizeMB: parseFloat(fileSizeMB.toFixed(2)),
          megaUrl,
          createdAt: Date.now()
        });

        res.json({
          success: true,
          message: 'Video uploaded successfully!',
          embed_url: megaUrl,
          remaining_coins: updatedCoins
        });
      });
    });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
