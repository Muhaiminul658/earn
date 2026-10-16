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

// ১. Render Environment Variable থেকে Firebase Admin SDK ইনিশিয়ালাইজেশন
try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is not set on Render!");
  }

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin SDK initialized successfully!');
} catch (error) {
  console.error('❌ Firebase initialization error:', error.message);
}

const db = admin.firestore();

// মুল্টার টেম্পোরারি ফাইল আপলোড কনফিগারেশন
const upload = multer({ dest: 'uploads/' });

// ২. Mega API Key (FvaGMKqrmJ7LmBDnWFJqMw) দিয়ে Mega Storage কানেক্ট করা
const megaStorage = new Storage({
  key: 'FvaGMKqrmJ7LmBDnWFJqMw'
}, () => {
  console.log('✅ Connected to Mega.nz Storage successfully!');
});

// ৩. টেস্ট রুট (সার্ভার সচল আছে কি না তা চেক করার জন্য)
app.get('/', (req, res) => {
  res.send('🚀 Video Hosting API Backend is Running!');
});

// ৪. গুগল সাইন-ইন এবং ১০ ফ্রি কয়েন দেওয়ার API
app.post('/api/v1/auth/google-login', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ success: false, message: 'ID Token missing!' });

    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const { uid, email, name, picture } = decodedToken;

    const teacherRef = db.collection('teachers').doc(uid);
    const doc = await teacherRef.get();

    if (!doc.exists) {
      // নতুন শিক্ষক হলে ইউনিক API Key জেনারেট করা এবং ১০ কয়েন ওয়েলকাম বোনাস দেওয়া
      const generatedApiKey = 'mhin_live_' + crypto.randomBytes(12).toString('hex');
      const newTeacherData = {
        uid,
        name: name || 'Teacher',
        email,
        photoURL: picture || '',
        apiKey: generatedApiKey,
        coins: 10, // 🎁 সাইন-আপ বোনাস ১০ কয়েন
        totalStorageMB: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };

      await teacherRef.set(newTeacherData);
      return res.json({ success: true, isNewUser: true, data: newTeacherData });
    } else {
      return res.json({ success: true, isNewUser: false, data: doc.data() });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ৫. ভিডিও আপলোড এবং Mega-তে ব্যাকগ্রাউন্ডে পাঠানোর API
app.post('/api/v1/upload-video', upload.single('video'), async (req, res) => {
  try {
    const teacherApiKey = req.headers['x-api-key'];
    if (!teacherApiKey) return res.status(401).json({ success: false, message: 'API Key missing!' });

    // টিচারের API Key ভেরিফাই করা
    const snapshot = await db.collection('teachers').where('apiKey', '==', teacherApiKey).get();
    if (snapshot.empty) return res.status(403).json({ success: false, message: 'Invalid API Key!' });

    let teacherDocId = null;
    let teacherData = null;
    snapshot.forEach(doc => {
      teacherDocId = doc.id;
      teacherData = doc.data();
    });

    // কয়েন চেক করা (কমপক্ষে ১ কয়েন থাকতে হবে)
    if (teacherData.coins < 1) {
      return res.status(402).json({ success: false, message: 'পর্যাপ্ত কয়েন নেই! দয়া করে রিচার্জ করুন।' });
    }

    if (!req.file) return res.status(400).json({ success: false, message: 'No video file uploaded.' });

    const localFilePath = req.file.path;
    const fileName = req.file.originalname;
    const fileSizeMB = req.file.size / (1024 * 1024);

    // Mega স্টোরেজে ফাইল ব্যাকগ্রাউন্ডে আপলোড করা
    megaStorage.upload({ name: fileName, size: req.file.size }, fs.createReadStream(localFilePath), async (err, file) => {
      // টেম্পোরারি ফাইল মুছে ফেলা
      if (fs.existsSync(localFilePath)) {
        fs.unlinkSync(localFilePath);
      }

      if (err) return res.status(500).json({ success: false, message: 'Failed to upload to Mega storage.' });

      file.link(async (linkErr, megaUrl) => {
        if (linkErr) return res.status(500).json({ success: false, message: 'Failed to generate video link.' });

        // টিচারের ১ কয়েন কেটে নেওয়া এবং ব্যবহৃত স্টোরেজ আপডেট করা
        await db.collection('teachers').doc(teacherDocId).update({
          coins: admin.firestore.FieldValue.increment(-1),
          totalStorageMB: admin.firestore.FieldValue.increment(fileSizeMB)
        });

        // ফায়ারবেজে ভিডিওর ইনফো সেভ করা
        await db.collection('videos').add({
          teacherApiKey,
          fileName,
          fileSizeMB: parseFloat(fileSizeMB.toFixed(2)),
          megaUrl,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
          success: true,
          message: 'Video uploaded successfully!',
          embed_url: megaUrl,
          remaining_coins: teacherData.coins - 1
        });
      });
    });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Port Listening Setup
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
